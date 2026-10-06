package jobs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"fastview/sidecar/internal/fileops"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/library"
	"fastview/sidecar/internal/pathkey"
	"fastview/sidecar/internal/scan"
)

var ctx = context.Background()

type env struct {
	t     testing.TB
	root  string
	store *index.Store
	lib   *library.Library
	m     *Manager

	mu      sync.Mutex
	snaps   []Snapshot
	changed map[int64]bool
}

func write(t testing.TB, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, bytes.Repeat([]byte{'x'}, size), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newEnv(t testing.TB) *env {
	t.Helper()
	e := &env{t: t, root: filepath.Join(t.TempDir(), "photos"), changed: map[int64]bool{}}
	if err := os.MkdirAll(e.root, 0o755); err != nil {
		t.Fatal(err)
	}
	store, err := index.Open(filepath.Join(t.TempDir(), "index.db"), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	lib, err := library.Open(filepath.Join(t.TempDir(), "library.db"))
	if err != nil {
		t.Fatal(err)
	}
	e.store, e.lib = store, lib
	e.m = e.manager()
	t.Cleanup(func() {
		e.m.Close()
		_ = lib.Close()
		_ = store.Close()
	})
	return e
}

func (e *env) manager() *Manager {
	return NewManager(Deps{
		Store:   e.store,
		Library: func(context.Context) (*library.Library, error) { return e.lib, nil },
		Changed: func(cs []scan.Change) {
			e.mu.Lock()
			for _, c := range cs {
				e.changed[c.DirID] = true
			}
			e.mu.Unlock()
		},
		Emit: func(s Snapshot) {
			e.mu.Lock()
			e.snaps = append(e.snaps, s)
			e.mu.Unlock()
		},
	})
}

// index lists dir (recursively) like opening it with "Include subfolders".
func (e *env) index(dir string) index.DirInfo {
	e.t.Helper()
	info, err := e.store.EnsureDir(ctx, dir)
	if err != nil {
		e.t.Fatal(err)
	}
	st := scan.Run(ctx, e.store, slog.New(slog.DiscardHandler), scan.Options{}, scan.Hooks{}, 0, e.store.NextGeneration(), info, true)
	if st.State != scan.StateCompleted {
		e.t.Fatalf("scan %s", st.State)
	}
	return info
}

// ids returns the index ids of names directly inside dir, in name order.
func (e *env) ids(dir index.DirInfo, names ...string) []int64 {
	e.t.Helper()
	all, err := e.store.QueryIDs(ctx, index.Descriptor{DirID: dir.ID, Sort: []index.SortKey{{Field: index.SortName}}}, dir.Key)
	if err != nil {
		e.t.Fatal(err)
	}
	items, err := e.store.LoadItems(ctx, all)
	if err != nil {
		e.t.Fatal(err)
	}
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

func (e *env) names(dir index.DirInfo) []string {
	e.t.Helper()
	all, err := e.store.QueryIDs(ctx, index.Descriptor{DirID: dir.ID, Sort: []index.SortKey{{Field: index.SortName}}}, dir.Key)
	if err != nil {
		e.t.Fatal(err)
	}
	items, _ := e.store.LoadItems(ctx, all)
	out := []string{}
	for _, it := range items {
		out = append(out, it.Name)
	}
	return out
}

// run starts a job and waits for its final snapshot.
func (e *env) run(spec Spec) Snapshot {
	e.t.Helper()
	s, err := e.m.Start(spec)
	if err != nil {
		e.t.Fatal(err)
	}
	return e.wait(s.JobID)
}

func (e *env) wait(id int64) Snapshot {
	e.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		for _, s := range e.m.List() {
			if s.JobID == id && !s.State.Active() {
				return s
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.t.Fatalf("job %d did not finish", id)
	return Snapshot{}
}

func (e *env) errors(id int64) []ItemError {
	errs, _, err := e.m.Errors(id, 0, 100)
	if err != nil {
		e.t.Fatal(err)
	}
	return errs
}

func exist(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func TestPattern(t *testing.T) {
	for _, tc := range []struct {
		pattern, name string
		isDir         bool
		n             int
		want          string
	}{
		{"Holiday {n:000}", "IMG_1.JPG", false, 7, "Holiday 007.JPG"},
		{"{name}-{n}", "a.b.png", false, 12, "a.b-12.png"},
		{"{n:00} {name}", "Album", true, 3, "03 Album"},
		{"x{n:0}", "a.jpg", false, 1234, "x1234.jpg"},
	} {
		p, err := ParsePattern(tc.pattern)
		if err != nil {
			t.Fatalf("%q: %v", tc.pattern, err)
		}
		if got := p.Apply(tc.name, tc.isDir, tc.n); got != tc.want {
			t.Errorf("%q on %q = %q, want %q", tc.pattern, tc.name, got, tc.want)
		}
	}
	for _, bad := range []string{"", "plain", "{ext}", "{n", "{n:0a}", "{n:}"} {
		if _, err := ParsePattern(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestCopyIntoIndexedFolderAndDuplicateInPlace(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "a.jpg"), 1000)
	write(t, filepath.Join(e.root, "album", "b.jpg"), 2000)
	write(t, filepath.Join(e.root, "album", "deep", "c.png"), 3000)
	dest := filepath.Join(e.root, "dest")
	if err := os.Mkdir(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	root := e.index(e.root)
	destDir, err := e.store.DirByPath(ctx, dest)
	if err != nil {
		t.Fatal(err)
	}
	s := e.run(Spec{Kind: KindCopy, IDs: e.ids(root, "a.jpg", "album"), Destination: dest, Conflict: ConflictKeepBoth})
	if s.State != StateCompleted || s.Done != 2 || s.Failed != 0 {
		t.Fatalf("copy: %+v %v", s, e.errors(s.JobID))
	}
	if s.BytesDone != 6000 || s.BytesTotal != 6000 {
		t.Errorf("bytes %d/%d", s.BytesDone, s.BytesTotal)
	}
	if !exist(filepath.Join(dest, "album", "deep", "c.png")) || !exist(filepath.Join(dest, "a.jpg")) {
		t.Fatal("copies missing")
	}
	if got := e.names(destDir); !slices.Equal(got, []string{"album", "a.jpg"}) {
		t.Errorf("dest index = %v", got)
	}
	if !e.changed[destDir.ID] {
		t.Error("destination sessions were not notified")
	}
	// Paste into the source folder duplicates instead of failing.
	s = e.run(Spec{Kind: KindCopy, IDs: e.ids(root, "a.jpg"), Destination: e.root, Conflict: ConflictSkip})
	if s.Done != 1 || !exist(filepath.Join(e.root, "a (2).jpg")) {
		t.Fatalf("duplicate: %+v", s)
	}
	if got := e.names(root); !slices.Contains(got, "a (2).jpg") {
		t.Errorf("duplicate not indexed: %v", got)
	}
	// The snapshot stream is throttled but always ends with the final state.
	e.mu.Lock()
	last := e.snaps[len(e.snaps)-1]
	e.mu.Unlock()
	if last.State != StateCompleted {
		t.Errorf("last event %+v", last)
	}
}

func TestConflictPolicies(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "src", "a.jpg"), 10)
	write(t, filepath.Join(e.root, "dst", "a.jpg"), 3)
	root := e.index(e.root)
	src, _ := e.store.DirByPath(ctx, filepath.Join(e.root, "src"))
	ids := e.ids(src, "a.jpg")
	dst := filepath.Join(e.root, "dst")
	_ = root

	s := e.run(Spec{Kind: KindCopy, IDs: ids, Destination: dst, Conflict: ConflictSkip})
	if s.Skipped != 1 || s.Done != 0 {
		t.Errorf("skip: %+v", s)
	}
	s = e.run(Spec{Kind: KindCopy, IDs: ids, Destination: dst, Conflict: ConflictReplace})
	if fi, _ := os.Stat(filepath.Join(dst, "a.jpg")); s.Done != 1 || fi.Size() != 10 {
		t.Errorf("replace: %+v", s)
	}
	s = e.run(Spec{Kind: KindCopy, IDs: ids, Destination: dst, Conflict: ConflictKeepBoth})
	if s.Done != 1 || !exist(filepath.Join(dst, "a (2).jpg")) {
		t.Errorf("keep both: %+v", s)
	}
	dstDir, _ := e.store.DirByPath(ctx, dst)
	if got := e.names(dstDir); !slices.Equal(got, []string{"a (2).jpg", "a.jpg"}) {
		t.Errorf("dst index %v", got)
	}
}

func TestMoveKeepsIDsAndUserMetadata(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "a.jpg"), 10)
	write(t, filepath.Join(e.root, "album", "b.jpg"), 20)
	write(t, filepath.Join(e.root, "dest", "keep.txt"), 1)
	root := e.index(e.root)
	dest := filepath.Join(e.root, "dest")
	ids := e.ids(root, "a.jpg", "album")
	album, _ := e.store.DirByPath(ctx, filepath.Join(e.root, "album"))
	childID := e.ids(album, "b.jpg")[0]
	keyB := pathkey.ChildKey(album.Key, "b.jpg", false)
	if err := e.lib.SetRating(ctx, []string{pathkey.ChildKey(root.Key, "a.jpg", false), keyB}, 4, nil); err != nil {
		t.Fatal(err)
	}
	s := e.run(Spec{Kind: KindMove, IDs: ids, Destination: dest, Conflict: ConflictKeepBoth})
	if s.State != StateCompleted || s.Done != 2 {
		t.Fatalf("move: %+v %v", s, e.errors(s.JobID))
	}
	destDir, _ := e.store.DirByPath(ctx, dest)
	if got := e.names(destDir); !slices.Equal(got, []string{"album", "a.jpg"}) {
		t.Errorf("dest %v", got)
	}
	if got := e.names(root); !slices.Equal(got, []string{"dest"}) {
		t.Errorf("source %v", got)
	}
	// Same ids, paths resolve to the new place, including the folder's child.
	paths, _ := e.store.EntryPaths(ctx, []int64{ids[0], ids[1], childID})
	want := []string{filepath.Join(dest, "a.jpg"), filepath.Join(dest, "album"), filepath.Join(dest, "album", "b.jpg")}
	for i, p := range paths {
		if p.Path != want[i] {
			t.Errorf("path %d = %s, want %s", i, p.Path, want[i])
		}
	}
	newB := pathkey.ChildKey(pathkey.ChildKey(destDir.Key, "album", true), "b.jpg", false)
	ann, _ := e.lib.Annotations(ctx, []string{pathkey.ChildKey(destDir.Key, "a.jpg", false), newB, keyB}, false)
	if len(ann) != 2 || ann[newB].Rating != 4 {
		t.Errorf("metadata did not follow the move: %+v", ann)
	}
	// Moving into the folder it is already in is a no-op.
	s = e.run(Spec{Kind: KindMove, IDs: e.ids(destDir, "a.jpg"), Destination: dest, Conflict: ConflictKeepBoth})
	if s.Skipped != 1 || s.Failed != 0 {
		t.Errorf("same-folder move %+v", s)
	}
	// A folder can't go into itself.
	s = e.run(Spec{Kind: KindMove, IDs: e.ids(destDir, "album"), Destination: filepath.Join(dest, "album"), Conflict: ConflictKeepBoth})
	if errs := e.errors(s.JobID); s.Failed != 1 || errs[0].Code != fileops.CodeIntoItself {
		t.Errorf("into itself %+v %v", s, errs)
	}
}

func TestMoveToUnindexedFolderRemovesRows(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "a.jpg"), 10)
	root := e.index(e.root)
	elsewhere := t.TempDir()
	s := e.run(Spec{Kind: KindMove, IDs: e.ids(root, "a.jpg"), Destination: elsewhere, Conflict: ConflictKeepBoth})
	if s.Done != 1 || !exist(filepath.Join(elsewhere, "a.jpg")) {
		t.Fatalf("%+v", s)
	}
	if got := e.names(root); len(got) != 0 {
		t.Errorf("row kept: %v", got)
	}
	if !e.changed[root.ID] {
		t.Error("source session not notified")
	}
	// A destination that vanished fails the job, not each item.
	write(t, filepath.Join(e.root, "b.jpg"), 1)
	root = e.index(e.root)
	s = e.run(Spec{Kind: KindCopy, IDs: e.ids(root, "b.jpg"), Destination: filepath.Join(elsewhere, "gone"), Conflict: ConflictKeepBoth})
	if s.State != StateFailed || s.Error == "" {
		t.Errorf("missing destination %+v", s)
	}
}

func TestDeleteRemovesFilesRowsAndMetadata(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "a.jpg"), 10)
	write(t, filepath.Join(e.root, "album", "b.jpg"), 10)
	root := e.index(e.root)
	keyA := pathkey.ChildKey(root.Key, "a.jpg", false)
	if err := e.lib.SetFavorite(ctx, []string{keyA}, true, nil); err != nil {
		t.Fatal(err)
	}
	ids := e.ids(root, "a.jpg", "album")
	if err := os.Remove(filepath.Join(e.root, "a.jpg")); err != nil { // already gone counts as removed
		t.Fatal(err)
	}
	s := e.run(Spec{Kind: KindDelete, IDs: ids})
	if s.State != StateCompleted || s.Done != 2 || s.Failed != 0 {
		t.Fatalf("%+v %v", s, e.errors(s.JobID))
	}
	if exist(filepath.Join(e.root, "album")) || len(e.names(root)) != 0 {
		t.Error("not deleted")
	}
	if ann, _ := e.lib.Annotations(ctx, []string{keyA}, false); len(ann) != 0 {
		t.Error("metadata of a permanently deleted file kept")
	}
	// Ids that left the index fail without stopping the job.
	s = e.run(Spec{Kind: KindDelete, IDs: ids})
	if s.Failed != 2 || s.State != StateCompleted {
		t.Errorf("stale ids %+v", s)
	}
}

