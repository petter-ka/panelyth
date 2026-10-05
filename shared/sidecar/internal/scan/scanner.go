// Package scan lists directories into the index: bounded workers, one
// batching writer per scan, cancellation that never deletes rows
// (ADR-0015).
package scan

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"fastview/sidecar/internal/fsx"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/media"
	"fastview/sidecar/internal/pathkey"
)

// Options tunes a scan. Zero values get defaults.
type Options struct {
	// Workers lists directories concurrently in recursive scans.
	Workers int
	// BatchRows caps rows per write transaction.
	BatchRows int
	// FlushInterval bounds how long listed rows wait before being committed,
	// which bounds time-to-first-results.
	FlushInterval time.Duration
	// ReadChunk is the number of directory entries read per ReadDir call.
	ReadChunk int
	// ProgressInterval throttles progress callbacks.
	ProgressInterval time.Duration
}

func (o *Options) defaults() {
	if o.Workers <= 0 {
		o.Workers = 4
	}
	if o.BatchRows <= 0 {
		o.BatchRows = 2000
	}
	if o.FlushInterval <= 0 {
		o.FlushInterval = 40 * time.Millisecond
	}
	if o.ReadChunk <= 0 {
		o.ReadChunk = 512
	}
	if o.ProgressInterval <= 0 {
		o.ProgressInterval = 100 * time.Millisecond
	}
}

// Scan states reported in Progress.State.
const (
	StateRunning   = "running"
	StateCompleted = "completed"
	StateCancelled = "cancelled"
	StateFailed    = "failed"
)

// Progress is a snapshot of a running scan. Producers emit it throttled;
// consumers coalesce further (latest wins).
type Progress struct {
	ScanID      int64  `json:"scanId"`
	DirID       int64  `json:"dirId"`
	Recursive   bool   `json:"recursive"`
	State       string `json:"state"`
	DirsListed  int    `json:"dirsListed"`
	DirsPending int    `json:"dirsPending"`
	Entries     int    `json:"entries"`
	Skipped     int    `json:"skipped"`
	Errors      int    `json:"errors"`
	ElapsedMs   int64  `json:"elapsedMs"`
}

// Stats summarizes a finished scan for benchmarks and logs.
type Stats struct {
	Progress
	Batches         int
	MaxBatchMs      float64
	TotalWriteMs    float64
	FirstCommitMs   float64
	DirsWithErrors  int
	CommitRowCounts []int
}

// Change identifies a directory whose children were written or reconciled.
type Change struct {
	DirID  int64
	DirKey string
}

// Hooks receive scan output. Both are called from scan goroutines.
type Hooks struct {
	Progress func(Progress)
	Changed  func([]Change)
}

type job struct {
	id   int64
	path string
	key  string
}

// msg flows from listing workers to the writer. A finish is sent after all
// rows of its directory, so FIFO order guarantees rows commit first.
type msg struct {
	rows   []index.Row
	finish *index.Finish
}

type commitResult struct {
	dirs     []index.DirRef
	finished int
}

// Run lists root (and, if recursive, every visible subdirectory) into the
// index under a fresh generation. It returns when the scan completes, fails
// or ctx is cancelled.
func Run(ctx context.Context, store *index.Store, log *slog.Logger, opts Options, hooks Hooks,
	scanID int64, gen int64, root index.DirInfo, recursive bool) Stats {
	opts.defaults()
	start := time.Now()
	workers := 1
	if recursive {
		workers = opts.Workers
	}

	var (
		dirsListed, entries, skipped, errCount atomic.Int64
		stats                                  = Stats{}
	)
	snapshot := func(state string, pending int) Progress {
		return Progress{
			ScanID: scanID, DirID: root.ID, Recursive: recursive, State: state,
			DirsListed: int(dirsListed.Load()), DirsPending: pending, Entries: int(entries.Load()),
			Skipped: int(skipped.Load()), Errors: int(errCount.Load()), ElapsedMs: time.Since(start).Milliseconds(),
		}
	}

	jobs := make(chan job)
	out := make(chan msg, 8) // bounded: workers block when the writer falls behind
	results := make(chan commitResult, 8)
	writeErr := make(chan error, 1)

	var workerWG sync.WaitGroup
	workerWG.Add(workers)
	for range workers {
		go func() {
			defer workerWG.Done()
			for j := range jobs {
				listDir(ctx, j, opts.ReadChunk, out, &skipped, &errCount, log)
			}
		}()
	}

	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		writeLoop(ctx, store, opts, gen, out, results, writeErr, hooks, &stats, &entries, &dirsListed, start)
	}()

	frontier := []job{{id: root.ID, path: root.Path, key: root.Key}}
	pending := 0
	state := StateCompleted
	progress := time.NewTicker(opts.ProgressInterval)
	defer progress.Stop()

