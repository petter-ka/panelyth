// Package watch watches the currently open folder, non-recursively, and
// turns bursts of filesystem events into one debounced re-listing
// (ADR-0020).
package watch

import (
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watcher holds at most one watched directory.
type Watcher struct {
	log     *slog.Logger
	onDirty func(dirID int64)
	quiet   time.Duration
	maxWait time.Duration

	fs *fsnotify.Watcher // nil if the platform watcher is unavailable

	mu         sync.Mutex
	dirID      int64
	path       string
	timer      *time.Timer
	firstEvent time.Time
	done       chan struct{}
}

// New starts the watcher. If the OS watcher cannot be created the Watcher
// still works as a no-op (the folder is browsable, only live updates are lost).
func New(log *slog.Logger, onDirty func(dirID int64), quiet, maxWait time.Duration) *Watcher {
	w := &Watcher{log: log, onDirty: onDirty, quiet: quiet, maxWait: maxWait, done: make(chan struct{})}
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

// Watch replaces the watched directory.
func (w *Watcher) Watch(dirID int64, path string) {
	if w.fs == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.path == path && w.dirID == dirID {
		return
	}
	if w.path != "" {
		_ = w.fs.Remove(w.path)
	}
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	w.dirID, w.path = 0, ""
	if err := w.fs.Add(path); err != nil {
		w.log.Warn("cannot watch folder; refresh manually", "path", path, "err", err)
		return
	}
	w.dirID, w.path = dirID, path
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
			// Overflow and similar errors: re-list to resynchronize.
			w.log.Warn("watch error; re-listing", "err", err)
			w.mu.Lock()
			w.scheduleLocked()
			w.mu.Unlock()
		}
	}
}

func (w *Watcher) event(ev fsnotify.Event) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.path == "" || filepath.Dir(ev.Name) != w.path {
		return
	}
	w.scheduleLocked()
}

// scheduleLocked debounces: each event pushes the re-listing out by quiet,
// but never beyond maxWait after the first event of a burst.
func (w *Watcher) scheduleLocked() {
	if w.dirID == 0 {
		return
	}
	now := time.Now()
	if w.timer == nil {
		w.firstEvent = now
	}
	delay := w.quiet
	if remaining := w.maxWait - now.Sub(w.firstEvent); remaining < delay {
		delay = max(remaining, 0)
	}
	if w.timer != nil {
		w.timer.Stop()
	}
	dirID := w.dirID
	w.timer = time.AfterFunc(delay, func() {
		w.mu.Lock()
		w.timer = nil
		current := w.dirID
		w.mu.Unlock()
		if current == dirID {
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
	if w.timer != nil {
		w.timer.Stop()
	}
	w.mu.Unlock()
	_ = w.fs.Close()
	<-w.done
}
