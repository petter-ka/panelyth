// Package query implements query sessions (ADR-0017): ordered id lists
// materialized once, paged at constant cost, re-materialized on a throttle
// when the index changes underneath them.
package query

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/scan"
)

// ErrUnknownSession is returned for closed or evicted sessions; the renderer
// re-opens its query.
var ErrUnknownSession = errors.New("query: unknown session")

// ErrStaleVersion is returned when a caller refers to a version older than
// the previous one; selections are rebased on every invalidation, so this
// only happens after two refreshes in quick succession.
var ErrStaleVersion = errors.New("query: version is out of date")

// MaxPageSize bounds page responses (and so IPC payloads).
const MaxPageSize = 1000

// Snapshot is the state the renderer tracks per session.
type Snapshot struct {
	QueryID int64 `json:"queryId"`
	Version int64 `json:"version"`
	Total   int   `json:"total"`
}

// Page is one slice of a session.
type Page struct {
	Snapshot
	Offset int
	Items  []index.Item
}

// Owner is the app a session belongs to. Each app has its own budget inside
// the one sidecar and evicts only its own least recently used sessions
// (ADR-0026): a commander with many tabs never closes the viewer's folder.
type Owner string

const (
	OwnerViewer    Owner = "viewer"
	OwnerCommander Owner = "commander"
	// OwnerSystem is Panelyth System's (ADR-0042): its searches.
	OwnerSystem Owner = "system"
	// OwnerMain is every other caller: Electron main's own sessions (the
	// neighbours of a file opened from the OS) and callers that name no app.
	OwnerMain Owner = ""
)

// Budgets are the sessions each owner may hold (ADR-0026): the viewer's
// folder and its recent queries; the commander's 2 panels × visible tabs,
// find results, branch views and compares.
var Budgets = map[Owner]int{OwnerViewer: 8, OwnerCommander: 24, OwnerSystem: 4, OwnerMain: 8}

// ParseOwner maps the app named by main to an owner; anything else is
// OwnerMain.
func ParseOwner(app string) Owner {
	switch o := Owner(app); o {
	case OwnerViewer, OwnerCommander, OwnerSystem:
		return o
	}
	return OwnerMain
}

// Options tunes session behaviour; zero values get defaults.
type Options struct {
	// Budgets overrides the sessions an owner may hold (tests).
	Budgets map[Owner]int
	// MinRefreshDelay is the throttle between re-materializations; the
	// effective delay grows to 3x the last refresh cost for huge sessions.
	MinRefreshDelay time.Duration
	// User loads the scope's user data (library.db) for descriptors that
	// sort or filter by it (ADR-0021). Nil, or an error, materializes
	// without annotations: browsing never depends on library.db.
	User func(ctx context.Context, d index.Descriptor, dirKey string) ([]index.UserRow, error)
	// Materialized is called after a session's id list was built or
	// rebuilt (outside the manager's lock); Dropped when it is closed or
	// evicted. The metadata extractor follows sessions through them.
	Materialized func(id int64, d index.Descriptor, ids []int64)
	Dropped      func(id int64)
}

// Source supplies a session's ids instead of the index (ADR-0017 as amended
// by Stage C06): find results, archives (C07) and directory compares (C08).
// A source sorts and filters in Go by the descriptor's Sort, NameMask and
// ShowHidden; DirID and Recursive do not apply. Sessions over a source are
// never refreshed by index changes; the source asks with Manager.Refresh.
type Source interface {
	IDs(ctx context.Context, d index.Descriptor) ([]int64, error)
	// Names returns the folded names of the source's entries (quick search,
	// marking by mask).
	Names(ctx context.Context) (map[int64]index.NameRow, error)
	// Missing reports that a page could not load some of the source's ids
	// (deleted meanwhile); the next IDs leaves them out.
	Missing()
}

// ItemSource is a Source whose rows are not in the index (archives, Stage
// C07): pages are built from it instead of index.db.
type ItemSource interface {
	Items(ctx context.Context, ids []int64) ([]index.Item, error)
}