loop:
	for len(frontier) > 0 || pending > 0 {
		var send chan job
		var next job
		if len(frontier) > 0 {
			send, next = jobs, frontier[len(frontier)-1] // depth-first keeps the frontier small
		}
		select {
		case send <- next:
			frontier = frontier[:len(frontier)-1]
			pending++
		case r := <-results:
			pending -= r.finished
			if recursive {
				for _, d := range r.dirs {
					// Hidden and system folders are listed but never descended
					// into (the media scope's rule, ADR-0015/ADR-0026).
					if d.Attrs&(fsx.AttrHidden|fsx.AttrSystem) == 0 {
						frontier = append(frontier, job{id: d.ID, path: d.Path, key: d.Key})
					}
				}
			}
		case err := <-writeErr:
			log.Error("index write failed; aborting scan", "scanId", scanID, "err", err)
			state = StateFailed
			break loop
		case <-progress.C:
			if hooks.Progress != nil {
				hooks.Progress(snapshot(StateRunning, pending+len(frontier)))
			}
		case <-ctx.Done():
			state = StateCancelled
			break loop
		}
	}

	// Drain results first: otherwise a writer blocked on a full results
	// channel stops consuming out, workers block on out, and Wait deadlocks.
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		for range results {
		}
	}()
	close(jobs)
	workerWG.Wait()
	close(out)
	<-writerDone
	close(results)
	<-drained

	if state == StateCompleted && ctx.Err() != nil {
		state = StateCancelled
	}
	final := snapshot(state, 0)
	if state != StateCompleted {
		final.DirsPending = pending + len(frontier)
	}
	if hooks.Progress != nil {
		hooks.Progress(final)
	}
	stats.Progress = final
	return stats
}

func listDir(ctx context.Context, j job, chunk int, out chan<- msg, skipped, errCount *atomic.Int64, log *slog.Logger) {
	fail := func(err error) {
		errCount.Add(1)
		log.Warn("cannot list directory", "path", j.path, "err", err)
		out <- msg{finish: &index.Finish{DirID: j.id, DirKey: j.key, State: index.ListingError, ErrCode: errorCode(err)}}
	}
	f, err := os.Open(j.path)
	if err != nil {
		fail(err)
		return
	}
	defer f.Close()

	var nDirs, nMedia, nSkipped int
	for {
		if ctx.Err() != nil {
			return // no finish: an incomplete listing must not reconcile
		}
		ents, readErr := f.ReadDir(chunk)
		rows := make([]index.Row, 0, len(ents))
		for _, e := range ents {
			// Every entry is stored (ADR-0026). The counters keep the viewer's
			// meaning: visible folders, visible media, and visible other files
			// ("not shown"); hidden entries and links count nowhere.
			name := e.Name()
			info, err := e.Info()
			if err != nil {
				continue // vanished between read and stat
			}
			attrs := fsx.AttrsOf(name, info)
			visible := attrs&(fsx.AttrHidden|fsx.AttrSystem) == 0
			link := fsx.IsLink(e)
			isDir := e.IsDir() && !link
			kind, ext := media.KindDir, ""
			switch {
			case link:
				kind, ext = media.KindLink, media.Ext(name)
			case !isDir:
				var ok bool
				if kind, ext, ok = media.Classify(name); !ok {
					kind = media.KindFile
				}
			}
			row := index.Row{
				ParentID: j.id, ParentKey: j.key, Kind: kind, Name: name, Ext: ext, Attrs: attrs,
				MtimeNs: info.ModTime().UnixNano(), BtimeNs: fsx.FileTimes(info).BirthNs, PathKey: pathkey.ChildKey(j.key, name, isDir),
			}
			if isDir {
				row.Path = filepath.Join(j.path, name)
			} else {
				row.Size = info.Size()
			}
			switch {
			case !visible || link:
			case isDir:
				nDirs++
			case kind.IsMedia():
				nMedia++
			default:
				nSkipped++
			}
			rows = append(rows, row)
		}
		if len(rows) > 0 {
			select {
			case out <- msg{rows: rows}:
			case <-ctx.Done():
				return
			}
		}
		if errors.Is(readErr, io.EOF) || (readErr == nil && len(ents) == 0) {
			break
		}
		if readErr != nil {
			fail(readErr)
			return
		}
	}
	skipped.Add(int64(nSkipped))
	out <- msg{finish: &index.Finish{DirID: j.id, DirKey: j.key, State: index.ListingComplete,
		ChildDirs: nDirs, ChildMedia: nMedia, Skipped: nSkipped}}
}

