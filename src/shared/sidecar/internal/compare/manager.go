package compare

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"panelyth/sidecar/internal/fsx"
)

// States reported in Progress.State.
const (
	StateRunning   = "running"
	StateCompleted = "completed"
	StateCancelled = "cancelled"
	StateFailed    = "failed"
)

// Phases of a running compare.
const (
	PhaseListing = "listing"
	PhaseContent = "content"
)

// MaxRuns bounds the compares kept for their rows; the oldest finished one
// is forgotten first.
const MaxRuns = 4

// ErrUnknown is returned for compares that were closed or forgotten.
var ErrUnknown = errors.New("compare: unknown compare")

// Progress is the compare.progress event (src/shared/contracts/src/events.ts).
type Progress struct {
	CompareID int64  `json:"compareId"`
	State     string `json:"state"`
	Phase     string `json:"phase"`
	Counters
	Rows      int   `json:"rows"`
	Truncated bool  `json:"truncated"`
	ElapsedMs int64 `json:"elapsedMs"`
}

// Deps wires a manager into the sidecar.
type Deps struct {
	Log *slog.Logger
	// Progress receives throttled progress and always the final state.
	Progress func(Progress)
	// Refresh re-materializes a query session over a compare's rows.
	Refresh func(sessionID int64)
	// Walkers and Readers override the folder readers and the content
	// readers (benchmarks); 0 chooses by the volumes.
	Walkers, Readers int
}

type run struct {
	res      *Result
	cancel   context.CancelFunc
	done     chan struct{}
	sessions map[int64]bool
	finished bool
}

// Manager owns running and finished compares.
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
	if deps.Log == nil {
		deps.Log = slog.New(slog.DiscardHandler)
	}
	ctx, stop := context.WithCancel(context.Background())
	return &Manager{deps: deps, ctx: ctx, stop: stop, runs: map[int64]*run{}, sessions: map[int64]int64{}}
}

