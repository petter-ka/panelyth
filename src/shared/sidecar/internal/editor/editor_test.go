package editor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/imaging"
)

func picture(w, h int, alpha bool) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			a := uint8(255)
			if alpha && x < w/4 {
				a = 0
			}
			img.SetNRGBA(x, y, color.NRGBA{uint8(x * 255 / w), uint8(y * 255 / h), uint8((x + y) % 256), a})
		}
	}
	return img
}

func writeJPEG(t testing.TB, dir, name string, w, h int) Source {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, picture(w, h, false), &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return Source{EntryID: 1, Path: p, Ext: "jpg"}
}

func writePNG(t testing.TB, dir, name string, w, h int, alpha bool) Source {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, picture(w, h, alpha)); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return Source{EntryID: 2, Path: p, Ext: "png"}
}

func edits(t testing.TB, js string) imaging.EditList {
	t.Helper()
	var e imaging.EditList
	if err := json.Unmarshal([]byte(js), &e); err != nil {
		t.Fatal(err)
	}
	return e
}

func manager(t testing.TB, cfg Config) *Manager {
	t.Helper()
	if cfg.TmpDir == "" {
		cfg.TmpDir = filepath.Join(t.TempDir(), "edit")
	}
	m := NewManager(cfg)
	t.Cleanup(m.Shutdown)
	return m
}

func TestOpenRenderClose(t *testing.T) {
	dir := t.TempDir()
	m := manager(t, Config{})
	s, err := m.Open(context.Background(), 1, writeJPEG(t, dir, "a.jpg", 4000, 3000))
	if err != nil {
		t.Fatal(err)
	}
	if s.Width != 4000 || s.Height != 3000 || s.Format != "jpeg" || s.HasAlpha || s.Notice != "" {
		t.Fatalf("session %+v", s)
	}
	if e := max(s.proxy.Rect.Dx(), s.proxy.Rect.Dy()); e != ProxyEdge {
		t.Fatalf("proxy edge %d", e)
	}
	res, err := s.Render(context.Background(), RenderRequest{Rev: 1, MaxEdge: 1000, Histogram: true,
		Edits: edits(t, `[{"op":"rotate","p":{"angle":90}},{"op":"crop","p":{"rect":{"x":0,"y":0,"w":0.5,"h":0.5}}}]`)})
	if err != nil {
		t.Fatal(err)
	}
	if res.Superseded || res.OutWidth != 1500 || res.OutHeight != 2000 || res.Mime != "image/jpeg" {
		t.Fatalf("result %+v", res)
	}
	if max(res.Width, res.Height) < 1000 || max(res.Width, res.Height) > 1064 {
		t.Fatalf("frame %dx%d for a 1000 px view", res.Width, res.Height)
	}
	if res.Stats == nil || res.Stats.Pixels != uint32(res.Width*res.Height) {
		t.Fatal("no histogram of the frame")
	}
	f, err := os.Open(res.File)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := jpeg.DecodeConfig(f)
	f.Close()
	if err != nil || cfg.Width != res.Width || cfg.Height != res.Height {
		t.Fatalf("frame file: %v %v", cfg, err)
	}
	if !m.Close(s.ID) || m.Close(s.ID) {
		t.Fatal("close is not reported once")
	}
	if _, err := os.Stat(res.File); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("frames outlive their session")
	}
	if _, err := m.Get(s.ID); !errors.Is(err, ErrGone) {
		t.Fatalf("closed session: %v", err)
	}
	if _, err := s.Render(context.Background(), RenderRequest{Rev: 2, MaxEdge: 500}); !errors.Is(err, ErrGone) {
		t.Fatalf("render after close: %v", err)
	}
}

func TestSmallPictureIsItsOwnProxy(t *testing.T) {
	m := manager(t, Config{})
	s, err := m.Open(context.Background(), 1, writePNG(t, t.TempDir(), "s.png", 300, 200, true))
	if err != nil {
		t.Fatal(err)
	}
	if !s.HasAlpha || s.proxy.Rect.Dx() != 300 {
		t.Fatalf("alpha %v proxy %v", s.HasAlpha, s.proxy.Rect)
	}
	// A frame is never larger than the picture; what is transparent is
	// drawn on a checkerboard, so the frame is opaque.
	res, err := s.Render(context.Background(), RenderRequest{Rev: 1, MaxEdge: 2000})
	if err != nil || res.Width != 300 || res.Height != 200 || res.Mime != "image/jpeg" {
		t.Fatalf("%+v %v", res, err)
	}
	// Enlarging beyond the proxy's resolution is bounded by the proxy.
	res, err = s.Render(context.Background(), RenderRequest{Rev: 2, MaxEdge: 2000,
		Edits: edits(t, `[{"op":"resize","p":{"mode":"percent","w":400}}]`)})
	if err != nil || res.OutWidth != 1200 || res.Width != 1200 {
		t.Fatalf("%+v %v", res, err)
	}
}

