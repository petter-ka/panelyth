package editor

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/imaging"
)

// Session is one opened picture.
type Session struct {
	ID     string
	Source Source
	// Format is the decoder family: jpeg, png, gif, bmp, tiff or webp.
	Format string
	// Width, Height: the full size, upright.
	Width, Height int
	HasAlpha      bool
	Meta          imaging.Metadata
	// Notice is "bitDepth" when the source had more than 8 bits per channel.
	Notice string
	// Size and MtimeNs identify the file as it was opened; a save checks them.
	Size    int64
	MtimeNs int64

	owner   int64
	proxy   *image.RGBA
	dir     string
	release func()
	// slot serializes renders: one runs, the newest request waits for it.
	slot chan struct{}

	mu        sync.Mutex
	closed    bool
	lastUsed  time.Time
	latest    int64
	cancelRun context.CancelFunc
	base      *image.RGBA // the proxy at baseEdge, for renders below proxy size
	baseEdge  int
	cache     []checkpoint // most recently used last
	frames    []string     // frame files, oldest first
	stale     []string     // files something held when they were dropped; removed at close
	frameSeq  int
	// Preset thumbnails: the small base they are rendered from and the
	// files of the last batch.
	thumbBase *image.RGBA
	thumbs    []string
	// reserve takes decode memory for work at full resolution.
	reserve func(ctx context.Context, pixels int64) (func(), error)
	// res gives the edit lists their assets, fonts and tokens.
	res *resources
}

// checkpoint is the result of a prefix of an edit list at one working size.
type checkpoint struct {
	key string
	img *image.RGBA
}

func (s *Session) touch() {
	s.mu.Lock()
	s.lastUsed = time.Now()
	s.mu.Unlock()
}

func (s *Session) used() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastUsed
}

// drop removes files the session no longer shows, with one quick try: a
// render must not wait for a virus scanner. What something still holds is
// removed when the session closes.
func (s *Session) drop(files []string) {
	var held []string
	for _, f := range files {
		if err := os.Remove(f); err != nil && !errors.Is(err, fs.ErrNotExist) {
			held = append(held, f)
		}
	}
	if len(held) == 0 {
		return
	}
	s.mu.Lock()
	closed := s.closed
	if !closed {
		s.stale = append(s.stale, held...)
	}
	s.mu.Unlock()
	if closed {
		for _, f := range held {
			_ = fsx.RemoveSoon(f)
		}
	}
}

func (s *Session) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	if s.cancelRun != nil {
		s.cancelRun()
	}
	frames := append(append(s.frames, s.thumbs...), s.stale...)
	s.frames, s.thumbs, s.stale, s.cache, s.base, s.thumbBase = nil, nil, nil, nil, nil, nil
	s.mu.Unlock()
	// A render still running holds the slot; the memory goes back after it.
	s.slot <- struct{}{}
	s.mu.Lock()
	s.proxy = nil
	s.mu.Unlock()
	<-s.slot
	// The session is over: a frame a scanner still holds is waited for.
	for _, f := range frames {
		_ = fsx.RemoveSoon(f)
	}
	s.release()
}

// RenderRequest asks for a frame.
type RenderRequest struct {
	// Rev orders requests: a higher one replaces every lower one.
	Rev   int64
	Edits imaging.EditList
	// MaxEdge is the long edge the frame is shown at, in device pixels.
	MaxEdge int
	// Draft: a control is being dragged; a smaller, faster frame will do.
	Draft bool
	// Histogram asks for the frame's statistics.
	Histogram bool
	// Before asks for the histogram of the picture after BeforeAt of the
	// list's active operations, which is what the tool at that place is
	// given (levels and curves draw it).
	Before   bool
	BeforeAt int
}

// RenderResult is a frame on disk, or Superseded when a newer request
// replaced this one.
type RenderResult struct {
	Rev        int64
	Superseded bool
	File       string
	Mime       string
	// Width, Height: the frame. OutWidth, OutHeight: the saved picture.
	Width, Height       int
	OutWidth, OutHeight int
	DPI                 imaging.DPI
	Stats               *imaging.Stats
	// Before is the histogram asked for with BeforeAt, when it was at hand.
	Before *imaging.Stats
}

