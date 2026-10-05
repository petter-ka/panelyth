package preview

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"runtime"
	"sync"
	"time"

	"fastview/sidecar/internal/imaging"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/media"
	"fastview/sidecar/internal/video"
)

// Item is one preview outcome sent to the renderer: either URL (+ size) or
// Failed (an error code). Mirrors shared/contracts PreviewItem.
type Item struct {
	ID      int64   `json:"id"`
	Profile Profile `json:"profile"`
	URL     string  `json:"url,omitempty"`
	Width   int     `json:"width,omitempty"`
	Height  int     `json:"height,omitempty"`
	Failed  string  `json:"failed,omitempty"`
}

// Failure codes (protocol ErrorCode values).
const (
	failUnsupported = "UNSUPPORTED_MEDIA"
	failCorrupt     = "CORRUPT_MEDIA"
	failPermission  = "PERMISSION_DENIED"
	failNotFound    = "NOT_FOUND"
	failCache       = "CACHE_ERROR"
)

// Options tunes the service; zero values get defaults.
type Options struct {
	Workers   int   // default clamp(NumCPU/2, 2, 8)
	MaxQueued int   // default 2000
	MaxPixels int64 // concurrent decode budget in pixels; default 250M
	// FlushInterval batches access-time and metadata writes.
	FlushInterval time.Duration
	// Video extracts poster frames (ADR-0018). Nil or unavailable: video
	// previews fail with UNSUPPORTED_MEDIA, without recording a failure, so
	// installing ffmpeg later makes them appear.
	Video *video.Tools
}

// Service is the preview pipeline.
type Service struct {
	store  *index.Store
	cache  *DiskCache
	reg    *imaging.Registry
	video  *video.Tools
	log    *slog.Logger
	emit   func(Item)
	sched  *Scheduler
	budget *pixelBudget

	mu      sync.Mutex
	touched map[string][]byte
	dims    []index.Dimension

	covers coverState

	stop chan struct{}
	done chan struct{}
}

type job struct {
	src     index.Source
	profile Profile
	edge    int
	// durationMs is set by renderPoster (videos) and recorded with the
	// dimensions, so duration sorting needs no second probe.
	durationMs int64
}

// NewService starts the scheduler and the batch flusher. emit receives every
// finished item (success or failure) for each waiting entry.
func NewService(store *index.Store, cache *DiskCache, log *slog.Logger, opts Options, emit func(Item)) *Service {
	if opts.Workers <= 0 {
		opts.Workers = min(max(runtime.NumCPU()/2, 2), 8)
	}
	if opts.MaxQueued <= 0 {
		opts.MaxQueued = 2000
	}
	if opts.MaxPixels <= 0 {
		opts.MaxPixels = 250_000_000
	}
	if opts.FlushInterval <= 0 {
		opts.FlushInterval = 2 * time.Second
	}
	s := &Service{
		store: store, cache: cache, reg: imaging.DefaultRegistry(), video: opts.Video, log: log, emit: emit,
		budget: newPixelBudget(opts.MaxPixels), touched: map[string][]byte{},
		stop: make(chan struct{}), done: make(chan struct{}),
	}
	s.sched = NewScheduler(opts.Workers, opts.MaxQueued, s.process)
	go s.flushLoop(opts.FlushInterval)
	return s
}

// Close stops workers and flushes pending batched writes.
func (s *Service) Close() {
	s.sched.Close()
	close(s.stop)
	<-s.done
}

// Stats exposes scheduler counters.
func (s *Service) Stats() SchedulerStats { return s.sched.Stats() }

// ReserveDecode waits for decode memory for work outside the scheduler
// (clipboard copies), so it never adds to a full preview budget.
func (s *Service) ReserveDecode(ctx context.Context, pixels int64) (func(), error) {
	return s.budget.acquire(ctx, pixels)
}

// EnsureRequest asks for previews of entries.
type EnsureRequest struct {
	Lane    string
	Epoch   uint64
	Profile Profile
	Items   []EnsureItem
	// Force regenerates these ids even if cached or failed (broken cache
	// file reported by the renderer, or an explicit retry).
	Force []int64
}

// EnsureItem is one requested entry.
type EnsureItem struct {
	ID       int64
	Priority Priority
}

// EnsureResult returns what is already known; everything else is queued and
// arrives later through emit.
type EnsureResult struct {
	Items    []Item
	Queued   int
	Deferred int
}

// ErrUnknownProfile is returned for profiles without a size.
var ErrUnknownProfile = errors.New("preview: unknown profile")