func TestOneSessionPerOwner(t *testing.T) {
	dir := t.TempDir()
	m := manager(t, Config{})
	a, _ := m.Open(context.Background(), 7, writeJPEG(t, dir, "a.jpg", 400, 300))
	b, _ := m.Open(context.Background(), 8, writeJPEG(t, dir, "b.jpg", 400, 300))
	c, err := m.Open(context.Background(), 7, writeJPEG(t, dir, "c.jpg", 400, 300))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Get(a.ID); !errors.Is(err, ErrGone) {
		t.Fatal("the owner's first session stayed open")
	}
	if _, err := m.Get(b.ID); err != nil {
		t.Fatal("another owner's session was closed")
	}
	if _, err := m.Get(c.ID); err != nil || m.Count() != 2 {
		t.Fatalf("sessions: %d %v", m.Count(), err)
	}
}

func TestRefusals(t *testing.T) {
	dir := t.TempDir()
	m := manager(t, Config{})
	ctx := context.Background()
	// An animated GIF.
	pal := color.Palette{color.Black, color.White}
	var buf bytes.Buffer
	frames := []*image.Paletted{image.NewPaletted(image.Rect(0, 0, 8, 8), pal), image.NewPaletted(image.Rect(0, 0, 8, 8), pal)}
	_ = gif.EncodeAll(&buf, &gif.GIF{Image: frames, Delay: []int{5, 5}})
	anim := filepath.Join(dir, "anim.gif")
	_ = os.WriteFile(anim, buf.Bytes(), 0o644)
	if _, err := m.Open(ctx, 1, Source{Path: anim, Ext: "gif"}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("animated gif: %v", err)
	}
	buf.Reset()
	_ = gif.Encode(&buf, frames[0], nil)
	still := filepath.Join(dir, "still.gif")
	_ = os.WriteFile(still, buf.Bytes(), 0o644)
	if s, err := m.Open(ctx, 1, Source{Path: still, Ext: "gif"}); err != nil || s.Format != "gif" {
		t.Fatalf("single-frame gif: %v", err)
	}
	if _, err := m.Open(ctx, 3, Source{Path: filepath.Join(dir, "x.heic"), Ext: "heic"}); err == nil {
		t.Fatal("a missing file opened")
	}
	raw := filepath.Join(dir, "x.heic")
	_ = os.WriteFile(raw, []byte("heic"), 0o644)
	if _, err := m.Open(ctx, 3, Source{Path: raw, Ext: "heic"}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("no decoder: %v", err)
	}
	bad := filepath.Join(dir, "bad.jpg")
	_ = os.WriteFile(bad, []byte("not a jpeg"), 0o644)
	if _, err := m.Open(ctx, 3, Source{Path: bad, Ext: "jpg"}); !errors.Is(err, imaging.ErrCorrupt) {
		t.Fatalf("garbage: %v", err)
	}
	// 10001 × 10001 pixels is over the cap; the header is enough to refuse.
	var hdr bytes.Buffer
	_ = png.Encode(&hdr, image.NewGray(image.Rect(0, 0, 1, 1)))
	huge := pngWithSize(hdr.Bytes(), 10001, 10001)
	hp := filepath.Join(dir, "huge.png")
	_ = os.WriteFile(hp, huge, 0o644)
	if _, err := m.Open(ctx, 3, Source{Path: hp, Ext: "png"}); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("over the cap: %v", err)
	}
	if m.Count() != 1 {
		t.Fatalf("failed opens left sessions: %d", m.Count())
	}
	s, _ := m.Open(ctx, 2, writeJPEG(t, dir, "ok.jpg", 100, 100))
	for _, js := range []string{`[{"op":"nope"}]`, `[{"op":"crop","p":{}}]`} {
		if _, err := s.Render(ctx, RenderRequest{Rev: 1, Edits: edits(t, js)}); !errors.Is(err, imaging.ErrInvalidEdit) {
			t.Errorf("%s: %v", js, err)
		}
	}
	if _, err := s.Render(ctx, RenderRequest{Rev: 1, Edits: edits(t, `[{"op":"resize","p":{"mode":"pixels","w":65000,"h":65000}}]`)}); !errors.Is(err, imaging.ErrTooLarge) {
		t.Errorf("huge result: %v", err)
	}
	// A refused list does not use up the revision.
	if res, err := s.Render(ctx, RenderRequest{Rev: 1}); err != nil || res.Superseded {
		t.Fatalf("after refusals: %+v %v", res, err)
	}
}

