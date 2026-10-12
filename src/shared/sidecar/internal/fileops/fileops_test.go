package fileops

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, bytes.Repeat([]byte{'x'}, size), 0o644); err != nil {
		t.Fatal(err)
	}
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func TestValidateName(t *testing.T) {
	for _, tc := range []struct {
		name    string
		windows bool
		ok      bool
	}{
		{"photo.jpg", true, true},
		{"Ünïcødé 写真.png", true, true},
		{"", false, false},
		{"   ", false, false},
		{".", false, false},
		{"..", false, false},
		{"a/b", false, false},
		{"a\x00b", false, false},
		{"tab\there", false, false},
		{strings.Repeat("a", 256), false, false},
		{`a\b`, true, false},
		{`a\b`, false, true}, // a valid (if odd) name on Unix
		{"what?.jpg", true, false},
		{"what?.jpg", false, true},
		{"trailing.", true, false},
		{"trailing ", true, false},
		{"CON", true, false},
		{"con.txt", true, false},
		{"COM1.jpg", true, false},
		{"CONSOLE.jpg", true, true},
		{"CON", false, true},
	} {
		err := validateName(tc.name, tc.windows)
		if (err == nil) != tc.ok {
			t.Errorf("validateName(%q, windows=%v) = %v, want ok=%v", tc.name, tc.windows, err, tc.ok)
		}
		if err != nil && !errors.Is(err, ErrInvalidName) {
			t.Errorf("%q: error does not wrap ErrInvalidName", tc.name)
		}
	}
}

func TestUniqueName(t *testing.T) {
	taken := map[string]bool{"a.jpg": true, "a (2).jpg": true, "dir": true, "b (2).jpg": true, "b.jpg": true}
	has := func(n string) bool { return taken[n] }
	for _, tc := range []struct {
		in    string
		isDir bool
		want  string
	}{
		{"new.jpg", false, "new.jpg"},
		{"a.jpg", false, "a (3).jpg"},
		{"b (2).jpg", false, "b (3).jpg"}, // continues the counter
		{"dir", true, "dir (2)"},
	} {
		got, ok := UniqueName(tc.in, tc.isDir, has)
		if !ok || got != tc.want {
			t.Errorf("UniqueName(%q) = %q, %v; want %q", tc.in, got, ok, tc.want)
		}
	}
	if _, ok := UniqueName("x.jpg", false, func(string) bool { return true }); ok {
		t.Error("UniqueName should give up when every candidate is taken")
	}
}

func TestSplitExtAndIsWithin(t *testing.T) {
	if s, e := SplitExt("a.b.jpg", false); s != "a.b" || e != ".jpg" {
		t.Errorf("SplitExt = %q %q", s, e)
	}
	if s, e := SplitExt(".hidden", false); s != ".hidden" || e != "" {
		t.Errorf("SplitExt(.hidden) = %q %q", s, e)
	}
	if _, e := SplitExt("folder.v2", true); e != "" {
		t.Error("folders have no extension")
	}
	root := filepath.Join(t.TempDir(), "A")
	if !IsWithin(filepath.Join(root, "b", "c"), root) || !IsWithin(root, root) {
		t.Error("IsWithin should accept descendants and the root itself")
	}
	if IsWithin(root+"B", root) {
		t.Error("a sibling with a common prefix is not inside")
	}
}

func TestCopyFilePreservesDataAndMtime(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "src.jpg"), filepath.Join(dir, "out", "dst.jpg")
	write(t, src, 9<<20) // > one cancellation chunk
	mtime := time.Date(2020, 5, 17, 10, 0, 0, 0, time.UTC)
	if err := os.Chtimes(src, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}
	var reported int64
	if err := CopyFile(context.Background(), src, dst, false, &CopyOptions{Progress: func(n int64) { reported += n }}); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(dst)
	if err != nil || fi.Size() != 9<<20 || !fi.ModTime().Equal(mtime) {
		t.Fatalf("copy: %v size=%d mtime=%v", err, fi.Size(), fi.ModTime())
	}
	if reported != 9<<20 {
		t.Errorf("progress reported %d bytes", reported)
	}
	if exists(PartialName(filepath.Dir(dst), "dst.jpg")) {
		t.Error("partial file left behind")
	}
	// An existing target is refused unless replace is set.
	err = CopyFile(context.Background(), src, dst, false, nil)
	if Code(err) != CodeExists {
		t.Errorf("copy onto existing = %v, want ALREADY_EXISTS", err)
	}
	if exists(PartialName(filepath.Dir(dst), "dst.jpg")) {
		t.Error("partial file left behind after a conflict")
	}
	write(t, dst, 3)
	if err := CopyFile(context.Background(), src, dst, true, nil); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(dst); fi.Size() != 9<<20 {
		t.Error("replace did not overwrite")
	}
}

