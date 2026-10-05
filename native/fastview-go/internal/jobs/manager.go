// Package jobs runs batch operations (ADR-0010, ADR-0021): copy, move,
// trash, delete, batch rename and user-metadata changes. Jobs are bounded
// (a fixed number run at once, the rest wait in a capped FIFO), cancellable,
// report coalesced progress and keep per-item errors for paging.
package jobs

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"time"

	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/library"
	"fastview/sidecar/internal/scan"
)

// Kind names a job type (mirrors packages/contracts JobKind).
type Kind string

const (
	KindCopy     Kind = "copy"
	KindMove     Kind = "move"
	KindTrash    Kind = "trash"
	KindDelete   Kind = "delete"
	KindRename   Kind = "rename"
	KindFavorite Kind = "favorite"
	KindRating   Kind = "rating"
	KindTag      Kind = "tag"
	KindLabel    Kind = "label"
)

// State of a job (mirrors JobState).
type State string

const (
	StateQueued    State = "queued"
	StateRunning   State = "running"
	StateCompleted State = "completed"
	StateCancelled State = "cancelled"
	StateFailed    State = "failed"
)

// Conflict policies for copy and move.
const (
	ConflictKeepBoth = "keepBoth"
	ConflictSkip     = "skip"
	ConflictReplace  = "replace"
)

// Spec describes a job. IDs are resolved by the caller (selection or
// clipboard) in display order.
type Spec struct {
	Kind        Kind
	IDs         []int64
	Destination string // copy, move: clean absolute folder path
	Conflict    string
	Pattern     string // rename
	Start       int
	Favorite    bool   // favorite
	Rating      int    // rating
	Label       int    // label (0 clears)
	Tag         string // tag
	Add         bool
}

// Snapshot is a job's progress (the job.progress payload).
type Snapshot struct {
	JobID      int64  `json:"jobId"`
	Kind       Kind   `json:"kind"`
	State      State  `json:"state"`
	Total      int    `json:"total"`
	Done       int    `json:"done"`
	Failed     int    `json:"failed"`
	Skipped    int    `json:"skipped"`
	BytesTotal int64  `json:"bytesTotal"`
	BytesDone  int64  `json:"bytesDone"`
	Current    string `json:"current"`
	// Destination is the folder name for copy/move ("" otherwise).
	Destination string `json:"destination"`
	// Error explains a job-level failure (state "failed").
	Error      string `json:"error"`
	StartedMs  int64  `json:"startedMs"`
	FinishedMs int64  `json:"finishedMs"`
}