func pngWithSize(b []byte, w, h uint32) []byte {
	out := bytes.Clone(b)
	put := func(off int, v uint32) {
		out[off], out[off+1], out[off+2], out[off+3] = byte(v>>24), byte(v>>16), byte(v>>8), byte(v)
	}
	put(16, w)
	put(20, h)
	crc := crc32IEEE(out[12:29])
	put(29, crc)
	return out
}

func crc32IEEE(b []byte) uint32 {
	crc := ^uint32(0)
	for _, v := range b {
		crc ^= uint32(v)
		for range 8 {
			if crc&1 != 0 {
				crc = crc>>1 ^ 0xEDB88320
			} else {
				crc >>= 1
			}
		}
	}
	return ^crc
}

func TestLatestRevisionWins(t *testing.T) {
	m := manager(t, Config{})
	s, err := m.Open(context.Background(), 1, writeJPEG(t, t.TempDir(), "a.jpg", 3000, 2000))
	if err != nil {
		t.Fatal(err)
	}
	// Many revisions at once: only the newest must produce a frame; an
	// older one may finish first, but none arrives after a newer one.
	const n = 24
	var wg sync.WaitGroup
	var frames, superseded atomic.Int32
	results := make([]RenderResult, n+1)
	for rev := 1; rev <= n; rev++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := s.Render(context.Background(), RenderRequest{Rev: int64(rev), MaxEdge: 2000,
				Edits: edits(t, `[{"op":"rotate","p":{"angle":`+strings.Repeat("1", 1+rev%3)+`,"mode":"expand"}}]`)})
			if err != nil {
				t.Errorf("rev %d: %v", rev, err)
				return
			}
			results[rev] = res
			if res.Superseded {
				superseded.Add(1)
			} else {
				frames.Add(1)
			}
		}()
	}
	wg.Wait()
	if results[n].Superseded || results[n].File == "" {
		t.Fatal("the newest revision has no frame")
	}
	if superseded.Load() == 0 {
		t.Fatal("every revision rendered: nothing was superseded")
	}
	// An older revision after the newest is dropped without work.
	res, err := s.Render(context.Background(), RenderRequest{Rev: 3, MaxEdge: 2000})
	if err != nil || !res.Superseded {
		t.Fatalf("stale revision: %+v %v", res, err)
	}
	// At most the last few frame files remain.
	left, _ := filepath.Glob(filepath.Join(s.dir, s.ID+"-*"))
	if len(left) == 0 || len(left) > keepFrames {
		t.Fatalf("%d frame files kept", len(left))
	}
}

func TestCallerCancelIsNotSuperseded(t *testing.T) {
	m := manager(t, Config{})
	s, _ := m.Open(context.Background(), 1, writeJPEG(t, t.TempDir(), "a.jpg", 2000, 1500))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.Render(ctx, RenderRequest{Rev: 1, MaxEdge: 2000, Edits: edits(t, `[{"op":"rotate","p":{"angle":5}}]`)}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled by the caller: %v", err)
	}
}

