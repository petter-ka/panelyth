package jobs

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"time"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/pathkey"
	"panelyth/sidecar/internal/rename"
)

func masks(name, ext string) *rename.Spec {
	return &rename.Spec{NameMask: name, ExtMask: ext, Start: 1, Step: 1, Digits: 1}
}

// diskNames lists a folder as the file system spells its names.
func diskNames(t testing.TB, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

func TestMultiRenameAndUndo(t *testing.T) {
	e := newEnv(t)
	shot := time.Date(2024, 3, 9, 7, 5, 2, 0, time.Local)
	for _, n := range []string{"IMG_0001.JPG", "IMG_0002.JPG", "notes.txt"} {
		write(t, filepath.Join(e.root, n), 1)
		if err := os.Chtimes(filepath.Join(e.root, n), shot, shot); err != nil {
			t.Fatal(err)
		}
	}
	write(t, filepath.Join(e.root, "Album.2024", "inside.jpg"), 1)
	root := e.index(e.root)
	if info := e.m.UndoInfo(); info.Count != 0 {
		t.Fatalf("a journal before any rename: %+v", info)
	}
	if _, err := e.m.Start(Spec{Kind: KindUndoRename}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("undo with nothing to undo: %v", err)
	}
	ids := e.allIDs(root, "IMG_0001.JPG", "IMG_0002.JPG", "notes.txt", "Album.2024")
	spec := masks("[Y]-[M]-[D] [N5-] [C10+5:3]", "[E]")
	spec.Search, spec.Replace, spec.Regex = `\.jpg$`, ".jpeg", true
	spec.Case = rename.CaseLower
	s := e.run(Spec{Kind: KindMultiRename, IDs: ids, Rename: spec})
	if s.State != StateCompleted || s.Done != 4 || s.Failed != 0 || s.Skipped != 0 {
		t.Fatalf("multi-rename: %+v %v", s, e.errors(s.JobID))
	}
	// A folder has no extension, so its whole name is [N] and its date is the
	// folder's own.
	album := e.allNames(root)[0]
	want := []string{album, "2024-03-09 0001 010.jpeg", "2024-03-09 0002 015.jpeg", "2024-03-09 s 020.txt"}
	if got := e.allNames(root); !slices.Equal(got, want) || len(album) < 20 || album[len(album)-9:] != ".2024 025" {
		t.Fatalf("index after the rename: %v", got)
	}
	slices.Sort(want)
	if got := diskNames(t, e.root); !slices.Equal(got, want) {
		t.Fatalf("disk after the rename: %v, want %v", got, want)
	}
	// The ids kept their entries, and the folder's subtree moved with it.
	paths, _ := e.store.EntryPaths(ctx, ids)
	if len(paths) != 4 || filepath.Base(paths[0].Path) != "2024-03-09 0001 010.jpeg" {
		t.Fatalf("ids after the rename: %+v", paths)
	}
	if !exist(filepath.Join(e.root, album, "inside.jpg")) {
		t.Fatal("the folder's content did not follow")
	}
	if info := e.m.UndoInfo(); info.Count != 4 || info.Dir != e.root || info.FinishedMs == 0 {
		t.Fatalf("journal: %+v", info)
	}
	u := e.run(Spec{Kind: KindUndoRename})
	if u.State != StateCompleted || u.Total != 4 || u.Done != 4 || u.Failed != 0 {
		t.Fatalf("undo: %+v %v", u, e.errors(u.JobID))
	}
	if got := e.allNames(root); !slices.Equal(got, []string{"Album.2024", "IMG_0001.JPG", "IMG_0002.JPG", "notes.txt"}) {
		t.Fatalf("index after the undo: %v", got)
	}
	if got := diskNames(t, e.root); !slices.Equal(got, []string{"Album.2024", "IMG_0001.JPG", "IMG_0002.JPG", "notes.txt"}) {
		t.Fatalf("disk after the undo: %v", got)
	}
	if paths, _ := e.store.EntryPaths(ctx, ids); len(paths) != 4 || filepath.Base(paths[3].Path) != "Album.2024" {
		t.Fatalf("ids after the undo: %+v", paths)
	}
	// One level: the journal is used up.
	if info := e.m.UndoInfo(); info.Count != 0 {
		t.Fatalf("journal after the undo: %+v", info)
	}
	if _, err := e.m.Start(Spec{Kind: KindUndoRename}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a second undo: %v", err)
	}
}

func TestMultiRenameConflicts(t *testing.T) {
	e := newEnv(t)
	for _, n := range []string{"a.txt", "b.txt", "c.md", "keep.txt", "taken.md"} {
		write(t, filepath.Join(e.root, n), 1)
	}
	root := e.index(e.root)
	// a.txt and b.txt both become same.txt; c.md becomes same.md.
	s := e.run(Spec{Kind: KindMultiRename, IDs: e.allIDs(root, "a.txt", "b.txt", "c.md"), Rename: masks("same", "[E]")})
	errs := e.errors(s.JobID)
	if s.Done != 1 || s.Failed != 2 || errs[0].Code != fileops.CodeExists || errs[1].Code != fileops.CodeExists {
		t.Fatalf("duplicates: %+v %v", s, errs)
	}
	if got := e.allNames(root); !slices.Equal(got, []string{"a.txt", "b.txt", "keep.txt", "same.md", "taken.md"}) {
		t.Fatalf("after duplicates: %v", got)
	}
	// A name an entry outside the batch has, an unchanged name, an invalid one.
	spec := masks("[N]", "[E]")
	spec.Search, spec.Replace, spec.Regex = `^same\.md$|^(b)\.txt$`, "taken.md$1", true
	s = e.run(Spec{Kind: KindMultiRename, IDs: e.allIDs(root, "same.md", "a.txt"), Rename: spec})
	if errs = e.errors(s.JobID); s.Done != 0 || s.Failed != 1 || s.Skipped != 1 || errs[0].Name != "same.md" || errs[0].Code != fileops.CodeExists {
		t.Fatalf("existing name: %+v %v", s, errs)
	}
	bad := masks("[N]/x", "[E]")
	s = e.run(Spec{Kind: KindMultiRename, IDs: e.allIDs(root, "a.txt"), Rename: bad})
	if errs = e.errors(s.JobID); s.Failed != 1 || errs[0].Code != fileops.CodeInvalidName || errs[0].Message == "" {
		t.Fatalf("invalid name: %+v %v", s, errs)
	}
	// Nothing was renamed since the first job: its journal is still the one.
	if info := e.m.UndoInfo(); info.Count != 1 {
		t.Fatalf("journal after failed renames: %+v", info)
	}
	// Two entries exchanging names fail; the chain beside them works.
	swap := masks("[N]", "[E]")
	swap.Search, swap.Replace, swap.Regex = `^(.)(.)$`, "$2$1", true
	for _, n := range []string{"1", "2", "3", "pq", "qp"} {
		write(t, filepath.Join(e.root, n), 1)
	}
	root = e.index(e.root)
	s = e.run(Spec{Kind: KindMultiRename, IDs: e.allIDs(root, "pq", "qp"), Rename: swap})
	if errs = e.errors(s.JobID); s.Done != 0 || s.Failed != 2 || errs[0].Code != fileops.CodeExists || !exist(filepath.Join(e.root, "pq")) {
		t.Fatalf("swap: %+v %v", s, errs)
	}
	chain := masks("[C]", "")
	chain.Start = 2
	s = e.run(Spec{Kind: KindMultiRename, IDs: e.allIDs(root, "1", "2", "3"), Rename: chain})
	if s.Done != 3 || s.Failed != 0 || !exist(filepath.Join(e.root, "4")) || exist(filepath.Join(e.root, "1")) {
		t.Fatalf("chain: %+v %v", s, e.errors(s.JobID))
	}
	// The viewer's rename keeps no journal: the chain's is still there.
	v := e.run(Spec{Kind: KindRename, IDs: e.allIDs(root, "keep.txt"), Pattern: "kept {n}", Start: 1})
	if v.Done != 1 || e.m.UndoInfo().Count != 3 {
		t.Fatalf("viewer rename: %+v, journal %+v", v, e.m.UndoInfo())
	}
	// Validation: masks, the search expression, too many entries.
	for _, r := range []*rename.Spec{nil, masks("[Q]", "[E]"), {NameMask: "[N]", ExtMask: "[E]", Step: 1, Digits: 1, Search: "(", Regex: true}} {
		if _, err := e.m.Start(Spec{Kind: KindMultiRename, IDs: e.allIDs(root, "a.txt"), Rename: r}); !errors.Is(err, ErrInvalid) {
			t.Errorf("spec %+v: %v", r, err)
		}
	}
	if _, err := e.m.Start(Spec{Kind: KindMultiRename, IDs: make([]int64, MaxMultiRename+1), Rename: masks("[N]", "[E]")}); !errors.Is(err, ErrInvalid) {
		t.Errorf("too many entries: %v", err)
	}
}

// An undo after a rename that failed in part takes back what was renamed,
// and leaves alone what is no longer there or whose old name is taken again.
func TestUndoAfterPartialFailure(t *testing.T) {
	e := newEnv(t)
	for _, n := range []string{"a.txt", "b.txt", "c.txt", "d.txt", "gone.txt"} {
		write(t, filepath.Join(e.root, n), 1)
	}
	root := e.index(e.root)
	ids := e.allIDs(root, "a.txt", "b.txt", "c.txt", "d.txt", "gone.txt")
	// The index still lists it; the rename finds it gone.
	if err := os.Remove(filepath.Join(e.root, "gone.txt")); err != nil {
		t.Fatal(err)
	}
	s := e.run(Spec{Kind: KindMultiRename, IDs: ids, Rename: masks("new-[N]", "[E]")})
	if errs := e.errors(s.JobID); s.Done != 4 || s.Failed != 1 || errs[0].Code != fileops.CodeNotFound {
		t.Fatalf("partial rename: %+v %v", s, errs)
	}
	if info := e.m.UndoInfo(); info.Count != 4 {
		t.Fatalf("journal: %+v", info)
	}
	// Since then: new-b.txt was deleted, and a.txt exists again.
	if err := os.Remove(filepath.Join(e.root, "new-b.txt")); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(e.root, "a.txt"), 2)
	u := e.run(Spec{Kind: KindUndoRename})
	errs := e.errors(u.JobID)
	if u.State != StateCompleted || u.Total != 4 || u.Done != 2 || u.Failed != 2 {
		t.Fatalf("undo: %+v %v", u, errs)
	}
	codes := map[string]string{}
	for _, er := range errs {
		codes[er.Name] = er.Code
	}
	if codes["new-b.txt"] != fileops.CodeNotFound || codes["new-a.txt"] != fileops.CodeExists {
		t.Fatalf("undo errors: %v", errs)
	}
	if got := diskNames(t, e.root); !slices.Equal(got, []string{"a.txt", "c.txt", "d.txt", "new-a.txt"}) {
		t.Fatalf("disk after the undo: %v", got)
	}
	if fi, _ := os.Stat(filepath.Join(e.root, "a.txt")); fi.Size() != 2 {
		t.Fatal("the undo replaced a file that took the old name")
	}
	// What the index knows followed.
	if paths, _ := e.store.EntryPaths(ctx, ids[2:4]); len(paths) != 2 || filepath.Base(paths[0].Path) != "c.txt" || filepath.Base(paths[1].Path) != "d.txt" {
		t.Fatalf("ids after the undo: %+v", paths)
	}
}

