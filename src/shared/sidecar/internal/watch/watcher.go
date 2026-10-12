// Package watch watches the folders the visible app shows, non-recursively,
// and turns bursts of filesystem events into one debounced re-listing per
// folder (ADR-0020). Both apps share one sidecar (ADR-0031): the viewer's
// folder and each commander panel's folder are slots, and only the slots of
// the app on screen are watched (ADR-0026). A hidden app's folders are
// re-listed when it is shown again.
package watch

import (
	"log/slog"
	"slices"
	"sync"
	"time"
)

// MaxLanes bounds the slots of one app: a commander has two panels, and a
// renderer could name any lane.
const MaxLanes = 4

// Slot is a place where an app shows a folder: the viewer's one folder
// (lane ""), or a commander panel (its side). A slot holds one folder; the
// next folder opened in it replaces the watch.
type Slot struct {
	// App is the app named by Electron main; "" is main itself and callers
	// that name no app, whose folders are always watched.
	App  string
	Lane string
}

type slotState struct {
	path string
	seq  uint64 // order of opening; the oldest slot of an app is dropped first
}

// folder is one path some slot holds.
type folder struct {
	dirID int64
	// active: a slot of an app on screen holds it. added: the backend
	// watches it. failed: it could not (a network share, too many watches);
	// not retried until every slot let go of the path.
	active, added, failed bool
	timer                 *time.Timer
	firstEvent            time.Time
}

// Watcher holds at most MaxLanes folders per app.
type Watcher struct {
	log     *slog.Logger
	onDirty func(dirID int64)
	quiet   time.Duration
	maxWait time.Duration

	fs backend // nil if the platform watcher is unavailable

	// syncMu serializes changes of the backend's watch set. The backend's
	// Add and Remove run under it but outside mu: on Windows fsnotify's wait
	// for its I/O goroutine, which may itself be waiting to deliver an event
	// to loop, and loop needs mu to handle it (a deadlock while the watched
	// folder keeps changing; Stage P04).
	syncMu sync.Mutex

	mu      sync.Mutex
	slots   map[Slot]*slotState
	folders map[string]*folder
	seq     uint64
	// visible is the app on screen; until main names one (restricted is
	// false) every app's folders are watched.
	visible    string
	restricted bool
	done       chan struct{}
}

// New starts the watcher. If the OS watcher cannot be created the Watcher
// still works as a no-op (the folder is browsable, only live updates are lost).
func New(log *slog.Logger, onDirty func(dirID int64), quiet, maxWait time.Duration) *Watcher {
	fw, err := newBackend()
	if err != nil {
		log.Warn("file watching unavailable", "err", err)
		return newWatcher(log, onDirty, quiet, maxWait, nil)
	}
	return newWatcher(log, onDirty, quiet, maxWait, fw)
}

func newWatcher(log *slog.Logger, onDirty func(dirID int64), quiet, maxWait time.Duration, fs backend) *Watcher {
	w := &Watcher{log: log, onDirty: onDirty, quiet: quiet, maxWait: maxWait, fs: fs,
		slots: map[Slot]*slotState{}, folders: map[string]*folder{}, done: make(chan struct{})}
	if fs == nil {
		close(w.done)
		return w
	}
	go w.loop()
	return w
}

// Watch puts a folder into slot, replacing the slot's previous folder. It is
// watched at once if the slot's app is on screen, otherwise when it is shown.
func (w *Watcher) Watch(slot Slot, dirID int64, path string) {
	if w.fs == nil {
		return
	}
	w.mu.Lock()
	w.seq++
	if s := w.slots[slot]; s != nil {
		s.path, s.seq = path, w.seq
	} else {
		w.slots[slot] = &slotState{path: path, seq: w.seq}
		w.trimLocked(slot.App)
	}
	if f := w.folders[path]; f != nil {
		f.dirID = dirID // the index may have been recreated
	} else {
		w.folders[path] = &folder{dirID: dirID}
	}
	w.mu.Unlock()
	w.sync(false)
}

// trimLocked drops the least recently opened slots of app over MaxLanes.
func (w *Watcher) trimLocked(app string) {
	for {
		var oldest Slot
		var oldestSeq uint64
		n := 0
		for slot, s := range w.slots {
			if slot.App != app {
				continue
			}
			n++
			if oldestSeq == 0 || s.seq < oldestSeq {
				oldest, oldestSeq = slot, s.seq
			}
		}
		if n <= MaxLanes {
			return
		}
		delete(w.slots, oldest)
	}
}

