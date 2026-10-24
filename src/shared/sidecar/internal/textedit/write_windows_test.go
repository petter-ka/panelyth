//go:build windows

package textedit

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"panelyth/sidecar/internal/fileops"
)

// A file that was just written is often held for a moment by a virus scanner
// or the indexer. The rename waits that moment out; a file that stays held
// still fails as in use, after a bounded wait, and the original stays.
func TestReplaceWaitsOutABriefHold(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(dst, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	partial := fileops.PartialName(dir, "a.txt")
	if err := os.WriteFile(partial, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Go opens files without FILE_SHARE_DELETE: while this handle is open the
	// file cannot be renamed.
	held, err := os.Open(partial)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(60 * time.Millisecond)
		_ = held.Close()
	}()
	start := time.Now()
	if err := replaceFile(partial, dst); err != nil {
		t.Fatalf("replace of a briefly held file: %v", err)
	}
	if waited := time.Since(start); waited < 50*time.Millisecond || waited > 2*time.Second {
		t.Errorf("waited %v", waited)
	}
	if b, _ := os.ReadFile(dst); string(b) != "new" {
		t.Errorf("replaced file %q", b)
	}

	// Held for good: in use, within the bound, the original untouched and
	// still read-only.
	if err := os.WriteFile(partial, []byte("newer"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(dst, 0o444)
	t.Cleanup(func() { _ = os.Chmod(dst, 0o644) })
	held, err = os.Open(partial)
	if err != nil {
		t.Fatal(err)
	}
	start = time.Now()
	err = replaceFile(partial, dst)
	waited := time.Since(start)
	_ = held.Close()
	if fileops.Code(err) != fileops.CodeInUse {
		t.Errorf("replace of a held file: %v", err)
	}
	if waited < 300*time.Millisecond || waited > 3*time.Second {
		t.Errorf("gave up after %v", waited)
	}
	if b, _ := os.ReadFile(dst); string(b) != "new" {
		t.Errorf("a held file replaced the original: %q", b)
	}
	if fi, _ := os.Stat(dst); fi.Mode().Perm()&0o222 != 0 {
		t.Error("the original lost its read-only attribute")
	}
}

// Hidden and system files keep their attributes through a save.
func TestHiddenSystemAttributesKept(t *testing.T) {
	ctx := context.Background()
	m := newManager(t, Config{})
	path := writeTemp(t, t.TempDir(), "desktop.ini", []byte("[.ShellClassInfo]\r\n"))
	p, _ := windows.UTF16PtrFromString(path)
	if err := windows.SetFileAttributes(p, windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_SYSTEM); err != nil {
		t.Fatal(err)
	}
	info, err := m.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	stage(t, m, info.SessionID, "[.ShellClassInfo]\nIconIndex=1\n", ChunkChars)
	if out, err := m.Commit(ctx, info.SessionID, info.State.Version, false, false); err != nil || out.Status != StatusSaved {
		t.Fatalf("%+v %v", out, err)
	}
	attrs, _ := windows.GetFileAttributes(p)
	if attrs&(windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_SYSTEM) != windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_SYSTEM {
		t.Errorf("attributes %#x", attrs)
	}
	if got, _ := os.ReadFile(path); string(got) != "[.ShellClassInfo]\r\nIconIndex=1\r\n" {
		t.Errorf("saved %q", got)
	}
}
