// Package jobs runs batch operations (ADR-0010, ADR-0021, ADR-0029): copy,
// move, trash, delete, batch rename, folder sizes and user-metadata changes.
// Jobs wait in a capped queue and run in lanes, one per source and
// destination volume: jobs of different lanes run in parallel, jobs of one
// lane one after another. A job can be paused, resumed, started right away,
// and asked about conflicts; it reports coalesced progress with speed and
// ETA and keeps per-item errors for paging.
package jobs

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"time"

	"panelyth/sidecar/internal/archive"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/library"
	"panelyth/sidecar/internal/scan"
)

// Kind names a job type (mirrors shared/contracts JobKind).
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
	StatePaused    State = "paused"
	StateAsking    State = "asking" // waiting for a conflict answer (ADR-0029)
	StateCompleted State = "completed"
	StateCancelled State = "cancelled"
	StateFailed    State = "failed"
)

// Active reports whether the state is not final.
func (s State) Active() bool {
	return s == StateQueued || s == StateRunning || s == StatePaused || s == StateAsking
}

// Conflict policies for copy and move (ADR-0029).
const (
	ConflictAsk                    = "ask"
	ConflictKeepBoth               = "keepBoth"
	ConflictSkip                   = "skip"
	ConflictReplace                = "replace"
	ConflictReplaceOlder           = "replaceOlder"
	ConflictReplaceIfDifferentSize = "replaceIfDifferentSize"
	ConflictRenameNew              = "renameNew"
	ConflictRenameExisting         = "renameExisting"
)

// Decisions are the policies a conflict answer may choose (all but ask).
var Decisions = []string{ConflictKeepBoth, ConflictSkip, ConflictReplace, ConflictReplaceOlder,
	ConflictReplaceIfDifferentSize, ConflictRenameNew, ConflictRenameExisting}

var policies = append([]string{ConflictAsk}, Decisions...)

// Spec describes a job. IDs are resolved by the caller (selection or
// clipboard) in display order.
type Spec struct {
	Kind        Kind
	IDs         []int64
	Destination string // copy, move: clean absolute folder path
	Conflict    string
	// Verify hashes source and copy (copy, move across volumes).
	Verify bool
	// CopyLinks copies links as links (the commander); otherwise they are
	// skipped and reported (the viewer, ADR-0021).
	CopyLinks bool
	// Now starts the job right away instead of after its lane's queue.
	Now bool
	// Mask limits a copy or move to the files matching it ("*.jpg;*.png|x*",
	// the nameMask syntax); folders are copied with their matching files.
	Mask string
	// Name gives a single copied or moved item a new name (Shift+F5).
	Name     string
	Pattern  string // rename
	Start    int
	Favorite bool   // favorite
	Rating   int    // rating
	Label    int    // label (0 clears)
	Tag      string // tag
	Add      bool
	// Archive holds the extract, pack and test fields (Stage C07).
	Archive ArchiveSpec
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
	// BytesPerSec and EtaMs come from a moving window of recent progress;
	// 0 while unknown, queued, paused or finished (ADR-0029).
	BytesPerSec int64 `json:"bytesPerSec"`
	EtaMs       int64 `json:"etaMs"`
	// Conflict is the question a job in state "asking" waits on.
	Conflict *Conflict `json:"conflict,omitempty"`
}

// ConflictSide describes one side of a conflict.
type ConflictSide struct {
	// ID is the entry id when the item is indexed (for a preview), else 0.
	ID         int64 `json:"id"`
	Size       int64 `json:"size"`
	ModifiedMs int64 `json:"modifiedMs"`
	IsDir      bool  `json:"isDir"`
}

// Conflict is an item whose name is taken in the destination.
type Conflict struct {
	// Name is the item's name, or its path inside a folder being merged.
	Name   string       `json:"name"`
	Source ConflictSide `json:"source"`
	Target ConflictSide `json:"target"`
}