// Show names the app on screen: from now on only its folders (and main's
// own) are watched. Folders it shows that were not watched while it was
// hidden are re-listed, since they may have changed meanwhile: after the
// quiet period, so a folder the app leaves at once (it opens the folder
// carried over from the other app) is not listed for nothing. Naming the
// app that is already on screen does nothing.
func (w *Watcher) Show(app string) {
	if w.fs == nil {
		return
	}
	w.mu.Lock()
	same := w.restricted && w.visible == app
	w.visible, w.restricted = app, true
	w.mu.Unlock()
	if same {
		return
	}
	stale := w.sync(true)
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, path := range stale {
		if f := w.folders[path]; f != nil && f.active {
			w.scheduleLocked(f)
		}
	}
}

func (w *Watcher) activeLocked(slot Slot) bool {
	return !w.restricted || slot.App == "" || slot.App == w.visible
}

// sync makes the backend watch exactly the folders of the active slots.
// With shown (the visible app changed) it returns the folders of that app
// that were not watched until now.
func (w *Watcher) sync(shown bool) (stale []string) {
	w.syncMu.Lock()
	defer w.syncMu.Unlock()

	w.mu.Lock()
	want := map[string]bool{}  // the path is in an active slot
	ofApp := map[string]bool{} // ... of the app that was just shown
	held := map[string]bool{}  // the path is in any slot
	for slot, s := range w.slots {
		held[s.path] = true
		if w.activeLocked(slot) {
			want[s.path] = true
			if shown && slot.App != "" && slot.App == w.visible {
				ofApp[s.path] = true
			}
		}
	}
	var add, remove []string
	for path, f := range w.folders {
		f.active = want[path]
		switch {
		case want[path] && !f.added && !f.failed:
			add = append(add, path)
		case want[path] && f.failed && ofApp[path]:
			// Never watched (a network share): out of date like the rest.
			stale = append(stale, path)
		case !want[path]:
			// Hidden, or in no slot any more: no events, no pending re-listing.
			if f.timer != nil {
				f.timer.Stop()
				f.timer = nil
			}
			if f.added {
				f.added = false
				remove = append(remove, path)
			}
			if !held[path] {
				delete(w.folders, path)
			}
		}
	}
	w.mu.Unlock()

	for _, path := range remove {
		_ = w.fs.Remove(path)
	}
	for _, path := range add {
		err := w.fs.Add(path)
		if err != nil {
			w.log.Warn("cannot watch folder; refresh manually", "path", path, "err", err)
		}
		w.mu.Lock()
		if f := w.folders[path]; f != nil {
			f.added, f.failed = err == nil, err != nil
			// Unwatched until now: what it holds may be out of date, watch
			// or no watch.
			if ofApp[path] {
				stale = append(stale, path)
			}
		}
		w.mu.Unlock()
	}
	return stale
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
			for _, f := range w.folders {
				if f.active {
					w.scheduleLocked(f)
				}
			}
			w.mu.Unlock()
		}
	}
}

// event schedules a re-listing of the watched directory dir.
func (w *Watcher) event(dir string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if f := w.folders[dir]; f != nil && f.added {
		w.scheduleLocked(f)
	}
}

// scheduleLocked debounces: each event pushes the re-listing out by quiet,
// but never beyond maxWait after the first event of a burst.
func (w *Watcher) scheduleLocked(f *folder) {
	now := time.Now()
	if f.timer == nil {
		f.firstEvent = now
	}
	delay := w.quiet
	if remaining := w.maxWait - now.Sub(f.firstEvent); remaining < delay {
		delay = max(remaining, 0)
	}
	if f.timer != nil {
		f.timer.Stop()
	}
	var timer *time.Timer
	timer = time.AfterFunc(delay, func() {
		w.mu.Lock()
		// Not after the folder left its slots or its app was hidden (both
		// stop or replace the timer).
		still := f.timer == timer && f.active
		if still {
			f.timer = nil
		}
		dirID := f.dirID
		w.mu.Unlock()
		if still {
			w.onDirty(dirID)
		}
	})
	f.timer = timer
}

// Watched returns the folders watched right now, sorted (tests, diagnostics).
func (w *Watcher) Watched() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	var paths []string
	for path, f := range w.folders {
		if f.added {
			paths = append(paths, path)
		}
	}
	slices.Sort(paths)
	return paths
}

// Close stops watching.
func (w *Watcher) Close() {
	if w.fs == nil {
		return
	}
	w.mu.Lock()
	for _, f := range w.folders {
		if f.timer != nil {
			f.timer.Stop()
			f.timer = nil
		}
	}
	w.mu.Unlock()
	_ = w.fs.Close()
	<-w.done
}