func TestPrefixCache(t *testing.T) {
	m := manager(t, Config{})
	s, _ := m.Open(context.Background(), 1, writeJPEG(t, t.TempDir(), "a.jpg", 1600, 1200))
	ctx := context.Background()
	list := func(angle string) imaging.EditList {
		return edits(t, `[{"op":"flip","p":{"axis":"h"}},{"op":"crop","p":{"rect":{"x":0.1,"y":0.1,"w":0.8,"h":0.8}}},{"op":"rotate","p":{"angle":`+angle+`,"mode":"fill"}}]`)
	}
	first, err := s.Render(ctx, RenderRequest{Rev: 1, MaxEdge: 1600, Edits: list("3")})
	if err != nil {
		t.Fatal(err)
	}
	if s.Checkpoints() != 2 {
		t.Fatalf("%d checkpoints after one render", s.Checkpoints())
	}
	// Changing the last operation starts from the kept prefix: the same
	// pixels as a session that renders the list from scratch.
	second, err := s.Render(ctx, RenderRequest{Rev: 2, MaxEdge: 1600, Edits: list("4")})
	if err != nil {
		t.Fatal(err)
	}
	fresh, _ := m.Open(ctx, 2, s.Source)
	want, err := fresh.Render(ctx, RenderRequest{Rev: 1, MaxEdge: 1600, Edits: list("4")})
	if err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(second.File)
	b, _ := os.ReadFile(want.File)
	if !bytes.Equal(a, b) || len(a) == 0 {
		t.Fatal("a render from a checkpoint differs from a render from scratch")
	}
	// The same list again is served from the result checkpoint.
	again, _ := s.Render(ctx, RenderRequest{Rev: 3, MaxEdge: 1600, Edits: list("3")})
	c, _ := os.ReadFile(again.File)
	d, _ := os.ReadFile(first.File)
	if !bytes.Equal(c, d) {
		t.Fatal("re-rendering a list gives another frame")
	}
	for rev := int64(4); rev < 12; rev++ {
		if _, err := s.Render(ctx, RenderRequest{Rev: rev, MaxEdge: 1600, Edits: list(strings.Repeat("2", int(rev-3)%2+1))}); err != nil {
			t.Fatal(err)
		}
	}
	if s.Checkpoints() > MaxCheckpoints {
		t.Fatalf("%d checkpoints", s.Checkpoints())
	}
}

func TestMemoryReservation(t *testing.T) {
	var held atomic.Int64
	limit := int64(20_000_000)
	reserve := func(ctx context.Context, n int64) (func(), error) {
		if held.Load()+n > limit {
			return nil, errors.New("over budget")
		}
		held.Add(n)
		return func() { held.Add(-n) }, nil
	}
	dir := t.TempDir()
	m := manager(t, Config{Reserve: reserve})
	s, err := m.Open(context.Background(), 1, writeJPEG(t, dir, "a.jpg", 800, 600))
	if err != nil {
		t.Fatal(err)
	}
	if got := held.Load(); got != sessionPixels*800*600 {
		t.Fatalf("a session holds %d pixels", got)
	}
	// A picture whose decode does not fit the budget is refused, and
	// nothing stays reserved for it.
	if _, err := m.Open(context.Background(), 2, writeJPEG(t, dir, "big.jpg", 4000, 3000)); err == nil {
		t.Fatal("opened beyond the budget")
	}
	if got := held.Load(); got != sessionPixels*800*600 {
		t.Fatalf("a refused open leaked %d pixels", got)
	}
	m.Close(s.ID)
	if held.Load() != 0 {
		t.Fatalf("%d pixels held after close", held.Load())
	}
}

func TestIdleTimeoutAndShutdown(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "edit")
	// Frames left by a crash are removed at start.
	_ = os.MkdirAll(tmp, 0o700)
	stale := filepath.Join(tmp, "old-1.jpg")
	_ = os.WriteFile(stale, []byte("x"), 0o600)
	m := NewManager(Config{TmpDir: tmp, Idle: 80 * time.Millisecond})
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a stale frame survived the start")
	}
	s, err := m.Open(context.Background(), 1, writeJPEG(t, t.TempDir(), "a.jpg", 200, 100))
	if err != nil {
		t.Fatal(err)
	}
	res, _ := s.Render(context.Background(), RenderRequest{Rev: 1, MaxEdge: 200})
	deadline := time.Now().Add(3 * time.Second)
	for m.Count() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if m.Count() != 0 {
		t.Fatal("an idle session stayed open")
	}
	if _, err := os.Stat(res.File); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("an idle session's frame stayed")
	}
	other, _ := m.Open(context.Background(), 2, writeJPEG(t, t.TempDir(), "b.jpg", 200, 100))
	m.Shutdown()
	m.Shutdown()
	if _, err := other.Render(context.Background(), RenderRequest{Rev: 1}); !errors.Is(err, ErrGone) {
		t.Fatalf("render after shutdown: %v", err)
	}
	if _, err := m.Open(context.Background(), 3, other.Source); !errors.Is(err, ErrGone) {
		t.Fatalf("open after shutdown: %v", err)
	}
}

