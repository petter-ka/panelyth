package editor

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"panelyth/sidecar/internal/imaging"
)

// blocks writes a PNG of four flat quarters: red, green, blue and white.
func blocks(t testing.TB, dir string, w, h int) Source {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			c := color.NRGBA{255, 0, 0, 255}
			switch {
			case x >= w/2 && y < h/2:
				c = color.NRGBA{0, 255, 0, 255}
			case x < w/2 && y >= h/2:
				c = color.NRGBA{0, 0, 255, 255}
			case x >= w/2:
				c = color.NRGBA{255, 255, 255, 255}
			}
			img.SetNRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "blocks.png")
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return Source{EntryID: 3, Path: p, Ext: "png"}
}

func TestBeforeHistogram(t *testing.T) {
	m := manager(t, Config{})
	s, _ := m.Open(context.Background(), 1, blocks(t, t.TempDir(), 400, 300))
	ctx := context.Background()
	list := edits(t, `[{"op":"negative","p":{}},{"op":"lighting","p":{"brightness":-50}}]`)
	// Before the first operation: the picture itself.
	res, err := s.Render(ctx, RenderRequest{Rev: 1, MaxEdge: 400, Edits: list, Histogram: true, Before: true, BeforeAt: 0})
	if err != nil || res.Before == nil {
		t.Fatalf("%v %v", res.Before, err)
	}
	if res.Before.R[255] != 400*300/2 || res.Before.R[0] != 400*300/2 {
		t.Fatalf("histogram before any operation: %d at 255, %d at 0", res.Before.R[255], res.Before.R[0])
	}
	// Before the second: the negative. The white quarter is black now.
	res, err = s.Render(ctx, RenderRequest{Rev: 2, MaxEdge: 400, Edits: list, Histogram: true, Before: true, BeforeAt: 1})
	if err != nil || res.Before == nil {
		t.Fatalf("%v %v", res.Before, err)
	}
	if res.Before.Lum[0] != 400*300/4 || res.Stats.Mean >= res.Before.Mean {
		t.Fatalf("histogram before the second operation: %d black pixels, mean %.0f; after it: mean %.0f",
			res.Before.Lum[0], res.Before.Mean, res.Stats.Mean)
	}
	// Changing the second operation serves it again from the checkpoint.
	list2 := edits(t, `[{"op":"negative","p":{}},{"op":"lighting","p":{"brightness":30}}]`)
	again, err := s.Render(ctx, RenderRequest{Rev: 3, MaxEdge: 400, Edits: list2, Before: true, BeforeAt: 1})
	if err != nil || again.Before == nil || *again.Before != *res.Before {
		t.Fatal("the histogram before the tool changed with the tool's own parameters")
	}
	// Not asked for, or out of range: none.
	plain, _ := s.Render(ctx, RenderRequest{Rev: 4, MaxEdge: 400, Edits: list})
	far, _ := s.Render(ctx, RenderRequest{Rev: 5, MaxEdge: 400, Edits: list, Before: true, BeforeAt: 9})
	if plain.Before != nil || far.Before != nil {
		t.Fatal("a histogram nobody asked for")
	}
}

func TestProbe(t *testing.T) {
	m := manager(t, Config{})
	s, _ := m.Open(context.Background(), 1, blocks(t, t.TempDir(), 400, 300))
	ctx := context.Background()
	for _, c := range []struct {
		x, y float64
		want [4]uint8
	}{
		{0.25, 0.25, [4]uint8{255, 0, 0, 255}},
		{0.75, 0.25, [4]uint8{0, 255, 0, 255}},
		{0.25, 0.75, [4]uint8{0, 0, 255, 255}},
		{0.75, 0.75, [4]uint8{255, 255, 255, 255}},
		{0, 0, [4]uint8{255, 0, 0, 255}},
		{1, 1, [4]uint8{255, 255, 255, 255}},
		{-3, 7, [4]uint8{0, 0, 255, 255}},
	} {
		got, err := s.Probe(ctx, nil, 400, c.x, c.y, 2)
		if err != nil || got != c.want {
			t.Errorf("probe %v,%v: %v %v", c.x, c.y, got, err)
		}
	}
	// The probe sees the list it is given: after a negative, red is cyan.
	got, err := s.Probe(ctx, edits(t, `[{"op":"negative","p":{}}]`), 400, 0.25, 0.25, 2)
	if err != nil || got != [4]uint8{0, 255, 255, 255} {
		t.Fatalf("probe after a negative: %v %v", got, err)
	}
	// On the border between two quarters the average is in between.
	mixed, _ := s.Probe(ctx, nil, 400, 0.5, 0.25, 4)
	if mixed[0] == 0 || mixed[0] == 255 || mixed[1] == 0 || mixed[1] == 255 {
		t.Fatalf("average over a border: %v", mixed)
	}
	if _, err := s.Probe(ctx, edits(t, `[{"op":"nope"}]`), 400, 0.5, 0.5, 2); !errors.Is(err, imaging.ErrInvalidEdit) {
		t.Fatalf("invalid list: %v", err)
	}
	m.Close(s.ID)
	if _, err := s.Probe(ctx, nil, 400, 0.5, 0.5, 2); !errors.Is(err, ErrGone) {
		t.Fatalf("closed session: %v", err)
	}
}

