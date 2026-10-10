package app

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"panelyth/sidecar/internal/fixture"
	"panelyth/sidecar/internal/imaging"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/rpc"
	"panelyth/sidecar/internal/scan"
	"panelyth/sidecar/internal/video"
)

func TestMediaResolveVideo(t *testing.T) {
	tools := video.Locate(os.Getenv)
	if !tools.Available() {
		t.Skip("ffmpeg/ffprobe not installed")
	}
	root := filepath.Join(t.TempDir(), "videos")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := fixture.GenerateVideo(tools.FFmpeg, filepath.Join(root, "clip.webm"),
		fixture.VideoSpec{Width: 320, Height: 240, Seconds: 1.5, Codec: "libvpx-vp9", Audio: true}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "broken.mp4"), []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.DiscardHandler)
	svc, err := newIndexService(t.TempDir(), 1<<30, log, func(string, any) error { return nil }, tools, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer svc.close()
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
	reg := imaging.DefaultRegistry()
	// Name order: broken.mp4, clip.webm.
	res, err := svc.mediaResolve(ctx, reg, mediaResolveParams{EntryID: ids[1]})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Original || res.Kind != "video" || res.Mime != "video/webm" || res.Width != 320 || res.Height != 240 ||
		res.VideoCodec != "vp9" || res.AudioCodec != "opus" || res.DurationMs < 1400 || res.DurationMs > 1700 {
		t.Fatalf("resolve: %+v", res)
	}
	_, err = svc.mediaResolve(ctx, reg, mediaResolveParams{EntryID: ids[0]})
	var rerr *rpc.Error
	if !errors.As(err, &rerr) || rerr.Code != rpc.CodeCorruptMedia {
		t.Fatalf("broken video: %v", err)
	}
}
