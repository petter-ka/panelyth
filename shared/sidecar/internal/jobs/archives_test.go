package jobs

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"panelyth/sidecar/internal/archive"
	"panelyth/sidecar/internal/index"
)

func makeZip(t *testing.T, path string, files map[string]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	z := zip.NewWriter(f)
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	slices.Sort(names)
	for _, n := range names {
		w, err := z.Create(n)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(w, files[n])
	}
	_ = z.Close()
	_ = f.Close()
}

// allIDs returns the ids of names inside dir in the all scope (archives are
// not media).
func (e *env) allIDs(dir index.DirInfo, names ...string) []int64 {
	e.t.Helper()
	all, err := e.store.QueryIDs(ctx, index.Descriptor{DirID: dir.ID, Scope: index.ScopeAll, ShowHidden: true}, dir.Key)
	if err != nil {
		e.t.Fatal(err)
	}
	items, _ := e.store.LoadItems(ctx, all)
	var out []int64
	for _, n := range names {
		for _, it := range items {
			if it.Name == n {
				out = append(out, it.ID)
			}
		}
	}
	if len(out) != len(names) {
		e.t.Fatalf("ids of %v: found %d", names, len(out))
	}
	return out
}

func (e *env) allNames(dir index.DirInfo) []string {
	e.t.Helper()
	all, _ := e.store.QueryIDs(ctx, index.Descriptor{DirID: dir.ID, Scope: index.ScopeAll, ShowHidden: true,
		Sort: []index.SortKey{{Field: index.SortName}}}, dir.Key)
	items, _ := e.store.LoadItems(ctx, all)
	out := []string{}
	for _, it := range items {
		out = append(out, it.Name)
	}
	return out
}

func TestUnpackPackAndTest(t *testing.T) {
	e := newEnv(t)
	makeZip(t, filepath.Join(e.root, "one.zip"), map[string]string{"a.txt": "a", "dir/b.txt": "bb"})
	makeZip(t, filepath.Join(e.root, "two.zip"), map[string]string{"c.txt": "ccc"})
	write(t, filepath.Join(e.root, "bad.zip"), 100) // not a zip
	out := filepath.Join(e.root, "out")
	_ = os.Mkdir(out, 0o755)
	root := e.index(e.root)
	outDir := e.index(out)

	// Unpack two archives, each into its own folder.
	s := e.run(Spec{Kind: KindExtract, IDs: e.allIDs(root, "one.zip", "two.zip"), Destination: out,
		Conflict: ConflictAsk, Archive: ArchiveSpec{Subfolders: true}})
	if s.State != StateCompleted || s.Done != 2 || s.Failed != 0 {
		t.Fatalf("unpack: %+v %v", s, e.errors(s.JobID))
	}
	if b, _ := os.ReadFile(filepath.Join(out, "one", "dir", "b.txt")); string(b) != "bb" {
		t.Error("one/dir/b.txt")
	}
	if got := e.allNames(outDir); !slices.Equal(got, []string{"one", "two"}) {
		t.Errorf("index rows %v", got)
	}

	// Unpack into the folder itself; existing files are skipped by policy.
	s = e.run(Spec{Kind: KindExtract, IDs: e.allIDs(root, "two.zip", "bad.zip"), Destination: out, Conflict: ConflictSkip})
	if s.Done != 1 || s.Failed != 1 {
		t.Errorf("unpack with a bad archive: %+v", s)
	}
	if errs := e.errors(s.JobID); len(errs) != 1 || errs[0].Name != "bad.zip" || errs[0].Code != archive.CodeCorrupt {
		t.Errorf("errors %v", errs)
	}
	if b, _ := os.ReadFile(filepath.Join(out, "c.txt")); string(b) != "ccc" {
		t.Error("c.txt")
	}
	s = e.run(Spec{Kind: KindExtract, IDs: e.allIDs(root, "two.zip"), Destination: out, Conflict: ConflictKeepBoth})
	if _, err := os.Stat(filepath.Join(out, "c (2).txt")); err != nil || s.State != StateCompleted {
		t.Errorf("keep both: %v %+v", err, s)
	}

	// Test: two good, one bad.
	s = e.run(Spec{Kind: KindTestArchive, IDs: e.allIDs(root, "one.zip", "two.zip", "bad.zip")})
	if s.Done != 2 || s.Failed != 1 {
		t.Errorf("test: %+v", s)
	}

	// Pack a folder and a file into tar.gz, deleting the originals.
	write(t, filepath.Join(e.root, "pack", "x.txt"), 10)
	write(t, filepath.Join(e.root, "loose.txt"), 5)
	root = e.index(e.root)
	s = e.run(Spec{Kind: KindPack, IDs: e.allIDs(root, "pack", "loose.txt"), Destination: out, Conflict: ConflictAsk,
		Archive: ArchiveSpec{Name: "packed.tar.gz", Format: archive.FormatTgz, Level: 6, DeleteOriginals: true}})
	if s.State != StateCompleted || s.Done != 2 || s.BytesDone != 15 {
		t.Fatalf("pack: %+v %v", s, e.errors(s.JobID))
	}
	if _, err := os.Stat(filepath.Join(e.root, "pack")); err == nil {
		t.Error("the packed folder was not deleted")
	}
	l, err := archive.Read(ctx, filepath.Join(out, "packed.tar.gz"), archive.FormatTgz, nil)
	if err != nil || l.Find("pack/x.txt") < 0 || l.Find("loose.txt") < 0 {
		t.Fatalf("packed listing: %v", err)
	}
	if !slices.Contains(e.allNames(outDir), "packed.tar.gz") {
		t.Error("no index row for the new archive")
	}
	if slices.Contains(e.allNames(root), "loose.txt") {
		t.Error("the deleted original kept its row")
	}

	// Packing again under the same name keeps both.
	write(t, filepath.Join(e.root, "again.txt"), 1)
	root = e.index(e.root)
	s = e.run(Spec{Kind: KindPack, IDs: e.allIDs(root, "again.txt"), Destination: out, Conflict: ConflictKeepBoth,
		Archive: ArchiveSpec{Name: "packed.tar.gz", Format: archive.FormatZip, Level: 0}})
	if _, err := os.Stat(filepath.Join(out, "packed.tar (2).gz")); err != nil || s.State != StateCompleted {
		t.Errorf("keep both: %v %+v", err, s)
	}

	if _, err := e.m.Start(Spec{Kind: KindPack, IDs: []int64{1}, Destination: out, Conflict: ConflictAsk,
		Archive: ArchiveSpec{Name: "x.rar", Format: "rar"}}); err == nil {
		t.Error("rar can't be created")
	}
}