// singleFolder is a Source whose rows all come from one folder: its pages
// carry no folder path.
type singleFolder interface{ SingleFolder() bool }

type session struct {
	id      int64
	owner   Owner
	desc    index.Descriptor
	src     Source
	dirKey  string
	ids     []int64
	version int64
	// prevIDs is the previous version's list, kept so selection descriptors
	// made just before a refresh still resolve exactly (ADR-0017).
	prevIDs []int64
	// lastUsed is the manager's use counter at the last use: two sessions
	// used within one clock tick still have an order.
	lastUsed uint64
	// pending is true while a refresh is scheduled or running; dirtyAgain
	// records changes that arrived during a running refresh.
	pending, running, dirtyAgain bool
	lastCost                     time.Duration
	timer                        *time.Timer
}

// Manager owns all sessions.
type Manager struct {
	store       *index.Store
	log         *slog.Logger
	opts        Options
	invalidated func(Snapshot)

	mu       sync.Mutex
	sessions map[int64]*session
	nextID   int64
	uses     uint64
	closed   bool

	// lk holds the name lookups of sessions used for search and marking.
	lk lookups
}

// NewManager creates a manager; invalidated is called (from a timer
// goroutine) after a session was re-materialized.
func NewManager(store *index.Store, log *slog.Logger, opts Options, invalidated func(Snapshot)) *Manager {
	if opts.MinRefreshDelay <= 0 {
		opts.MinRefreshDelay = 250 * time.Millisecond
	}
	return &Manager{store: store, log: log, opts: opts, invalidated: invalidated, sessions: map[int64]*session{}}
}

// Open materializes a new session for owner.
func (m *Manager) Open(ctx context.Context, owner Owner, d index.Descriptor) (Snapshot, error) {
	dir, err := m.store.Dir(ctx, d.DirID)
	if err != nil {
		return Snapshot{}, err
	}
	return m.open(ctx, owner, d, nil, dir.Key)
}

// OpenSource materializes a new session over src instead of the index.
func (m *Manager) OpenSource(ctx context.Context, owner Owner, d index.Descriptor, src Source) (Snapshot, error) {
	return m.open(ctx, owner, d, src, "")
}

// useLocked stamps a use of a session.
func (m *Manager) useLocked() uint64 {
	m.uses++
	return m.uses
}

// budget is the number of sessions owner may hold.
func (m *Manager) budget(owner Owner) int {
	if n := m.opts.Budgets[owner]; n > 0 {
		return n
	}
	if n := Budgets[owner]; n > 0 {
		return n
	}
	return Budgets[OwnerMain]
}

// Count is the number of sessions owner holds.
func (m *Manager) Count(owner Owner) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.countLocked(owner)
}

func (m *Manager) countLocked(owner Owner) (n int) {
	for _, s := range m.sessions {
		if s.owner == owner {
			n++
		}
	}
	return n
}

func (m *Manager) open(ctx context.Context, owner Owner, d index.Descriptor, src Source, dirKey string) (Snapshot, error) {
	ids, err := m.materialize(ctx, d, src, dirKey)
	if err != nil {
		return Snapshot{}, err
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Snapshot{}, ErrUnknownSession
	}
	m.nextID++
	s := &session{id: m.nextID, owner: owner, desc: d, src: src, dirKey: dirKey, ids: ids, version: 1, lastUsed: m.useLocked()}
	m.sessions[s.id] = s
	dropped := m.evictLocked(owner)
	m.mu.Unlock()
	m.notifyDropped(dropped)
	if m.opts.Materialized != nil {
		m.opts.Materialized(s.id, d, ids)
	}
	return Snapshot{QueryID: s.id, Version: s.version, Total: len(ids)}, nil
}