// A cancelled undo keeps what it did not reach for a later undo.
func TestUndoCancelKeepsTheRest(t *testing.T) {
	e := newEnv(t)
	const n = 400
	names := make([]string, n)
	for i := range names {
		names[i] = "f" + itoa(i) + ".txt"
		write(t, filepath.Join(e.root, names[i]), 0)
	}
	root := e.index(e.root)
	s := e.run(Spec{Kind: KindMultiRename, IDs: e.allIDs(root, names...), Rename: masks("x[N]", "[E]")})
	if s.Done != n {
		t.Fatalf("rename: %+v", s)
	}
	u, err := e.m.Start(Spec{Kind: KindUndoRename})
	if err != nil {
		t.Fatal(err)
	}
	// While it runs nothing else can take the journal.
	if info := e.m.UndoInfo(); info.Count != 0 {
		t.Fatalf("journal during an undo: %+v", info)
	}
	e.m.Pause(u.JobID)
	e.m.Cancel(u.JobID)
	final := e.wait(u.JobID)
	rest := e.m.UndoInfo().Count
	if final.Done+rest != n || final.Failed != 0 {
		t.Fatalf("undone %d + kept %d of %d (%+v)", final.Done, rest, n, final)
	}
	back := 0
	for _, name := range names {
		if exist(filepath.Join(e.root, name)) {
			back++
		}
	}
	if back != final.Done {
		t.Fatalf("%d names are back, the job says %d", back, final.Done)
	}
	if rest > 0 {
		again := e.run(Spec{Kind: KindUndoRename})
		if again.Done != rest || again.Failed != 0 {
			t.Fatalf("second undo: %+v", again)
		}
	}
	if got := diskNames(t, e.root); len(got) != n || got[0] != "f0000.txt" {
		t.Fatalf("after both undos: %d names, first %q", len(got), got[0])
	}
}

