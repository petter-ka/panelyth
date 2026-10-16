package git

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// Op names the operations a run can do.
type Op string

const (
	OpStage        Op = "stage"
	OpUnstage      Op = "unstage"
	OpDiscard      Op = "discard"
	OpCommit       Op = "commit"
	OpPull         Op = "pull"
	OpPush         Op = "push"
	OpFetch        Op = "fetch"
	OpSwitch       Op = "switch"
	OpCreateBranch Op = "createBranch"
)

// ValidOp reports whether op is one of the operations.
func ValidOp(op Op) bool {
	switch op {
	case OpStage, OpUnstage, OpDiscard, OpCommit, OpPull, OpPush, OpFetch, OpSwitch, OpCreateBranch:
		return true
	}
	return false
}

// Request is one run: the operation and what it works on. Paths are
// relative to the working tree (from the index or a change list, never
// from a renderer).
type Request struct {
	Op       Op
	Paths    []string
	Message  string
	Amend    bool
	StageAll bool
	// Push after a commit.
	Push   bool
	Mode   PullMode
	Branch string
}

// Report is a run's progress and, at the end, its result. State is
// "running", "completed", "failed" or "cancelled".
type Report struct {
	OpID    int64  `json:"opId"`
	RepoID  int64  `json:"repoId"`
	Op      Op     `json:"op"`
	State   string `json:"state"`
	Phase   string `json:"phase"`
	Percent int    `json:"percent"`
	// Message: Git's last line on success, its error on failure.
	Message string `json:"message"`
	Reason  string `json:"reason"`
	// Discard: how many paths were restored, and how many untracked ones left.
	Restored int `json:"restored"`
	Left     int `json:"left"`
}

// Manager serves the commander's Git: one status per repository at a time,
// cached briefly, and one run per repository at a time.
type Manager struct {
	tool   *Tool
	log    *slog.Logger
	report func(Report)
	bg     context.Context
	stop   context.CancelFunc
	// statusSem bounds the repositories read at once.
	statusSem chan struct{}

	mu       sync.Mutex
	repoIDs  map[string]int64
	statuses map[string]*cached
	changes  map[int64]changeList
	runs     map[int64]*running
	busy     map[string]int64
	nextID   int64
}

type cached struct {
	done chan struct{}
	at   time.Time
	st   *Status
	err  error
	// gen is the repository's generation when the read started: a run
	// that finished meanwhile makes it stale.
	gen int64
}

type changeList struct {
	root    string
	entries []Entry
}

type running struct {
	cancel context.CancelFunc
	root   string
}

// fresh is how long a status is reused: the panels of both sides and a
// burst of listing changes share one run.
const fresh = 750 * time.Millisecond

// NewManager makes the manager; report gets each run's progress.
func NewManager(tool *Tool, log *slog.Logger, report func(Report)) *Manager {
	bg, stop := context.WithCancel(context.Background())
	return &Manager{tool: tool, log: log, report: report, bg: bg, stop: stop, statusSem: make(chan struct{}, 2),
		repoIDs: map[string]int64{}, statuses: map[string]*cached{}, changes: map[int64]changeList{},
		runs: map[int64]*running{}, busy: map[string]int64{}}
}

// Available reports whether Git was found.
func (m *Manager) Available() bool { return m.tool.Available() }

// Branches lists the repository's branches.
func (m *Manager) Branches(ctx context.Context, root string) ([]Branch, bool, error) {
	return m.tool.Branches(ctx, root)
}

// Log is the repository's last commits.
func (m *Manager) Log(ctx context.Context, root string, limit int) ([]LogEntry, error) {
	return m.tool.Log(ctx, root, limit)
}

// Close cancels the runs.
func (m *Manager) Close() { m.stop() }

func (m *Manager) id() int64 {
	m.nextID++
	return m.nextID
}

// RepoID is a repository's id for this run of the sidecar.
func (m *Manager) RepoID(root string) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.repoIDLocked(root)
}

func (m *Manager) repoIDLocked(root string) int64 {
	key := strings.ToLower(root)
	if id, ok := m.repoIDs[key]; ok {
		return id
	}
	id := m.id()
	m.repoIDs[key] = id
	return id
}