// materialize builds the id list, attaching user data when d needs it.
func (m *Manager) materialize(ctx context.Context, d index.Descriptor, src Source, dirKey string) ([]int64, error) {
	if src != nil {
		return src.IDs(ctx, d)
	}
	if d.NeedsUser() && m.opts.User != nil {
		rows, err := m.opts.User(ctx, d, dirKey)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			m.log.Warn("query: user data unavailable", "err", err)
		}
		d.User = rows
	}
	return m.store.QueryIDs(ctx, d, dirKey)
}

func (m *Manager) notifyDropped(ids []int64) {
	if m.opts.Dropped == nil {
		return
	}
	for _, id := range ids {
		m.opts.Dropped(id)
	}
}

// evictLocked drops owner's least recently used sessions over its budget;
// another owner's sessions are never touched.
func (m *Manager) evictLocked(owner Owner) (dropped []int64) {
	for over := m.countLocked(owner) - m.budget(owner); over > 0; over-- {
		var oldest *session
		for _, s := range m.sessions {
			if s.owner == owner && (oldest == nil || s.lastUsed < oldest.lastUsed) {
				oldest = s
			}
		}
		m.dropLocked(oldest)
		dropped = append(dropped, oldest.id)
	}
	return dropped
}

func (m *Manager) dropLocked(s *session) {
	if s.timer != nil {
		s.timer.Stop()
	}
	delete(m.sessions, s.id)
}

// SpansFolders reports whether a session's rows come from many folders (a
// source, or a recursive listing in the all scope): their pages carry each
// row's folder.
func (m *Manager) SpansFolders(id int64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessions[id]
	if s == nil {
		return false
	}
	if sf, ok := s.src.(singleFolder); ok && sf.SingleFolder() {
		return false
	}
	return s.src != nil || (s.desc.Recursive && s.desc.Scope == index.ScopeAll)
}

// Page returns items [offset, offset+limit) of the session's current version.
func (m *Manager) Page(ctx context.Context, id int64, offset, limit int) (Page, error) {
	m.mu.Lock()
	s := m.sessions[id]
	if s == nil {
		m.mu.Unlock()
		return Page{}, ErrUnknownSession
	}
	s.lastUsed = m.useLocked()
	snap := Snapshot{QueryID: s.id, Version: s.version, Total: len(s.ids)}
	lo := min(max(offset, 0), len(s.ids))
	hi := min(lo+min(max(limit, 0), MaxPageSize), len(s.ids))
	window := slices.Clone(s.ids[lo:hi])
	src := s.src
	m.mu.Unlock()

	var items []index.Item
	var err error
	if is, ok := src.(ItemSource); ok {
		items, err = is.Items(ctx, window)
	} else {
		items, err = m.store.LoadItems(ctx, window)
	}
	if err != nil {
		return Page{}, err
	}
	if src != nil && len(items) < len(window) {
		// Index changes do not reach source sessions; a gap heals itself
		// with the next version.
		src.Missing()
		m.Refresh(id)
	}
	return Page{Snapshot: snap, Offset: lo, Items: items}, nil
}

// IDs returns the ordered id list of the session at version (the current or
// the previous one) and the current version. Lists are never mutated after
// materialization, so the slice is shared, not copied; callers must not
// modify it.
func (m *Manager) IDs(id, version int64) (ids []int64, current int64, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessions[id]
	if s == nil {
		return nil, 0, ErrUnknownSession
	}
	s.lastUsed = m.useLocked()
	switch version {
	case s.version:
		return s.ids, s.version, nil
	case s.version - 1:
		if s.prevIDs != nil {
			return s.prevIDs, s.version, nil
		}
	}
	return nil, s.version, ErrStaleVersion
}

// Current returns the session's current id list and version (shared, as
// with IDs).
func (m *Manager) Current(id int64) ([]int64, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessions[id]
	if s == nil {
		return nil, 0, ErrUnknownSession
	}
	s.lastUsed = m.useLocked()
	return s.ids, s.version, nil
}

