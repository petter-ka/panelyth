package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"testing"

	"panelyth/sidecar/internal/library"
	"panelyth/sidecar/internal/rpc"
)

// newContextService opens an index service with library.db in configDir.
func newContextService(t *testing.T, configDir string) *indexService {
	t.Helper()
	svc, err := newIndexService(t.TempDir(), 1<<20, slog.New(slog.DiscardHandler), func(string, any) error { return nil }, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	lib, err := library.Open(filepath.Join(configDir, "library.db"))
	if err != nil {
		t.Fatal(err)
	}
	svc.lib = lib
	close(svc.libReady)
	t.Cleanup(func() {
		svc.context.flush()
		_ = lib.Close()
		svc.close()
	})
	return svc
}

func TestSharedContext(t *testing.T) {
	ctx := context.Background()
	config := t.TempDir()
	svc := newContextService(t, config)

	if got, _ := svc.context.get(ctx); got.Version != 0 || got.App != "" {
		t.Fatalf("fresh context %+v", got)
	}
	dir, err := svc.store.EnsureDir(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	focus := int64(42)
	if _, err := svc.context.publish(ctx, contextPublishParams{App: "commander", DirID: dir.ID, FocusID: &focus}); err != nil {
		t.Fatal(err)
	}
	got, _ := svc.context.get(ctx)
	if got.Version != 1 || got.App != "commander" || got.DirID != dir.ID || got.Path != dir.Path || got.FocusID == nil || *got.FocusID != 42 {
		t.Fatalf("after publish %+v", got)
	}
	if _, err := svc.context.publish(ctx, contextPublishParams{App: "viewer", DirID: dir.ID}); err != nil {
		t.Fatal(err)
	}
	if got, _ := svc.context.get(ctx); got.Version != 2 || got.App != "viewer" || got.FocusID != nil {
		t.Fatalf("second publish %+v", got)
	}

	// Rejected: an unknown app, an unknown folder, a bad focus id.
	var re *rpc.Error
	if _, err := svc.context.publish(ctx, contextPublishParams{App: "shell", DirID: dir.ID}); !errors.As(err, &re) || re.Code != rpc.CodeInvalidArgument {
		t.Fatalf("unknown app: %v", err)
	}
	if _, err := svc.context.publish(ctx, contextPublishParams{App: "viewer", DirID: 999_999}); !errors.As(err, &re) || re.Code != rpc.CodeNotFound {
		t.Fatalf("unknown folder: %v", err)
	}
	bad := int64(0)
	if _, err := svc.context.publish(ctx, contextPublishParams{App: "viewer", DirID: dir.ID, FocusID: &bad}); err == nil {
		t.Fatal("focusId 0 accepted")
	}

	// Flushed to shared.context; the next run reads the app and folder.
	svc.context.flush()
	settings, err := svc.lib.Settings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var stored storedContext
	if err := json.Unmarshal(settings[sharedContextKey], &stored); err != nil || stored.App != "viewer" || stored.Path != dir.Path || stored.V != 1 {
		t.Fatalf("stored %s (%v)", settings[sharedContextKey], err)
	}
	next := &sharedContext{svc: svc}
	if got, _ := next.get(ctx); got.Version != 0 || got.App != "viewer" || got.Path != dir.Path || got.DirID != 0 {
		t.Fatalf("next run %+v", got)
	}
}

func TestToRanges(t *testing.T) {
	got := toRanges([]int{0, 1, 2, 5, 7, 8})
	want := [][2]int{{0, 3}, {5, 6}, {7, 9}}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%v", got)
		}
	}
	if r := toRanges(nil); len(r) != 0 {
		t.Fatalf("%v", r)
	}
}

// A navigation publish (no selection field) keeps the carried selection for
// the version that carried it; context.get reports it only for that version.
func TestContextSelectionSurvivesNavigation(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	dir, err := svc.store.EnsureDir(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c := svc.context
	c.mu.Lock()
	c.sel, c.selVersion, c.selCount = []int64{5, 6}, 1, 2
	c.cur = contextGetResult{Version: 1, App: "commander", DirID: dir.ID, SelectionCount: 2}
	c.loaded = true
	c.mu.Unlock()
	if _, err := c.publish(ctx, contextPublishParams{App: "viewer", DirID: dir.ID}); err != nil {
		t.Fatal(err)
	}
	got, _ := c.get(ctx)
	if got.Version != 2 || got.SelectionCount != 0 {
		t.Fatalf("navigation publish %+v", got)
	}
	c.mu.Lock()
	if c.selVersion != 1 || len(c.sel) != 2 {
		t.Fatalf("selection lost: v%d %v", c.selVersion, c.sel)
	}
	c.mu.Unlock()
	// A switch with nothing selected clears it.
	if _, err := c.publish(ctx, contextPublishParams{App: "viewer", DirID: dir.ID, Selection: json.RawMessage("null")}); err != nil {
		t.Fatal(err)
	}
	if c.selVersion != 3 || c.sel != nil {
		t.Fatalf("not cleared: v%d %v", c.selVersion, c.sel)
	}
}
