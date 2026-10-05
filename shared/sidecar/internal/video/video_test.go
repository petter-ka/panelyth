package video

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"fastview/sidecar/internal/fixture"
)

func tools(t *testing.T) *Tools {
	t.Helper()
	tl := Locate(os.Getenv)
	if !tl.Available() {
		t.Skip("ffmpeg/ffprobe not installed")
	}
	return tl
}

func makeVideo(t *testing.T, tl *Tools, name string, s fixture.VideoSpec) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := fixture.GenerateVideo(tl.FFmpeg, p, s); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestProbeAndFrame(t *testing.T) {
	tl := tools(t)
	p := makeVideo(t, tl, "clip.mp4", fixture.VideoSpec{Width: 320, Height: 180, Seconds: 2, Audio: true})
	info, err := tl.Probe(context.Background(), p, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if info.Width != 320 || info.Height != 180 || info.VideoCodec != "h264" || info.AudioCodec != "aac" {
		t.Fatalf("info = %+v", info)
	}
	if info.DurationMs < 1900 || info.DurationMs > 2200 {
		t.Fatalf("duration = %d ms", info.DurationMs)
	}
	img, err := tl.Frame(context.Background(), p, PosterTime(info.DurationMs), 160)
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 160 || b.Dy() != 90 {
		t.Fatalf("frame %v, want 160x90", b)
	}
	// Never upscaled.
	img, err = tl.Frame(context.Background(), p, 0, 2560)
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 320 || b.Dy() != 180 {
		t.Fatalf("frame %v, want 320x180", b)
	}
}

func TestRotationIsDisplayOrientation(t *testing.T) {
	tl := tools(t)
	p := makeVideo(t, tl, "phone.mp4", fixture.VideoSpec{Width: 320, Height: 180, Seconds: 1, Rotate: 90})
	info, err := tl.Probe(context.Background(), p, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if info.Width != 180 || info.Height != 320 {
		t.Fatalf("display size %dx%d, want 180x320", info.Width, info.Height)
	}
	img, err := tl.Frame(context.Background(), p, 0, 160)
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 90 || b.Dy() != 160 {
		t.Fatalf("frame %v, want 90x160 (autorotated)", b)
	}
}

func TestSeekPastEndFallsBackToFirstFrame(t *testing.T) {
	tl := tools(t)
	p := makeVideo(t, tl, "short.webm", fixture.VideoSpec{Width: 64, Height: 64, Seconds: 0.5, Codec: "libvpx-vp9"})
	img, err := tl.Frame(context.Background(), p, 30*time.Second, 64)
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 64 {
		t.Fatalf("frame %v", img.Bounds())
	}
}

func TestCorruptAndAudioOnly(t *testing.T) {
	tl := tools(t)
	dir := t.TempDir()
	bad := filepath.Join(dir, "bad.mp4")
	if err := os.WriteFile(bad, []byte("this is not a video file at all"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := tl.Probe(context.Background(), bad, 1, 1); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("corrupt probe err = %v", err)
	}
	if _, err := tl.Frame(context.Background(), bad, time.Second, 64); !errors.Is(err, ErrNoVideo) {
		t.Fatalf("corrupt frame err = %v", err)
	}
	audio := filepath.Join(dir, "tone.mkv")
	if err := runFF(tl, "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "libopus", audio); err != nil {
		t.Fatal(err)
	}
	info, err := tl.Probe(context.Background(), audio, 1, 1)
	if err != nil || info.VideoCodec != "" || info.AudioCodec != "opus" || info.Width != 0 {
		t.Fatalf("audio-only info = %+v, %v", info, err)
	}
	if _, err := tl.Frame(context.Background(), audio, 0, 64); !errors.Is(err, ErrNoVideo) {
		t.Fatalf("audio-only frame err = %v", err)
	}
}

func runFF(tl *Tools, args ...string) error {
	_, err := run(context.Background(), tl.FFmpeg, 1<<20, append([]string{"-nostdin", "-v", "error", "-y"}, args...)...)
	return err
}

func TestProbeCachedPerIdentity(t *testing.T) {
	tl := tools(t)
	p := makeVideo(t, tl, "c.mp4", fixture.VideoSpec{Width: 64, Height: 64, Seconds: 0.5})
	if _, err := tl.Probe(context.Background(), p, 10, 20); err != nil {
		t.Fatal(err)
	}
	// Point the tool at nothing: a cache hit must not start a process.
	saved := tl.FFprobe
	tl.FFprobe = filepath.Join(t.TempDir(), "missing")
	if _, err := tl.Probe(context.Background(), p, 10, 20); err != nil {
		t.Fatalf("cached probe started ffprobe: %v", err)
	}
	// A new identity (file changed) probes again.
	if _, err := tl.Probe(context.Background(), p, 11, 20); err == nil {
		t.Fatal("changed identity served from cache")
	}
	tl.FFprobe = saved
}

func TestCancelKillsProcess(t *testing.T) {
	tl := tools(t)
	p := makeVideo(t, tl, "c.mp4", fixture.VideoSpec{Width: 64, Height: 64, Seconds: 0.5})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := tl.Frame(ctx, p, 0, 64); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if _, err := tl.Probe(ctx, p, 1, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("probe err = %v", err)
	}
}

func TestUnavailable(t *testing.T) {
	tl := Locate(func(k string) string {
		if k == "FASTVIEW_FFMPEG" {
			return "off"
		}
		return ""
	})
	if tl.Available() {
		t.Fatal("off must disable tools")
	}
	if _, err := tl.Probe(context.Background(), "x.mp4", 1, 1); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
	var nilTools *Tools
	if nilTools.Available() {
		t.Fatal("nil tools available")
	}
}

func TestParseProbe(t *testing.T) {
	info, err := parseProbe([]byte(`{"streams":[
		{"codec_type":"video","codec_name":"mjpeg","width":600,"height":600,"disposition":{"attached_pic":1}},
		{"codec_type":"video","codec_name":"hevc","width":3840,"height":2160,"side_data_list":[{"rotation":-90}]},
		{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"12.345"}}`))
	if err != nil {
		t.Fatal(err)
	}
	want := Info{DurationMs: 12345, Width: 2160, Height: 3840, VideoCodec: "hevc", AudioCodec: "aac"}
	if info != want {
		t.Fatalf("got %+v want %+v", info, want)
	}
	if _, err := parseProbe([]byte(`{"streams":[],"format":{}}`)); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("empty: %v", err)
	}
	if PosterTime(0) != 0 || PosterTime(20_000) != 2*time.Second || PosterTime(3_600_000) != 10*time.Second {
		t.Fatal("poster time")
	}
}

// Benchmarks (Stage 06): `pnpm bench:go`. Fixtures are generated once per run.
func benchVideo(b *testing.B, w, h int) (*Tools, string) {
	b.Helper()
	tl := Locate(os.Getenv)
	if !tl.Available() {
		b.Skip("ffmpeg/ffprobe not installed")
	}
	p := filepath.Join(b.TempDir(), "bench.mp4")
	if err := fixture.GenerateVideo(tl.FFmpeg, p, fixture.VideoSpec{Width: w, Height: h, Seconds: 10, Audio: true}); err != nil {
		b.Fatal(err)
	}
	return tl, p
}

func BenchmarkProbe1080p(b *testing.B) {
	tl, p := benchVideo(b, 1920, 1080)
	for i := 0; b.Loop(); i++ {
		// A new identity each time: measure ffprobe, not the cache.
		if _, err := tl.Probe(context.Background(), p, int64(i), 0); err != nil {
			b.Fatal(err)
		}
	}
}

func benchPoster(b *testing.B, w, h, edge int) {
	tl, p := benchVideo(b, w, h)
	for b.Loop() {
		if _, err := tl.Frame(context.Background(), p, PosterTime(10_000), edge); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPoster1080pGridMd(b *testing.B)    { benchPoster(b, 1920, 1080, 384) }
func BenchmarkPoster1080pViewerFit(b *testing.B) { benchPoster(b, 1920, 1080, 2560) }
func BenchmarkPoster4KGridMd(b *testing.B)       { benchPoster(b, 3840, 2160, 384) }