// Ensure resolves cache hits and known failures immediately and schedules
// the rest by priority.
func (s *Service) Ensure(ctx context.Context, req EnsureRequest) (EnsureResult, error) {
	start := time.Now()
	edge, ok := req.Profile.MaxEdge()
	if !ok {
		return EnsureResult{}, ErrUnknownProfile
	}
	ids := make([]int64, len(req.Items))
	for i, it := range req.Items {
		ids[i] = it.ID
	}
	sources, err := s.store.Sources(ctx, ids)
	if err != nil {
		return EnsureResult{}, err
	}
	force := map[int64]bool{}
	for _, id := range req.Force {
		force[id] = true
	}

	keys := make([][]byte, 0, len(req.Items))
	keyOf := make(map[int64]Key, len(req.Items))
	res := EnsureResult{Items: []Item{}}
	for _, it := range req.Items {
		src, ok := sources[it.ID]
		if !ok {
			continue // removed from the index; the listing will drop it
		}
		if src.Kind == media.KindVideo && !s.video.Available() {
			res.Items = append(res.Items, Item{ID: it.ID, Profile: req.Profile, Failed: failUnsupported})
			continue
		}
		k := MakeKey(src.PathKey, src.Size, src.MtimeNs, req.Profile)
		keyOf[it.ID] = k
		keys = append(keys, k[:])
	}

	var forced [][]byte
	for id := range force {
		if k, ok := keyOf[id]; ok {
			forced = append(forced, k[:])
			if hit, err := s.store.LookupPreviews(ctx, [][]byte{k[:]}); err == nil {
				if p, ok := hit[string(k[:])]; ok {
					_ = s.cache.Remove(k, imaging.Format(p.Format))
				}
			}
		}
	}
	if err := s.store.ForgetPreviews(ctx, forced); err != nil {
		return EnsureResult{}, err
	}

	hits, err := s.store.LookupPreviews(ctx, keys)
	if err != nil {
		return EnsureResult{}, err
	}
	failures, err := s.store.LookupFailures(ctx, keys)
	if err != nil {
		return EnsureResult{}, err
	}
	now := time.Now().UnixMilli()
	var todo []Request
	for _, it := range req.Items {
		k, ok := keyOf[it.ID]
		if !ok {
			continue
		}
		if p, ok := hits[string(k[:])]; ok {
			res.Items = append(res.Items, Item{ID: it.ID, Profile: req.Profile, URL: URL(k, imaging.Format(p.Format)), Width: p.Width, Height: p.Height})
			s.touch(k)
			continue
		}
		if f, ok := failures[string(k[:])]; ok && (f.RetryAfter == 0 || f.RetryAfter > now) {
			res.Items = append(res.Items, Item{ID: it.ID, Profile: req.Profile, Failed: f.Code})
			continue
		}
		todo = append(todo, Request{Key: k, EntryID: it.ID, Priority: it.Priority,
			Payload: &job{src: sourcesOf(sources, it.ID), profile: req.Profile, edge: edge}})
	}
	res.Queued, res.Deferred = s.sched.Submit(req.Lane, req.Epoch, todo)
	// One line per call (never per file), for latency diagnostics.
	s.log.Debug("preview.ensure", "lane", req.Lane, "epoch", req.Epoch, "items", len(req.Items),
		"known", len(res.Items), "queued", res.Queued, "deferred", res.Deferred, "ms", time.Since(start).Milliseconds())
	return res, nil
}

func sourcesOf(m map[int64]index.Source, id int64) index.Source { return m[id] }

// Thumbs returns cached preview URLs for page items (no generation). Pages
// carry these so revisiting a folder paints without any ensure round trip.
func (s *Service) Thumbs(ctx context.Context, items []index.Item, p Profile) (map[int64]Item, error) {
	if _, ok := p.MaxEdge(); !ok {
		return nil, ErrUnknownProfile
	}
	keyOf := map[string]int64{}
	var keys [][]byte
	for _, it := range items {
		if it.Kind != media.KindImage && it.Kind != media.KindVideo {
			continue
		}
		k := MakeKey(it.PathKey, it.Size, it.MtimeNs, p)
		keyOf[string(k[:])] = it.ID
		keys = append(keys, k[:])
	}
	hits, err := s.store.LookupPreviews(ctx, keys)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]Item, len(hits))
	for ks, row := range hits {
		var k Key
		copy(k[:], ks)
		id := keyOf[ks]
		out[id] = Item{ID: id, Profile: p, URL: URL(k, imaging.Format(row.Format)), Width: row.Width, Height: row.Height}
		s.touch(k)
	}
	return out, nil
}