// IndexOf returns the position of entryID in the session's current list
// (-1 when absent) and the version it belongs to. The list is immutable, so
// the scan runs outside the lock; 100k ids take well under a millisecond.
func (m *Manager) IndexOf(id, entryID int64) (int, int64, error) {
	ids, version, err := m.Current(id)
	if err != nil {
		return -1, 0, err
	}
	return slices.Index(ids, entryID), version, nil
}

// facetChunk is how many of a source session's rows are loaded at a time to
// count them (an index page's size).
const facetChunk = 1000

// Facets counts filter choices for the session's folder scope and search:
// what the filters can choose from, so the name mask (the commander's quick
// filter, which its count by type sets) is left out as the kind and
// extension filters are. A session over a source (find results, an archive,
// a server) counts its own rows, listed again without the mask when it has
// one.
func (m *Manager) Facets(ctx context.Context, id int64) (index.Facets, error) {
	m.mu.Lock()
	s := m.sessions[id]
	if s == nil {
		m.mu.Unlock()
		return index.Facets{}, ErrUnknownSession
	}
	s.lastUsed = m.useLocked()
	// A refresh replaces ids with a new slice, so this one stays as it is.
	desc, key, src, ids := s.desc, s.dirKey, s.src, s.ids
	m.mu.Unlock()
	masked := desc.NameMask != ""
	desc.NameMask = ""
	if src != nil {
		if masked {
			all, err := src.IDs(ctx, desc)
			if err != nil {
				return index.Facets{}, err
			}
			ids = all
		}
		return m.sourceFacets(ctx, src, ids)
	}
	return m.store.Facets(ctx, desc, key)
}

// sourceFacets loads a source session's rows a chunk at a time and counts
// them; its rows come from the source (an archive, a server) or the index
// (find results).
func (m *Manager) sourceFacets(ctx context.Context, src Source, ids []int64) (index.Facets, error) {
	load := m.store.LoadItems
	if items, ok := src.(ItemSource); ok {
		load = items.Items
	}
	var c index.FacetCounter
	for lo := 0; lo < len(ids); lo += facetChunk {
		if err := ctx.Err(); err != nil {
			return index.Facets{}, err
		}
		rows, err := load(ctx, ids[lo:min(lo+facetChunk, len(ids))])
		if err != nil {
			return index.Facets{}, err
		}
		for _, r := range rows {
			c.Add(r.Kind, r.Ext, 1)
		}
	}
	return c.Facets(), nil
}

// Close drops a session; false if it did not exist.
func (m *Manager) Close(id int64) bool {
	m.mu.Lock()
	s := m.sessions[id]
	if s != nil {
		m.dropLocked(s)
	}
	m.mu.Unlock()
	if s == nil {
		return false
	}
	m.notifyDropped([]int64{id})
	return true
}

// Refresh schedules a throttled re-materialization of one session (the
// metadata extractor wrote values it sorts by).
func (m *Manager) Refresh(id int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.sessions[id]; s != nil {
		m.markLocked(s)
	}
}

