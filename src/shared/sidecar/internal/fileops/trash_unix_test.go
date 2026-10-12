//go:build unix

package fileops

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Stage P04 (ADR-0021): a share whose top folder the user cannot write to
// has no place for a trash folder. The item stays where it is and the
// error says there is no trash, so the app can offer to delete for good.
func TestTrashWhereNoTrashFolderCanBeMade(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root may write anywhere")
	}
	top := t.TempDir()
	item := filepath.Join(top, "data", "a.jpg")
	if err := os.MkdirAll(filepath.Dir(item), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(item, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(top, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(top, 0o755) })

	err := trashInto(filepath.Join(top, ".Trash-"+strconv.Itoa(os.Getuid())), item, "data/a.jpg", time.Now())
	if Code(err) != CodeTrashUnavailable {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(item); err != nil {
		t.Fatalf("the item is gone: %v", err)
	}
	if ents, _ := os.ReadDir(top); len(ents) != 1 {
		t.Fatalf("left in the top folder: %v", ents)
	}
}

// The same on a real second volume: PANELYTH_TEST_VOLUME names a folder
// the user may write to on a volume other than home's (a mounted share, a
// USB stick). Where the volume's top folder is writable the item goes to
// its .Trash-$uid with a path relative to the top; where it is not, the
// item stays and the error says so.
func TestTrashOnAnotherVolume(t *testing.T) {
	dir := os.Getenv("PANELYTH_TEST_VOLUME")
	if dir == "" {
		t.Skip("set PANELYTH_TEST_VOLUME to a writable folder on another volume")
	}
	if runtime.GOOS == "darwin" {
		t.Skip("macOS keeps .Trashes per volume; see TestTrashOnThisPlatform")
	}
	dev, ok := devOf(dir)
	home, _ := os.UserHomeDir()
	if homeDev, hok := devOf(home); !ok || (hok && homeDev == dev) {
		t.Skipf("%s is on home's volume", dir)
	}
	item := filepath.Join(dir, "panelyth-trash-test.jpg")
	if err := os.WriteFile(item, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(item) })
	top := mountTop(item, dev)
	uid := strconv.Itoa(os.Getuid())
	probe := filepath.Join(top, ".panelyth-probe")
	writable := os.Mkdir(probe, 0o700) == nil
	_ = os.Remove(probe)

	err := Trash(item)
	if !writable {
		if Code(err) != CodeTrashUnavailable {
			t.Fatalf("top folder %s is not writable; err = %v", top, err)
		}
		if _, err := os.Stat(item); err != nil {
			t.Fatalf("the item is gone: %v", err)
		}
		return
	}
	if err != nil {
		t.Fatalf("trash on %s: %v", top, err)
	}
	trash := filepath.Join(top, ".Trash-"+uid)
	t.Cleanup(func() { _ = os.RemoveAll(trash) })
	if _, err := os.Stat(filepath.Join(trash, "files", filepath.Base(item))); err != nil {
		t.Fatalf("not in %s: %v", trash, err)
	}
	info, err := os.ReadFile(filepath.Join(trash, "info", filepath.Base(item)+".trashinfo"))
	rel, _ := filepath.Rel(top, item)
	if err != nil || !strings.Contains(string(info), "Path="+rel+"\n") {
		t.Fatalf("trashinfo %q, %v (want the path relative to %s)", info, err, top)
	}
}

// A fresh account has no ~/.local/share yet: the home trash is made when
// the first item goes there. (Without it the item was sent to a trash at
// the top of the home volume, which an ordinary user cannot create.)
func TestHomeTrashIsMadeWhenFirstNeeded(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("macOS has ~/.Trash")
	}
	base := t.TempDir()
	dataHome := filepath.Join(base, "home", ".local", "share")
	t.Setenv("XDG_DATA_HOME", dataHome)
	item := filepath.Join(base, "photos", "a.jpg")
	if err := os.MkdirAll(filepath.Dir(item), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(item, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Trash(item); err != nil {
		t.Fatalf("trash on a fresh account: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataHome, "Trash", "files", "a.jpg")); err != nil {
		t.Fatalf("not in the home trash: %v", err)
	}
	info, err := os.ReadFile(filepath.Join(dataHome, "Trash", "info", "a.jpg.trashinfo"))
	if err != nil || !strings.Contains(string(info), "Path="+item+"\n") {
		t.Fatalf("trashinfo %q, %v", info, err)
	}
	if _, err := os.Stat(item); err == nil {
		t.Fatal("the item is still in its folder")
	}
}
