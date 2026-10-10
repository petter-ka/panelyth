package preview

import (
	"os"
	"path/filepath"
	"testing"

	"panelyth/sidecar/internal/fixture"
	"panelyth/sidecar/internal/video"
)

func videoTools(t *testing.T) *video.Tools {
	t.Helper()
	tl := video.Locate(os.Getenv)
	if !tl.Available() {
		t.Skip("ffmpeg/ffprobe not installed")
	}
	return tl
}

func idsByName(r *rig) map[string]int64 {
	items, err := r.store.LoadItems(bg, r.ids())
	if err != nil {
		r.t.Fatal(err)
	}
	out := map[string]int64{}
	for _, it := range items {
		out[it.Name] = it.ID
	}
	return out
}

func TestVideoPosterGeneratedCachedAndReused(t *testing.T) {
	tl := videoTools(t)
	r := newRigWith(t, fixture.ImageSpec{Count: 1, Width: 64, Height: 64}, tl, func(root string) {
		if err := fixture.GenerateVideo(tl.FFmpeg, filepath.Join(root, "clip.mp4"), fixture.VideoSpec{Width: 640, Height: 360, Seconds: 2}); err != nil {
			t.Fatal(err)
		}
	})
	id := idsByName(r)["clip.mp4"]
	res := r.ensure(1, []int64{id})
	if res.Queued != 1 || len(res.Items) != 0 {
		t.Fatalf("first ensure: %+v", res)
	}
	got := r.waitItems([]int64{id})[id]
	if got.Failed != "" || got.Width != 384 || got.Height != 216 {
		t.Fatalf("poster: %+v", got)
	}
	if _, err := os.Stat(filePath(got.URL, r.disk)); err != nil {
		t.Fatalf("poster file: %v", err)
	}
	// Cached: served without generation, after a restart too, and attached to pages.
	r.restart()
	again := r.ensure(2, []int64{id})
	if again.Queued != 0 || len(again.Items) != 1 || again.Items[0].URL != got.URL {
		t.Fatalf("cached poster not reused: %+v", again)
	}
	items, _ := r.store.LoadItems(bg, []int64{id})
	thumbs, err := r.svc.Thumbs(bg, items, GridMd)
	if err != nil || thumbs[id].URL != got.URL {
		t.Fatalf("page thumbs: %+v %v", thumbs, err)
	}
	// Video dimensions are recorded like image dimensions (sort by size).
	r.svc.flush()
	detail, err := r.store.Entry(bg, id)
	if err != nil || detail.Width != 640 || detail.Height != 360 {
		t.Fatalf("dimensions: %+v %v", detail, err)
	}
}

func TestBrokenAndAudioOnlyVideosFailPermanently(t *testing.T) {
	tl := videoTools(t)
	r := newRigWith(t, fixture.ImageSpec{Count: 0}, tl, func(root string) {
		if err := os.WriteFile(filepath.Join(root, "broken.mp4"), []byte("garbage, not a video"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "empty.webm"), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	})
	ids := idsByName(r)
	broken, empty := ids["broken.mp4"], ids["empty.webm"]
	got := r.waitItemsAfter(1, []int64{broken, empty})
	if got[broken].Failed != "CORRUPT_MEDIA" || got[empty].Failed != "CORRUPT_MEDIA" {
		t.Fatalf("broken: %+v", got)
	}
	again := r.ensure(2, []int64{broken, empty})
	if again.Queued != 0 || len(again.Items) != 2 {
		t.Fatalf("permanent failure retried: %+v", again)
	}
}

func TestVideoWithoutToolsIsNotRecorded(t *testing.T) {
	tl := videoTools(t)
	dir := t.TempDir()
	clip := filepath.Join(dir, "clip.mp4")
	if err := fixture.GenerateVideo(tl.FFmpeg, clip, fixture.VideoSpec{Width: 64, Height: 64, Seconds: 0.5}); err != nil {
		t.Fatal(err)
	}
	r := newRigWith(t, fixture.ImageSpec{Count: 0}, nil, func(root string) {
		b, _ := os.ReadFile(clip)
		_ = os.WriteFile(filepath.Join(root, "clip.mp4"), b, 0o644)
	})
	id := idsByName(r)["clip.mp4"]
	if res := r.ensure(1, []int64{id}); len(res.Items) != 1 || res.Items[0].Failed != "UNSUPPORTED_MEDIA" {
		t.Fatalf("no tools: %+v", res)
	}
	// ffmpeg installed later (restart with tools): the poster is generated.
	r.video = tl
	r.restart()
	res := r.ensure(2, []int64{id})
	if res.Queued != 1 {
		t.Fatalf("failure was recorded without tools: %+v", res)
	}
	if got := r.waitItems([]int64{id})[id]; got.Failed != "" {
		t.Fatalf("poster after install: %+v", got)
	}
}

// waitItemsAfter ensures ids and waits for their outcome (immediate or event).
func (r *rig) waitItemsAfter(epoch uint64, ids []int64) map[int64]Item {
	r.t.Helper()
	res := r.ensure(epoch, ids)
	out := map[int64]Item{}
	var pending []int64
	known := map[int64]Item{}
	for _, it := range res.Items {
		known[it.ID] = it
	}
	for _, id := range ids {
		if it, ok := known[id]; ok {
			out[id] = it
		} else {
			pending = append(pending, id)
		}
	}
	for id, it := range r.waitItems(pending) {
		out[id] = it
	}
	return out
}