func TestRenamePatternChainsAndConflicts(t *testing.T) {
	e := newEnv(t)
	for _, n := range []string{"1.jpg", "2.jpg", "3.jpg", "x.png", "y.png"} {
		write(t, filepath.Join(e.root, n), 1)
	}
	root := e.index(e.root)
	// 1→2, 2→3, 3→4: each new name is held by the next selected item.
	s := e.run(Spec{Kind: KindRename, IDs: e.ids(root, "1.jpg", "2.jpg", "3.jpg"), Pattern: "{n}", Start: 2})
	if s.Done != 3 || s.Failed != 0 {
		t.Fatalf("chain %+v %v", s, e.errors(s.JobID))
	}
	if got := e.names(root); !slices.Equal(got, []string{"2.jpg", "3.jpg", "4.jpg", "x.png", "y.png"}) {
		t.Errorf("after chain: %v", got)
	}
	xy := e.ids(root, "x.png", "y.png")
	if _, err := e.m.Start(Spec{Kind: KindRename, IDs: xy, Pattern: "same"}); !errors.Is(err, ErrInvalid) {
		t.Errorf("pattern without a token: %v", err)
	}
	s = e.run(Spec{Kind: KindRename, IDs: xy, Pattern: "{n:000}", Start: 5})
	if s.Done != 2 || !exist(filepath.Join(e.root, "005.png")) || !exist(filepath.Join(e.root, "006.png")) {
		t.Fatalf("%+v %v", s, e.errors(s.JobID))
	}
	// The ids survived the rename: the same ids address the new names.
	s = e.run(Spec{Kind: KindRename, IDs: xy, Pattern: "{name}", Start: 1})
	if s.Skipped != 2 || s.Failed != 0 {
		t.Errorf("unchanged names %+v %v", s, e.errors(s.JobID))
	}
	// A new name taken by a file that is not selected fails that item only.
	write(t, filepath.Join(e.root, "a1.png"), 1)
	s = e.run(Spec{Kind: KindRename, IDs: xy, Pattern: "a{n}", Start: 1})
	if errs := e.errors(s.JobID); s.Done != 1 || s.Failed != 1 || errs[0].Code != fileops.CodeExists {
		t.Errorf("conflict with an unselected file: %+v %v", s, errs)
	}
	if !exist(filepath.Join(e.root, "a2.png")) || !exist(filepath.Join(e.root, "005.png")) {
		t.Error("wrong item renamed")
	}
}

