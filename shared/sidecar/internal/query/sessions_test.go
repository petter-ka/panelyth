package query

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"fastview/sidecar/internal/fixture"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/scan"
)

var quiet = slog.New(slog.DiscardHandler)

type env struct {
	store *index.Store
	root  index.DirInfo
	mu    sync.Mutex
	inv   []Snapshot
	mgr   *Manager
}

func setup(t *testing.T, files int) *env {
	t.Helper()
	s, err := index.Open(filepath.Join(t.TempDir(), "index.db"), quiet)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	dir := filepath.Join(t.TempDir(), "q")
	if _, err := fixture.Generate(dir, fixture.Spec{Files: files, Depth: 1, Fanout: 2}); err != nil {
		t.Fatal(err)
	}
	root, _ := s.EnsureDir(context.Background(), dir)
	e := &env{store: s, root: root}
	e.mgr = NewManager(s, quiet, Options{MinRefreshDelay: 20 * time.Millisecond, MaxSessions: 3}, func(snap Snapshot) {
		e.mu.Lock()
		e.inv = append(e.inv, snap)
		e.mu.Unlock()
	})
	t.Cleanup(e.mgr.Shutdown)
	return e
}

func (e *env) scan(t *testing.T, recursive bool) {
	t.Helper()
	gen := e.store.NextGeneration()
	st := scan.Run(context.Background(), e.store, quiet, scan.Options{BatchRows: 64}, scan.Hooks{Changed: e.mgr.Changed},
		1, gen, e.root, recursive)
	if st.State != scan.StateCompleted {
		t.Fatalf("scan %s", st.State)
	}
}

func (e *env) waitInvalidation(t *testing.T, total int) Snapshot {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		e.mu.Lock()
		if n := len(e.inv); n > 0 && e.inv[n-1].Total == total {
			s := e.inv[n-1]
			e.mu.Unlock()
			return s
		}
		e.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no invalidation reaching total %d; got %+v", total, e.inv)
	return Snapshot{}
}

func TestSessionFollowsScan(t *testing.T) {
	e := setup(t, 300)
	ctx := context.Background()
	snap, err := e.mgr.Open(ctx, index.Descriptor{DirID: e.root.ID, Sort: []index.SortKey{{Field: index.SortName}}})
	if err != nil {
		t.Fatal(err)
	}
	if snap.Total != 0 || snap.Version != 1 {
		t.Fatalf("unscanned folder: %+v", snap)
	}
	e.scan(t, false)
	last := e.waitInvalidation(t, 2+300) // 2 subfolders + 300 media
	if last.Version < 2 {
		t.Fatalf("version did not advance: %+v", last)
	}
	e.mu.Lock()
	n := len(e.inv)
	e.mu.Unlock()
	if n > 10 {
		t.Fatalf("invalidations not throttled: %d events", n)
	}

	p, err := e.mgr.Page(ctx, snap.QueryID, 0, 5)
	if err != nil {
		t.Fatal(err)
	}
	if p.Version != last.Version || len(p.Items) != 5 || p.Items[0].Name != "folder 1" {
		t.Fatalf("page %+v", p)
	}
	deep, _ := e.mgr.Page(ctx, snap.QueryID, 300, 100)
	if deep.Offset != 300 || len(deep.Items) != 2 {
		t.Fatalf("tail page offset=%d items=%d", deep.Offset, len(deep.Items))
	}
	clamped, _ := e.mgr.Page(ctx, snap.QueryID, 0, 5000)
	if len(clamped.Items) != 302 {
		t.Fatalf("limit not clamped to available rows: %d", len(clamped.Items))
	}
}

func TestPageSizeCap(t *testing.T) {
	e := setup(t, 1200)
	e.scan(t, false)
	snap, _ := e.mgr.Open(context.Background(), index.Descriptor{DirID: e.root.ID})
	p, _ := e.mgr.Page(context.Background(), snap.QueryID, 0, 1_000_000)
	if len(p.Items) != MaxPageSize {
		t.Fatalf("page size %d, want cap %d", len(p.Items), MaxPageSize)
	}
}

func TestRecursiveSessionSeesSubfolderChanges(t *testing.T) {
	e := setup(t, 20)
	snap, _ := e.mgr.Open(context.Background(), index.Descriptor{DirID: e.root.ID, Recursive: true})
	e.scan(t, true)
	got := e.waitInvalidation(t, 3*20)
	if got.QueryID != snap.QueryID {
		t.Fatal("wrong session invalidated")
	}
}

func TestEvictionAndClose(t *testing.T) {
	e := setup(t, 5)
	ctx := context.Background()
	var ids []int64
	for range 4 {
		s, _ := e.mgr.Open(ctx, index.Descriptor{DirID: e.root.ID})
		ids = append(ids, s.QueryID)
		time.Sleep(time.Millisecond)
	}
	if _, err := e.mgr.Page(ctx, ids[0], 0, 1); !errors.Is(err, ErrUnknownSession) {
		t.Fatalf("oldest session should be evicted, got %v", err)
	}
	if !e.mgr.Close(ids[3]) || e.mgr.Close(ids[3]) {
		t.Fatal("close semantics")
	}
	if _, err := e.mgr.Open(ctx, index.Descriptor{DirID: 999999}); !errors.Is(err, index.ErrNotFound) {
		t.Fatalf("unknown dir: %v", err)
	}
}

