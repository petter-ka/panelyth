package fsx

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRemoveSoonWaitsForAHolder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "frame.jpg")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// On Windows an open handle refuses the delete, as a virus scanner's does;
	// elsewhere the removal works at once.
	held, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(30 * time.Millisecond)
		_ = held.Close()
	}()
	if err := RemoveSoon(path); err != nil {
		t.Fatalf("RemoveSoon: %v", err)
	}
	_ = held.Close()
	if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the file is still there: %v", err)
	}
	// Gone already is no error.
	if err := RemoveSoon(path); err != nil {
		t.Fatalf("RemoveSoon of a missing file: %v", err)
	}
}
