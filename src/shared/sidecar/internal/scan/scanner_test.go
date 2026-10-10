package scan

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"testing"
	"time"

	"panelyth/sidecar/internal/fixture"
	"panelyth/sidecar/internal/index"
)

var quiet = slog.New(slog.DiscardHandler)

type rig struct {
	t     *testing.T
	store *index.Store
	mu    sync.Mutex
	prog  []Progress
	dirty map[int64]int
}

func newRig(t *testing.T) *rig {
	t.Helper()
	s, err := index.Open(filepath.Join(t.TempDir(), "index.db"), quiet)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return &rig{t: t, store: s, dirty: map[int64]int{}}
}

func (r *rig) hooks() Hooks {
	return Hooks{
		Progress: func(p Progress) { r.mu.Lock(); r.prog = append(r.prog, p); r.mu.Unlock() },
		Changed: func(changes []Change) {
			r.mu.Lock()
			for _, c := range changes {
				r.dirty[c.DirID]++
			}
			r.mu.Unlock()
		},
	}
}

func (r *rig) run(ctx context.Context, root string, recursive bool, opts Options) (Stats, index.DirInfo) {
	r.t.Helper()
	// Setup never sees ctx: cancellation tests target the scan itself.
	info, err := r.store.EnsureDir(context.Background(), root)
	if err != nil {
		r.t.Fatal(err)
	}
	gen := r.store.NextGeneration()
	id, err := r.store.ScanStarted(context.Background(), info.ID, recursive, gen)
	if err != nil {
		r.t.Fatal(err)
	}
	return Run(ctx, r.store, quiet, opts, r.hooks(), id, gen, info, recursive), info
}

func (r *rig) names(info index.DirInfo, recursive bool) []string {
	r.t.Helper()
	ids, err := r.store.QueryIDs(context.Background(), index.Descriptor{DirID: info.ID, Recursive: recursive,
		Sort: []index.SortKey{{Field: index.SortName}}}, info.Key)
	if err != nil {
		r.t.Fatal(err)
	}
	items, _ := r.store.LoadItems(context.Background(), ids)
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.Name
	}
	return out
}

func TestShallowScan(t *testing.T) {
	r := newRig(t)
	root := filepath.Join(t.TempDir(), "shallow")
	exp, err := fixture.Generate(root, fixture.Spec{Files: 20, Depth: 1, Fanout: 2, NonMediaEvery: 5, HiddenEvery: 7})
	if err != nil {
		t.Fatal(err)
	}
	stats, info := r.run(context.Background(), root, false, Options{})
	if stats.State != StateCompleted || stats.DirsListed != 1 {
		t.Fatalf("stats %+v", stats.Progress)
	}
	got := r.names(info, false)
	mediaPerDir := exp.Media / 3
	if len(got) != 2+mediaPerDir {
		t.Fatalf("want 2 dirs + %d media, got %d: %q", mediaPerDir, len(got), got)
	}
	if got[0] != "folder 1" || got[1] != "folder 2" {
		t.Fatalf("directories must sort first: %q", got[:3])
	}
	for _, n := range got {
		if n[0] == '.' || filepath.Ext(n) == ".txt" {
			t.Fatalf("hidden or non-media entry indexed: %q", n)
		}
	}
	if stats.Skipped != exp.NonMedia/3 {
		t.Fatalf("skipped %d, want %d", stats.Skipped, exp.NonMedia/3)
	}
	// Every entry is stored (ADR-0026); the media scope above hides the rest.
	all, _ := os.ReadDir(root)
	last := r.prog[len(r.prog)-1]
	if last.State != StateCompleted || last.Entries != len(all) {
		t.Fatalf("final progress %+v, want %d entries", last, len(all))
	}
	if r.dirty[info.ID] == 0 {
		t.Fatal("Changed hook not called for root")
	}
}

func TestRecursiveScan(t *testing.T) {
	r := newRig(t)
	root := filepath.Join(t.TempDir(), "tree")
	exp, _ := fixture.Generate(root, fixture.Spec{Files: 30, Depth: 3, Fanout: 3, NonMediaEvery: 10})
	stats, info := r.run(context.Background(), root, true, Options{Workers: 3, BatchRows: 50})
	if stats.State != StateCompleted {
		t.Fatalf("state %s", stats.State)
	}
	if stats.DirsListed != exp.Dirs+1 {
		t.Fatalf("dirs listed %d, want %d", stats.DirsListed, exp.Dirs+1)
	}
	if got := r.names(info, true); len(got) != exp.Media {
		t.Fatalf("recursive media %d, want %d", len(got), exp.Media)
	}
	if stats.Batches < 2 {
		t.Fatalf("expected batched commits, got %d", stats.Batches)
	}
}

