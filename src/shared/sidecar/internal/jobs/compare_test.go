package jobs

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"panelyth/sidecar/internal/archive"
	"panelyth/sidecar/internal/checksum"
	"panelyth/sidecar/internal/compare"
	"panelyth/sidecar/internal/fileops"
)

var syncT0 = time.Date(2024, 3, 9, 12, 0, 0, 0, time.UTC)

// put writes a file with a date (seconds after syncT0).
func put(t testing.TB, root, rel, data string, sec int) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	at := syncT0.Add(time.Duration(sec) * time.Second)
	if err := os.Chtimes(p, at, at); err != nil {
		t.Fatal(err)
	}
}

func read(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return "<" + fileops.Code(err) + ">"
	}
	return string(b)
}

// syncPair builds two trees under the test's root with every difference.
func syncPair(e *env) (left, right string) {
	t := e.t
	left, right = filepath.Join(e.root, "left"), filepath.Join(e.root, "right")
	for _, root := range []string{left, right} {
		put(t, root, "same.txt", "same", 0)
	}
	put(t, left, "newer-left.txt", "left!!", 100)
	put(t, right, "newer-left.txt", "old", 0)
	put(t, left, "newer-right.txt", "old", 0)
	put(t, right, "newer-right.txt", "right!", 100)
	put(t, left, "size.txt", "12345", 0)
	put(t, right, "size.txt", "123456789", 0)
	put(t, left, "only-left.txt", "l", 0)
	put(t, left, "new-folder/inner/b.txt", "bb", 0)
	if err := os.MkdirAll(filepath.Join(left, "new-folder", "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	put(t, right, "only-right.txt", "r", 0)
	put(t, right, "sub/old/gone.txt", "gone", 0)
	put(t, left, "sub/keep.txt", "k", 0)
	put(t, right, "sub/keep.txt", "k", 0)
	return left, right
}

// planOf compares two trees and returns the plan of the shown rows.
func planOf(t testing.TB, spec compare.Spec, change func(*compare.Result)) *compare.Plan {
	t.Helper()
	cm := compare.NewManager(compare.Deps{})
	t.Cleanup(cm.Shutdown)
	res, err := cm.Start(spec, nil)
	if err != nil {
		t.Fatal(err)
	}
	cm.Wait(res.ID())
	if change != nil {
		change(res)
	}
	plan, err := res.Plan(res.Summary().Version)
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

// remaining compares again and returns how many rows still call for action
// or differ.
func remaining(t testing.TB, spec compare.Spec) compare.Summary {
	t.Helper()
	cm := compare.NewManager(compare.Deps{})
	t.Cleanup(cm.Shutdown)
	res, _ := cm.Start(spec, nil)
	cm.Wait(res.ID())
	return res.Summary()
}

func TestSyncBothWays(t *testing.T) {
	e := newEnv(t)
	left, right := syncPair(e)
	leftDir, rightDir := e.index(left), e.index(right)
	spec := compare.Spec{Left: left, Right: right}
	plan := planOf(t, spec, nil)

	s := e.run(Spec{Kind: KindSync, Sync: &SyncSpec{Plan: plan}, Destination: right})
	if s.State != StateCompleted || s.Failed != 0 || s.Done != len(plan.Items) || s.Total != len(plan.Items) || s.BytesDone != s.BytesTotal {
		t.Fatalf("sync: %+v %v", s, e.errors(s.JobID))
	}
	for path, want := range map[string]string{
		filepath.Join(right, "newer-left.txt"):               "left!!",
		filepath.Join(left, "newer-right.txt"):               "right!",
		filepath.Join(right, "only-left.txt"):                "l",
		filepath.Join(left, "only-right.txt"):                "r",
		filepath.Join(right, "new-folder", "inner", "b.txt"): "bb",
		filepath.Join(left, "sub", "old", "gone.txt"):        "gone",
		// The same date and another size has no direction: left alone.
		filepath.Join(left, "size.txt"):  "12345",
		filepath.Join(right, "size.txt"): "123456789",
	} {
		if got := read(path); got != want {
			t.Errorf("%s = %q, want %q", path, got, want)
		}
	}
	if fi, err := os.Stat(filepath.Join(right, "new-folder", "empty")); err != nil || !fi.IsDir() {
		t.Error("the empty folder was not created")
	}
	// Dates travel with the copies, so the trees now compare as equal.
	if fi, _ := os.Stat(filepath.Join(right, "newer-left.txt")); !fi.ModTime().Equal(syncT0.Add(100 * time.Second)) {
		t.Errorf("date of the copy: %s", fi.ModTime())
	}
	after := remaining(t, spec)
	if c := after.Counts; c.CopyRight != 0 || c.CopyLeft != 0 || c.Delete != 0 || c.Different != 1 {
		t.Errorf("after the sync: %+v", c)
	}
	// New entries are in the index at once.
	if got := e.allNames(rightDir); !slices.Contains(got, "only-left.txt") || !slices.Contains(got, "new-folder") {
		t.Errorf("right rows %v", got)
	}
	if got := e.allNames(leftDir); !slices.Contains(got, "only-right.txt") {
		t.Errorf("left rows %v", got)
	}
	e.mu.Lock()
	if !e.changed[leftDir.ID] || !e.changed[rightDir.ID] {
		t.Error("the listings were not told")
	}
	e.mu.Unlock()
}

func TestSyncMirror(t *testing.T) {
	e := newEnv(t)
	left, right := syncPair(e)
	rightDir := e.index(right)
	spec := compare.Spec{Left: left, Right: right, Asymmetric: true}
	plan := planOf(t, spec, nil)

	var trashed []string
	trashMany = func(paths []string) []error {
		trashed = append(trashed, paths...)
		errs := make([]error, len(paths))
		for i, p := range paths {
			errs[i] = os.Remove(p)
		}
		return errs
	}
	t.Cleanup(func() { trashMany = fileops.TrashMany })

	s := e.run(Spec{Kind: KindSync, Sync: &SyncSpec{Plan: plan}, Destination: right})
	if s.State != StateCompleted || s.Failed != 0 || s.Done != len(plan.Items) {
		t.Fatalf("mirror: %+v %v", s, e.errors(s.JobID))
	}
	// The right side is the left side: its own files went to the trash, the
	// folder that held them is gone, the newer file was replaced.
	for _, gone := range []string{"only-right.txt", "sub/old/gone.txt", "sub/old"} {
		if _, err := os.Lstat(filepath.Join(right, filepath.FromSlash(gone))); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s is still there", gone)
		}
	}
	if len(trashed) != 2 {
		t.Errorf("trashed %v", trashed)
	}
	if got := read(filepath.Join(right, "newer-right.txt")); got != "old" {
		t.Errorf("newer-right.txt = %q", got)
	}
	if got := read(filepath.Join(right, "size.txt")); got != "12345" {
		t.Errorf("size.txt = %q", got)
	}
	// The left side was not touched.
	if _, err := os.Lstat(filepath.Join(left, "only-right.txt")); err == nil {
		t.Error("a mirror wrote to the left side")
	}
	after := remaining(t, spec)
	if c := after.Counts; c.CopyRight+c.CopyLeft+c.Delete+c.Different != 0 {
		t.Errorf("after the mirror: %+v", c)
	}
	if got := e.allNames(rightDir); slices.Contains(got, "only-right.txt") {
		t.Errorf("right rows %v", got)
	}
}

// Nothing is overwritten or deleted that is not as the table showed it.
func TestSyncLeavesChangedEntriesAlone(t *testing.T) {
	e := newEnv(t)
	left, right := syncPair(e)
	plan := planOf(t, compare.Spec{Left: left, Right: right, Asymmetric: true}, nil)

	// After the compare: a target is edited, a source is edited, the file to
	// delete gets a counterpart on the left, and the folder to remove a new file.
	put(t, right, "newer-left.txt", "edited on the right meanwhile", 900)
	put(t, left, "only-left.txt", "edited on the left meanwhile", 900)
	put(t, left, "only-right.txt", "now on both sides", 900)
	put(t, right, "sub/old/new.txt", "new", 900)

	s := e.run(Spec{Kind: KindSync, Sync: &SyncSpec{Plan: plan, Permanent: true}, Destination: right})
	if s.State != StateCompleted || s.Failed != 4 {
		t.Fatalf("sync: %+v %v", s, e.errors(s.JobID))
	}
	codes := map[string]string{}
	for _, err := range e.errors(s.JobID) {
		codes[filepath.ToSlash(err.Name)] = err.Code
	}
	for _, name := range []string{"newer-left.txt", "only-left.txt", "only-right.txt", "sub/old"} {
		if codes[name] != CodeChanged {
			t.Errorf("%s: %q (%v)", name, codes[name], codes)
		}
	}
	if got := read(filepath.Join(right, "newer-left.txt")); got != "edited on the right meanwhile" {
		t.Errorf("an edited target was overwritten: %q", got)
	}
	if _, err := os.Lstat(filepath.Join(right, "only-left.txt")); err == nil {
		t.Error("an edited source was copied")
	}
	if got := read(filepath.Join(right, "only-right.txt")); got != "r" {
		t.Errorf("a file that got a counterpart was deleted: %q", got)
	}
	// The folder kept its new file; the file the table showed is gone.
	if got := read(filepath.Join(right, "sub", "old", "new.txt")); got != "new" {
		t.Errorf("a new file was deleted with its folder: %q", got)
	}
	if _, err := os.Lstat(filepath.Join(right, "sub", "old", "gone.txt")); err == nil {
		t.Error("gone.txt was kept")
	}
}

func TestSyncOnlyShownRows(t *testing.T) {
	e := newEnv(t)
	left, right := syncPair(e)
	// Deletes hidden by the filter are not applied.
	plan := planOf(t, compare.Spec{Left: left, Right: right, Asymmetric: true}, func(r *compare.Result) {
		r.SetShow(compare.ShowCopyRight)
	})
	s := e.run(Spec{Kind: KindSync, Sync: &SyncSpec{Plan: plan, Permanent: true}, Destination: right})
	if s.State != StateCompleted || s.Failed != 0 {
		t.Fatalf("sync: %+v", s)
	}
	if got := read(filepath.Join(right, "only-right.txt")); got != "r" {
		t.Errorf("a hidden delete was applied: %q", got)
	}
	if got := read(filepath.Join(right, "only-left.txt")); got != "l" {
		t.Errorf("a shown copy was not applied: %q", got)
	}
}

func TestSyncWithoutTrash(t *testing.T) {
	e := newEnv(t)
	left, right := syncPair(e)
	plan := planOf(t, compare.Spec{Left: left, Right: right, Asymmetric: true}, nil)
	trashMany = func(paths []string) []error {
		errs := make([]error, len(paths))
		for i := range paths {
			errs[i] = fileops.Errorf(fileops.CodeTrashUnavailable, "this drive has no trash")
		}
		return errs
	}
	t.Cleanup(func() { trashMany = fileops.TrashMany })
	s := e.run(Spec{Kind: KindSync, Sync: &SyncSpec{Plan: plan}, Destination: right})
	errs := e.errors(s.JobID)
	// The two files stay, and so does the folder that still holds one.
	if s.Failed != 3 || errs[0].Code != fileops.CodeTrashUnavailable || !strings.Contains(errs[0].Message, "permanently") {
		t.Errorf("sync: %+v %v", s, errs)
	}
	if got := read(filepath.Join(right, "only-right.txt")); got != "r" {
		t.Errorf("deleted without a trash: %q", got)
	}
}

func TestSyncMissingRoot(t *testing.T) {
	e := newEnv(t)
	left, right := syncPair(e)
	plan := planOf(t, compare.Spec{Left: left, Right: right}, nil)
	if err := os.RemoveAll(right); err != nil {
		t.Fatal(err)
	}
	s := e.run(Spec{Kind: KindSync, Sync: &SyncSpec{Plan: plan}, Destination: right})
	if s.State != StateFailed || s.Error == "" {
		t.Errorf("sync into a missing folder: %+v", s)
	}
}

func TestCompareJobsAreValidated(t *testing.T) {
	e := newEnv(t)
	for name, spec := range map[string]Spec{
		"a sync without a plan":   {Kind: KindSync},
		"an unknown algorithm":    {Kind: KindHashCreate, Hash: HashSpec{Algo: "sha512", PerFile: true}},
		"a list without a folder": {Kind: KindHashCreate, Hash: HashSpec{Algo: checksum.MD5, Name: "a.md5"}},
		"a list without a name":   {Kind: KindHashCreate, Destination: e.root, Hash: HashSpec{Algo: checksum.MD5}},
		"a list with a path":      {Kind: KindHashCreate, Destination: e.root, Hash: HashSpec{Algo: checksum.MD5, Name: "a/b.md5"}},
		"one file compared":       {Kind: KindCompareFiles, IDs: []int64{1}},
		"three files compared":    {Kind: KindCompareFiles, IDs: []int64{1, 2, 3}},
	} {
		if _, err := e.m.Start(spec); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestChecksumsCreateAndVerify(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "a.txt"), 3)
	write(t, filepath.Join(e.root, "b.bin"), 2*checksum.BufferSize+5)
	write(t, filepath.Join(e.root, "docs", "c.txt"), 7)
	write(t, filepath.Join(e.root, "docs", "deep", "d.txt"), 0)
	root := e.index(e.root)
	xxx := "cd2eb0837c9b4c962c22d2ff8b5441b7b45805887f051d39bf133b583baf6860" // sha256("xxx")

	// One checksum file beside each file, folders walked.
	s := e.run(Spec{Kind: KindHashCreate, IDs: e.allIDs(root, "a.txt", "docs"), Hash: HashSpec{Algo: checksum.SHA256, PerFile: true}})
	if s.State != StateCompleted || s.Done != 3 || s.Failed != 0 || s.Total != 3 || s.BytesDone != 10 {
		t.Fatalf("per file: %+v %v", s, e.errors(s.JobID))
	}
	if got := read(filepath.Join(e.root, "a.txt.sha256")); got != xxx+" *a.txt\n" {
		t.Errorf("a.txt.sha256 = %q", got)
	}
	if got := read(filepath.Join(e.root, "docs", "deep", "d.txt.sha256")); !strings.HasSuffix(got, " *d.txt\n") {
		t.Errorf("d.txt.sha256 = %q", got)
	}
	if got := e.allNames(root); !slices.Contains(got, "a.txt.sha256") {
		t.Errorf("index rows %v", got)
	}
	// Again: the checksum files themselves are skipped, not hashed.
	root = e.index(e.root)
	s = e.run(Spec{Kind: KindHashCreate, IDs: e.allIDs(root, "a.txt", "a.txt.sha256"), Hash: HashSpec{Algo: checksum.SHA256, PerFile: true}})
	if s.Done != 1 || s.Skipped != 1 {
		t.Errorf("again: %+v", s)
	}
	if _, err := os.Lstat(filepath.Join(e.root, "a.txt.sha256.sha256")); err == nil {
		t.Error("a checksum of a checksum file")
	}

	// One list for everything, paths relative to its folder.
	for algo, name := range map[checksum.Algo]string{checksum.MD5: "all.md5", checksum.CRC32: "all.sfv", checksum.SHA1: "all.sha1"} {
		s = e.run(Spec{Kind: KindHashCreate, IDs: e.allIDs(root, "a.txt", "b.bin", "docs"), Destination: e.root,
			Hash: HashSpec{Algo: algo, Name: name}})
		if s.State != StateCompleted || s.Failed != 0 {
			t.Fatalf("%s: %+v %v", name, s, e.errors(s.JobID))
		}
		f, err := os.Open(filepath.Join(e.root, name))
		if err != nil {
			t.Fatal(err)
		}
		entries, err := checksum.Parse(f, algo)
		_ = f.Close()
		var paths []string
		for _, en := range entries {
			paths = append(paths, en.Path)
		}
		slices.Sort(paths)
		// The per-file .sha256 files in docs are files like any other here.
		want := []string{"a.txt", "b.bin", "docs/c.txt", "docs/c.txt.sha256", "docs/deep/d.txt", "docs/deep/d.txt.sha256"}
		if err != nil || !slices.Equal(paths, want) {
			t.Errorf("%s lists %v, %v", name, paths, err)
		}
	}
	if got := read(filepath.Join(e.root, "all.sfv")); !strings.HasPrefix(got, "; ") || !strings.Contains(got, "\ndocs/deep/d.txt 00000000\n") {
		t.Errorf("all.sfv = %q", got)
	}

	// Verify: everything matches.
	root = e.index(e.root)
	s = e.run(Spec{Kind: KindHashVerify, IDs: e.allIDs(root, "all.md5", "all.sfv", "a.txt.sha256")})
	if s.State != StateCompleted || s.Done != 13 || s.Failed != 0 || s.Total != 13 {
		t.Fatalf("verify: %+v %v", s, e.errors(s.JobID))
	}

	// A changed file, a missing file, an entry that leaves the folder, a
	// damaged list and a file that is no list.
	write(t, filepath.Join(e.root, "docs", "c.txt"), 8)
	_ = os.Remove(filepath.Join(e.root, "b.bin"))
	md5OfNothing := "d41d8cd98f00b204e9800998ecf8427e"
	if err := os.WriteFile(filepath.Join(e.root, "escape.md5"), []byte(md5OfNothing+" *../outside.txt\n"+md5OfNothing+" *docs/deep/d.txt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.root, "damaged.sha1"), []byte("not a list\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	root = e.index(e.root)
	s = e.run(Spec{Kind: KindHashVerify, IDs: e.allIDs(root, "all.md5", "escape.md5", "damaged.sha1", "a.txt")})
	if s.State != StateCompleted || s.Done != 5 || s.Failed != 5 || s.Total != 10 {
		t.Fatalf("verify with damage: %+v %v", s, e.errors(s.JobID))
	}
	codes := map[string]string{}
	for _, err := range e.errors(s.JobID) {
		codes[filepath.ToSlash(err.Name)] = err.Code
	}
	want := map[string]string{"docs/c.txt": CodeMismatch, "b.bin": fileops.CodeNotFound, "../outside.txt": archive.CodeUnsafePath,
		"damaged.sha1": archive.CodeCorrupt, "a.txt": archive.CodeCorrupt}
	for name, code := range want {
		if codes[name] != code {
			t.Errorf("%s: %q, want %q (%v)", name, codes[name], code, codes)
		}
	}

	// A list in a folder that is gone fails as a whole.
	s = e.run(Spec{Kind: KindHashCreate, IDs: e.allIDs(root, "a.txt"), Destination: filepath.Join(e.root, "missing"),
		Hash: HashSpec{Algo: checksum.MD5, Name: "x.md5"}})
	if s.State != StateFailed {
		t.Errorf("a list into a missing folder: %+v", s)
	}
	// A file outside the list's folder is not listed.
	s = e.run(Spec{Kind: KindHashCreate, IDs: e.allIDs(root, "a.txt"), Destination: filepath.Join(e.root, "docs"),
		Hash: HashSpec{Algo: checksum.MD5, Name: "x.md5"}})
	if s.Failed != 1 || s.Done != 0 {
		t.Errorf("a file outside the list's folder: %+v", s)
	}
	if _, err := os.Lstat(filepath.Join(e.root, "docs", "x.md5")); err == nil {
		t.Error("an empty list was written")
	}
}

func TestCompareFilesJob(t *testing.T) {
	e := newEnv(t)
	data := strings.Repeat("0123456789abcdef", 100_000)
	for name, text := range map[string]string{"a.bin": data, "same.bin": data, "other.bin": data[:900_000] + "X" + data[900_001:], "short.bin": data[:10]} {
		if err := os.WriteFile(filepath.Join(e.root, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.Mkdir(filepath.Join(e.root, "folder"), 0o755)
	root := e.index(e.root)

	s := e.run(Spec{Kind: KindCompareFiles, IDs: e.allIDs(root, "a.bin", "same.bin")})
	if s.State != StateCompleted || s.Done != 1 || s.Failed != 0 || s.Total != 1 || s.BytesDone != int64(len(data)) {
		t.Errorf("identical: %+v %v", s, e.errors(s.JobID))
	}
	s = e.run(Spec{Kind: KindCompareFiles, IDs: e.allIDs(root, "a.bin", "other.bin")})
	errs := e.errors(s.JobID)
	if s.Done != 0 || s.Failed != 1 || errs[0].Code != CodeDifferent || !strings.Contains(errs[0].Message, "byte 900000") {
		t.Errorf("different: %+v %v", s, errs)
	}
	s = e.run(Spec{Kind: KindCompareFiles, IDs: e.allIDs(root, "a.bin", "short.bin")})
	if errs = e.errors(s.JobID); s.Failed != 1 || errs[0].Code != CodeDifferent || !strings.Contains(errs[0].Message, "size") || s.BytesDone != 0 {
		t.Errorf("other size: %+v %v", s, errs)
	}
	s = e.run(Spec{Kind: KindCompareFiles, IDs: e.allIDs(root, "a.bin", "folder")})
	if s.Failed != 1 || s.Done != 0 {
		t.Errorf("a folder: %+v", s)
	}
	// One of them is gone.
	ids := e.allIDs(root, "a.bin", "same.bin")
	_ = os.Remove(filepath.Join(e.root, "same.bin"))
	s = e.run(Spec{Kind: KindCompareFiles, IDs: ids})
	if s.Failed != 1 || e.errors(s.JobID)[0].Code != fileops.CodeNotFound {
		t.Errorf("a missing file: %+v %v", s, e.errors(s.JobID))
	}
}