func TestIDsKeepPreviousVersion(t *testing.T) {
	e := setup(t, 10)
	ctx := context.Background()
	snap, _ := e.mgr.Open(ctx, index.Descriptor{DirID: e.root.ID})
	v1, cur, err := e.mgr.IDs(snap.QueryID, 1)
	if err != nil || cur != 1 || len(v1) != 0 {
		t.Fatalf("v1: %v %d %v", v1, cur, err)
	}
	e.scan(t, false)
	last := e.waitInvalidation(t, 12)
	ids, cur, err := e.mgr.IDs(snap.QueryID, last.Version)
	if err != nil || cur != last.Version || len(ids) != 12 {
		t.Fatalf("current: %d ids, cur %d, %v", len(ids), cur, err)
	}
	if _, _, err := e.mgr.IDs(snap.QueryID, last.Version-1); err != nil {
		t.Fatalf("previous version must resolve: %v", err)
	}
	if last.Version >= 3 {
		if _, _, err := e.mgr.IDs(snap.QueryID, last.Version-2); !errors.Is(err, ErrStaleVersion) {
			t.Fatalf("older versions are stale: %v", err)
		}
	}
	if _, _, err := e.mgr.IDs(snap.QueryID, last.Version+1); !errors.Is(err, ErrStaleVersion) {
		t.Fatalf("future version: %v", err)
	}
	if _, _, err := e.mgr.IDs(99999, 1); !errors.Is(err, ErrUnknownSession) {
		t.Fatalf("unknown: %v", err)
	}
	f, err := e.mgr.Facets(ctx, snap.QueryID)
	if err != nil || f.Folders != 2 || f.Images+f.Videos != 10 {
		t.Fatalf("facets %+v %v", f, err)
	}
}

func TestUserDataAndMaterializedHooks(t *testing.T) {
	e := setup(t, 6)
	e.scan(t, false)
	var mu sync.Mutex
	var userCalls, materialized, dropped int
	e.mgr.opts.User = func(_ context.Context, d index.Descriptor, dirKey string) ([]index.UserRow, error) {
		mu.Lock()
		userCalls++
		mu.Unlock()
		if dirKey != e.root.Key {
			t.Errorf("dirKey %q", dirKey)
		}
		return nil, errors.New("library unavailable") // must not fail the query
	}
	e.mgr.opts.Materialized = func(int64, index.Descriptor, []int64) { mu.Lock(); materialized++; mu.Unlock() }
	e.mgr.opts.Dropped = func(int64) { mu.Lock(); dropped++; mu.Unlock() }

	plain, err := e.mgr.Open(context.Background(), index.Descriptor{DirID: e.root.ID})
	if err != nil {
		t.Fatal(err)
	}
	fav, err := e.mgr.Open(context.Background(), index.Descriptor{DirID: e.root.ID, FavoriteOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if fav.Total != 0 {
		t.Errorf("favorites without a library: %d rows", fav.Total)
	}
	mu.Lock()
	if userCalls != 1 || materialized != 2 {
		t.Errorf("user %d materialized %d after two opens", userCalls, materialized)
	}
	mu.Unlock()

	// Refresh re-materializes one session (the metadata extractor's path).
	e.mgr.Refresh(plain.QueryID)
	e.waitInvalidation(t, plain.Total)
	mu.Lock()
	if materialized != 3 {
		t.Errorf("materialized %d after refresh", materialized)
	}
	mu.Unlock()

	e.mgr.Close(fav.QueryID)
	// MaxSessions is 3: two more opens evict the oldest.
	for range 3 {
		if _, err := e.mgr.Open(context.Background(), index.Descriptor{DirID: e.root.ID}); err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if dropped != 2 {
		t.Errorf("dropped %d, want 2 (close + eviction)", dropped)
	}
}

func TestIndexOf(t *testing.T) {
	e := setup(t, 300)
	e.scan(t, false)
	ctx := context.Background()
	snap, _ := e.mgr.Open(ctx, index.Descriptor{DirID: e.root.ID})
	p, _ := e.mgr.Page(ctx, snap.QueryID, 250, 1)
	at, version, err := e.mgr.IndexOf(snap.QueryID, p.Items[0].ID)
	if err != nil || at != 250 || version != snap.Version {
		t.Fatalf("IndexOf = %d v%d %v, want 250 v%d", at, version, err, snap.Version)
	}
	if at, _, _ := e.mgr.IndexOf(snap.QueryID, 999_999); at != -1 {
		t.Fatalf("absent entry at %d", at)
	}
	if _, _, err := e.mgr.IndexOf(999, 1); !errors.Is(err, ErrUnknownSession) {
		t.Fatalf("unknown session: %v", err)
	}
}

// 100k ids: the scan behind query.indexOf (cursor on the folder just left,
// carried-over focus).
func BenchmarkIndexOf100k(b *testing.B) {
	ids := make([]int64, 100_000)
	for i := range ids {
		ids[i] = int64(i + 1)
	}
	m := &Manager{sessions: map[int64]*session{1: {id: 1, ids: ids, version: 1}}}
	for b.Loop() {
		if at, _, _ := m.IndexOf(1, 100_000); at != 99_999 {
			b.Fatal(at)
		}
	}
}