func TestCopyOutOfArchive(t *testing.T) {
	e := newEnv(t)
	src := filepath.Join(t.TempDir(), "a.zip")
	makeZip(t, src, map[string]string{"docs/a.txt": "a", "docs/sub/b.txt": "bb", "docs/c.txt": "c", "top.txt": "t"})
	out := filepath.Join(e.root, "out")
	_ = os.Mkdir(out, 0o755)
	outDir := e.index(out)
	write(t, filepath.Join(out, "a.txt"), 3)

	am := archive.NewManager(nil, filepath.Join(t.TempDir(), "tmp"), nil)
	defer am.Shutdown()
	a, err := am.OpenFile(ctx, 1, src, true)
	if err != nil {
		t.Fatal(err)
	}
	l := a.Listing
	ids := []int64{archive.EntryID(a.ID, l.Find("docs/a.txt")), archive.EntryID(a.ID, l.Find("docs/sub"))}
	sel, err := am.Select(ids)
	if err != nil {
		t.Fatal(err)
	}
	// "ask": the conflict about a.txt is answered with replace.
	s, err := e.m.Start(Spec{Kind: KindExtract, Destination: out, Conflict: ConflictAsk, Archive: ArchiveSpec{Selection: sel}})
	if err != nil {
		t.Fatal(err)
	}
	asking := e.waitFor(s.JobID, "asking", func(s Snapshot) bool { return s.State == StateAsking })
	if c := asking.Conflict; c == nil || c.Name != "a.txt" || c.Source.Size != 1 || c.Target.Size != 3 {
		t.Errorf("conflict %+v", asking.Conflict)
	}
	if err := e.m.Resolve(s.JobID, ConflictReplace, false); err != nil {
		t.Fatal(err)
	}
	s = e.wait(s.JobID)
	if s.State != StateCompleted || s.Total != 2 || s.Done != 2 || s.BytesTotal != 3 {
		t.Fatalf("copy out: %+v %v", s, e.errors(s.JobID))
	}
	if b, _ := os.ReadFile(filepath.Join(out, "a.txt")); string(b) != "a" {
		t.Error("a.txt was not replaced")
	}
	if b, _ := os.ReadFile(filepath.Join(out, "sub", "b.txt")); string(b) != "bb" {
		t.Error("sub/b.txt")
	}
	if _, err := os.Stat(filepath.Join(out, "c.txt")); err == nil {
		t.Error("an unselected entry was copied")
	}
	if got := e.allNames(outDir); !slices.Equal(got, []string{"sub", "a.txt"}) {
		t.Errorf("index rows %v", got)
	}

	// The archive changed on disk: the job refuses.
	makeZip(t, src, map[string]string{"other.txt": "o"})
	s = e.run(Spec{Kind: KindExtract, Destination: out, Conflict: ConflictSkip, Archive: ArchiveSpec{Selection: sel}})
	if s.State != StateFailed {
		t.Errorf("changed archive: %+v", s)
	}
}