// ItemError is one failed item.
type ItemError struct {
	Name    string `json:"name"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Limits.
const (
	MaxRunning      = 2
	MaxQueued       = 32
	MaxErrors       = 10_000
	KeepFinished    = 20
	progressEvery   = 250 * time.Millisecond
	flushEvery      = 250 * time.Millisecond
	flushItems      = 500
	maxCurrentBytes = 200
)

// ErrBusy is returned when the queue is full.
var ErrBusy = errors.New("jobs: too many jobs queued")

// ErrUnknownJob is returned for ids the manager does not know (any more).
var ErrUnknownJob = errors.New("jobs: unknown job")

// Deps are the manager's collaborators; everything is injectable for tests.
type Deps struct {
	Store *index.Store
	// Library waits for library.db; it returns an error when unavailable.
	Library func(context.Context) (*library.Library, error)
	// Changed routes index changes to query sessions.
	Changed func([]scan.Change)
	// Emit publishes a snapshot (the caller coalesces per job id).
	Emit func(Snapshot)
	Log  *slog.Logger
}

// Manager owns all jobs. Safe for concurrent use.
type Manager struct {
	deps Deps
	ctx  context.Context
	stop context.CancelFunc
	wg   sync.WaitGroup

	mu       sync.Mutex
	jobs     map[int64]*job
	queue    []*job
	running  int
	finished []int64 // ids of finished jobs, oldest first
	closed   bool
}

type job struct {
	spec   Spec
	ctx    context.Context
	cancel context.CancelFunc

	mu     sync.Mutex
	snap   Snapshot
	errors []ItemError
	// lastEmit throttles progress events; touched only by the job goroutine.
	lastEmit time.Time
}

// NewManager creates a manager and recovers jobs interrupted by a crash.
func NewManager(deps Deps) *Manager {
	if deps.Log == nil {
		deps.Log = slog.New(slog.DiscardHandler)
	}
	ctx, stop := context.WithCancel(context.Background())
	m := &Manager{deps: deps, ctx: ctx, stop: stop, jobs: map[int64]*job{}}
	m.recover()
	return m
}

// Start validates and queues a job; it runs as soon as a slot is free.
func (m *Manager) Start(spec Spec) (Snapshot, error) {
	if err := validate(spec); err != nil {
		return Snapshot{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Snapshot{}, context.Canceled
	}
	if len(m.queue) >= MaxQueued {
		return Snapshot{}, ErrBusy
	}
	id, err := m.deps.Store.JobStarted(m.ctx, string(spec.Kind), spec.Destination, len(spec.IDs))
	if err != nil {
		return Snapshot{}, err
	}
	ctx, cancel := context.WithCancel(m.ctx)
	j := &job{spec: spec, ctx: ctx, cancel: cancel, snap: Snapshot{
		JobID: id, Kind: spec.Kind, State: StateQueued, Total: len(spec.IDs),
		Destination: baseName(spec.Destination), StartedMs: time.Now().UnixMilli(),
	}}
	m.jobs[id] = j
	m.queue = append(m.queue, j)
	m.pumpLocked()
	return j.snapshot(), nil
}

// pumpLocked starts queued jobs while slots are free (one goroutine each).
func (m *Manager) pumpLocked() {
	for m.running < MaxRunning && len(m.queue) > 0 && !m.closed {
		j := m.queue[0]
		m.queue = m.queue[1:]
		if j.ctx.Err() != nil { // cancelled while queued
			j.finish(StateCancelled, "")
			m.retireLocked(j)
			m.deps.Emit(j.snapshot())
			continue
		}
		m.running++
		m.wg.Add(1)
		go m.run(j)
	}
}

func (m *Manager) run(j *job) {
	defer m.wg.Done()
	j.setState(StateRunning)
	m.emit(j, true)
	state, msg := m.execute(j)
	if state == StateCompleted && j.ctx.Err() != nil {
		state = StateCancelled
	}
	j.finish(state, msg)
	s := j.snapshot()
	if err := m.deps.Store.JobEnded(context.WithoutCancel(j.ctx), s.JobID, string(s.State), s.Done, s.Failed); err != nil {
		m.deps.Log.Warn("record job end", "jobId", s.JobID, "err", err)
	}
	m.deps.Log.Info("job finished", "jobId", s.JobID, "kind", s.Kind, "state", s.State, "done", s.Done,
		"failed", s.Failed, "skipped", s.Skipped, "ms", s.FinishedMs-s.StartedMs)
	m.emit(j, true)
	m.mu.Lock()
	m.running--
	m.retireLocked(j)
	m.pumpLocked()
	m.mu.Unlock()
}

// retireLocked keeps the newest KeepFinished jobs for listing and errors.
func (m *Manager) retireLocked(j *job) {
	j.cancel()
	m.finished = append(m.finished, j.snap.JobID)
	for len(m.finished) > KeepFinished {
		delete(m.jobs, m.finished[0])
		m.finished = m.finished[1:]
	}
}

// Cancel stops a queued or running job; false if it is not active.
func (m *Manager) Cancel(id int64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.jobs[id]
	if j == nil {
		return false
	}
	if s := j.snapshot().State; s != StateQueued && s != StateRunning {
		return false
	}
	j.cancel()
	if i := slices.Index(m.queue, j); i >= 0 {
		m.queue = slices.Delete(m.queue, i, i+1)
		j.finish(StateCancelled, "")
		m.retireLocked(j)
		m.deps.Emit(j.snapshot())
	}
	return true
}

// List returns active and recently finished jobs, oldest first.
func (m *Manager) List() []Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Snapshot, 0, len(m.jobs))
	for _, j := range m.jobs {
		out = append(out, j.snapshot())
	}
	slices.SortFunc(out, func(a, b Snapshot) int { return int(a.JobID - b.JobID) })
	return out
}

// Errors pages a job's item errors.
func (m *Manager) Errors(id int64, offset, limit int) ([]ItemError, int, error) {
	m.mu.Lock()
	j := m.jobs[id]
	m.mu.Unlock()
	if j == nil {
		return nil, 0, ErrUnknownJob
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	total := len(j.errors)
	lo := min(max(offset, 0), total)
	hi := min(lo+max(limit, 0), total)
	return slices.Clone(j.errors[lo:hi]), total, nil
}

// Close cancels every job and waits for running ones to stop.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	m.mu.Unlock()
	m.stop()
	m.wg.Wait()
}

// emit publishes the snapshot, at most every progressEvery unless forced.
// Called only from the job's own goroutine.
func (m *Manager) emit(j *job, force bool) {
	now := time.Now()
	if !force && now.Sub(j.lastEmit) < progressEvery {
		return
	}
	j.lastEmit = now
	m.deps.Emit(j.snapshot())
}

func (j *job) snapshot() Snapshot {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.snap
}

func (j *job) setState(s State) {
	j.mu.Lock()
	j.snap.State = s
	j.mu.Unlock()
}

func (j *job) finish(s State, msg string) {
	j.mu.Lock()
	j.snap.State, j.snap.Error, j.snap.Current = s, msg, ""
	j.snap.FinishedMs = time.Now().UnixMilli()
	j.mu.Unlock()
}

func (j *job) update(fn func(s *Snapshot)) {
	j.mu.Lock()
	fn(&j.snap)
	j.mu.Unlock()
}

func (j *job) fail(name, code, message string) {
	j.mu.Lock()
	j.snap.Failed++
	if len(j.errors) < MaxErrors {
		j.errors = append(j.errors, ItemError{Name: name, Code: code, Message: message})
	}
	j.mu.Unlock()
}

func (m *Manager) recover() {
	dests, err := m.deps.Store.RecoverJobs(m.ctx)
	if err != nil {
		m.deps.Log.Warn("recover jobs", "err", err)
		return
	}
	for _, d := range dests {
		if n := removePartials(d); n > 0 {
			m.deps.Log.Info("removed partial copies of an interrupted job", "dir", d, "count", n)
		}
	}
}