func TestCopyFileCancelRemovesPartial(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "big.mp4"), filepath.Join(dir, "copy.mp4")
	write(t, src, 16<<20)
	ctx, cancel := context.WithCancel(context.Background())
	var seen int64
	err := CopyFile(ctx, src, dst, false, &CopyOptions{Progress: func(n int64) {
		seen += n
		if seen >= 2<<20 {
			cancel()
		}
	}})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if exists(dst) || exists(PartialName(dir, "copy.mp4")) {
		t.Error("cancelled copy left files behind")
	}
}

func TestCopyTreeSkipsLinksAndIsAtomic(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "album")
	write(t, filepath.Join(src, "a.jpg"), 10)
	write(t, filepath.Join(src, "sub", "b.jpg"), 20)
	link := filepath.Join(src, "link.jpg")
	hasLink := os.Symlink(filepath.Join(src, "a.jpg"), link) == nil // needs privileges on Windows
	var skipped []string
	dst := filepath.Join(dir, "copy")
	if err := CopyTree(context.Background(), src, dst, &CopyOptions{Skipped: func(p string) { skipped = append(skipped, p) }}); err != nil {
		t.Fatal(err)
	}
	if !exists(filepath.Join(dst, "sub", "b.jpg")) || !exists(filepath.Join(dst, "a.jpg")) {
		t.Error("tree not copied")
	}
	if hasLink && (exists(filepath.Join(dst, "link.jpg")) || len(skipped) != 1) {
		t.Errorf("link copied or not reported: %v", skipped)
	}
	if n, err := TreeSize(context.Background(), dst); err != nil || n != 30 {
		t.Errorf("TreeSize = %d, %v", n, err)
	}
	// A failure part-way leaves nothing under the final name.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := CopyTree(ctx, src, filepath.Join(dir, "never"), nil); err == nil {
		t.Fatal("cancelled tree copy succeeded")
	}
	if exists(filepath.Join(dir, "never")) || exists(PartialName(dir, "never")) {
		t.Error("cancelled tree copy left files behind")
	}
}

func TestMoveAndRename(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.jpg")
	write(t, src, 5)
	other := filepath.Join(dir, "b.jpg")
	write(t, other, 1)
	if err := Move(context.Background(), src, other, false, false, nil); Code(err) != CodeExists {
		t.Errorf("move onto existing = %v", err)
	}
	if err := Move(context.Background(), src, filepath.Join(dir, "sub-missing", "x.jpg"), false, false, nil); Code(err) != CodeNotFound {
		t.Errorf("move into missing folder = %v (%s)", err, Code(err))
	}
	dst := filepath.Join(dir, "moved.jpg")
	if err := Move(context.Background(), src, dst, false, false, nil); err != nil || exists(src) || !exists(dst) {
		t.Fatalf("move: %v", err)
	}
	if _, err := Rename(dst, "b.jpg"); Code(err) != CodeExists {
		t.Errorf("rename onto existing = %v", err)
	}
	if _, err := Rename(dst, "bad/name"); Code(err) != CodeInvalidName {
		t.Errorf("rename to invalid = %v", err)
	}
	got, err := Rename(dst, "Moved.jpg") // case-only change
	if err != nil || filepath.Base(got) != "Moved.jpg" {
		t.Fatalf("case rename: %v %q", err, got)
	}
	entries, _ := os.ReadDir(dir)
	found := false
	for _, e := range entries {
		found = found || e.Name() == "Moved.jpg"
	}
	if !found {
		t.Error("case-only rename not applied on disk")
	}
}

func TestDeleteAndPartials(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "tree", "x", "y.jpg"), 1)
	if err := Delete(filepath.Join(dir, "tree"), true); err != nil || exists(filepath.Join(dir, "tree")) {
		t.Fatalf("delete tree: %v", err)
	}
	if err := Delete(filepath.Join(dir, "gone.jpg"), false); Code(err) != CodeNotFound {
		t.Errorf("delete missing = %v", err)
	}
	write(t, PartialName(dir, "a.jpg"), 1)
	if err := os.Mkdir(PartialName(dir, "folder"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "keep.jpg"), 1)
	if n := RemovePartials(dir); n != 2 || !exists(filepath.Join(dir, "keep.jpg")) {
		t.Errorf("RemovePartials removed %d", n)
	}
}

func TestFreedesktopTrash(t *testing.T) {
	dir := t.TempDir()
	trash := filepath.Join(dir, "Trash")
	now := time.Date(2026, 10, 1, 12, 30, 0, 0, time.Local)
	for i := range 2 {
		item := filepath.Join(dir, "my photo.jpg")
		write(t, item, i+1)
		if err := trashInto(trash, item, "/home/u/my photo.jpg", now); err != nil {
			t.Fatal(err)
		}
		if exists(item) {
			t.Fatal("item still in place")
		}
	}
	if !exists(filepath.Join(trash, "files", "my photo.jpg")) || !exists(filepath.Join(trash, "files", "my photo.2.jpg")) {
		t.Error("trashed files missing or not uniquely named")
	}
	info, err := os.ReadFile(filepath.Join(trash, "info", "my photo.2.jpg.trashinfo"))
	if err != nil {
		t.Fatal(err)
	}
	want := "[Trash Info]\nPath=/home/u/my%20photo.jpg\nDeletionDate=2026-10-01T12:30:00\n"
	if string(info) != want {
		t.Errorf("trashinfo = %q", info)
	}
	// A failed rename releases the reserved info file.
	if err := trashInto(trash, filepath.Join(dir, "missing.jpg"), "/x", now); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("missing item: %v", err)
	}
	if exists(filepath.Join(trash, "info", "missing.jpg.trashinfo")) {
		t.Error("info file left behind")
	}
}