func TestEstimate(t *testing.T) {
	dir := t.TempDir()
	m := manager(t, Config{})
	src := writeJPEG(t, dir, "a.jpg", 3000, 2000)
	s, _ := m.Open(context.Background(), 1, src)
	ctx := context.Background()
	e := edits(t, `[{"op":"resize","p":{"mode":"percent","w":50}}]`)
	for _, format := range []string{"jpeg", "png", "bmp", "tiff", "gif"} {
		est, err := s.Estimate(ctx, e, format, 85, imaging.MetaKeep)
		if err != nil {
			t.Fatal(err)
		}
		dest := filepath.Join(dir, "out."+imaging.SaveFormats[format])
		res, err := Save(ctx, SaveRequest{Source: src, Size: s.Size, MtimeNs: s.MtimeNs, Edits: e, Dest: dest, Format: format, Quality: 85, Policy: imaging.MetaKeep})
		if err != nil {
			t.Fatal(err)
		}
		ratio := float64(est) / float64(res.Bytes)
		if ratio < 0.5 || ratio > 2 {
			t.Errorf("%s: estimated %d, saved %d", format, est, res.Bytes)
		}
	}
	if _, err := s.Estimate(ctx, e, "webp", 85, imaging.MetaKeep); !errors.Is(err, imaging.ErrInvalidEdit) {
		t.Fatalf("unknown format: %v", err)
	}
}

func TestSaveCopyAndReplace(t *testing.T) {
	dir := t.TempDir()
	m := manager(t, Config{})
	src := writeJPEG(t, dir, "photo.jpg", 1200, 800)
	original, _ := os.ReadFile(src.Path)
	s, _ := m.Open(context.Background(), 1, src)
	ctx := context.Background()
	e := edits(t, `[{"op":"rotate","p":{"angle":90}},{"op":"resize","p":{"mode":"fit","w":400,"h":400}}]`)
	name, ok := CopyName(dir, src.Path, "jpg")
	if !ok || name != "photo (edited).jpg" {
		t.Fatalf("copy name %q", name)
	}
	var steps []int
	req := SaveRequest{Source: src, Size: s.Size, MtimeNs: s.MtimeNs, Edits: e, Dest: filepath.Join(dir, name),
		Format: "jpeg", Quality: 90, Policy: imaging.MetaKeep, DPI: imaging.DPI{X: 200},
		Step: func(done, total int, _ int64) {
			if total != saveSteps {
				t.Errorf("total %d", total)
			}
			if len(steps) == 0 || steps[len(steps)-1] != done {
				steps = append(steps, done)
			}
		}}
	res, err := Save(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if res.Width != 267 || res.Height != 400 || res.Trashed || len(steps) != saveSteps {
		t.Fatalf("%+v steps %v", res, steps)
	}
	meta, _ := imaging.ReadMetadata(res.Path, "jpeg")
	if meta.DPI != (imaging.DPI{X: 200, Y: 200}) {
		t.Fatalf("resolution %v", meta.DPI)
	}
	if now, _ := os.ReadFile(src.Path); !bytes.Equal(now, original) {
		t.Fatal("saving a copy changed the original")
	}
	// The same name again is not overwritten silently.
	if _, err := Save(ctx, req); fileops.Code(err) != fileops.CodeExists {
		t.Fatalf("second save over the copy: %v", err)
	}
	if next, _ := CopyName(dir, src.Path, "jpg"); next != "photo (edited) (2).jpg" {
		t.Fatalf("next copy name %q", next)
	}
	// Save as over an existing file, confirmed by the dialog.
	req.Overwrite = true
	if _, err := Save(ctx, req); err != nil {
		t.Fatal(err)
	}

	// Replace: the original goes to the trash first.
	var trashed []string
	replace := SaveRequest{Source: src, Size: s.Size, MtimeNs: s.MtimeNs, Edits: e, Dest: src.Path, Replace: true,
		Format: "jpeg", Policy: imaging.MetaKeep, Trash: func(p string) error {
			trashed = append(trashed, p)
			return os.Rename(p, p+".trashed")
		}}
	res, err = Save(ctx, replace)
	if err != nil || !res.Trashed || len(trashed) != 1 {
		t.Fatalf("replace: %+v %v", res, err)
	}
	if kept, _ := os.ReadFile(src.Path + ".trashed"); !bytes.Equal(kept, original) {
		t.Fatal("the trashed original is not the original")
	}
	cfg, _ := decodeConfig(t, src.Path)
	if cfg.Width != 267 || cfg.Height != 400 {
		t.Fatalf("replaced file is %dx%d", cfg.Width, cfg.Height)
	}
	// The session is about the old file: saving from it again is refused.
	if _, err := Save(ctx, replace); !errors.Is(err, ErrChanged) {
		t.Fatalf("save from a changed file: %v", err)
	}
	if left := partials(t, dir); len(left) != 0 {
		t.Fatalf("partial files left: %v", left)
	}
}

func decodeConfig(t testing.TB, path string) (image.Config, error) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	return jpeg.DecodeConfig(f)
}

