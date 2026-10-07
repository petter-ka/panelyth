package scan

import (
	"context"
	"log/slog"
	"sync"

	"fastview/sidecar/internal/index"
)

// Manager owns running scans. At most one foreground scan (the folder the
// user opened) runs at a time; starting another cancels it. Background
// re-listings (watcher) are shallow and deduplicated per directory.
type Manager struct {
	store *index.Store
	log   *slog.Logger
	opts  Options
	hooks Hooks

	mu        sync.Mutex
	ctx       context.Context
	cancelAll context.CancelFunc
	running   map[int64]*runningScan
	// foreground is the scan the user waits for, per lane (the viewer, each
	// commander panel).
	foreground map[string]int64
	// relistDirty marks directories that changed again while being re-listed.
	relistDirty map[int64]bool
	wg          sync.WaitGroup
	onFinished  func(scanID int64, stats Stats)
}

type runningScan struct {
	id        int64
	dirID     int64
	recursive bool
	cancel    context.CancelFunc
	done      chan struct{}
}

// NewManager creates a manager; onFinished (optional) observes completed scans.
func NewManager(store *index.Store, log *slog.Logger, opts Options, hooks Hooks, onFinished func(int64, Stats)) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{
		store: store, log: log, opts: opts, hooks: hooks, ctx: ctx, cancelAll: cancel,
		running: map[int64]*runningScan{}, foreground: map[string]int64{}, relistDirty: map[int64]bool{}, onFinished: onFinished,
	}
}

// Open starts the foreground scan of root in lane, cancelling the previous
// foreground scan of that lane: the viewer's folder ("") or one commander
// panel's, so a panel never stops the other panel's listing or branch view.
func (m *Manager) Open(root index.DirInfo, recursive bool, lane string) (int64, error) {
	m.mu.Lock()
	if prev := m.running[m.foreground[lane]]; prev != nil {
		prev.cancel()
	}
	m.mu.Unlock()
	id, err := m.start(root, recursive)
	if err != nil {
		return 0, err
	}
	m.mu.Lock()
	m.foreground[lane] = id
	m.mu.Unlock()
	return id, nil
}

// Relist re-lists one directory shallowly in the background. If the directory
// is already being listed, one more pass runs after the current one.
func (m *Manager) Relist(dirID int64) {
	m.mu.Lock()
	for _, r := range m.running {
		if r.dirID == dirID {
			m.relistDirty[dirID] = true
			m.mu.Unlock()
			return
		}
	}
	m.mu.Unlock()
	info, err := m.store.Dir(m.ctx, dirID)
	if err != nil {
		m.log.Warn("relist: unknown directory", "dirId", dirID, "err", err)
		return
	}
	if _, err := m.start(info, false); err != nil {
		m.log.Warn("relist failed", "dirId", dirID, "err", err)
	}
}

// Cancel stops a scan; false if it is not running.
func (m *Manager) Cancel(scanID int64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.running[scanID]
	if r == nil {
		return false
	}
	r.cancel()
	return true
}

// Wait blocks until scanID has finished (test helper and shutdown aid).
func (m *Manager) Wait(scanID int64) {
	m.mu.Lock()
	r := m.running[scanID]
	m.mu.Unlock()
	if r != nil {
		<-r.done
	}
}

// Close cancels all scans and waits for them to stop.
func (m *Manager) Close() {
	m.cancelAll()
	m.wg.Wait()
}

func (m *Manager) start(root index.DirInfo, recursive bool) (int64, error) {
	if err := m.ctx.Err(); err != nil {
		return 0, err
	}
	gen := m.store.NextGeneration()
	scanID, err := m.store.ScanStarted(m.ctx, root.ID, recursive, gen)
	if err != nil {
		return 0, err
	}
	ctx, cancel := context.WithCancel(m.ctx)
	r := &runningScan{id: scanID, dirID: root.ID, recursive: recursive, cancel: cancel, done: make(chan struct{})}
	m.mu.Lock()
	m.running[scanID] = r
	m.mu.Unlock()

	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		defer cancel()
		stats := Run(ctx, m.store, m.log, m.opts, m.hooks, scanID, gen, root, recursive)
		state := map[string]int{
			StateCompleted: index.ScanCompleted, StateCancelled: index.ScanCancelled, StateFailed: index.ScanFailed,
		}[stats.State]
		if err := m.store.ScanEnded(context.WithoutCancel(ctx), scanID, state, stats.DirsListed, stats.Entries, stats.Errors); err != nil {
			m.log.Warn("record scan end", "scanId", scanID, "err", err)
		}
		m.log.Info("scan finished", "scanId", scanID, "dirId", root.ID, "recursive", recursive, "state", stats.State,
			"dirs", stats.DirsListed, "entries", stats.Entries, "ms", stats.ElapsedMs)

		m.mu.Lock()
		delete(m.running, scanID)
		again := m.relistDirty[root.ID] && m.ctx.Err() == nil
		delete(m.relistDirty, root.ID)
		m.mu.Unlock()
		close(r.done)
		if m.onFinished != nil {
			m.onFinished(scanID, stats)
		}
		if again {
			m.Relist(root.ID)
		}
	}()
	return scanID, nil
}