func TestThumbs(t *testing.T) {
	m := manager(t, Config{})
	s, _ := m.Open(context.Background(), 1, writeJPEG(t, t.TempDir(), "a.jpg", 1600, 1200))
	ctx := context.Background()
	lists := []imaging.EditList{
		nil,
		edits(t, `[{"op":"grayscale","p":{}}]`),
		edits(t, `[{"op":"rotate","p":{"angle":90}}]`),
		edits(t, `[{"op":"nope"}]`),
		edits(t, `[{"op":"resize","p":{"mode":"percent","w":400}}]`),
	}
	thumbs, err := s.Thumbs(ctx, lists, 160)
	if err != nil || len(thumbs) != len(lists) {
		t.Fatalf("%d thumbs, %v", len(thumbs), err)
	}
	for i, th := range thumbs {
		if i == 3 {
			// An invalid list has no thumbnail and stops nothing.
			if th.File != "" {
				t.Fatal("a thumbnail for an invalid list")
			}
			continue
		}
		f, err := os.Open(th.File)
		if err != nil {
			t.Fatal(err)
		}
		cfg, err := jpeg.DecodeConfig(f)
		f.Close()
		if err != nil || cfg.Width != th.Width || cfg.Height != th.Height || max(cfg.Width, cfg.Height) > 160 {
			t.Fatalf("thumb %d: %dx%d %v", i, cfg.Width, cfg.Height, err)
		}
	}
	if thumbs[0].Width != 160 || thumbs[0].Height != 120 || thumbs[2].Width != 120 || thumbs[2].Height != 160 {
		t.Fatalf("thumb sizes: %+v %+v", thumbs[0], thumbs[2])
	}
	// A new batch replaces the files of the last one.
	old := thumbs[0].File
	if _, err := s.Thumbs(ctx, lists[:2], 160); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(old); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("thumbnails of the previous batch were kept")
	}
	// Thumbnails do not disturb the frame revisions.
	if res, err := s.Render(ctx, RenderRequest{Rev: 1, MaxEdge: 800}); err != nil || res.Superseded {
		t.Fatalf("render after thumbs: %+v %v", res, err)
	}
	too := make([]imaging.EditList, MaxThumbs+1)
	if _, err := s.Thumbs(ctx, too, 160); !errors.Is(err, imaging.ErrInvalidEdit) {
		t.Fatalf("too many thumbnails: %v", err)
	}
	left, _ := s.Thumbs(ctx, lists[:1], 160)
	m.Close(s.ID)
	if _, err := os.Stat(left[0].File); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("thumbnails outlive their session")
	}
}

func TestCountColors(t *testing.T) {
	dir := t.TempDir()
	var held int64
	m := manager(t, Config{Reserve: func(_ context.Context, n int64) (func(), error) {
		held += n
		return func() { held -= n }, nil
	}})
	s, _ := m.Open(context.Background(), 1, blocks(t, dir, 3000, 2600))
	ctx := context.Background()
	steady := held
	// The original at full size: exactly four colors, a quarter each.
	orig, err := s.CountColors(ctx, edits(t, `[{"op":"negative","p":{}}]`), ScopeOriginal, 8)
	if err != nil {
		t.Fatal(err)
	}
	if orig.Distinct != 4 || orig.HasAlpha || orig.Width != 3000 || orig.Height != 2600 || len(orig.Palette) != 4 {
		t.Fatalf("original: %+v", orig)
	}
	for _, sw := range orig.Palette {
		if sw.Share != 0.25 {
			t.Fatalf("share of %s: %v", sw.Hex, sw.Share)
		}
	}
	// Edited: reduced to two gray levels.
	two, err := s.CountColors(ctx, edits(t, `[{"op":"reduceColors","p":{"count":2,"quantizer":"gray"}}]`), ScopeEdited, 8)
	if err != nil || two.Distinct != 2 {
		t.Fatalf("edited: %+v %v", two, err)
	}
	// The preview scope counts the proxy: the same four here, at proxy size.
	pre, err := s.CountColors(ctx, nil, ScopePreview, 8)
	if err != nil || pre.Width != ProxyEdge || pre.Distinct < 4 {
		t.Fatalf("preview: %+v %v", pre, err)
	}
	if held != steady {
		t.Fatalf("counting left %d pixels reserved", held-steady)
	}
	// The file changed its size since it was opened.
	blocks(t, dir, 200, 100)
	if _, err := s.CountColors(ctx, nil, ScopeOriginal, 8); !errors.Is(err, ErrChanged) {
		t.Fatalf("changed file: %v", err)
	}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := s.CountColors(cctx, nil, ScopePreview, 8); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
}
