package app

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"fastview/sidecar/internal/fixture"
	"fastview/sidecar/internal/imaging"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/rpc"
	"fastview/sidecar/internal/scan"
	"fastview/sidecar/internal/video"
)

func TestClipboardImage(t *testing.T) {
	root := filepath.Join(t.TempDir(), "pics")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	// 3x1: opaque red, fully transparent, half-transparent blue.
	src := image.NewNRGBA(image.Rect(0, 0, 3, 1))
	src.Set(0, 0, color.NRGBA{255, 0, 0, 255})
	src.Set(1, 0, color.NRGBA{0, 0, 0, 0})
	src.Set(2, 0, color.NRGBA{0, 0, 255, 128})
	var buf bytes.Buffer
	if err := png.Encode(&buf, src); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "a.png"), buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "b.jpg"), []byte("not a jpeg"), 0o644); err != nil {
		t.Fatal(err)
	}

	cacheRoot := t.TempDir()
	stale := filepath.Join(cacheRoot, "tmp", "clip-1-1.png")
	if err := os.MkdirAll(filepath.Dir(stale), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte{1}, 0o600); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.DiscardHandler)
	svc, err := newIndexService(cacheRoot, 1<<30, log, func(string, any) error { return nil }, &video.Tools{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer svc.close()
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale clipboard file kept: %v", err)
	}
	ctx := context.Background()
	info, err := svc.store.EnsureDir(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if st := scan.Run(ctx, svc.store, log, scan.Options{}, scan.Hooks{}, 1, svc.store.NextGeneration(), info, false); st.State != scan.StateCompleted {
		t.Fatal(st.State)
	}
	dir, _ := svc.store.Dir(ctx, info.ID)
	ids, _ := svc.store.QueryIDs(ctx, index.Descriptor{DirID: dir.ID, Sort: []index.SortKey{{Field: index.SortName}}}, dir.Key)
	if len(ids) != 2 {
		t.Fatalf("ids %v", ids)
	}

	res, err := svc.clipboardImage(ctx, entryParams{EntryID: ids[0]})
	if err != nil {
		t.Fatal(err)
	}
	if res.Width != 3 || res.Height != 1 || filepath.Dir(res.File) != filepath.Join(cacheRoot, "tmp") {
		t.Fatalf("result %+v", res)
	}
	f, err := os.Open(res.File)
	if err != nil {
		t.Fatal(err)
	}
	got, err := png.Decode(f)
	_ = f.Close()
	if err != nil {
		t.Fatal(err)
	}
	// Transparency is kept.
	for x, want := range []color.NRGBA{{255, 0, 0, 255}, {0, 0, 0, 0}, {0, 0, 255, 128}} {
		if c := color.NRGBAModel.Convert(got.At(x, 0)).(color.NRGBA); c != want {
			t.Fatalf("pixel %d = %v, want %v", x, c, want)
		}
	}

	var rerr *rpc.Error
	if _, err := svc.clipboardImage(ctx, entryParams{EntryID: ids[1]}); !errors.As(err, &rerr) || rerr.Code != rpc.CodeCorruptMedia {
		t.Fatalf("corrupt image: %v", err)
	}
	if _, err := svc.clipboardImage(ctx, entryParams{EntryID: dir.ID}); !errors.As(err, &rerr) || rerr.Code != rpc.CodeInvalidArgument {
		t.Fatalf("folder: %v", err)
	}
}

// BenchmarkClipboardImage: decode + orient + PNG for a 24 MP JPEG (a typical
// camera photo), the work behind one Ctrl+C.
func BenchmarkClipboardImage(b *testing.B) {
	dir := b.TempDir()
	path := filepath.Join(dir, "big.jpg")
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, fixture.Pattern(6000, 4000, 1), &jpeg.Options{Quality: 90}); err != nil {
		b.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		b.Fatal(err)
	}
	probe, err := imaging.DefaultRegistry().ProbeFile(path, "jpg")
	if err != nil {
		b.Fatal(err)
	}
	out := filepath.Join(dir, "clip.png")
	b.ResetTimer()
	for b.Loop() {
		img, err := renderClipboard(probe)
		if err != nil {
			b.Fatal(err)
		}
		if err := writePNG(out, img); err != nil {
			b.Fatal(err)
		}
	}
}