func TestRenameFolderRekeysSubtree(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "album", "sub", "c.jpg"), 1)
	root := e.index(e.root)
	album := e.ids(root, "album")
	sub, _ := e.store.DirByPath(ctx, filepath.Join(e.root, "album", "sub"))
	cID := e.ids(sub, "c.jpg")[0]
	s := e.run(Spec{Kind: KindRename, IDs: album, Pattern: "2026 {name}", Start: 1})
	if s.Done != 1 {
		t.Fatalf("%+v %v", s, e.errors(s.JobID))
	}
	paths, _ := e.store.EntryPaths(ctx, []int64{cID})
	if want := filepath.Join(e.root, "2026 album", "sub", "c.jpg"); len(paths) != 1 || paths[0].Path != want {
		t.Errorf("child path %v, want %s", paths, want)
	}
	if _, err := e.store.DirByPath(ctx, filepath.Join(e.root, "2026 album", "sub")); err != nil {
		t.Errorf("subfolder not re-keyed: %v", err)
	}
}

func TestCancelStopsBetweenAndInsideItems(t *testing.T) {
	e := newEnv(t)
	for i := range 4 {
		write(t, filepath.Join(e.root, "big"+string(rune('a'+i))+".mp4"), 24<<20)
	}
	dest := filepath.Join(e.root, "dest")
	if err := os.Mkdir(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	root := e.index(e.root)
	s, err := e.m.Start(Spec{Kind: KindCopy, IDs: e.ids(root, "biga.mp4", "bigb.mp4", "bigc.mp4", "bigd.mp4"),
		Destination: dest, Conflict: ConflictKeepBoth})
	if err != nil {
		t.Fatal(err)
	}
	for {
		snap := e.wait0(s.JobID)
		if snap.BytesDone > 30<<20 || snap.State != StateRunning && snap.State != StateQueued {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !e.m.Cancel(s.JobID) {
		t.Fatal("cancel refused")
	}
	final := e.wait(s.JobID)
	if final.State != StateCancelled || final.Done >= 4 || final.Failed != 0 {
		t.Fatalf("%+v", final)
	}
	entries, _ := os.ReadDir(dest)
	for _, en := range entries {
		if filepath.Ext(en.Name()) != ".mp4" {
			t.Errorf("leftover %s", en.Name())
		}
	}
	destDir, _ := e.store.DirByPath(ctx, dest)
	if got := e.names(destDir); len(got) != final.Done || len(entries) != final.Done {
		t.Errorf("index %v vs disk %d vs done %d", got, len(entries), final.Done)
	}
	if e.m.Cancel(s.JobID) {
		t.Error("cancelling a finished job reported true")
	}
}

func (e *env) wait0(id int64) Snapshot {
	for _, s := range e.m.List() {
		if s.JobID == id {
			return s
		}
	}
	return Snapshot{}
}

func TestMetadataJobs(t *testing.T) {
	e := newEnv(t)
	for i := range 2500 {
		write(t, filepath.Join(e.root, "IMG_"+itoa(i)+".jpg"), 0)
	}
	if err := os.Mkdir(filepath.Join(e.root, "folder"), 0o755); err != nil {
		t.Fatal(err)
	}
	root := e.index(e.root)
	all, _ := e.store.QueryIDs(ctx, index.Descriptor{DirID: root.ID}, root.Key)
	s := e.run(Spec{Kind: KindFavorite, IDs: all, Favorite: true})
	if s.Done != 2500 || s.Skipped != 1 || s.State != StateCompleted {
		t.Fatalf("%+v", s)
	}
	if !e.changed[root.ID] {
		t.Error("sessions not notified")
	}
	s = e.run(Spec{Kind: KindTag, IDs: all[:10], Tag: "Trip", Add: true})
	if s.Done != 9 { // all[0] is the folder
		t.Errorf("tag %+v", s)
	}
	tags, _ := e.lib.Tags(ctx)
	if len(tags) != 1 || tags[0].Count != 9 {
		t.Errorf("tags %+v", tags)
	}
	if _, err := e.m.Start(Spec{Kind: KindRating, IDs: all, Rating: 6}); !errors.Is(err, ErrInvalid) {
		t.Error("rating 6 accepted")
	}
	// Without library.db the job fails with an explanation.
	e.m.deps.Library = func(context.Context) (*library.Library, error) { return nil, errors.New("down") }
	s = e.run(Spec{Kind: KindRating, IDs: all, Rating: 3})
	if s.State != StateFailed || s.Error == "" {
		t.Errorf("%+v", s)
	}
}

func itoa(i int) string {
	return string([]byte{byte('0' + i/1000%10), byte('0' + i/100%10), byte('0' + i/10%10), byte('0' + i%10)})
}

func TestQueueAndRecovery(t *testing.T) {
	e := newEnv(t)
	dest := filepath.Join(e.root, "dest")
	write(t, fileops.PartialName(dest, "x.jpg"), 5)
	if _, err := e.store.JobStarted(ctx, "copy", dest, 1); err != nil {
		t.Fatal(err)
	}
	m := e.manager() // a new process
	defer m.Close()
	if exist(fileops.PartialName(dest, "x.jpg")) {
		t.Error("partial copy of an interrupted job not removed")
	}
	// Many jobs at once: at most MaxRunning run, the queue is capped.
	// Empty jobs may finish faster than they are queued, so ErrBusy is
	// allowed but not required.
	for range MaxRunning + MaxQueued + 5 {
		_, err := m.Start(Spec{Kind: KindFavorite, IDs: nil, Favorite: true})
		if errors.Is(err, ErrBusy) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	// Wait until nothing is active. Waiting per id would time out for the
	// ids already retired beyond KeepFinished.
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(time.Millisecond) {
		active := 0
		for _, s := range m.List() {
			if s.State == StateQueued || s.State == StateRunning {
				active++
			}
		}
		if active == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d jobs still active", active)
		}
	}
	// Finished jobs are retired right after their final state is set, so a
	// listing can briefly include the jobs that are just finishing.
	if n := len(m.List()); n > KeepFinished+MaxRunning {
		t.Errorf("kept %d finished jobs", n)
	}
}

func TestRenameOne(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "a.jpg"), 1)
	write(t, filepath.Join(e.root, "b.jpg"), 1)
	write(t, filepath.Join(e.root, "clip.mp4"), 1)
	root := e.index(e.root)
	ids := e.ids(root, "a.jpg", "b.jpg", "clip.mp4")
	keyA := pathkey.ChildKey(root.Key, "a.jpg", false)
	if err := e.lib.SetRating(ctx, []string{keyA}, 4, nil); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		id   int64
		name string
		code string
	}{
		{ids[0], "b.jpg", fileops.CodeExists},
		{ids[0], "a/b.jpg", fileops.CodeInvalidName},
		{ids[0], "a.txt", fileops.CodeInvalidName},
		{ids[2], "clip.jpg", fileops.CodeInvalidName}, // kind change
		{999999, "z.jpg", fileops.CodeNotFound},
	} {
		if _, err := e.m.RenameOne(ctx, c.id, c.name); fileops.Code(err) != c.code {
			t.Errorf("%q: got %v, want %s", c.name, err, c.code)
		}
	}
	got, err := e.m.RenameOne(ctx, ids[0], "Holiday.JPEG")
	if err != nil || got != "Holiday.JPEG" {
		t.Fatalf("rename: %q %v", got, err)
	}
	if !exist(filepath.Join(e.root, "Holiday.JPEG")) || exist(filepath.Join(e.root, "a.jpg")) {
		t.Error("file not renamed on disk")
	}
	if names := e.names(root); !slices.Contains(names, "Holiday.JPEG") || slices.Contains(names, "a.jpg") {
		t.Errorf("index not updated: %v", names)
	}
	if e.ids(root, "Holiday.JPEG")[0] != ids[0] {
		t.Error("rename changed the id")
	}
	ann, _ := e.lib.Annotations(ctx, []string{pathkey.ChildKey(root.Key, "Holiday.JPEG", false)}, false)
	if len(ann) != 1 {
		t.Error("rating did not follow the rename")
	}
	e.mu.Lock()
	notified := e.changed[root.ID]
	e.mu.Unlock()
	if !notified {
		t.Error("folder change not reported")
	}
}