// Render runs the edit list over the proxy and writes a frame. Latest
// wins: a newer revision cancels the running render and takes the place of
// a waiting one, and both come back Superseded. Errors: ErrGone,
// imaging.ErrInvalidEdit, imaging.ErrTooLarge, ctx's error.
func (s *Session) Render(ctx context.Context, req RenderRequest) (RenderResult, error) {
	superseded := RenderResult{Rev: req.Rev, Superseded: true}
	prog, err := imaging.Compile(req.Edits, s.Width, s.Height, s.Meta.DPI)
	if err != nil {
		return RenderResult{}, err
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return RenderResult{}, ErrGone
	}
	if req.Rev <= s.latest {
		s.mu.Unlock()
		return superseded, nil
	}
	s.latest = req.Rev
	if s.cancelRun != nil {
		s.cancelRun()
	}
	s.mu.Unlock()

	select {
	case s.slot <- struct{}{}:
	case <-ctx.Done():
		return RenderResult{}, ctx.Err()
	}
	defer func() { <-s.slot }()
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return RenderResult{}, ErrGone
	}
	if s.latest != req.Rev {
		s.mu.Unlock()
		return superseded, nil
	}
	s.cancelRun = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.latest == req.Rev {
			s.cancelRun = nil
		}
		s.mu.Unlock()
	}()

	res, err := s.render(rctx, prog, req)
	if err != nil {
		s.mu.Lock()
		stale := s.latest != req.Rev
		closed := s.closed
		s.mu.Unlock()
		switch {
		case closed:
			return RenderResult{}, ErrGone
		case stale && ctx.Err() == nil:
			return superseded, nil
		}
		return RenderResult{}, err
	}
	return res, nil
}

// workingBase picks the image a render starts from: the proxy, or the proxy
// scaled down when the frame asked for is smaller. Returns it with its
// scale (working pixels per full-resolution pixel).
func (s *Session) workingBase(ctx context.Context, prog *imaging.Program, maxEdge int, draft bool) (*image.RGBA, float64, error) {
	limit := min(max(maxEdge, MinFrameEdge), MaxFrameEdge)
	if draft {
		limit = min(limit, DraftEdge)
	}
	full := max(s.Width, s.Height)
	proxyEdge := max(s.proxy.Rect.Dx(), s.proxy.Rect.Dy())
	ow, oh := prog.Size()
	// The frame is the output at the working scale: no larger than asked,
	// no intermediate beyond workEdge, never above the proxy's resolution.
	edge := math.Min(float64(limit)/float64(max(ow, oh)), float64(workEdge)/float64(prog.PeakEdge())) * float64(full)
	// Sizes snap up to 64 px, so zooming does not rebuild the base for every
	// step and a frame is never smaller than asked.
	want := (int(math.Ceil(edge)) + 63) / 64 * 64
	if want >= proxyEdge {
		return s.proxy, float64(proxyEdge) / float64(full), nil
	}
	s.mu.Lock()
	base, have := s.base, s.baseEdge
	s.mu.Unlock()
	if base == nil || have != want {
		w, h := imaging.FitSize(s.proxy.Rect.Dx(), s.proxy.Rect.Dy(), want)
		var err error
		if base, err = imaging.Resample(ctx, s.proxy, w, h, imaging.Bilinear); err != nil {
			return nil, 0, err
		}
		s.mu.Lock()
		s.base, s.baseEdge = base, want
		s.mu.Unlock()
	}
	return base, float64(max(base.Rect.Dx(), base.Rect.Dy())) / float64(full), nil
}

// rendered runs prog on the working base for a view and returns the result,
// starting from the longest cached prefix of the list. With statsAt >= 0 it
// also returns the picture after that many steps (nil when it is neither
// made by this run nor cached).
func (s *Session) rendered(ctx context.Context, prog *imaging.Program, maxEdge int, draft bool, statsAt int) (out, at *image.RGBA, err error) {
	base, scale, err := s.workingBase(ctx, prog, maxEdge, draft)
	if err != nil {
		return nil, nil, err
	}
	// Checkpoints are valid for one working size and quality.
	prefix := fmt.Sprintf("%dx%d/%v/", base.Rect.Dx(), base.Rect.Dy(), draft)
	n := prog.Len()
	img, from := base, 0
	s.mu.Lock()
	for k := n; k > 0 && from == 0; k-- {
		for i := len(s.cache) - 1; i >= 0; i-- {
			if s.cache[i].key == prefix+prog.Key(k) {
				img, from = s.cache[i].img, k
				s.cache = append(append(s.cache[:i:i], s.cache[i+1:]...), checkpoint{key: prefix + prog.Key(k), img: img})
				break
			}
		}
	}
	if statsAt > 0 && statsAt < from {
		// The run starts after that step: only a checkpoint has it.
		for _, c := range s.cache {
			if c.key == prefix+prog.Key(statsAt) {
				at = c.img
			}
		}
	}
	s.mu.Unlock()
	switch {
	case statsAt == 0:
		at = base
	case statsAt == from:
		at = img
	}
	// Keep the picture before the last operation (the one being adjusted),
	// the result (the next operation starts from it) and the one asked for.
	keep := func(k int) bool { return k > 0 && (k >= n-1 || k == statsAt) }
	out, err = prog.Run(ctx, img, from, imaging.RunOptions{Scale: scale, Draft: draft, Keep: keep, Res: s.res,
		Each: func(k int, step *image.RGBA) {
			if keep(k) {
				s.remember(prefix+prog.Key(k), step)
			}
			if k == statsAt {
				at = step
			}
		}})
	return out, at, err
}