func TestRescanReconciles(t *testing.T) {
	r := newRig(t)
	root := filepath.Join(t.TempDir(), "r")
	_, _ = fixture.Generate(root, fixture.Spec{Files: 5})
	_, info := r.run(context.Background(), root, false, Options{})
	if err := os.Remove(filepath.Join(root, "IMG_0.jpg")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "added.png"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	r.run(context.Background(), root, false, Options{})
	got := r.names(info, false)
	if slices.Contains(got, "IMG_0.jpg") || !slices.Contains(got, "added.png") {
		t.Fatalf("rescan did not reconcile: %q", got)
	}
}

func TestCancelKeepsExistingRows(t *testing.T) {
	r := newRig(t)
	root := filepath.Join(t.TempDir(), "big")
	exp, _ := fixture.Generate(root, fixture.Spec{Files: 3000, Depth: 1, Fanout: 4})
	full, info := r.run(context.Background(), root, true, Options{})
	if full.State != StateCompleted {
		t.Fatal(full.State)
	}
	before := len(r.names(info, true))
	if before != exp.Media {
		t.Fatalf("baseline %d want %d", before, exp.Media)
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.mu.Lock()
	r.prog = nil
	r.mu.Unlock()
	go func() { time.Sleep(2 * time.Millisecond); cancel() }()
	stats, _ := r.run(ctx, root, true, Options{ReadChunk: 16})
	if stats.State != StateCancelled && stats.State != StateCompleted {
		t.Fatalf("state %s", stats.State)
	}
	if after := len(r.names(info, true)); after != before {
		t.Fatalf("cancelled scan changed the index: %d -> %d", before, after)
	}
}

func TestUnreadableDirectoryIsReported(t *testing.T) {
	r := newRig(t)
	root := filepath.Join(t.TempDir(), "gone")
	_ = os.MkdirAll(root, 0o755)
	info, _ := r.store.EnsureDir(context.Background(), root)
	_ = os.Remove(root)
	gen := r.store.NextGeneration()
	stats := Run(context.Background(), r.store, quiet, Options{}, r.hooks(), 1, gen, info, false)
	if stats.Errors != 1 || stats.DirsWithErrors != 1 {
		t.Fatalf("expected one listing error: %+v", stats)
	}
	d, _ := r.store.Dir(context.Background(), info.ID)
	if d.ListingState != index.ListingError {
		t.Fatalf("listing state %d", d.ListingState)
	}
}

func TestManagerForegroundCancelsPrevious(t *testing.T) {
	r := newRig(t)
	base := t.TempDir()
	a, b := filepath.Join(base, "a"), filepath.Join(base, "b")
	_, _ = fixture.Generate(a, fixture.Spec{Files: 4000, Depth: 1, Fanout: 3})
	_, _ = fixture.Generate(b, fixture.Spec{Files: 5})
	finished := map[int64]string{}
	var mu sync.Mutex
	m := NewManager(r.store, quiet, Options{ReadChunk: 8}, r.hooks(), func(id int64, s Stats) {
		mu.Lock()
		finished[id] = s.State
		mu.Unlock()
	})
	defer m.Close()
	ia, _ := r.store.EnsureDir(context.Background(), a)
	ib, _ := r.store.EnsureDir(context.Background(), b)
	idA, err := m.Open(ia, true, "")
	if err != nil {
		t.Fatal(err)
	}
	idB, _ := m.Open(ib, false, "")
	m.Wait(idA)
	m.Wait(idB)
	mu.Lock()
	defer mu.Unlock()
	if finished[idA] != StateCancelled {
		t.Fatalf("previous foreground scan should be cancelled, got %q", finished[idA])
	}
	if finished[idB] != StateCompleted {
		t.Fatalf("new scan %q", finished[idB])
	}
	if m.Cancel(idB) {
		t.Fatal("cancel of finished scan reported success")
	}
}

func TestNoGoroutineLeak(t *testing.T) {
	r := newRig(t)
	root := filepath.Join(t.TempDir(), "leak")
	_, _ = fixture.Generate(root, fixture.Spec{Files: 50, Depth: 2, Fanout: 2})
	before := runtime.NumGoroutine()
	for range 5 {
		r.run(context.Background(), root, true, Options{})
	}
	deadline := time.Now().Add(time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if after := runtime.NumGoroutine(); after > before {
		t.Fatalf("goroutines leaked: %d -> %d", before, after)
	}
}