// BenchmarkCopySmallFiles copies 200 × 64 KiB files into an indexed folder
// per iteration (one file at a time per job, ADR-0021).
func BenchmarkCopySmallFiles(b *testing.B) {
	e := newEnv(b)
	src := filepath.Join(e.root, "src")
	names := make([]string, 200)
	for i := range names {
		names[i] = fmt.Sprintf("IMG_%03d.jpg", i)
		write(b, filepath.Join(src, names[i]), 64<<10)
	}
	srcDir := e.index(src)
	ids := e.ids(srcDir, names...)
	b.SetBytes(int64(len(names)) * 64 << 10)
	n := 0
	for b.Loop() {
		n++
		dest := filepath.Join(e.root, fmt.Sprintf("dest%d", n))
		if err := os.MkdirAll(dest, 0o755); err != nil {
			b.Fatal(err)
		}
		e.index(dest)
		if s := e.run(Spec{Kind: KindCopy, IDs: ids, Destination: dest, Conflict: ConflictKeepBoth}); s.Done != len(ids) {
			b.Fatalf("%+v", s)
		}
	}
}

// BenchmarkFavorite10k marks 10k indexed files as favorites through the job
// manager (target resolution, library.db chunks, progress, index changes).
func BenchmarkFavorite10k(b *testing.B) {
	e := newEnv(b)
	names := make([]string, 10_000)
	for i := range names {
		names[i] = fmt.Sprintf("IMG_%05d.jpg", i)
		write(b, filepath.Join(e.root, "flat", names[i]), 0)
	}
	dir := e.index(filepath.Join(e.root, "flat"))
	ids, err := e.store.QueryIDs(ctx, index.Descriptor{DirID: dir.ID}, dir.Key)
	if err != nil {
		b.Fatal(err)
	}
	fav := false
	for b.Loop() {
		fav = !fav
		if s := e.run(Spec{Kind: KindFavorite, IDs: ids, Favorite: fav}); s.Done != len(ids) {
			b.Fatalf("%+v", s)
		}
	}
}