func writeLoop(ctx context.Context, store *index.Store, opts Options, gen int64, out <-chan msg,
	results chan<- commitResult, writeErr chan<- error, hooks Hooks, stats *Stats,
	entries, dirsListed *atomic.Int64, start time.Time) {
	// Rows already listed are real data: commit them even after
	// cancellation. Only completed listings carry a reconciling finish.
	wctx := context.WithoutCancel(ctx)
	var rows []index.Row
	var finishes []index.Finish
	failed := false
	flush := func() {
		if failed || (len(rows) == 0 && len(finishes) == 0) {
			return
		}
		t := time.Now()
		dirs, err := store.Commit(wctx, gen, rows, finishes)
		ms := float64(time.Since(t).Microseconds()) / 1000
		if err != nil {
			failed = true
			writeErr <- err
			return
		}
		stats.Batches++
		stats.TotalWriteMs += ms
		stats.MaxBatchMs = max(stats.MaxBatchMs, ms)
		stats.CommitRowCounts = append(stats.CommitRowCounts, len(rows))
		if stats.FirstCommitMs == 0 && len(rows) > 0 {
			stats.FirstCommitMs = float64(time.Since(start).Microseconds()) / 1000
		}
		entries.Add(int64(len(rows)))
		dirsListed.Add(int64(len(finishes)))

		changed := make([]Change, 0, 4)
		seen := map[int64]bool{}
		for _, r := range rows {
			if !seen[r.ParentID] {
				seen[r.ParentID] = true
				changed = append(changed, Change{DirID: r.ParentID, DirKey: r.ParentKey})
			}
		}
		for _, f := range finishes {
			if f.State == index.ListingError {
				stats.DirsWithErrors++
			}
			if !seen[f.DirID] {
				seen[f.DirID] = true
				changed = append(changed, Change{DirID: f.DirID, DirKey: f.DirKey})
			}
		}
		if hooks.Changed != nil && len(changed) > 0 {
			hooks.Changed(changed)
		}
		results <- commitResult{dirs: dirs, finished: len(finishes)}
		rows, finishes = rows[:0:0], finishes[:0:0]
	}

	ticker := time.NewTicker(opts.FlushInterval)
	defer ticker.Stop()
	for {
		select {
		case m, ok := <-out:
			if !ok {
				flush()
				return
			}
			rows = append(rows, m.rows...)
			if m.finish != nil {
				finishes = append(finishes, *m.finish)
			}
			if len(rows) >= opts.BatchRows {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

// errorCode maps filesystem errors to protocol error codes.
func errorCode(err error) string {
	switch {
	case errors.Is(err, fs.ErrPermission):
		return "PERMISSION_DENIED"
	case errors.Is(err, fs.ErrNotExist):
		return "NOT_FOUND"
	default:
		return "INTERNAL"
	}
}