func (s *Session) render(ctx context.Context, prog *imaging.Program, req RenderRequest) (RenderResult, error) {
	statsAt := -1
	if req.Before && req.BeforeAt >= 0 && req.BeforeAt <= prog.Len() {
		statsAt = req.BeforeAt
	}
	out, at, err := s.rendered(ctx, prog, req.MaxEdge, req.Draft, statsAt)
	if err != nil {
		return RenderResult{}, err
	}
	res := RenderResult{Rev: req.Rev, Width: out.Rect.Dx(), Height: out.Rect.Dy(), DPI: prog.DPI()}
	res.OutWidth, res.OutHeight = prog.Size()
	if req.Histogram {
		stats, err := imaging.Histogram(ctx, out)
		if err != nil {
			return RenderResult{}, err
		}
		res.Stats = &stats
	}
	if at != nil {
		before, err := imaging.Histogram(ctx, at)
		if err != nil {
			return RenderResult{}, err
		}
		res.Before = &before
	}
	if res.File, res.Mime, err = s.writeFrame(ctx, out, req.Draft); err != nil {
		return RenderResult{}, err
	}
	return res, nil
}

func (s *Session) remember(key string, img *image.RGBA) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	for i, c := range s.cache {
		if c.key == key {
			s.cache = append(s.cache[:i:i], s.cache[i+1:]...)
			break
		}
	}
	s.cache = append(s.cache, checkpoint{key: key, img: img})
	if len(s.cache) > MaxCheckpoints {
		s.cache = append([]checkpoint(nil), s.cache[len(s.cache)-MaxCheckpoints:]...)
	}
}

// Checkpoints is how many intermediate results the session holds.
func (s *Session) Checkpoints() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.cache)
}

// Frame encoding (Stage 12 spike (a)): a frame is a JPEG file in the
// cache's tmp folder that Electron main serves through a token; no pixels
// cross IPC. What is transparent is shown on a checkerboard, drawn into the
// frame here: a PNG that carries the alpha costs four times as long to
// encode, which a dragged control cannot wait for.
const (
	frameQuality      = 90
	draftFrameQuality = 80
	keepFrames        = 3
	checkerCell       = 8
)

func (s *Session) writeFrame(ctx context.Context, img *image.RGBA, draft bool) (string, string, error) {
	var buf bytes.Buffer
	const ext, mime = "jpg", "image/jpeg"
	flat, err := imaging.OnChecker(ctx, img, checkerCell)
	if err != nil {
		return "", "", err
	}
	q := frameQuality
	if draft {
		q = draftFrameQuality
	}
	buf.Grow(flat.Rect.Dx() * flat.Rect.Dy() / 3)
	if err := jpeg.Encode(&buf, flat, &jpeg.Options{Quality: q}); err != nil {
		return "", "", err
	}
	if err := ctx.Err(); err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return "", "", err
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return "", "", ErrGone
	}
	s.frameSeq++
	file := filepath.Join(s.dir, fmt.Sprintf("%s-%d.%s", s.ID, s.frameSeq, ext))
	s.mu.Unlock()
	f, err := os.OpenFile(file, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return "", "", err
	}
	w := bufio.NewWriterSize(f, 256<<10)
	_, err = w.Write(buf.Bytes())
	if err == nil {
		err = w.Flush()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(file)
		return "", "", err
	}
	// The renderer may still be loading the frame before this one.
	s.mu.Lock()
	s.frames = append(s.frames, file)
	var old []string
	closed := s.closed
	if closed {
		old, s.frames = s.frames, nil
	} else if len(s.frames) > keepFrames {
		old = s.frames[:len(s.frames)-keepFrames]
		s.frames = append([]string(nil), s.frames[len(s.frames)-keepFrames:]...)
	}
	s.mu.Unlock()
	if closed {
		// Closed while this frame was written: close() has removed the rest.
		for _, o := range old {
			_ = fsx.RemoveSoon(o)
		}
	} else {
		s.drop(old)
	}
	return file, mime, nil
}