func TestTrashOnThisPlatform(t *testing.T) {
	if os.Getenv("PANELYTH_TEST_TRASH") != "1" {
		t.Skip("moves a file into the real OS trash; set PANELYTH_TEST_TRASH=1")
	}
	item := filepath.Join(t.TempDir(), "panelyth-trash-test.txt")
	write(t, item, 1)
	err := Trash(item)
	if Code(err) == CodeTrashUnavailable {
		t.Skipf("no trash for the temp folder on %s: %v", runtime.GOOS, err)
	}
	if err != nil || exists(item) {
		t.Fatalf("Trash: %v", err)
	}
}

func TestTrashManyOnThisPlatform(t *testing.T) {
	if os.Getenv("PANELYTH_TEST_TRASH") != "1" {
		t.Skip("moves files into the real OS trash; set PANELYTH_TEST_TRASH=1")
	}
	dir := t.TempDir()
	var paths []string
	for i := range 3 {
		p := filepath.Join(dir, "panelyth-trash-many-"+string(rune('a'+i))+".txt")
		write(t, p, 1)
		paths = append(paths, p)
	}
	paths = append(paths, filepath.Join(dir, "missing.txt"))
	errs := TrashMany(paths)
	if Code(errs[0]) == CodeTrashUnavailable {
		t.Skipf("no trash for the temp folder on %s", runtime.GOOS)
	}
	for i := range 3 {
		if errs[i] != nil || exists(paths[i]) {
			t.Errorf("%s: %v", paths[i], errs[i])
		}
	}
	if Code(errs[3]) != CodeNotFound {
		t.Errorf("missing item: %v", errs[3])
	}
}

// A case-only rename goes through a temporary name (Stage C09): where the
// volume ignores case the entry ends up under its new name and nothing else
// is left; where it tells case apart, the other name is another entry.
func TestRenameCaseOnly(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "photo.jpg")
	write(t, src, 3)
	names := func() []string {
		entries, _ := os.ReadDir(dir)
		out := []string{}
		for _, e := range entries {
			out = append(out, e.Name())
		}
		return out
	}
	if _, err := os.Lstat(filepath.Join(dir, "PHOTO.JPG")); err != nil {
		// Case matters here: a rename to another case is an ordinary rename,
		// and an existing entry of that name is in the way.
		if _, err := Rename(src, "PHOTO.JPG"); err != nil || !slices.Equal(names(), []string{"PHOTO.JPG"}) {
			t.Fatalf("rename on a case-sensitive volume: %v %v", err, names())
		}
		write(t, src, 3)
		if _, err := Rename(src, "PHOTO.JPG"); Code(err) != CodeExists {
			t.Fatalf("rename onto another entry = %v", err)
		}
		// A hard link of the same file under the other case stays an entry of its own.
		link := filepath.Join(dir, "Linked.txt")
		write(t, link, 1)
		if err := os.Link(link, filepath.Join(dir, "linked.txt")); err == nil {
			if _, err := Rename(link, "linked.txt"); Code(err) != CodeExists || !exists(link) {
				t.Fatalf("rename onto a hard link of the same file = %v", err)
			}
		}
		return
	}
	got, err := Rename(src, "Photo.JPG")
	if err != nil || filepath.Base(got) != "Photo.JPG" || !slices.Equal(names(), []string{"Photo.JPG"}) {
		t.Fatalf("case rename: %v %q %v", err, got, names())
	}
	// A folder with content too.
	sub := filepath.Join(dir, "album")
	write(t, filepath.Join(sub, "a.jpg"), 1)
	if _, err := Rename(sub, "Album"); err != nil || !slices.Contains(names(), "Album") || !exists(filepath.Join(dir, "Album", "a.jpg")) {
		t.Fatalf("folder case rename: %v %v", err, names())
	}
	// The second step fails: the entry gets its old name back.
	calls := 0
	renameItem = func(a, b string) error {
		if calls++; calls == 2 {
			return &os.PathError{Op: "rename", Path: b, Err: fs.ErrPermission}
		}
		return os.Rename(a, b)
	}
	t.Cleanup(func() { renameItem = os.Rename })
	if _, err := Rename(got, "PHOTO.jpg"); Code(err) != CodePermission {
		t.Fatalf("failed second step = %v", err)
	}
	if calls != 3 || !slices.Contains(names(), "Photo.JPG") || len(names()) != 2 {
		t.Fatalf("after a failed case rename: %d calls, %v", calls, names())
	}
}
