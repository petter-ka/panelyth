package fsx

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func mkdirs(t *testing.T, root string, rel ...string) {
	t.Helper()
	for _, r := range rel {
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(r)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func TestListDirsNaturalOrderAndProbe(t *testing.T) {
	root := t.TempDir()
	mkdirs(t, root, "img10/sub", "img2", "img1/only-files", ".hidden/x", "empty")
	if err := os.WriteFile(filepath.Join(root, "file.jpg"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "img2", "a.jpg"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	got, truncated, err := ListDirs(context.Background(), root, ListOptions{})
	if err != nil || truncated {
		t.Fatal(err, truncated)
	}
	want := []struct {
		name string
		has  bool
	}{{"empty", false}, {"img1", true}, {"img2", false}, {"img10", true}}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i, w := range want {
		if got[i].Name != w.name || got[i].HasChildren != w.has || got[i].Path != filepath.Join(root, w.name) {
			t.Errorf("%d: got %+v want %+v", i, got[i], w)
		}
	}
}

// Stage C10.5: the commander's tree lists hidden folders when its panel
// shows hidden files.
func TestListDirsShowHidden(t *testing.T) {
	root := t.TempDir()
	mkdirs(t, root, "plain", ".hidden/x", "parent/.only-hidden")
	names := func(o ListOptions) map[string]bool {
		t.Helper()
		got, _, err := ListDirs(context.Background(), root, o)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]bool{}
		for _, c := range got {
			out[c.Name] = c.HasChildren
		}
		return out
	}
	if got := names(ListOptions{}); len(got) != 2 || got["parent"] {
		t.Errorf("hidden folders listed or counted: %v", got)
	}
	got := names(ListOptions{ShowHidden: true})
	if len(got) != 3 || !got[".hidden"] || !got["parent"] || got["plain"] {
		t.Errorf("with hidden folders: %v", got)
	}
}

func TestListDirsBounds(t *testing.T) {
	root := t.TempDir()
	for i := range 30 {
		mkdirs(t, root, fmt.Sprintf("d%02d", i))
	}
	got, truncated, err := ListDirs(context.Background(), root, ListOptions{MaxEntries: 10, ProbeBudget: 3})
	if err != nil || !truncated || len(got) != 10 {
		t.Fatalf("len=%d truncated=%v err=%v", len(got), truncated, err)
	}
	// Probed children are empty (false); beyond the budget they stay true.
	probed := 0
	for _, c := range got {
		if !c.HasChildren {
			probed++
		}
	}
	if probed != 3 {
		t.Fatalf("probe budget not respected: %d probed", probed)
	}
	// Probe reads are bounded: a folder with many files and no subfolder
	// past the read budget answers true (unknown), not a full listing.
	many := filepath.Join(root, "many")
	mkdirs(t, root, "many")
	for i := range 40 {
		_ = os.WriteFile(filepath.Join(many, fmt.Sprintf("f%d", i)), nil, 0o644)
	}
	opts := ListOptions{ProbeReads: 10}
	opts.defaults()
	opts.probeReadChunk = 5
	if !hasSubdir(many, opts) {
		t.Fatal("exhausted probe budget must report true")
	}
	opts.ProbeReads = 1000
	if hasSubdir(many, opts) {
		t.Fatal("fully read folder without subfolders must report false")
	}
}

func TestListDirsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := ListDirs(ctx, t.TempDir(), ListOptions{}); err == nil {
		t.Fatal("cancelled context must fail")
	}
}

func TestCrumbs(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "a", "b")
	c := Crumbs(p)
	if last := c[len(c)-1]; last.Name != "b" || last.Path != p {
		t.Fatalf("last crumb %+v", last)
	}
	if c[len(c)-2].Path != filepath.Join(root, "a") {
		t.Fatalf("parent crumb %+v", c[len(c)-2])
	}
	first := c[0]
	if filepath.Dir(first.Path) != first.Path {
		t.Fatalf("first crumb is not a root: %+v", first)
	}
	if runtime.GOOS == "windows" {
		if len(first.Name) != 2 || first.Name[1] != ':' {
			t.Fatalf("drive root name %q", first.Name)
		}
		if unc := Crumbs(`\\server\share\photos`); unc[0].Name != `\\server\share` || unc[1].Name != "photos" {
			t.Fatalf("unc crumbs %+v", unc)
		}
	} else if first.Name != "/" {
		t.Fatalf("root name %q", first.Name)
	}
	if one := Crumbs(first.Path); len(one) != 1 {
		t.Fatalf("root alone: %+v", one)
	}
}

func TestFileTimes(t *testing.T) {
	f := filepath.Join(t.TempDir(), "x")
	before := time.Now().Add(-time.Minute).UnixNano()
	if err := os.WriteFile(f, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	fi, _ := Stat(f)
	tm := FileTimes(fi)
	switch runtime.GOOS {
	case "windows", "darwin":
		if tm.BirthNs < before {
			t.Fatalf("birth time missing: %d", tm.BirthNs)
		}
	default:
		// statx (Stage P04): zero only where the filesystem keeps none.
		if tm.BirthNs != 0 && tm.BirthNs < before {
			t.Fatalf("birth time %d before the file was created", tm.BirthNs)
		}
		t.Logf("birth time reported: %v", tm.BirthNs != 0)
	}
	if plain, _ := os.Stat(f); FileTimes(plain).AccessNs != tm.AccessNs {
		t.Fatalf("access time differs from os.Stat")
	}
}

func TestVolumesIncludeSomething(t *testing.T) {
	v, err := Volumes()
	if err != nil || len(v) == 0 {
		t.Fatalf("volumes: %v %v", v, err)
	}
	for _, x := range v {
		if !filepath.IsAbs(x.Path) {
			t.Errorf("volume path not absolute: %+v", x)
		}
	}
}

// Local volumes report their space; the test runs where "/" or C:\ exists.
func TestVolumesSpace(t *testing.T) {
	vs, err := Volumes()
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range vs {
		if v.Kind == "fixed" && v.TotalBytes > 0 {
			if v.FreeBytes < 0 || v.FreeBytes > v.TotalBytes {
				t.Fatalf("%s: free %d of %d", v.Path, v.FreeBytes, v.TotalBytes)
			}
			return
		}
	}
	t.Fatalf("no fixed volume with space in %v", vs)
}

func TestParseMountInfo(t *testing.T) {
	text := `22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw
23 22 0:5 / /proc rw - proc proc rw
40 22 8:17 / /media/petter/My\040Disk rw - exfat /dev/sdb1 rw
41 22 0:50 / /mnt/nas rw - nfs4 nas:/photos rw
42 22 0:51 / /run/media/p/CARD rw - vfat /dev/sdc1 rw
43 22 0:52 / /snap/core/1 ro - squashfs /dev/loop0 ro
44 22 8:17 / /media/petter/My\040Disk rw - exfat /dev/sdb1 rw
45 22 11:0 / /media/petter/HOLIDAY\0402019 ro - iso9660 /dev/sr0 ro
46 22 0:53 / /mnt/share rw - cifs //nas/share rw
47 22 0:54 / /home/petter/mnt rw - ext4 /dev/sdd1 rw`
	got := ParseMountInfo(text)
	want := []Volume{
		{Path: "/", Label: "/", Kind: "fixed"},
		{Path: "/media/petter/My Disk", Label: "My Disk", Kind: "removable"},
		{Path: "/mnt/nas", Label: "nas", Kind: "network"},
		{Path: "/run/media/p/CARD", Label: "CARD", Kind: "removable"},
		{Path: "/media/petter/HOLIDAY 2019", Label: "HOLIDAY 2019", Kind: "optical"},
		{Path: "/mnt/share", Label: "share", Kind: "network"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}