func TestUndoJournal(t *testing.T) {
	var u undoJournal
	u.set(nil)
	if steps, _ := u.take(); steps != nil {
		t.Fatal("an empty rename made a journal")
	}
	first := []RenameStep{{Dir: "d", Old: "a", New: "b"}}
	u.set(first)
	steps, gen := u.take()
	if len(steps) != 1 || u.steps != nil {
		t.Fatal("take left the journal")
	}
	// A newer rename wins over the rest of an older undo.
	u.set([]RenameStep{{Dir: "d", Old: "x", New: "y"}, {Dir: "d", Old: "p", New: "q"}})
	u.restore(steps, gen)
	if len(u.steps) != 2 {
		t.Fatalf("an old undo replaced a newer journal: %+v", u.steps)
	}
	steps, gen = u.take()
	u.restore(steps[:1], gen)
	if len(u.steps) != 1 || u.steps[0].Old != "x" {
		t.Fatalf("restore: %+v", u.steps)
	}
}

// Only the case changes: on a volume that ignores case this is a rename of
// the entry onto itself.
func TestMultiRenameCaseOnly(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "photo.jpg"), 1)
	write(t, filepath.Join(e.root, "Other.Jpg"), 1)
	root := e.index(e.root)
	spec := masks("[N]", "[E]")
	spec.Case = rename.CaseUpper
	s := e.run(Spec{Kind: KindMultiRename, IDs: e.allIDs(root, "Other.Jpg", "photo.jpg"), Rename: spec})
	if s.Done != 2 || s.Failed != 0 {
		t.Fatalf("case rename: %+v %v", s, e.errors(s.JobID))
	}
	if got := diskNames(t, e.root); !slices.Equal(got, []string{"OTHER.JPG", "PHOTO.JPG"}) {
		t.Fatalf("disk: %v", got)
	}
	if got := e.allNames(root); !slices.Equal(got, []string{"OTHER.JPG", "PHOTO.JPG"}) {
		t.Fatalf("index: %v", got)
	}
	u := e.run(Spec{Kind: KindUndoRename})
	if got := diskNames(t, e.root); u.Done != 2 || !slices.Equal(got, []string{"Other.Jpg", "photo.jpg"}) {
		t.Fatalf("undo: %+v %v", u, got)
	}
	if runtime.GOOS == "linux" {
		// Where case matters, the other spelling can be another entry's name.
		write(t, filepath.Join(e.root, "PHOTO.JPG"), 2)
		root = e.index(e.root)
		s = e.run(Spec{Kind: KindMultiRename, IDs: e.allIDs(root, "photo.jpg"), Rename: spec})
		if errs := e.errors(s.JobID); s.Failed != 1 || errs[0].Code != fileops.CodeExists {
			t.Fatalf("case rename onto another entry: %+v %v", s, errs)
		}
	}
}