// Status is the repository's status: cached, or read once for everyone
// asking at the same time.
func (m *Manager) Status(ctx context.Context, root string, force bool) (*Status, error) {
	key := strings.ToLower(root)
	m.mu.Lock()
	c := m.statuses[key]
	if c != nil {
		select {
		case <-c.done:
			if force || c.err != nil || time.Since(c.at) > fresh {
				c = nil
			}
		default:
			// A read is under way: share it.
		}
	}
	if c == nil {
		c = &cached{done: make(chan struct{})}
		m.statuses[key] = c
		go m.read(root, c)
	}
	m.mu.Unlock()
	select {
	case <-c.done:
		return c.st, c.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (m *Manager) read(root string, c *cached) {
	defer close(c.done)
	select {
	case m.statusSem <- struct{}{}:
	case <-m.bg.Done():
		c.err = m.bg.Err()
		return
	}
	defer func() { <-m.statusSem }()
	ctx, cancel := context.WithTimeout(m.bg, 60*time.Second)
	defer cancel()
	start := time.Now()
	c.st, c.err = m.tool.ReadStatus(ctx, root)
	c.at = time.Now()
	if ms := time.Since(start).Milliseconds(); ms > 500 {
		m.log.Info("git status", "root", root, "ms", ms)
	}
}

// Forget drops a repository's cached status: the next ask reads it again.
func (m *Manager) Forget(root string) {
	m.mu.Lock()
	delete(m.statuses, strings.ToLower(root))
	m.mu.Unlock()
}

// SaveChanges keeps a change list the commit dialog shows: its rows are
// named by index in later runs.
func (m *Manager) SaveChanges(root string, entries []Entry) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	// One list per repository: the newest.
	for id, l := range m.changes {
		if strings.EqualFold(l.root, root) {
			delete(m.changes, id)
		}
	}
	id := m.id()
	m.changes[id] = changeList{root: root, entries: entries}
	return id
}

// ErrStaleChanges is a change list that is gone or of another repository.
var ErrStaleChanges = errors.New("the list of changes is out of date")

// Changes returns entries of a saved change list by index.
func (m *Manager) Changes(id int64, root string, items []int) ([]Entry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.changes[id]
	if !ok || !strings.EqualFold(l.root, root) {
		return nil, ErrStaleChanges
	}
	out := make([]Entry, 0, len(items))
	for _, i := range items {
		if i < 0 || i >= len(l.entries) {
			return nil, ErrStaleChanges
		}
		out = append(out, l.entries[i])
	}
	return out, nil
}

// ErrBusy is a run asked for while another runs in the same repository.
var ErrBusy = errors.New("another Git operation is running in this repository")

// Start begins a run and returns its id at once; its reports follow.
func (m *Manager) Start(root string, req Request) (int64, error) {
	key := strings.ToLower(root)
	m.mu.Lock()
	if _, busy := m.busy[key]; busy {
		m.mu.Unlock()
		return 0, ErrBusy
	}
	id := m.id()
	repoID := m.repoIDLocked(root)
	ctx, cancel := context.WithCancel(m.bg)
	m.runs[id] = &running{cancel: cancel, root: root}
	m.busy[key] = id
	m.mu.Unlock()

	go func() {
		defer cancel()
		base := Report{OpID: id, RepoID: repoID, Op: req.Op}
		r := m.execute(ctx, root, req, func(p Progress) {
			rep := base
			rep.State, rep.Phase, rep.Percent = "running", p.Phase, p.Percent
			m.report(rep)
		})
		r.OpID, r.RepoID, r.Op = id, repoID, req.Op
		m.mu.Lock()
		delete(m.runs, id)
		delete(m.busy, key)
		delete(m.statuses, key)
		m.mu.Unlock()
		m.log.Info("git run", "op", Describe(string(req.Op), len(req.Paths)), "state", r.State, "message", r.Message)
		m.report(r)
	}()
	m.report(Report{OpID: id, RepoID: repoID, Op: req.Op, State: "running", Percent: -1})
	return id, nil
}

// Cancel stops a run; false when it is not running.
func (m *Manager) Cancel(id int64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.runs[id]
	if ok {
		r.cancel()
	}
	return ok
}

func (m *Manager) execute(ctx context.Context, root string, req Request, progress func(Progress)) Report {
	var r Report
	var msg string
	var err error
	switch req.Op {
	case OpStage:
		err = m.tool.Stage(ctx, root, req.Paths)
	case OpUnstage, OpDiscard:
		var st *Status
		if st, err = m.tool.ReadStatus(ctx, root); err == nil {
			if req.Op == OpUnstage {
				err = m.tool.Unstage(ctx, root, req.Paths, st.Unborn)
			} else {
				var entries []Entry
				for _, p := range req.Paths {
					entries = append(entries, st.Under(p)...)
				}
				var d Discarded
				d, err = m.tool.Discard(ctx, root, dedupe(entries), st.Unborn)
				r.Restored, r.Left = d.Restored, d.Left
			}
		}
	case OpCommit:
		if req.StageAll {
			err = m.tool.StageAll(ctx, root)
		}
		if err == nil {
			msg, err = m.tool.Commit(ctx, root, req.Message, req.Amend, progress)
		}
		if err == nil && req.Push {
			var st *Status
			if st, err = m.tool.ReadStatus(ctx, root); err == nil {
				msg, err = m.tool.Push(ctx, root, st, progress)
			}
		}
	case OpPull:
		msg, err = m.tool.Pull(ctx, root, req.Mode, progress)
	case OpPush:
		var st *Status
		if st, err = m.tool.ReadStatus(ctx, root); err == nil {
			msg, err = m.tool.Push(ctx, root, st, progress)
		}
	case OpFetch:
		msg, err = m.tool.Fetch(ctx, root, progress)
	case OpSwitch:
		msg, err = m.switchBranch(ctx, root, req.Branch)
	case OpCreateBranch:
		msg, err = m.tool.CreateBranch(ctx, root, req.Branch)
	}
	r.Message = msg
	switch {
	case err == nil:
		r.State = "completed"
	case errors.Is(err, context.Canceled):
		r.State = "cancelled"
	default:
		r.State = "failed"
		r.Message = err.Error()
		var ge *Error
		if errors.As(err, &ge) {
			r.Reason = ge.Reason
		}
		if errors.Is(err, ErrBadName) {
			r.Message = "That is not a valid branch name."
			r.Reason = "badName"
		}
	}
	return r
}

func (m *Manager) switchBranch(ctx context.Context, root, name string) (string, error) {
	branches, _, err := m.tool.Branches(ctx, root)
	if err != nil {
		return "", err
	}
	locals := map[string]bool{}
	var target *Branch
	for i, b := range branches {
		if !b.Remote {
			locals[b.Name] = true
		}
		if b.Name == name && target == nil {
			target = &branches[i]
		}
	}
	if target == nil {
		return "", &Error{Message: "That branch no longer exists.", Reason: "badName"}
	}
	return m.tool.Switch(ctx, root, *target, locals)
}

func dedupe(entries []Entry) []Entry {
	seen := map[string]bool{}
	out := entries[:0]
	for _, e := range entries {
		if !seen[e.Path] {
			seen[e.Path] = true
			out = append(out, e)
		}
	}
	return out
}