// Info returns the EXIF tags for the info panel.
func (s *Session) Info() []imaging.InfoGroup {
	return exifInfo(s.Source.Path, s.Format, s.Meta.Exif)
}

// exifInfo reads the EXIF tags of a picture: from the file for a TIFF,
// otherwise from the EXIF block its metadata carries.
func exifInfo(path, format string, exif []byte) []imaging.InfoGroup {
	if format == "tiff" {
		// A TIFF is its own tag structure.
		f, err := os.Open(path)
		if err != nil {
			return nil
		}
		defer f.Close()
		fi, err := f.Stat()
		if err != nil {
			return nil
		}
		return imaging.ExifInfo(f, fi.Size())
	}
	if len(exif) == 0 {
		return nil
	}
	return imaging.ExifInfo(bytes.NewReader(exif), int64(len(exif)))
}

// estimateEdge is the size of the picture an estimate encodes.
const estimateEdge = 1024

// Estimate predicts the size of a save: the proxy is rendered small and
// encoded, and the result is scaled by the pixel count; the metadata is
// added as it would be written. It is an estimate ("about"), mostly a
// little high for JPEG.
func (s *Session) Estimate(ctx context.Context, edits imaging.EditList, format string, quality int, policy string) (int64, error) {
	prog, err := imaging.Compile(edits, s.Width, s.Height, s.Meta.DPI)
	if err != nil {
		return 0, err
	}
	s.mu.Lock()
	closed := s.closed
	proxy := s.proxy
	s.mu.Unlock()
	if closed || proxy == nil {
		return 0, ErrGone
	}
	ow, oh := prog.Size()
	full := max(s.Width, s.Height)
	proxyEdge := max(proxy.Rect.Dx(), proxy.Rect.Dy())
	edge := math.Min(float64(estimateEdge)/float64(max(ow, oh)), float64(workEdge)/float64(prog.PeakEdge())) * float64(full)
	base := proxy
	if edge < float64(proxyEdge) {
		w, h := imaging.FitSize(proxy.Rect.Dx(), proxy.Rect.Dy(), max(int(edge), 16))
		if base, err = imaging.Resample(ctx, proxy, w, h, imaging.Bilinear); err != nil {
			return 0, err
		}
	}
	scale := float64(max(base.Rect.Dx(), base.Rect.Dy())) / float64(full)
	out, err := prog.Run(ctx, base, 0, imaging.RunOptions{Scale: scale, Draft: true, Res: s.res})
	if err != nil {
		return 0, err
	}
	bare := imaging.SaveOptions{Format: format, Quality: quality}
	small, err := imaging.EncodedSize(ctx, out, bare)
	if err != nil {
		return 0, err
	}
	// What a 1×1 picture takes is the format's fixed part; the rest grows
	// with the pixels.
	one := image.NewRGBA(image.Rect(0, 0, 1, 1))
	fixed, err := imaging.EncodedSize(ctx, one, bare)
	if err != nil {
		return 0, err
	}
	withMeta, err := imaging.EncodedSize(ctx, one, imaging.SaveOptions{Format: format, Quality: quality,
		Meta: s.Meta.For(policy, ow, oh, prog.DPI())})
	if err != nil {
		return 0, err
	}
	meta := withMeta - fixed
	if format == "tiff" {
		meta = int64(len(s.Meta.ICC)) // added after encoding
	}
	pixels := float64(ow) * float64(oh) / (float64(out.Rect.Dx()) * float64(out.Rect.Dy()))
	return fixed + int64(float64(max(small-fixed, 0))*pixels) + meta, nil
}

// wait takes the render slot, so analysis never runs beside a render.
func (s *Session) wait(ctx context.Context) (func(), error) {
	select {
	case s.slot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		<-s.slot
		return nil, ErrGone
	}
	return func() { <-s.slot }, nil
}

