// Package meta fills in metadata the scanner doesn't read (ADR-0021):
// display dimensions from image headers and video size and duration from
// ffprobe. It works lazily, only for the query session that sorts by them,
// with a fixed number of workers, and writes in batches.
package meta

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"sync"

	"panelyth/sidecar/internal/imaging"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/video"
)

// Options tunes the extractor; zero values get defaults.
type Options struct {
	Workers int
	// Chunk is the number of entries read and written per batch.
	Chunk int
}

// Extractor serves one session at a time: the most recent request wins.
type Extractor struct {
	store   *index.Store
	video   *video.Tools
	images  *imaging.Registry
	log     *slog.Logger
	opts    Options
	refresh func(queryID int64)

	mu      sync.Mutex
	queryID int64
	ids     []int64
	gen     uint64 // bumped per request; a running pass restarts when it changes
	cancel  context.CancelFunc
	wake    chan struct{}
	closed  bool
	done    chan struct{}
}

// New starts the extractor's loop. refresh is called after each written
// batch so the session re-materializes (through its normal throttle).
func New(store *index.Store, tools *video.Tools, log *slog.Logger, opts Options, refresh func(queryID int64)) *Extractor {
	if opts.Workers <= 0 {
		opts.Workers = 2
	}
	if opts.Chunk <= 0 {
		opts.Chunk = 256
	}
	x := &Extractor{store: store, video: tools, images: imaging.DefaultRegistry(), log: log, opts: opts,
		refresh: refresh, wake: make(chan struct{}, 1), done: make(chan struct{})}
	go x.loop()
	return x
}

// Want asks for the metadata of ids (a session's order) to be filled in.
func (x *Extractor) Want(queryID int64, ids []int64) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.closed {
		return
	}
	if x.queryID != queryID && x.cancel != nil {
		x.cancel() // a different session took over
	}
	x.queryID, x.ids = queryID, ids
	x.gen++
	select {
	case x.wake <- struct{}{}:
	default:
	}
}

// Drop stops work for a session (closed, or no longer sorted by metadata).
func (x *Extractor) Drop(queryID int64) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.queryID != queryID {
		return
	}
	if x.cancel != nil {
		x.cancel()
	}
	x.queryID, x.ids = 0, nil
	x.gen++
}

// Close stops the loop and waits for it.
func (x *Extractor) Close() {
	x.mu.Lock()
	x.closed = true
	if x.cancel != nil {
		x.cancel()
	}
	x.mu.Unlock()
	close(x.wake)
	<-x.done
}

func (x *Extractor) loop() {
	defer close(x.done)
	for range x.wake {
		for {
			x.mu.Lock()
			if x.closed || x.queryID == 0 {
				x.mu.Unlock()
				break
			}
			ctx, cancel := context.WithCancel(context.Background())
			x.cancel = cancel
			queryID, ids, gen := x.queryID, x.ids, x.gen
			x.mu.Unlock()

			x.pass(ctx, queryID, ids)
			cancel()

			x.mu.Lock()
			again := x.gen != gen && !x.closed
			if !again && x.queryID == queryID {
				x.queryID, x.ids = 0, nil // finished; a refresh asks again if needed
			}
			x.mu.Unlock()
			if !again {
				break
			}
		}
	}
}

// pass extracts every pending entry of ids in session order.
func (x *Extractor) pass(ctx context.Context, queryID int64, ids []int64) {
	for lo := 0; lo < len(ids); lo += x.opts.Chunk {
		if ctx.Err() != nil {
			return
		}
		pending, err := x.store.MetaPending(ctx, ids[lo:min(lo+x.opts.Chunk, len(ids))])
		if err != nil {
			if ctx.Err() == nil {
				x.log.Warn("metadata: load pending", "err", err)
			}
			return
		}
		if len(pending) == 0 {
			continue
		}
		dims := x.extract(ctx, pending)
		if len(dims) == 0 {
			continue
		}
		if err := x.store.SetDimensions(context.WithoutCancel(ctx), dims); err != nil {
			x.log.Warn("metadata: write", "err", err)
			return
		}
		x.refresh(queryID)
	}
}

// extract reads metadata of one chunk with a fixed number of workers.
func (x *Extractor) extract(ctx context.Context, srcs []index.MetaSource) []index.Dimension {
	jobs := make(chan index.MetaSource)
	var mu sync.Mutex
	var out []index.Dimension
	var wg sync.WaitGroup
	for range min(x.opts.Workers, len(srcs)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for src := range jobs {
				if d, ok := x.one(ctx, src); ok {
					mu.Lock()
					out = append(out, d)
					mu.Unlock()
				}
			}
		}()
	}
feed:
	for _, s := range srcs {
		select {
		case jobs <- s:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()
	return out
}

// one returns the metadata of one file; ok=false leaves it pending (file
// missing, tools unavailable, cancelled) so a later pass can retry.
func (x *Extractor) one(ctx context.Context, src index.MetaSource) (index.Dimension, bool) {
	d := index.Dimension{ID: src.ID, State: 1}
	var err error
	if src.Kind == media.KindVideo {
		var info video.Info
		info, err = x.video.Probe(ctx, src.Path, src.Size, src.Mtime)
		d.Width, d.Height, d.DurationMs = info.Width, info.Height, info.DurationMs
		if err == nil && info.VideoCodec == "" {
			err = video.ErrNoVideo
		}
	} else {
		var p imaging.Probe
		p, err = x.images.ProbeFile(src.Path, src.Ext)
		d.Width, d.Height = p.DisplaySize()
	}
	switch {
	case err == nil:
		return d, true
	case errors.Is(err, imaging.ErrUnsupported), errors.Is(err, imaging.ErrTooLarge), errors.Is(err, video.ErrNoVideo):
		return index.Dimension{ID: src.ID, State: 2}, true
	case errors.Is(err, imaging.ErrCorrupt), errors.Is(err, video.ErrCorrupt):
		return index.Dimension{ID: src.ID, State: 3}, true
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, video.ErrUnavailable), ctx.Err() != nil:
		return d, false
	}
	x.log.Debug("metadata: extract", "id", src.ID, "err", err)
	return d, false
}
