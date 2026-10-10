package app

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	"panelyth/sidecar/internal/imaging"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/rpc"
)

// Copying a picture to the OS clipboard (Stage 08.6). Go decodes the image
// (any indexed format, EXIF orientation applied) and writes it as a fast PNG
// to a temp file in the cache; Electron main reads the file asynchronously,
// hands it to the clipboard as image/png and deletes the file. No pixels
// travel over IPC and nothing is decoded in Electron main.

// ClipboardMaxPixels caps the copied picture; larger images are scaled down
// to fit.
const ClipboardMaxPixels = 40_000_000

var clipPNG = png.Encoder{CompressionLevel: png.BestSpeed}

type clipboardImageResult struct {
	// File is a PNG (transparency kept).
	File   string `json:"file"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type clipImager struct {
	dir  string
	reg  *imaging.Registry
	seq  atomic.Int64
	busy chan struct{} // one copy at a time: repeated Ctrl+C never stacks decodes
}

// newClipImager removes temp files left by a crash.
func newClipImager(cacheRoot string) *clipImager {
	dir := filepath.Join(cacheRoot, "tmp")
	if old, err := filepath.Glob(filepath.Join(dir, "clip-*.png")); err == nil {
		for _, f := range old {
			_ = os.Remove(f)
		}
	}
	return &clipImager{dir: dir, reg: imaging.DefaultRegistry(), busy: make(chan struct{}, 1)}
}

func (s *indexService) clipboardImage(ctx context.Context, p entryParams) (clipboardImageResult, error) {
	srcs, err := s.store.Sources(ctx, []int64{p.EntryID})
	if err != nil {
		return clipboardImageResult{}, dbError(err)
	}
	src, ok := srcs[p.EntryID]
	if !ok || src.Kind != media.KindImage {
		return clipboardImageResult{}, rpc.NewError(rpc.CodeInvalidArgument, "not an indexed image")
	}
	c := s.clipImg
	select {
	case c.busy <- struct{}{}:
		defer func() { <-c.busy }()
	case <-ctx.Done():
		return clipboardImageResult{}, rpc.NewError(rpc.CodeCancelled, "cancelled")
	}
	probe, err := c.reg.ProbeFile(src.Path, src.Ext)
	if err != nil {
		return clipboardImageResult{}, imageError(err)
	}
	// The decoded source and the oriented copy share the preview decode budget.
	release, err := s.preview.ReserveDecode(ctx, 2*probe.Pixels())
	if err != nil {
		return clipboardImageResult{}, rpc.NewError(rpc.CodeCancelled, "cancelled")
	}
	img, err := renderClipboard(probe)
	release()
	if err != nil {
		return clipboardImageResult{}, imageError(err)
	}
	if err := os.MkdirAll(c.dir, 0o700); err != nil {
		return clipboardImageResult{}, rpc.NewError(rpc.CodeCacheError, err.Error())
	}
	file := filepath.Join(c.dir, fmt.Sprintf("clip-%d-%d.png", os.Getpid(), c.seq.Add(1)))
	if err := writePNG(file, img); err != nil {
		_ = os.Remove(file)
		return clipboardImageResult{}, rpc.NewError(rpc.CodeCacheError, err.Error())
	}
	return clipboardImageResult{File: file, Width: img.Rect.Dx(), Height: img.Rect.Dy()}, nil
}

// renderClipboard decodes p, applies orientation and fits ClipboardMaxPixels.
func renderClipboard(p imaging.Probe) (*image.RGBA, error) {
	src, err := imaging.DecodeFile(p)
	if err != nil {
		return nil, err
	}
	edge := max(p.Width, p.Height)
	if px := p.Pixels(); px > ClipboardMaxPixels {
		edge = int(float64(edge) * math.Sqrt(float64(ClipboardMaxPixels)/float64(px)))
	}
	return imaging.Orient(imaging.Downscale(src, edge), p.Orientation), nil
}

func writePNG(file string, img image.Image) error {
	f, err := os.OpenFile(file, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 256<<10)
	if err := clipPNG.Encode(w, img); err != nil {
		_ = f.Close()
		return err
	}
	if err := w.Flush(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func imageError(err error) error {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return rpc.NewError(rpc.CodeNotFound, "file no longer exists")
	case errors.Is(err, fs.ErrPermission):
		return rpc.NewError(rpc.CodePermissionDenied, "no permission to read this file")
	case errors.Is(err, imaging.ErrUnsupported):
		return rpc.NewError(rpc.CodeUnsupportedMedia, "this image format can't be copied")
	case errors.Is(err, imaging.ErrTooLarge), errors.Is(err, imaging.ErrCorrupt):
		return rpc.NewError(rpc.CodeCorruptMedia, "image cannot be read")
	default:
		return rpc.NewError(rpc.CodeInternal, strings.TrimSpace(err.Error()))
	}
}