// Start begins a compare and returns its result. open opens the session over
// its rows before the walk starts (its first version is empty); an error
// from it cancels the compare.
func (m *Manager) Start(spec Spec, open func(res *Result) (sessionID int64, err error)) (*Result, error) {
	if err := m.ctx.Err(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(m.ctx)
	m.mu.Lock()
	m.nextID++
	r := &run{res: newResult(m.nextID, spec), cancel: cancel, done: make(chan struct{}), sessions: map[int64]bool{}}
	m.runs[r.res.id] = r
	m.order = append(m.order, r.res.id)
	m.evictLocked()
	m.mu.Unlock()

	if open != nil {
		sid, err := open(r.res)
		m.mu.Lock()
		if err != nil {
			r.finished = true
			m.forgetLocked(r)
		} else {
			r.sessions[sid] = true
			m.sessions[sid] = r.res.id
		}
		m.mu.Unlock()
		if err != nil {
			cancel()
			close(r.done)
			return nil, err
		}
	}
	m.wg.Go(func() {
		defer cancel()
		defer close(r.done)
		m.run(ctx, r)
	})
	return r.res, nil
}

func (m *Manager) run(ctx context.Context, r *run) {
	start := time.Now()
	res, spec := r.res, &r.res.spec
	var cnt counters
	phase := PhaseListing
	emit := func(state string) {
		if m.deps.Progress == nil {
			return
		}
		res.mu.RLock()
		rows, truncated := len(res.rows), res.truncated
		res.mu.RUnlock()
		m.deps.Progress(Progress{CompareID: res.id, State: state, Phase: phase, Counters: cnt.snapshot(), Rows: rows,
			Truncated: truncated, ElapsedMs: time.Since(start).Milliseconds()})
	}
	// One reader per side at a time on disks that seek.
	walkers, readers := 8, 2
	if fsx.IsRotational(spec.Left) || fsx.IsRotational(spec.Right) {
		walkers, readers = 1, 1
	}
	if m.deps.Walkers > 0 {
		walkers = m.deps.Walkers
	}
	if m.deps.Readers > 0 {
		readers = m.deps.Readers
	}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	err := walk(ctx, spec, res, &cnt, walkers, tick.C, func() { emit(StateRunning) })
	state := StateCompleted
	switch {
	case err != nil && ctx.Err() == nil:
		state = StateFailed
		m.deps.Log.Warn("compare failed", "compareId", res.id, "err", err)
	case ctx.Err() != nil:
		state = StateCancelled
	}
	if state == StateCompleted {
		res.arrange()
		m.refresh(r) // the rows by size and date, while their contents are read
		if spec.Content {
			phase = PhaseContent
			stop := make(chan struct{})
			ticked := make(chan struct{})
			go func() {
				defer close(ticked)
				for {
					select {
					case <-tick.C:
						emit(StateRunning)
					case <-stop:
						return
					}
				}
			}()
			compareContent(ctx, spec, res, &cnt, readers)
			close(stop)
			<-ticked
			if ctx.Err() != nil {
				state = StateCancelled
			}
		}
	}
	if state == StateCompleted {
		res.finish()
	}
	m.mu.Lock()
	r.finished = true
	m.mu.Unlock()
	m.refresh(r)
	c := cnt.snapshot()
	m.deps.Log.Info("compare finished", "compareId", res.id, "state", state, "dirs", c.Dirs, "entries", c.Entries,
		"rows", res.Len(), "ms", time.Since(start).Milliseconds())
	emit(state)
}

// refresh re-materializes the sessions over r's rows.
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

// Result returns a compare's rows, running or finished.
func (m *Manager) Result(compareID int64) (*Result, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.runs[compareID]
	if r == nil {
		return nil, ErrUnknown
	}
	return r.res, nil
}

// Sessions returns the query sessions over a compare.
func (m *Manager) Sessions(compareID int64) []int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.runs[compareID]
	if r == nil {
		return nil
	}
	ids := make([]int64, 0, len(r.sessions))
	for id := range r.sessions {
		ids = append(ids, id)
	}
	return ids
}

// OfSession returns the compare a query session lists, if any.
func (m *Manager) OfSession(sessionID int64) *Result {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.runs[m.sessions[sessionID]]; r != nil {
		return r.res
	}
	return nil
}

// Dropped forgets a closed or evicted session; a finished compare without
// sessions is forgotten with it.
func (m *Manager) Dropped(sessionID int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.sessions[sessionID]
	if !ok {
		return
	}
	delete(m.sessions, sessionID)
	if r := m.runs[id]; r != nil {
		delete(r.sessions, sessionID)
		if r.finished && len(r.sessions) == 0 {
			m.forgetLocked(r)
		}
	}
}

// Cancel stops a running compare; false when it is not running.
func (m *Manager) Cancel(compareID int64) bool {
	m.mu.Lock()
	r := m.runs[compareID]
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

// Close cancels a compare and forgets its rows; false when it is unknown.
// The caller closes its sessions.
func (m *Manager) Close(compareID int64) bool {
	m.mu.Lock()
	r := m.runs[compareID]
	if r != nil {
		m.forgetLocked(r)
	}
	m.mu.Unlock()
	if r == nil {
		return false
	}
	r.cancel()
	return true
}

// Wait blocks until a compare has stopped (tests, benchmarks).
func (m *Manager) Wait(compareID int64) {
	m.mu.Lock()
	r := m.runs[compareID]
	m.mu.Unlock()
	if r != nil {
		<-r.done
	}
}

// Shutdown cancels every compare and waits for them.
func (m *Manager) Shutdown() {
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
	delete(m.runs, r.res.id)
	for id := range r.sessions {
		delete(m.sessions, id)
	}
	for i, id := range m.order {
		if id == r.res.id {
			m.order = append(m.order[:i], m.order[i+1:]...)
			break
		}
	}
}