// Ratings follow a multi-rename and its undo (one library.db transaction
// per batch of renames).
func TestMultiRenameKeepsUserMetadata(t *testing.T) {
	e := newEnv(t)
	for _, n := range []string{"a.jpg", "b.jpg", "c.jpg"} {
		write(t, filepath.Join(e.root, n), 1)
	}
	root := e.index(e.root)
	key := func(name string) string { return pathkey.ChildKey(root.Key, name, false) }
	if err := e.lib.SetRating(ctx, []string{key("a.jpg")}, 5, nil); err != nil {
		t.Fatal(err)
	}
	if err := e.lib.SetRating(ctx, []string{key("b.jpg")}, 2, nil); err != nil {
		t.Fatal(err)
	}
	// a.jpg becomes x.jpg and b.jpg becomes bx.jpg, in one batch.
	both := masks("[N]", "[E]")
	both.Search, both.Replace, both.Regex = `^a\.jpg$|^(b)\.jpg$`, "${1}x.jpg", true
	s := e.run(Spec{Kind: KindMultiRename, IDs: e.allIDs(root, "a.jpg", "b.jpg"), Rename: both})
	if s.Done != 2 || s.Failed != 0 {
		t.Fatalf("rename: %+v %v", s, e.errors(s.JobID))
	}
	ann, _ := e.lib.Annotations(ctx, []string{key("a.jpg"), key("b.jpg"), key("x.jpg"), key("bx.jpg")}, false)
	if len(ann) != 2 || ann[key("x.jpg")].Rating != 5 || ann[key("bx.jpg")].Rating != 2 {
		t.Fatalf("metadata after the rename: %+v", ann)
	}
	if u := e.run(Spec{Kind: KindUndoRename}); u.Done != 2 {
		t.Fatalf("undo: %+v %v", u, e.errors(u.JobID))
	}
	ann, _ = e.lib.Annotations(ctx, []string{key("a.jpg"), key("b.jpg"), key("x.jpg"), key("bx.jpg")}, false)
	if len(ann) != 2 || ann[key("a.jpg")].Rating != 5 || ann[key("b.jpg")].Rating != 2 {
		t.Fatalf("metadata after the undo: %+v", ann)
	}
}