func (s *Service) process(ctx context.Context, t *Task) {
	j := t.Payload.(*job)
	item := s.generate(ctx, t.Key, j)
	if ctx.Err() != nil {
		return // shutting down: nothing to publish
	}
	for _, id := range s.sched.TakeWaiters(t) {
		if id == 0 {
			continue // folder covers only (EntryID 0)
		}
		out := item
		out.ID = id
		s.emit(out)
	}
	s.publishCovers(t.Key, item)
}

// generate produces one preview (or a recorded failure).
func (s *Service) generate(ctx context.Context, key Key, j *job) Item {
	item := Item{ID: j.src.ID, Profile: j.profile}
	fi, err := os.Stat(j.src.Path)
	if err != nil {
		return s.fail(ctx, key, j, item, err)
	}
	// The file changed since it was indexed: record the new identity and use
	// the matching key, so a stale cache entry can never be served for it.
	if fi.Size() != j.src.Size || fi.ModTime().UnixNano() != j.src.MtimeNs {
		// Folder covers (ID 0) have no index row to update.
		if j.src.ID != 0 {
			if err := s.store.UpdateIdentity(ctx, j.src.ID, fi.Size(), fi.ModTime().UnixNano()); err != nil {
				s.log.Warn("update identity", "id", j.src.ID, "err", err)
			}
		}
		key = MakeKey(j.src.PathKey, fi.Size(), fi.ModTime().UnixNano(), j.profile)
		if hit, err := s.store.LookupPreviews(ctx, [][]byte{key[:]}); err == nil {
			if p, ok := hit[string(key[:])]; ok {
				item.URL, item.Width, item.Height = URL(key, imaging.Format(p.Format)), p.Width, p.Height
				return item
			}
		}
	}
	var rendered imaging.Rendered
	var w, h int
	if j.src.Kind == media.KindVideo {
		rendered, w, h, err = s.renderPoster(ctx, j, fi)
	} else {
		rendered, w, h, err = s.renderImage(ctx, j)
	}
	if err != nil {
		if errors.Is(err, errBudget) {
			return item // shutting down
		}
		return s.fail(ctx, key, j, item, err)
	}
	size, err := s.cache.Write(key, rendered.Format, rendered.Data)
	if err != nil {
		return s.fail(ctx, key, j, item, err)
	}
	if err := s.store.PutPreview(ctx, index.PreviewRow{Key: key[:], EntryID: j.src.ID, Profile: string(j.profile),
		Format: string(rendered.Format), Width: rendered.Width, Height: rendered.Height, ByteSize: size}); err != nil {
		_ = s.cache.Remove(key, rendered.Format)
		return s.fail(ctx, key, j, item, err)
	}
	if j.src.ID != 0 {
		s.recordDims(index.Dimension{ID: j.src.ID, Width: w, Height: h, DurationMs: j.durationMs, State: 1})
	}
	item.URL, item.Width, item.Height = URL(key, rendered.Format), rendered.Width, rendered.Height
	return item
}

var errBudget = errors.New("preview: budget wait cancelled")

func (s *Service) renderImage(ctx context.Context, j *job) (imaging.Rendered, int, int, error) {
	probe, err := s.reg.ProbeFile(j.src.Path, j.src.Ext)
	if err != nil {
		return imaging.Rendered{}, 0, 0, err
	}
	release, err := s.budget.acquire(ctx, probe.Pixels())
	if err != nil {
		return imaging.Rendered{}, 0, 0, errBudget
	}
	rendered, err := imaging.Render(probe, j.edge)
	release()
	w, h := probe.DisplaySize()
	return rendered, w, h, err
}

// renderPoster extracts a frame with ffmpeg (ADR-0018). ffmpeg scales and
// rotates; Go only re-encodes, so posters follow the image encoder policy.
// The frame's source pixels count against the decode budget like an image.
func (s *Service) renderPoster(ctx context.Context, j *job, fi os.FileInfo) (imaging.Rendered, int, int, error) {
	var info video.Info
	// Surface permission errors as such (ffprobe would report "unreadable").
	f, err := os.Open(j.src.Path)
	if err != nil {
		return imaging.Rendered{}, 0, 0, err
	}
	_ = f.Close()
	info, err = s.video.Probe(ctx, j.src.Path, fi.Size(), fi.ModTime().UnixNano())
	if err != nil {
		return imaging.Rendered{}, 0, 0, err
	}
	if info.VideoCodec == "" {
		return imaging.Rendered{}, 0, 0, video.ErrNoVideo
	}
	j.durationMs = info.DurationMs
	release, err := s.budget.acquire(ctx, int64(info.Width)*int64(info.Height))
	if err != nil {
		return imaging.Rendered{}, 0, 0, errBudget
	}
	frame, err := s.video.Frame(ctx, j.src.Path, video.PosterTime(info.DurationMs), j.edge)
	release()
	if err != nil {
		return imaging.Rendered{}, 0, 0, err
	}
	// Frames are already scaled; Downscale is a conversion here.
	small := imaging.Downscale(frame, j.edge)
	data, format, err := imaging.Encode(small)
	if err != nil {
		return imaging.Rendered{}, 0, 0, err
	}
	return imaging.Rendered{Data: data, Format: format, Width: small.Rect.Dx(), Height: small.Rect.Dy()},
		info.Width, info.Height, nil
}

