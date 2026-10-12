//go:build windows

package fsx

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// Stage P04: drives that come and go on a real machine. A substituted drive
// stands in for a disk that is plugged in, the loopback admin share for a
// mapped network drive; both need no administrator.

func freeLetter(t *testing.T) string {
	t.Helper()
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		t.Fatal(err)
	}
	for i := 25; i > 2; i-- { // Z down to D
		if mask&(1<<i) == 0 {
			return string(rune('A' + i))
		}
	}
	t.Skip("no free drive letter")
	return ""
}

func findVolume(t *testing.T, root string) (Volume, bool) {
	t.Helper()
	vs, err := Volumes()
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range vs {
		if v.Path == root {
			return v, true
		}
	}
	return Volume{}, false
}

func TestDriveThatAppearsIsListed(t *testing.T) {
	dir := t.TempDir()
	letter := freeLetter(t)
	root := letter + `:\`
	before, err := VolumeSignature()
	if err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("subst.exe", letter+":", dir).CombinedOutput(); err != nil {
		t.Skipf("subst: %v: %s", err, out)
	}
	removed := false
	remove := func() {
		if !removed {
			removed = true
			_ = exec.Command("subst.exe", letter+":", "/D").Run()
		}
	}
	t.Cleanup(remove)

	during, err := VolumeSignature()
	if err != nil || during == before {
		t.Fatalf("the signature did not change when %s appeared (%v)", root, err)
	}
	v, ok := findVolume(t, root)
	if !ok {
		t.Fatalf("%s is not listed", root)
	}
	home, _ := findVolume(t, filepath.VolumeName(dir)+`\`)
	if v.Kind != home.Kind || v.Label != home.Label {
		t.Errorf("%+v; the drive it stands for is %+v", v, home)
	}
	if v.TotalBytes <= 0 || v.FreeBytes < 0 || v.FreeBytes > v.TotalBytes || v.NotReady {
		t.Errorf("space of %s: %+v", root, v)
	}
	if got := VolumeID(root + `sub\file.jpg`); got != strings.ToLower(letter)+":" {
		t.Errorf("volume id %q", got)
	}
	// What is written through the drive is in the folder behind it.
	if err := os.WriteFile(root+"a.jpg", []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "a.jpg")); err != nil {
		t.Fatal(err)
	}
	if kids, _, err := ListDirs(t.Context(), root, ListOptions{}); err != nil || len(kids) != 0 {
		t.Errorf("subfolders of %s: %v, %v", root, kids, err)
	}

	remove()
	after, err := VolumeSignature()
	if err != nil || after != before {
		t.Fatalf("the signature did not return when %s went away (%v)", root, err)
	}
	if _, ok := findVolume(t, root); ok {
		t.Fatalf("%s is still listed", root)
	}
}

func TestMappedShareIsANetworkVolume(t *testing.T) {
	dir := t.TempDir()
	vol := filepath.VolumeName(dir)
	share := `\\localhost\` + vol[:1] + `$`
	if _, err := os.Stat(share + `\`); err != nil {
		t.Skipf("no access to %s: %v", share, err)
	}
	letter := freeLetter(t)
	root := letter + `:\`
	if out, err := exec.Command("net.exe", "use", letter+":", share, "/persistent:no").CombinedOutput(); err != nil {
		t.Skipf("net use: %v: %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("net.exe", "use", letter+":", "/delete", "/y").Run() })

	v, ok := findVolume(t, root)
	if !ok {
		t.Fatalf("%s is not listed", root)
	}
	// A share's label is not read: asking a share that stopped answering
	// can take seconds, and the list is read every two seconds.
	if v.Kind != "network" || v.Label != "" {
		t.Errorf("%+v", v)
	}
	if v.TotalBytes <= 0 || v.FreeBytes > v.TotalBytes || v.NotReady {
		t.Errorf("space of %s: %+v", root, v)
	}
	if IsRotational(root) {
		t.Error("a share is not a spinning disk of this machine")
	}
	// The same folder through the drive letter and through the share.
	mapped := root + dir[len(vol)+1:]
	if _, err := os.Stat(mapped); err != nil {
		t.Fatalf("%s: %v", mapped, err)
	}
	if VolumeID(mapped) != strings.ToLower(letter)+":" || VolumeID(share+dir[len(vol):]) != strings.ToLower(share) {
		t.Errorf("volume ids %q and %q", VolumeID(mapped), VolumeID(share+dir[len(vol):]))
	}
	crumbs := Crumbs(share + dir[len(vol):])
	if crumbs[0].Name != share || crumbs[0].Path != share+`\` {
		t.Errorf("root crumb of a share: %+v", crumbs[0])
	}
}