func partials(t testing.TB, dir string) []string {
	t.Helper()
	entries, _ := os.ReadDir(dir)
	var out []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), fileops.PartialSuffix) {
			out = append(out, e.Name())
		}
	}
	return out
}

func TestSaveFailuresLeaveTheOriginal(t *testing.T) {
	dir := t.TempDir()
	m := manager(t, Config{})
	src := writeJPEG(t, dir, "photo.jpg", 1500, 1000)
	original, _ := os.ReadFile(src.Path)
	s, _ := m.Open(context.Background(), 1, src)
	e := edits(t, `[{"op":"flip","p":{"axis":"h"}}]`)
	base := SaveRequest{Source: src, Size: s.Size, MtimeNs: s.MtimeNs, Edits: e, Format: "jpeg", Policy: imaging.MetaKeep}
	untouched := func(when string) {
		t.Helper()
		if now, err := os.ReadFile(src.Path); err != nil || !bytes.Equal(now, original) {
			t.Fatalf("%s: the original changed (%v)", when, err)
		}
		if left := partials(t, dir); len(left) != 0 {
			t.Fatalf("%s: partial files left: %v", when, left)
		}
	}

	// The trash is unavailable.
	replace := base
	replace.Dest, replace.Replace = src.Path, true
	replace.Trash = func(string) error { return fileops.Errorf(fileops.CodeTrashUnavailable, "no trash on this drive") }
	if _, err := Save(context.Background(), replace); !IsTrashUnavailable(err) {
		t.Fatalf("no trash: %v", err)
	}
	untouched("no trash")

	// Cancelled at each step.
	for stop := 1; stop <= 4; stop++ {
		ctx, cancel := context.WithCancel(context.Background())
		req := replace
		req.Trash = func(string) error { t.Error("the original was trashed by a cancelled save"); return nil }
		req.Step = func(done, _ int, _ int64) {
			if done >= stop {
				cancel()
			}
		}
		if _, err := Save(ctx, req); !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel at step %d: %v", stop, err)
		}
		cancel()
		untouched("cancelled")
	}

	// The destination folder is gone, the format is unknown, the list is bad.
	gone := base
	gone.Dest = filepath.Join(dir, "missing", "x.jpg")
	if _, err := Save(context.Background(), gone); err == nil {
		t.Fatal("saved into a missing folder")
	}
	bad := base
	bad.Dest, bad.Format = filepath.Join(dir, "x.webp"), "webp"
	if _, err := Save(context.Background(), bad); !errors.Is(err, imaging.ErrInvalidEdit) {
		t.Fatalf("unknown format: %v", err)
	}
	bad = base
	bad.Dest, bad.Edits = filepath.Join(dir, "x.jpg"), edits(t, `[{"op":"resize","p":{"mode":"pixels","w":65000,"h":65000}}]`)
	if _, err := Save(context.Background(), bad); !errors.Is(err, imaging.ErrTooLarge) {
		t.Fatalf("huge result: %v", err)
	}
	untouched("refused saves")

	// The file changed on disk after the session opened it.
	later := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(src.Path, later, later); err != nil {
		t.Fatal(err)
	}
	changed := base
	changed.Dest = filepath.Join(dir, "copy.jpg")
	if _, err := Save(context.Background(), changed); !errors.Is(err, ErrChanged) {
		t.Fatalf("changed file: %v", err)
	}
	if _, err := os.Stat(changed.Dest); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a refused save wrote a file")
	}
}

func TestGoroutinesStayBounded(t *testing.T) {
	m := manager(t, Config{})
	s, _ := m.Open(context.Background(), 1, writeJPEG(t, t.TempDir(), "a.jpg", 2400, 1600))
	before := goroutines()
	for rev := int64(1); rev <= 20; rev++ {
		if _, err := s.Render(context.Background(), RenderRequest{Rev: rev, MaxEdge: 2400, Histogram: true,
			Edits: edits(t, `[{"op":"rotate","p":{"angle":`+strings.Repeat("3", int(rev%3)+1)+`}}]`)}); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(50 * time.Millisecond)
	if after := goroutines(); after > before+2 {
		t.Fatalf("goroutines grew from %d to %d", before, after)
	}
}

func goroutines() int { return runtime.NumGoroutine() }