// RefreshNow re-materializes a session at once and returns its new snapshot
// (a source whose filter the user just changed: Stage C08). The usual
// query.invalidated event follows. While a refresh is already running, that
// one is followed by another and the current snapshot is returned.
func (m *Manager) RefreshNow(id int64) (Snapshot, error) {
	m.mu.Lock()
	s := m.sessions[id]
	if s == nil || m.closed {
		m.mu.Unlock()
		return Snapshot{}, ErrUnknownSession
	}
	if s.running {
		s.dirtyAgain = true
	} else {
		if s.timer != nil {
			s.timer.Stop()
		}
		s.pending = true
	}
	running := s.running
	m.mu.Unlock()
	if !running {
		m.refresh(id)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if s = m.sessions[id]; s == nil {
		return Snapshot{}, ErrUnknownSession
	}
	return Snapshot{QueryID: s.id, Version: s.version, Total: len(s.ids)}, nil
}

// Rows returns every row of a session's current version with its position,
// and that version (Stage C08: comparing two listings). Rows that left the
// index since the version was built are missing.
func (m *Manager) Rows(ctx context.Context, id int64) (items []index.Item, positions []int, version int64, err error) {
	m.mu.Lock()
	s := m.sessions[id]
	if s == nil {
		m.mu.Unlock()
		return nil, nil, 0, ErrUnknownSession
	}
	s.lastUsed = m.useLocked()
	ids, version, src := s.ids, s.version, s.src
	m.mu.Unlock()
	if is, ok := src.(ItemSource); ok {
		items, err = is.Items(ctx, ids)
	} else {
		items, err = m.store.LoadItems(ctx, ids)
	}
	if err != nil {
		return nil, nil, 0, err
	}
	// Items keep the order of ids; the missing ones are skipped.
	positions = make([]int, len(items))
	k := 0
	for i, entry := range ids {
		if k < len(items) && items[k].ID == entry {
			positions[k] = i
			k++
		}
	}
	return items[:k], positions[:k], version, nil
}

// Shutdown stops all refresh timers.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	for _, s := range m.sessions {
		m.dropLocked(s)
	}
}

// Changed marks sessions affected by index changes. A burst of changes
// causes at most one refresh per throttle interval per session.
func (m *Manager) Changed(changes []scan.Change) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		if affects(s, changes) {
			m.markLocked(s)
		}
	}
}

func (m *Manager) markLocked(s *session) {
	switch {
	case m.closed:
	case s.running:
		s.dirtyAgain = true
	case !s.pending:
		m.scheduleLocked(s)
	}
}

func affects(s *session, changes []scan.Change) bool {
	if s.src != nil {
		return false
	}
	for _, c := range changes {
		if c.DirID == s.desc.DirID {
			return true
		}
		if s.desc.Recursive && c.DirKey != "" && strings.HasPrefix(c.DirKey, s.dirKey) {
			return true
		}
	}
	return false
}

// firstRowsDelay applies while a session is still empty: the throttle exists
// to limit repeated re-materialization, not to delay the first results.
const firstRowsDelay = 25 * time.Millisecond

func (m *Manager) scheduleLocked(s *session) {
	s.pending = true
	delay := max(m.opts.MinRefreshDelay, 3*s.lastCost)
	if len(s.ids) == 0 {
		delay = firstRowsDelay
	}
	id := s.id
	s.timer = time.AfterFunc(delay, func() { m.refresh(id) })
}

func (m *Manager) refresh(id int64) {
	m.mu.Lock()
	s := m.sessions[id]
	if s == nil || m.closed {
		m.mu.Unlock()
		return
	}
	s.running, s.dirtyAgain = true, false
	desc, key, src := s.desc, s.dirKey, s.src
	m.mu.Unlock()

	start := time.Now()
	ids, err := m.materialize(context.Background(), desc, src, key)
	cost := time.Since(start)

	m.mu.Lock()
	s = m.sessions[id]
	if s == nil {
		m.mu.Unlock()
		return
	}
	s.running, s.pending, s.lastCost = false, false, cost
	var snap Snapshot
	changed := false
	if err != nil {
		m.log.Warn("query refresh failed", "queryId", id, "err", err)
	} else {
		// Always a new version: rows can change in place (size, mtime, and
		// therefore thumbnails) without moving, so an unchanged id list does
		// not mean unchanged pages. Refreshes are throttled, so this costs at
		// most one small page refetch per interval.
		s.prevIDs = s.ids
		s.ids = ids
		s.version++
		changed = true
		snap = Snapshot{QueryID: s.id, Version: s.version, Total: len(ids)}
	}
	if s.dirtyAgain && !m.closed {
		m.scheduleLocked(s)
	}
	m.mu.Unlock()
	if changed && m.opts.Materialized != nil {
		m.opts.Materialized(id, desc, ids)
	}
	if changed && m.invalidated != nil {
		m.invalidated(snap)
	}
}