// Probe returns the color at a point of the rendered picture (x, y in
// 0..1), averaged over a square of 2·radius+1 working pixels, as straight
// RGBA. It renders like a frame of the same view, so it normally comes
// straight from a checkpoint.
func (s *Session) Probe(ctx context.Context, edits imaging.EditList, maxEdge int, x, y float64, radius int) ([4]uint8, error) {
	prog, err := imaging.Compile(edits, s.Width, s.Height, s.Meta.DPI)
	if err != nil {
		return [4]uint8{}, err
	}
	done, err := s.wait(ctx)
	if err != nil {
		return [4]uint8{}, err
	}
	defer done()
	img, _, err := s.rendered(ctx, prog, maxEdge, false, -1)
	if err != nil {
		return [4]uint8{}, err
	}
	w, h := img.Rect.Dx(), img.Rect.Dy()
	cx := min(max(int(x*float64(w)), 0), w-1)
	cy := min(max(int(y*float64(h)), 0), h-1)
	radius = min(max(radius, 0), 16)
	var sum [4]uint64
	var n uint64
	for py := max(cy-radius, 0); py <= min(cy+radius, h-1); py++ {
		for px := max(cx-radius, 0); px <= min(cx+radius, w-1); px++ {
			o := py*img.Stride + px*4
			a := uint64(img.Pix[o+3])
			// Premultiplied sums give the alpha-weighted mean color.
			sum[0] += uint64(img.Pix[o])
			sum[1] += uint64(img.Pix[o+1])
			sum[2] += uint64(img.Pix[o+2])
			sum[3] += a
			n++
		}
	}
	if sum[3] == 0 {
		return [4]uint8{}, nil
	}
	return [4]uint8{
		uint8(min((sum[0]*255+sum[3]/2)/sum[3], 255)),
		uint8(min((sum[1]*255+sum[3]/2)/sum[3], 255)),
		uint8(min((sum[2]*255+sum[3]/2)/sum[3], 255)),
		uint8((sum[3] + n/2) / n),
	}, nil
}

// Thumbnail limits: presets are shown small, a few at a time.
const (
	MaxThumbs    = 16
	MaxThumbEdge = 256
)

// Thumb is a small rendering of one edit list.
type Thumb struct {
	File          string
	Width, Height int
}

// Thumbs renders each list on a small copy of the proxy (for preset
// previews) and writes one JPEG per list. The files of the previous call
// are removed. An invalid list gives an empty entry, not an error.
func (s *Session) Thumbs(ctx context.Context, lists []imaging.EditList, edge int) ([]Thumb, error) {
	if len(lists) > MaxThumbs {
		return nil, fmt.Errorf("%w: more than %d thumbnails", imaging.ErrInvalidEdit, MaxThumbs)
	}
	edge = min(max(edge, 32), MaxThumbEdge)
	s.mu.Lock()
	closed, proxy, base := s.closed, s.proxy, s.thumbBase
	old := s.thumbs
	s.thumbs = nil
	s.mu.Unlock()
	if closed || proxy == nil {
		return nil, ErrGone
	}
	s.drop(old)
	if base == nil || max(base.Rect.Dx(), base.Rect.Dy()) != min(edge, max(proxy.Rect.Dx(), proxy.Rect.Dy())) {
		w, h := imaging.FitSize(proxy.Rect.Dx(), proxy.Rect.Dy(), edge)
		var err error
		if base, err = imaging.Resample(ctx, proxy, w, h, imaging.Bilinear); err != nil {
			return nil, err
		}
		s.mu.Lock()
		s.thumbBase = base
		s.mu.Unlock()
	}
	scale := float64(max(base.Rect.Dx(), base.Rect.Dy())) / float64(max(s.Width, s.Height))
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return nil, err
	}
	out := make([]Thumb, len(lists))
	var files []string
	for i, list := range lists {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		prog, err := imaging.Compile(list, s.Width, s.Height, s.Meta.DPI)
		if err != nil {
			continue
		}
		// A list that grows the picture a lot is shown at the same small size.
		k := scale * math.Min(1, float64(max(s.Width, s.Height))/float64(prog.PeakEdge()))
		start := base
		if k < scale {
			w, h := imaging.FitSize(base.Rect.Dx(), base.Rect.Dy(), max(int(float64(max(s.Width, s.Height))*k), 16))
			if start, err = imaging.Resample(ctx, base, w, h, imaging.Bilinear); err != nil {
				return nil, err
			}
			k = float64(max(start.Rect.Dx(), start.Rect.Dy())) / float64(max(s.Width, s.Height))
		}
		img, err := prog.Run(ctx, start, 0, imaging.RunOptions{Scale: k, Draft: true, Res: s.res})
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue
		}
		flat, err := imaging.OnChecker(ctx, img, checkerCell)
		if err != nil {
			return nil, err
		}
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, flat, &jpeg.Options{Quality: draftFrameQuality}); err != nil {
			return nil, err
		}
		s.mu.Lock()
		s.frameSeq++
		file := filepath.Join(s.dir, fmt.Sprintf("%s-%d.jpg", s.ID, s.frameSeq))
		s.mu.Unlock()
		if err := os.WriteFile(file, buf.Bytes(), 0o600); err != nil {
			return nil, err
		}
		files = append(files, file)
		out[i] = Thumb{File: file, Width: flat.Rect.Dx(), Height: flat.Rect.Dy()}
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		for _, f := range files {
			_ = fsx.RemoveSoon(f)
		}
		return nil, ErrGone
	}
	s.thumbs = files
	s.mu.Unlock()
	return out, nil
}