// fail records the failure with a retry policy and returns the failed item.
// Corrupt and unsupported files are permanent for this key: fixing or
// replacing the file changes size/mtime and therefore the key.
func (s *Service) fail(ctx context.Context, key Key, j *job, item Item, err error) Item {
	if ctx.Err() != nil {
		return item
	}
	code, retry, state := failCache, 30*time.Second, 0
	switch {
	case errors.Is(err, imaging.ErrUnsupported), errors.Is(err, imaging.ErrTooLarge), errors.Is(err, video.ErrNoVideo):
		code, retry, state = failUnsupported, 0, 2
	case errors.Is(err, imaging.ErrCorrupt), errors.Is(err, video.ErrCorrupt):
		code, retry, state = failCorrupt, 0, 3
	case errors.Is(err, video.ErrTimeout):
		code, retry = failCache, 5*time.Minute
	case errors.Is(err, fs.ErrPermission):
		code, retry = failPermission, 5*time.Minute
	case errors.Is(err, fs.ErrNotExist):
		code, retry = failNotFound, time.Minute
	}
	var retryAt int64
	if retry > 0 {
		retryAt = time.Now().Add(retry).UnixMilli()
	}
	if perr := s.store.PutFailure(ctx, key[:], code, retryAt); perr != nil {
		s.log.Warn("record preview failure", "err", perr)
	}
	if state != 0 && j.src.ID != 0 {
		s.recordDims(index.Dimension{ID: j.src.ID, State: state})
	}
	s.log.Debug("preview failed", "id", j.src.ID, "code", code, "err", err)
	item.Failed = code
	return item
}

func (s *Service) touch(k Key) {
	s.mu.Lock()
	s.touched[string(k[:])] = k[:]
	s.mu.Unlock()
}

func (s *Service) recordDims(d index.Dimension) {
	s.mu.Lock()
	s.dims = append(s.dims, d)
	s.mu.Unlock()
}

func (s *Service) flush() {
	s.mu.Lock()
	touched, dims := s.touched, s.dims
	s.touched, s.dims = map[string][]byte{}, nil
	s.mu.Unlock()
	ctx := context.Background()
	if len(touched) > 0 {
		keys := make([][]byte, 0, len(touched))
		for _, k := range touched {
			keys = append(keys, k)
		}
		if err := s.store.TouchPreviews(ctx, keys); err != nil {
			s.log.Warn("touch previews", "err", err)
		}
	}
	if err := s.store.SetDimensions(ctx, dims); err != nil {
		s.log.Warn("store dimensions", "err", err)
	}
}

func (s *Service) flushLoop(every time.Duration) {
	defer close(s.done)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			s.flush()
		case <-s.stop:
			s.flush()
			return
		}
	}
}

// pixelBudget bounds decode memory: a 100 MP image and eight 12 MP images
// cost the same, not "one job each".
type pixelBudget struct {
	mu    sync.Mutex
	cond  *sync.Cond
	limit int64
	used  int64
}

func newPixelBudget(limit int64) *pixelBudget {
	b := &pixelBudget{limit: limit}
	b.cond = sync.NewCond(&b.mu)
	return b
}

// acquire waits for n pixels (capped at the limit so one huge image can run
// alone) or for ctx to end.
func (b *pixelBudget) acquire(ctx context.Context, n int64) (func(), error) {
	n = min(max(n, 1), b.limit)
	stop := context.AfterFunc(ctx, func() {
		b.mu.Lock()
		b.cond.Broadcast()
		b.mu.Unlock()
	})
	defer stop()
	b.mu.Lock()
	defer b.mu.Unlock()
	for b.used+n > b.limit {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		b.cond.Wait()
	}
	b.used += n
	return func() {
		b.mu.Lock()
		b.used -= n
		b.cond.Broadcast()
		b.mu.Unlock()
	}, nil
}
