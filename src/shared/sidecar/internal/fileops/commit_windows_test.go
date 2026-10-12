//go:build windows

package fileops

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A file that was just written is often held for a moment by a virus scanner
// or the indexer. The commit waits that moment out; a file that stays held
// still fails as IN_USE, after a bounded wait.
func TestCommitWaitsOutABriefHold(t *testing.T) {
	dir := t.TempDir()
	partial, dst := PartialName(dir, "a.jpg"), filepath.Join(dir, "a.jpg")
	if err := os.WriteFile(partial, []byte("picture"), 0o644); err != nil {
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
	if err := CommitFile(partial, dst, false); err != nil {
		t.Fatalf("commit of a briefly held file: %v", err)
	}
	if waited := time.Since(start); waited < 50*time.Millisecond || waited > 2*time.Second {
		t.Errorf("waited %v", waited)
	}
	if b, err := os.ReadFile(dst); err != nil || string(b) != "picture" {
		t.Errorf("committed file: %q %v", b, err)
	}
	if _, err := os.Lstat(partial); err == nil {
		t.Error("the partial file is still there")
	}

	// Held for good: IN_USE, within the bound, and nothing at the destination.
	other := filepath.Join(dir, "b.jpg")
	partial = PartialName(dir, "b.jpg")
	if err := os.WriteFile(partial, []byte("picture"), 0o644); err != nil {
		t.Fatal(err)
	}
	held, err = os.Open(partial)
	if err != nil {
		t.Fatal(err)
	}
	start = time.Now()
	err = CommitFile(partial, other, false)
	waited := time.Since(start)
	_ = held.Close()
	if Code(err) != CodeInUse {
		t.Errorf("commit of a held file: %v", err)
	}
	if waited < 300*time.Millisecond || waited > 3*time.Second {
		t.Errorf("gave up after %v", waited)
	}
	if _, err := os.Lstat(other); err == nil {
		t.Error("a held file reached its destination")
	}
	_ = os.Remove(partial)

	// A name that is taken is not waited for.
	partial = PartialName(dir, "a.jpg")
	if err := os.WriteFile(partial, []byte("second"), 0o644); err != nil {
		t.Fatal(err)
	}
	start = time.Now()
	if err := CommitFile(partial, dst, false); Code(err) != CodeExists {
		t.Errorf("commit onto a taken name: %v", err)
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Errorf("a taken name was waited for: %v", time.Since(start))
	}
}
