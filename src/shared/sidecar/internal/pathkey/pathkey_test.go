package pathkey

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func abs(t *testing.T, parts ...string) string {
	t.Helper()
	root := "/"
	if runtime.GOOS == "windows" {
		root = `C:\`
	}
	return filepath.Join(append([]string{root}, parts...)...)
}

func TestClean(t *testing.T) {
	if _, err := Clean("relative/dir"); err == nil {
		t.Fatal("relative path accepted")
	}
	if _, err := Clean(""); err == nil {
		t.Fatal("empty path accepted")
	}
	if _, err := Clean(abs(t, "a\x00b")); err == nil {
		t.Fatal("NUL accepted")
	}
	got, err := Clean(abs(t, "photos", "..", "photos", ".", "2024") + string(filepath.Separator))
	if err != nil {
		t.Fatal(err)
	}
	if got != abs(t, "photos", "2024") {
		t.Fatalf("got %q", got)
	}
}

func TestKeys(t *testing.T) {
	root := DirKey(abs(t))
	if !strings.HasSuffix(root, "/") || strings.Contains(root, `\`) {
		t.Fatalf("root key %q", root)
	}
	dir := DirKey(abs(t, "Photos", "Trip"))
	if !strings.HasPrefix(dir, root) || !strings.HasSuffix(dir, "trip/") && !strings.HasSuffix(dir, "Trip/") {
		t.Fatalf("dir key %q", dir)
	}
	file := ChildKey(dir, "IMG_1.JPG", false)
	sub := ChildKey(dir, "Sub", true)
	lo, hi := SubtreeRange(dir)
	for _, k := range []string{file, sub, ChildKey(sub, "x.png", false)} {
		if !(k >= lo && k < hi) {
			t.Fatalf("%q not in subtree [%q,%q)", k, lo, hi)
		}
	}
	// A sibling sharing the name prefix is outside the subtree.
	sibling := DirKey(abs(t, "Photos", "Trip2"))
	if sibling >= lo && sibling < hi {
		t.Fatalf("sibling %q inside subtree", sibling)
	}
	if dir >= lo && dir < hi && dir != lo {
		t.Fatal("dir itself must be the lower bound only")
	}
}

// Stage P04: the composed and the decomposed form of a name are one file
// on macOS and two files on Windows and Linux; the key follows.
func TestUnicodeNormalization(t *testing.T) {
	composed := ChildKey("/x/", "café.jpg", false)
	decomposed := ChildKey("/x/", "café.jpg", false)
	if (composed == decomposed) != (runtime.GOOS == "darwin") {
		t.Fatalf("on %s: %q vs %q", runtime.GOOS, composed, decomposed)
	}
	dirA, dirB := DirKey(abs(t, "café")), DirKey(abs(t, "café"))
	if (dirA == dirB) != (runtime.GOOS == "darwin") {
		t.Fatalf("on %s: %q vs %q", runtime.GOOS, dirA, dirB)
	}
	// Compare pairs the two forms on every platform.
	if NameKey("café.jpg") != NameKey("café.jpg") {
		t.Fatal("NameKey keeps the two forms apart")
	}
	if (NameKey("A.JPG") == NameKey("a.jpg")) != caseInsensitive {
		t.Fatalf("NameKey case on %s", runtime.GOOS)
	}
}

func TestCaseFolding(t *testing.T) {
	a, b := ChildKey("/x/", "A.JPG", false), ChildKey("/x/", "a.jpg", false)
	if caseInsensitive != (a == b) {
		t.Fatalf("case folding on %s: %q vs %q", runtime.GOOS, a, b)
	}
}
