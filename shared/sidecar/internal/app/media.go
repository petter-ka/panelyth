package app

import (
	"context"
	"errors"
	"io/fs"
	"os"

	"fastview/sidecar/internal/imaging"
	"fastview/sidecar/internal/media"
	"fastview/sidecar/internal/rpc"
	"fastview/sidecar/internal/video"
)

// mimeByExt covers the indexed media extensions (internal/media).
var mimeByExt = map[string]string{
	"jpg": "image/jpeg", "jpeg": "image/jpeg", "jpe": "image/jpeg", "jfif": "image/jpeg",
	"png": "image/png", "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp",
	"tif": "image/tiff", "tiff": "image/tiff",
	"mp4": "video/mp4", "m4v": "video/mp4", "webm": "video/webm", "mov": "video/quicktime", "mkv": "video/x-matroska",
}

// browserImage lists formats Chromium displays natively; others (TIFF) are
// shown through the viewer-fit preview only.
var browserImage = map[string]bool{"jpg": true, "jpeg": true, "jpe": true, "jfif": true, "png": true, "gif": true, "webp": true, "bmp": true}

// MaxOriginalPixels caps originals handed to Chromium (ARCHITECTURE-ANALYSIS
// M9); larger images are viewed through viewer-fit.
const MaxOriginalPixels = 50_000_000

type (
	mediaResolveParams struct {
		EntryID int64 `json:"entryId"`
	}
	// Returned to Electron main only; the renderer never sees the path.
	mediaResolveResult struct {
		Path      string `json:"path"`
		Kind      string `json:"kind"`
		Mime      string `json:"mime"`
		SizeBytes int64  `json:"sizeBytes"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
		// Original is true when the renderer may load the original file.
		Original bool `json:"original"`
		// Videos (ffprobe, ADR-0018); 0 / "" when unknown or ffprobe is missing.
		DurationMs int64  `json:"durationMs"`
		VideoCodec string `json:"videoCodec"`
		AudioCodec string `json:"audioCodec"`
	}
)

func (s *indexService) registerMedia(srv *rpc.Server) {
	reg := imaging.DefaultRegistry()
	rpc.Register(srv, "media.resolve", func(ctx context.Context, p mediaResolveParams) (mediaResolveResult, error) {
		return s.mediaResolve(ctx, reg, p)
	})
}

// mediaResolve validates that the entry is an indexed image or video that
// still exists, and returns what Electron main needs to serve it.
func (s *indexService) mediaResolve(ctx context.Context, reg *imaging.Registry, p mediaResolveParams) (mediaResolveResult, error) {
	srcs, err := s.store.Sources(ctx, []int64{p.EntryID})
	if err != nil {
		return mediaResolveResult{}, dbError(err)
	}
	src, ok := srcs[p.EntryID]
	if !ok {
		return mediaResolveResult{}, rpc.NewError(rpc.CodeNotFound, "not an indexed image or video")
	}
	fi, err := os.Stat(src.Path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return mediaResolveResult{}, rpc.NewError(rpc.CodeNotFound, "file no longer exists")
	case errors.Is(err, fs.ErrPermission):
		return mediaResolveResult{}, rpc.NewError(rpc.CodePermissionDenied, "no permission to read this file")
	case err != nil:
		return mediaResolveResult{}, rpc.NewError(rpc.CodeInvalidPath, err.Error())
	}
	res := mediaResolveResult{Path: src.Path, Kind: src.Kind.String(), Mime: mimeByExt[src.Ext], SizeBytes: fi.Size()}
	if src.Kind == media.KindImage {
		// Header probe (~1 ms): display dimensions after EXIF orientation.
		if probe, perr := reg.ProbeFile(src.Path, src.Ext); perr == nil {
			res.Width, res.Height = probe.DisplaySize()
			res.Original = browserImage[src.Ext] && probe.Pixels() <= MaxOriginalPixels
		} else if !errors.Is(perr, imaging.ErrTooLarge) {
			return res, rpc.NewError(rpc.CodeCorruptMedia, "image cannot be read")
		}
		return res, nil
	}
	// Videos play through Chromium from the original file; the probe adds
	// size, duration and codec names for the player and its error messages.
	res.Original = true
	info, err := s.video.Probe(ctx, src.Path, fi.Size(), fi.ModTime().UnixNano())
	switch {
	case errors.Is(err, video.ErrCorrupt):
		return res, rpc.NewError(rpc.CodeCorruptMedia, "video cannot be read")
	case err != nil:
		// No ffprobe, timeout or cancelled: Chromium still gets to try.
		return res, nil
	}
	res.Width, res.Height, res.DurationMs = info.Width, info.Height, info.DurationMs
	res.VideoCodec, res.AudioCodec = info.VideoCodec, info.AudioCodec
	return res, nil
}
