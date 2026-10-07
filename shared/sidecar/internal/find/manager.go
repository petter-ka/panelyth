package find

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/scan"
)

// States reported in Progress.State.
const (
	StateRunning   = "running"
	StateCompleted = "completed"
	StateCancelled = "cancelled"
	StateFailed    = "failed"
)

// MaxResults bounds one search (memory: about 150 bytes per result here,
// one index row each). The search stops there and reports Truncated.
const MaxResults = 250_000

// MaxRuns bounds the searches kept for their results; the oldest finished
// one is forgotten first.
const MaxRuns = 8

// ErrUnknown is returned for searches that ended and were forgotten.
var ErrUnknown = errors.New("find: unknown search")

// Progress is the find.progress event (shared/contracts/src/events.ts).
type Progress struct {
	FindID int64  `json:"findId"`
	State  string `json:"state"`
	Counters
	Matches   int  `json:"matches"`
	Truncated bool `json:"truncated"`
	// FirstMatchMs is the time to the first result; -1 before it.
	FirstMatchMs int64 `json:"firstMatchMs"`
	ElapsedMs    int64 `json:"elapsedMs"`
}

// Deps wires a manager into the sidecar.
type Deps struct {
	Store *index.Store
	Log   *slog.Logger
	// Progress receives throttled progress and always the final state.
	Progress func(Progress)
	// Refresh re-materializes a query session over a search's results.
	Refresh func(sessionID int64)
	Options Options
	// MaxResults overrides the result bound (tests).
	MaxResults int
}

type run struct {
	id       int64
	src      *Source
	cancel   context.CancelFunc
	done     chan struct{}
	sessions map[int64]bool
	finished bool
}

// Manager owns running and finished searches.
type Manager struct {
	deps Deps
	ctx  context.Context
	stop context.CancelFunc
	wg   sync.WaitGroup

	mu       sync.Mutex
	runs     map[int64]*run
	order    []int64 // start order
	sessions map[int64]int64
	nextID   int64
}

// NewManager creates a manager.
func NewManager(deps Deps) *Manager {
	if deps.MaxResults <= 0 {
		deps.MaxResults = MaxResults
	}
	ctx, stop := context.WithCancel(context.Background())
	return &Manager{deps: deps, ctx: ctx, stop: stop, runs: map[int64]*run{}, sessions: map[int64]int64{}}
}

// Start begins a search and returns its id; results reach the sessions
// attached to it. open, when set, opens the first session over the results
// before the walk starts (its first version is empty); an error from it
// cancels the search.
func (m *Manager) Start(c *Compiled, open func(src *Source) (sessionID int64, err error)) (int64, *Source, error) {
	if err := m.ctx.Err(); err != nil {
		return 0, nil, err
	}
	ctx, cancel := context.WithCancel(m.ctx)
	m.mu.Lock()
	m.nextID++
	r := &run{id: m.nextID, src: newSource(m.deps.Store), cancel: cancel, done: make(chan struct{}), sessions: map[int64]bool{}}
	m.runs[r.id] = r
	m.order = append(m.order, r.id)
	m.evictLocked()
	m.mu.Unlock()

	if open != nil {
		sid, err := open(r.src)
		m.mu.Lock()
		if err != nil {
			r.finished = true
			m.forgetLocked(r)
		} else {
			r.sessions[sid] = true
			m.sessions[sid] = r.id
		}
		m.mu.Unlock()
		if err != nil {
			cancel()
			close(r.done)
			return 0, nil, err
		}
	}
	m.wg.Go(func() {
		defer cancel()
		defer close(r.done)
		m.run(ctx, r, c)
	})
	return r.id, r.src, nil
}

