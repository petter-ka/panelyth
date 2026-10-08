package meta

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"panelyth/sidecar/internal/fixture"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/scan"
	"panelyth/sidecar/internal/video"
)

var quiet = slog.New(slog.DiscardHandler)

func TestExtractsDimensionsAndMarksFailures(t *testing.T) {
	ctx := context.Background()
	store, err := index.Open(filepath.Join(t.TempDir(), "index.db"), quiet)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	dir := filepath.Join(t.TempDir(), "imgs")
	if err := fixture.GenerateImages(dir, fixture.ImageSpec{Count: 4, Width: 64, Height: 48, RotatedEvery: 2}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken.jpg"), []byte("not a jpeg"), 0o644); err != nil {
		t.Fatal(err)
	}
	root, _ := store.EnsureDir(ctx, dir)
	if st := scan.Run(ctx, store, quiet, scan.Options{}, scan.Hooks{}, 1, store.NextGeneration(), root, false); st.State != scan.StateCompleted {
		t.Fatalf("scan %s", st.State)
	}
	ids, err := store.QueryIDs(ctx, index.Descriptor{DirID: root.ID}, root.Key)
	if err != nil || len(ids) != 5 {
		t.Fatalf("ids %v %v", ids, err)
	}

	var refreshes atomic.Int32
	x := New(store, video.Locate(func(string) string { return "off" }), quiet, Options{Chunk: 2},
		func(q int64) {
			if q == 7 {
				refreshes.Add(1)
			}
		})
	defer x.Close()
	x.Want(7, ids)
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		pending, err := store.MetaPending(ctx, ids)
		if err != nil {
			t.Fatal(err)
		}
		if len(pending) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d entries still pending", len(pending))
		}
	}
	if refreshes.Load() == 0 {
		t.Error("session never refreshed")
	}
	rotated := 0
	for _, id := range ids {
		d, err := store.Entry(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		switch {
		case d.Name == "broken.jpg":
			if d.Width != 0 {
				t.Errorf("corrupt file got dimensions %dx%d", d.Width, d.Height)
			}
		case d.Width == 48 && d.Height == 64:
			rotated++ // EXIF orientation 6: display size is swapped
		case d.Width != 64 || d.Height != 48:
			t.Errorf("%s: %dx%d", d.Name, d.Width, d.Height)
		}
	}
	if rotated != 2 {
		t.Errorf("%d rotated images, want 2", rotated)
	}

	// Dropping a session that is not the current one is a no-op; dropping
	// the current one stops the work.
	x.Drop(99)
	x.Want(8, ids)
	x.Drop(8)
}