// Colors is the answer of Count colors.
type Colors struct {
	// Distinct is the exact number of distinct colors of the visible pixels.
	Distinct int
	Palette  []imaging.Swatch
	HasAlpha bool
	// Width, Height: the picture that was counted.
	Width, Height int
}

// Color scopes: the proxy as rendered (fast, an estimate of the saved
// picture), or the full picture with or without the edits (exact).
const (
	ScopePreview  = "preview"
	ScopeEdited   = "edited"
	ScopeOriginal = "original"
)

// CountColors counts the colors of the picture in a scope and finds its
// dominant palette. The full scopes decode the source again, like a save.
func (s *Session) CountColors(ctx context.Context, edits imaging.EditList, scope string, swatches int) (Colors, error) {
	if scope == ScopeOriginal {
		edits = nil
	}
	prog, err := imaging.Compile(edits, s.Width, s.Height, s.Meta.DPI)
	if err != nil {
		return Colors{}, err
	}
	var img *image.RGBA
	if scope == ScopePreview {
		done, err := s.wait(ctx)
		if err != nil {
			return Colors{}, err
		}
		img, _, err = s.rendered(ctx, prog, MaxFrameEdge, false, -1)
		done()
		if err != nil {
			return Colors{}, err
		}
	} else {
		probe, err := imaging.DefaultRegistry().ProbeFile(s.Source.Path, s.Source.Ext)
		if err != nil {
			return Colors{}, err
		}
		release, err := s.reserve(ctx, 3*probe.Pixels())
		if err != nil {
			return Colors{}, err
		}
		defer release()
		full, err := imaging.DecodeOriented(ctx, probe)
		if err != nil {
			return Colors{}, err
		}
		if full.Rect.Dx() != s.Width || full.Rect.Dy() != s.Height {
			return Colors{}, ErrChanged
		}
		if img, err = prog.Run(ctx, full, 0, imaging.RunOptions{Scale: 1, Res: s.res}); err != nil {
			return Colors{}, err
		}
	}
	res := Colors{Width: img.Rect.Dx(), Height: img.Rect.Dy()}
	if res.Distinct, res.HasAlpha, err = imaging.CountColors(ctx, img); err != nil {
		return Colors{}, err
	}
	if res.Palette, err = imaging.Palette(ctx, img, swatches); err != nil {
		return Colors{}, err
	}
	return res, nil
}

// Eyes finds red pupils in the picture as edits renders it (Stage 15), on
// the session's proxy. The rects are 0..1 of that picture, one per pupil;
// the caller turns each into a red-eye operation, so what was found can be
// seen, changed and removed like any other edit.
func (s *Session) Eyes(ctx context.Context, edits imaging.EditList) ([]imaging.Rect, error) {
	prog, err := imaging.Compile(edits, s.Width, s.Height, s.Meta.DPI)
	if err != nil {
		return nil, err
	}
	done, err := s.wait(ctx)
	if err != nil {
		return nil, err
	}
	img, _, err := s.rendered(ctx, prog, MaxFrameEdge, false, -1)
	done()
	if err != nil {
		return nil, err
	}
	return imaging.DetectEyes(ctx, img)
}
