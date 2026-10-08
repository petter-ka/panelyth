package fsx

import (
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// EntryInfo and Stat must describe an entry exactly as os.Lstat and os.Stat
// do; on Linux they come from statx.
func TestEntryInfoMatchesLstat(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("hello"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.Symlink("file.txt", filepath.Join(dir, "link")) // needs a privilege on Windows
	f, err := os.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	ents, err := f.ReadDir(-1)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		got, err := EntryInfo(f, e)
		if err != nil {
			t.Fatal(err)
		}
		want, _ := os.Lstat(filepath.Join(dir, e.Name()))
		same(t, e.Name(), got, want)
	}
	got, err := Stat(filepath.Join(dir, "link"))
	if err == nil {
		want, _ := os.Stat(filepath.Join(dir, "link"))
		same(t, "link (followed)", got, want)
		if got.Name() != "link" {
			t.Fatalf("name %q", got.Name())
		}
	}
	if _, err := Stat(filepath.Join(dir, "missing")); !os.IsNotExist(err) {
		t.Fatalf("missing: %v", err)
	}
}

func same(t *testing.T, name string, got, want fs.FileInfo) {
	t.Helper()
	if got.Name() != want.Name() || got.Size() != want.Size() || got.Mode() != want.Mode() ||
		!got.ModTime().Equal(want.ModTime()) || got.IsDir() != want.IsDir() {
		t.Fatalf("%s: got %v %d %v %v, want %v %d %v %v", name, got.Name(), got.Size(), got.Mode(), got.ModTime(),
			want.Name(), want.Size(), want.Mode(), want.ModTime())
	}
	if !reflect.DeepEqual(got.Sys(), want.Sys()) {
		t.Fatalf("%s: Sys %+v, want %+v", name, got.Sys(), want.Sys())
	}
}

// BenchmarkEntryInfo compares statx (Linux) with DirEntry.Info (lstat).
func BenchmarkEntryInfo(b *testing.B) {
	dir := b.TempDir()
	for i := range 1000 {
		if err := os.WriteFile(filepath.Join(dir, "f"+string(rune('a'+i%26))+string(rune('a'+i/26))), nil, 0o644); err != nil {
			b.Fatal(err)
		}
	}
	f, err := os.Open(dir)
	if err != nil {
		b.Fatal(err)
	}
	defer f.Close()
	ents, _ := f.ReadDir(-1)
	b.Run("statx", func(b *testing.B) {
		for b.Loop() {
			for _, e := range ents {
				if _, err := EntryInfo(f, e); err != nil {
					b.Fatal(err)
				}
			}
		}
	})
	b.Run("lstat", func(b *testing.B) {
		for b.Loop() {
			for _, e := range ents {
				if _, err := e.Info(); err != nil {
					b.Fatal(err)
				}
			}
		}
	})
}
