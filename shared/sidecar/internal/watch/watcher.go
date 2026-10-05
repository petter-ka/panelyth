// Package watch watches recently opened folders, non-recursively, and turns
// bursts of filesystem events into one debounced re-listing per folder
// (ADR-0020). Both apps share one sidecar (ADR-0031), so the viewer's folder
// and the commander's two panels are watched at the same time.
package watch

import (
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// DefaultLimit covers the viewer's folder, both commander panels and one more.
const DefaultLimit = 4

type watched struct {
	dirID      int64
	path       string
	timer      *time.Timer
	firstEvent time.Time
}

// Watcher holds at most limit watched directories; the least recently opened
// one is dropped first.
type Watcher struct {
	log     *slog.Logger
	onDirty func(dirID int64)
	quiet   time.Duration
	maxWait time.Duration

	fs *fsnotify.Watcher // nil if the platform watcher is unavailable

	mu    sync.Mutex
	limit int
	dirs  []*watched // most recently opened last
	done  chan struct{}
}

// New starts the watcher. If the OS watcher cannot be created the Watcher
// still works as a no-op (the folder is browsable, only live updates are lost).
func New(log *slog.Logger, onDirty func(dirID int64), quiet, maxWait time.Duration) *Watcher {
	w := &Watcher{log: log, onDirty: onDirty, quiet: quiet, maxWait: maxWait, limit: DefaultLimit, done: make(chan struct{})}
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		log.Warn("file watching unavailable", "err", err)
		close(w.done)
		return w
	}
	w.fs = fw
	go w.loop()
	return w
}

// SetLimit changes how many folders are watched at once (at least 1).
func (w *Watcher) SetLimit(n int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.limit = max(n, 1)
	w.evictLocked()
}

// Watch adds a directory (or marks it most recently opened).
func (w *Watcher) Watch(dirID int64, path string) {
	if w.fs == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	for i, d := range w.dirs {
		if d.path == path {
			d.dirID = dirID
			w.dirs = append(append(w.dirs[:i:i], w.dirs[i+1:]...), d)
			return
		}
	}
	if err := w.fs.Add(path); err != nil {
		w.log.Warn("cannot watch folder; refresh manually", "path", path, "err", err)
		return
	}
	w.dirs = append(w.dirs, &watched{dirID: dirID, path: path})
	w.evictLocked()
}

func (w *Watcher) evictLocked() {
	for len(w.dirs) > w.limit {
		old := w.dirs[0]
		w.dirs = w.dirs[1:]
		if old.timer != nil {
			old.timer.Stop()
		}
		_ = w.fs.Remove(old.path)
	}
}

func (w *Watcher) loop() {
	defer close(w.done)
	for {
		select {
		case ev, ok := <-w.fs.Events:
			if !ok {
				return
			}
			w.event(ev)
		case err, ok := <-w.fs.Errors:
			if !ok {
				return
			}
			// Overflow and similar errors: re-list everything watched to resynchronize.
			w.log.Warn("watch error; re-listing", "err", err)
			w.mu.Lock()
			for _, d := range w.dirs {
				w.scheduleLocked(d)
			}
			w.mu.Unlock()
		}
	}
}

func (w *Watcher) event(ev fsnotify.Event) {
	w.mu.Lock()
	defer w.mu.Unlock()
	parent := filepath.Dir(ev.Name)
	for _, d := range w.dirs {
		if d.path == parent {
			w.scheduleLocked(d)
			return
		}
	}
}

// scheduleLocked debounces: each event pushes the re-listing out by quiet,
// but never beyond maxWait after the first event of a burst.
func (w *Watcher) scheduleLocked(d *watched) {
	now := time.Now()
	if d.timer == nil {
		d.firstEvent = now
	}
	delay := w.quiet
	if remaining := w.maxWait - now.Sub(d.firstEvent); remaining < delay {
		delay = max(remaining, 0)
	}
	if d.timer != nil {
		d.timer.Stop()
	}
	dirID := d.dirID
	d.timer = time.AfterFunc(delay, func() {
		w.mu.Lock()
		d.timer = nil
		still := false
		for _, x := range w.dirs {
			if x == d && x.dirID == dirID {
				still = true
			}
		}
		w.mu.Unlock()
		if still {
			w.onDirty(dirID)
		}
	})
}

// Close stops watching.
func (w *Watcher) Close() {
	if w.fs == nil {
		return
	}
	w.mu.Lock()
	for _, d := range w.dirs {
		if d.timer != nil {
			d.timer.Stop()
		}
	}
	w.mu.Unlock()
	_ = w.fs.Close()
	<-w.done
}