// ItemError is one failed item.
type ItemError struct {
	Name    string `json:"name"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Limits (ADR-0029).
const (
	MaxRunning = 4
	// MaxStartNow more jobs may run when the user starts them right away.
	MaxStartNow     = 4
	MaxQueued       = 256
	MaxErrors       = 10_000
	KeepFinished    = 20
	progressEvery   = 250 * time.Millisecond
	flushEvery      = 250 * time.Millisecond
	flushItems      = 500
	maxCurrentBytes = 200
	// speedWindow is the span the speed is averaged over.
	speedWindow = 3 * time.Second
)

// ErrBusy is returned when the queue is full.
var ErrBusy = errors.New("jobs: too many jobs queued")

// ErrUnknownJob is returned for ids the manager does not know (any more).
var ErrUnknownJob = errors.New("jobs: unknown job")

// ErrNotAsking is returned by Resolve for a job without a question.
var ErrNotAsking = errors.New("jobs: the job is not waiting for an answer")

// Deps are the manager's collaborators; everything is injectable for tests.
type Deps struct {
	Store *index.Store
	// Library waits for library.db; it returns an error when unavailable.
	Library func(context.Context) (*library.Library, error)
	// Changed routes index changes to query sessions.
	Changed func([]scan.Change)
	// Emit publishes a snapshot (the caller coalesces per job id).
	Emit func(Snapshot)
	// Ask publishes a job's conflict question (job.conflict).
	Ask func(jobID int64, c Conflict)
	// Lane returns a job's lane ("" = none: runs whenever a slot is free).
	// Nil uses volumes (laneOf).
	Lane func(Spec, *index.Store) string
	// Archive is the 7-Zip archive jobs use (nil or unavailable: the
	// built-in formats only).
	Archive *archive.Tool
	Log     *slog.Logger
}

// Manager owns all jobs. Safe for concurrent use.
type Manager struct {
	deps Deps
	ctx  context.Context
	stop context.CancelFunc
	wg   sync.WaitGroup

	mu      sync.Mutex
	jobs    map[int64]*job
	queue   []*job
	running int
	// nowRunning counts the running jobs started "now" (extra slots).
	nowRunning int
	lanes      map[string]int // running jobs per lane
	finished   []int64        // ids of finished jobs, oldest first
	closed     bool
}

type answer struct {
	decision string
	all      bool
}

type job struct {
	spec   Spec
	lane   string
	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	snap    Snapshot
	errors  []ItemError
	now     bool
	started bool
	// ranNow: started in one of the extra start-now slots.
	ranNow  bool
	paused  bool
	resumed chan struct{} // closed on resume
	policy  string        // conflict policy; "apply to all" answers change it
	answers chan answer

	// emitMu guards the throttle and the speed window (progress may come
	// from several copy workers).
	emitMu   sync.Mutex
	lastEmit time.Time
	samples  []sample
}

type sample struct {
	at    time.Time
	bytes int64
}

// NewManager creates a manager and recovers jobs interrupted by a crash.
func NewManager(deps Deps) *Manager {
	if deps.Log == nil {
		deps.Log = slog.New(slog.DiscardHandler)
	}
	if deps.Lane == nil {
		deps.Lane = laneOf
	}
	ctx, stop := context.WithCancel(context.Background())
	m := &Manager{deps: deps, ctx: ctx, stop: stop, jobs: map[int64]*job{}, lanes: map[string]int{}}
	m.recover()
	return m
}

// Start validates and queues a job; it runs as soon as its lane and a slot
// are free (or at once with spec.Now).
func (m *Manager) Start(spec Spec) (Snapshot, error) {
	if err := validate(spec); err != nil {
		return Snapshot{}, err
	}
	lane := m.deps.Lane(spec, m.deps.Store)
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
	j := &job{spec: spec, lane: lane, ctx: ctx, cancel: cancel, now: spec.Now, policy: spec.Conflict,
		answers: make(chan answer, 1), snap: Snapshot{
			JobID: id, Kind: spec.Kind, State: StateQueued, Total: len(spec.IDs),
			Destination: baseName(spec.Destination), StartedMs: time.Now().UnixMilli(),
		}}
	m.jobs[id] = j
	m.queue = append(m.queue, j)
	m.pumpLocked()
	return j.snapshot(), nil
}

// eligibleLocked: a job runs when it is not paused and either was started
// "now" (within the extra slots) or has a free slot and an idle lane.
func (m *Manager) eligibleLocked(j *job) bool {
	j.mu.Lock()
	paused, now := j.paused, j.now
	j.mu.Unlock()
	switch {
	case paused:
		return false
	case now:
		return m.nowRunning < MaxStartNow || m.running-m.nowRunning < MaxRunning
	}
	return m.running-m.nowRunning < MaxRunning && (j.lane == "" || m.lanes[j.lane] == 0)
}

// pumpLocked starts every queued job that may run, in queue order (one
// goroutine each).
func (m *Manager) pumpLocked() {
	if m.closed {
		return
	}
	for i := 0; i < len(m.queue); {
		j := m.queue[i]
		if j.ctx.Err() != nil { // cancelled while queued
			m.queue = slices.Delete(m.queue, i, i+1)
			j.finish(StateCancelled, "")
			m.retireLocked(j)
			m.deps.Emit(j.snapshot())
			continue
		}
		if !m.eligibleLocked(j) {
			i++
			continue
		}
		m.queue = slices.Delete(m.queue, i, i+1)
		m.running++
		if j.lane != "" {
			m.lanes[j.lane]++
		}
		j.mu.Lock()
		j.started = true
		// A start-now job takes a regular slot when one is free.
		j.ranNow = j.now && m.running-m.nowRunning > MaxRunning
		j.mu.Unlock()
		if j.ranNow {
			m.nowRunning++
		}
		m.wg.Add(1)
		go m.run(j)
	}
}

func (m *Manager) run(j *job) {
	defer m.wg.Done()
	j.update(func(s *Snapshot) {
		if s.State == StateQueued {
			s.State = StateRunning
		}
	})
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
	if j.ranNow {
		m.nowRunning--
	}
	if j.lane != "" {
		if m.lanes[j.lane]--; m.lanes[j.lane] <= 0 {
			delete(m.lanes, j.lane)
		}
	}
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

func (m *Manager) active(id int64) *job {
	j := m.jobs[id]
	if j == nil || !j.snapshot().State.Active() {
		return nil
	}
	return j
}

// Cancel stops a queued, running, paused or asking job; false if it is not
// active. A cancelled copy removes its partial file.
func (m *Manager) Cancel(id int64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.active(id)
	if j == nil {
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

// Pause holds a job: a running one stops at its next pause point (between
// chunks and items; a partial file is kept), a queued one is not started.
func (m *Manager) Pause(id int64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.active(id)
	if j == nil {
		return false
	}
	j.mu.Lock()
	if !j.paused {
		j.paused = true
		j.resumed = make(chan struct{})
		if j.snap.State != StateAsking {
			j.snap.State = StatePaused
		}
		j.snap.BytesPerSec, j.snap.EtaMs = 0, 0
	}
	j.mu.Unlock()
	m.deps.Emit(j.snapshot())
	return true
}

// Resume continues a paused job (or lets a paused queued one start).
func (m *Manager) Resume(id int64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.active(id)
	if j == nil {
		return false
	}
	j.mu.Lock()
	if j.paused {
		j.paused = false
		close(j.resumed)
		if j.snap.State == StatePaused {
			j.snap.State = StateQueued
			if j.started {
				j.snap.State = StateRunning
			}
		}
	}
	j.mu.Unlock()
	j.emitMu.Lock()
	j.samples = nil // the speed restarts after a pause
	j.emitMu.Unlock()
	m.deps.Emit(j.snapshot())
	m.pumpLocked()
	return true
}

// StartNow runs a queued job right away, ahead of its lane.
func (m *Manager) StartNow(id int64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.active(id)
	if j == nil || !slices.Contains(m.queue, j) {
		return false
	}
	j.mu.Lock()
	j.now = true
	j.mu.Unlock()
	m.pumpLocked()
	return true
}

// Resolve answers the conflict a job is asking about; with all, the answer
// becomes the job's policy for the conflicts still to come.
func (m *Manager) Resolve(id int64, decision string, all bool) error {
	if !slices.Contains(Decisions, decision) {
		return ErrInvalid
	}
	m.mu.Lock()
	j := m.active(id)
	m.mu.Unlock()
	if j == nil {
		return ErrUnknownJob
	}
	j.mu.Lock()
	asking := j.snap.State == StateAsking || (j.paused && j.snap.Conflict != nil)
	j.mu.Unlock()
	if !asking {
		return ErrNotAsking
	}
	select {
	case j.answers <- answer{decision: decision, all: all}:
		return nil
	default:
		return ErrNotAsking // answered already
	}
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

// emit publishes the snapshot, at most every progressEvery unless forced,
// with the speed and ETA of the last speedWindow. Safe from any goroutine.
func (m *Manager) emit(j *job, force bool) {
	now := time.Now()
	j.emitMu.Lock()
	j.addSample(now)
	if !force && now.Sub(j.lastEmit) < progressEvery {
		j.emitMu.Unlock()
		return
	}
	j.lastEmit = now
	j.emitMu.Unlock()
	m.deps.Emit(j.snapshot())
}

// addSample records progress and updates speed and ETA (emitMu held).
func (j *job) addSample(now time.Time) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.snap.State != StateRunning {
		j.snap.BytesPerSec, j.snap.EtaMs = 0, 0
		return
	}
	if n := len(j.samples); n == 0 || now.Sub(j.samples[n-1].at) >= 100*time.Millisecond {
		j.samples = append(j.samples, sample{at: now, bytes: j.snap.BytesDone})
	}
	for len(j.samples) > 2 && now.Sub(j.samples[0].at) > speedWindow {
		j.samples = j.samples[1:]
	}
	first := j.samples[0]
	dt := now.Sub(first.at)
	if dt < 500*time.Millisecond {
		return // too short to tell
	}
	bps := float64(j.snap.BytesDone-first.bytes) / dt.Seconds()
	j.snap.BytesPerSec = int64(max(bps, 0))
	j.snap.EtaMs = 0
	if bps > 0 && j.snap.BytesTotal > j.snap.BytesDone {
		j.snap.EtaMs = int64(float64(j.snap.BytesTotal-j.snap.BytesDone) / bps * 1000)
	}
}

func (j *job) snapshot() Snapshot {
	j.mu.Lock()
	defer j.mu.Unlock()
	s := j.snap
	if s.Conflict != nil {
		c := *s.Conflict
		s.Conflict = &c
	}
	return s
}

func (j *job) finish(s State, msg string) {
	j.mu.Lock()
	j.snap.State, j.snap.Error, j.snap.Current = s, msg, ""
	j.snap.FinishedMs = time.Now().UnixMilli()
	j.snap.BytesPerSec, j.snap.EtaMs, j.snap.Conflict = 0, 0, nil
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

// gate is the job's pause point: it blocks while the job is paused and
// returns the context's error once the job is cancelled.
func (j *job) gate(ctx context.Context) error {
	for {
		j.mu.Lock()
		paused, resumed := j.paused, j.resumed
		j.mu.Unlock()
		if !paused {
			return ctx.Err()
		}
		select {
		case <-resumed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// ask publishes a conflict and waits for its answer (or the job's end).
// The answer's policy is returned; with "all" it becomes the job's policy.
func (m *Manager) ask(j *job, c Conflict) (string, error) {
	j.update(func(s *Snapshot) {
		cc := c
		s.Conflict = &cc
		if s.State == StateRunning {
			s.State = StateAsking
		}
	})
	if m.deps.Ask != nil {
		m.deps.Ask(j.snap.JobID, c)
	}
	m.emit(j, true)
	var a answer
	select {
	case a = <-j.answers:
	case <-j.ctx.Done():
		return "", j.ctx.Err()
	}
	j.mu.Lock()
	j.snap.Conflict = nil
	if j.snap.State == StateAsking {
		j.snap.State = StateRunning
		if j.paused {
			j.snap.State = StatePaused
		}
	}
	if a.all {
		j.policy = a.decision
	}
	j.mu.Unlock()
	j.emitMu.Lock()
	j.samples = nil // waiting is not slowness
	j.emitMu.Unlock()
	m.emit(j, true)
	return a.decision, nil
}

func (j *job) currentPolicy() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.policy
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