func (m *Manager) run(ctx context.Context, r *run, c *Compiled) {
	start := time.Now()
	gen := m.deps.Store.NextGeneration()
	dirs := index.FoundDirs{}
	var (
		mu         sync.Mutex
		firstMatch int64 = -1
		truncated  bool
		failed     bool
	)
	limit := m.deps.MaxResults
	emit := func(state string, cnt Counters) {
		if m.deps.Progress == nil {
			return
		}
		mu.Lock()
		p := Progress{FindID: r.id, State: state, Counters: cnt, Matches: r.src.Len(), Truncated: truncated,
			FirstMatchMs: firstMatch, ElapsedMs: time.Since(start).Milliseconds()}
		mu.Unlock()
		m.deps.Progress(p)
	}
	sink := func(batch []index.Found) bool {
		room := limit - r.src.Len()
		if len(batch) > room {
			batch = batch[:max(room, 0)]
		}
		if len(batch) > 0 {
			// Matches are real data: written even while cancelling.
			ids, err := m.deps.Store.PutFound(context.WithoutCancel(ctx), gen, batch, dirs)
			if err != nil {
				m.deps.Log.Error("find: write results", "findId", r.id, "err", err)
				mu.Lock()
				failed = true
				mu.Unlock()
				return false
			}
			parents := make([]int64, len(batch))
			for i, f := range batch {
				parents[i] = dirs[f.Dir].ID
			}
			if r.src.add(batch, ids, parents) > 0 {
				mu.Lock()
				if firstMatch < 0 {
					firstMatch = time.Since(start).Milliseconds()
				}
				mu.Unlock()
				m.refresh(r)
			}
		}
		if r.src.Len() >= limit {
			mu.Lock()
			truncated = true
			mu.Unlock()
			return false
		}
		return true
	}
	cnt := Run(ctx, c, m.deps.Options, sink, func(cnt Counters) { emit(StateRunning, cnt) })
	state := StateCompleted
	mu.Lock()
	switch {
	case failed:
		state = StateFailed
	case truncated:
	case ctx.Err() != nil:
		state = StateCancelled
	}
	mu.Unlock()
	m.mu.Lock()
	r.finished = true
	m.mu.Unlock()
	m.deps.Log.Info("find finished", "findId", r.id, "state", state, "dirs", cnt.Dirs, "entries", cnt.Entries,
		"matches", r.src.Len(), "ms", time.Since(start).Milliseconds())
	emit(state, cnt)
}

// refresh re-materializes the sessions over r's results.
func (m *Manager) refresh(r *run) {
	if m.deps.Refresh == nil {
		return
	}
	m.mu.Lock()
	ids := make([]int64, 0, len(r.sessions))
	for id := range r.sessions {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.deps.Refresh(id)
	}
}

// Source returns a search's results, running or finished.
func (m *Manager) Source(findID int64) (*Source, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.runs[findID]
	if r == nil {
		return nil, ErrUnknown
	}
	return r.src, nil
}

// Attach ties a query session to a search, so new results refresh it.
func (m *Manager) Attach(findID, sessionID int64) {
	m.mu.Lock()
	r := m.runs[findID]
	if r != nil {
		r.sessions[sessionID] = true
		m.sessions[sessionID] = findID
	}
	m.mu.Unlock()
	// Results that arrived before the session existed.
	if r != nil && r.src.Len() > 0 && m.deps.Refresh != nil {
		m.deps.Refresh(sessionID)
	}
}

// Dropped forgets a closed or evicted session; a finished search without
// sessions is forgotten with it.
func (m *Manager) Dropped(sessionID int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	findID, ok := m.sessions[sessionID]
	if !ok {
		return
	}
	delete(m.sessions, sessionID)
	if r := m.runs[findID]; r != nil {
		delete(r.sessions, sessionID)
		if r.finished && len(r.sessions) == 0 {
			m.forgetLocked(r)
		}
	}
}

// Cancel stops a running search; false when it is not running.
func (m *Manager) Cancel(findID int64) bool {
	m.mu.Lock()
	r := m.runs[findID]
	m.mu.Unlock()
	if r == nil {
		return false
	}
	select {
	case <-r.done:
		return false
	default:
		r.cancel()
		return true
	}
}

// Wait blocks until a search has stopped (tests, benchmarks).
func (m *Manager) Wait(findID int64) {
	m.mu.Lock()
	r := m.runs[findID]
	m.mu.Unlock()
	if r != nil {
		<-r.done
	}
}

// Changed routes index changes to the searches whose results they touch.
func (m *Manager) Changed(changes []scan.Change) {
	m.mu.Lock()
	runs := make([]*run, 0, len(m.runs))
	for _, r := range m.runs {
		if len(r.sessions) > 0 {
			runs = append(runs, r)
		}
	}
	m.mu.Unlock()
	for _, r := range runs {
		if r.src.changed(changes) {
			m.refresh(r)
		}
	}
}

// Close cancels every search and waits for them.
func (m *Manager) Close() {
	m.stop()
	m.wg.Wait()
}

func (m *Manager) evictLocked() {
	for len(m.runs) > MaxRuns {
		var victim *run
		for _, id := range m.order {
			r := m.runs[id]
			if r == nil || !r.finished {
				continue
			}
			if victim == nil || (len(victim.sessions) > 0 && len(r.sessions) == 0) {
				victim = r
			}
		}
		if victim == nil {
			return // all running: they end on their own
		}
		m.forgetLocked(victim)
	}
}

func (m *Manager) forgetLocked(r *run) {
	delete(m.runs, r.id)
	for id := range r.sessions {
		delete(m.sessions, id)
	}
	for i, id := range m.order {
		if id == r.id {
			m.order = append(m.order[:i], m.order[i+1:]...)
			break
		}
	}
}
