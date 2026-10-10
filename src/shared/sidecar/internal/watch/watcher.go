// Package watch watches recently opened folders, non-recursively, and turns
// bursts of filesystem events into one debounced re-listing per folder
// (ADR-0020). Both apps share one sidecar (ADR-0031), so the viewer's folder
// and the commander's two panels are watched at the same time.
package watch

import (
	"log/slog"
	"slices"
	"sync"
	"time"
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

	fs backend // nil if the platform watcher is unavailable

	mu    sync.Mutex
	limit int
	dirs  []*watched // most recently opened last
	done  chan struct{}
}

// New starts the watcher. If the OS watcher cannot be created the Watcher
// still works as a no-op (the folder is browsable, only live updates are lost).
func New(log *slog.Logger, onDirty func(dirID int64), quiet, maxWait time.Duration) *Watcher {
	w := &Watcher{log: log, onDirty: onDirty, quiet: quiet, maxWait: maxWait, limit: DefaultLimit, done: make(chan struct{})}
	fw, err := newBackend()
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
	w.limit = max(n, 1)
	evicted := w.evictLocked()
	w.mu.Unlock()
	w.remove(evicted)
}

// Watch adds a directory (or marks it most recently opened).
//
// The backend's Add and Remove run outside w.mu: on Windows fsnotify's wait
// for its I/O goroutine, which may itself be waiting to deliver an event to
// loop, and loop needs w.mu to handle it (a deadlock while the watched
// folder keeps changing; Stage P04).
func (w *Watcher) Watch(dirID int64, path string) {
	if w.fs == nil {
		return
	}
	if w.touch(dirID, path) {
		return
	}
	if err := w.fs.Add(path); err != nil {
		w.log.Warn("cannot watch folder; refresh manually", "path", path, "err", err)
		return
	}
	w.mu.Lock()
	var evicted []string
	if !w.touchLocked(dirID, path) { // not added by a concurrent Watch meanwhile
		w.dirs = append(w.dirs, &watched{dirID: dirID, path: path})
		evicted = w.evictLocked()
	}
	w.mu.Unlock()
	w.remove(evicted)
}

// touch marks a watched path most recently opened; false if not watched.
func (w *Watcher) touch(dirID int64, path string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.touchLocked(dirID, path)
}

func (w *Watcher) touchLocked(dirID int64, path string) bool {
	for i, d := range w.dirs {
		if d.path == path {
			d.dirID = dirID
			w.dirs = append(append(w.dirs[:i:i], w.dirs[i+1:]...), d)
			return true
		}
	}
	return false
}

// evictLocked drops the least recently opened folders over the limit and
// returns their paths, to be removed from the backend after unlocking.
func (w *Watcher) evictLocked() []string {
	var paths []string
	for len(w.dirs) > w.limit {
		old := w.dirs[0]
		w.dirs = w.dirs[1:]
		if old.timer != nil {
			old.timer.Stop()
		}
		paths = append(paths, old.path)
	}
	return paths
}

// remove stops watching evicted paths, unless a Watch took one back meanwhile.
func (w *Watcher) remove(paths []string) {
	for _, p := range paths {
		w.mu.Lock()
		back := slices.ContainsFunc(w.dirs, func(d *watched) bool { return d.path == p })
		w.mu.Unlock()
		if !back {
			_ = w.fs.Remove(p)
		}
	}
}

func (w *Watcher) loop() {
	defer close(w.done)
	for {
		select {
		case dir, ok := <-w.fs.changed():
			if !ok {
				return
			}
			w.event(dir)
		case err, ok := <-w.fs.errors():
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

// event schedules a re-listing of the watched directory dir.
func (w *Watcher) event(dir string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, d := range w.dirs {
		if d.path == dir {
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
