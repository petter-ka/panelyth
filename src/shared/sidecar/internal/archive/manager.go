package archive

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// MaxOpen bounds the open archives kept while no session uses them.
const MaxOpen = 16

// orphanAfter: an archive opened without a session since is evictable.
const orphanAfter = time.Minute

// maxViews bounds the entries of one archive extracted for viewing; the
// oldest is removed when another is viewed.
const maxViews = 16

// ErrUnknown is returned for archive ids that are not open (any more).
var ErrUnknown = errors.New("archive: not open")

// Open is an archive browsed like a folder: its listing in memory, its
// sessions, and the entries extracted for viewing.
type Open struct {
	ID      int64
	EntryID int64 // the archive file's index entry
	Listing *Listing

	// guarded by Manager.mu
	handles  int // archive.open calls not closed yet
	sessions int // query sessions over it
	lastUsed time.Time

	viewMu sync.Mutex
	views  []view // oldest first
}

type view struct {
	idx  int
	path string
}

// Manager owns the open archives. Safe for concurrent use.
type Manager struct {
	tool    *Tool
	tmpRoot string
	log     *slog.Logger

	mu      sync.Mutex
	open    map[int64]*Open
	byQuery map[int64]*Open
	next    int64
	closed  bool
}

// NewManager creates a manager whose view extractions live below tmpRoot
// (<cache>/tmp/archive). Leftovers of an earlier run are removed.
func NewManager(tool *Tool, tmpRoot string, log *slog.Logger) *Manager {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	_ = os.RemoveAll(tmpRoot)
	return &Manager{tool: tool, tmpRoot: tmpRoot, log: log, open: map[int64]*Open{}, byQuery: map[int64]*Open{}}
}

// Tool is the 7-Zip the manager uses (possibly unavailable).
func (m *Manager) Tool() *Tool { return m.tool }

// OpenFile lists an archive (or reuses an open, unchanged listing of the
// same file) and holds it until Close. hold=false only caches it (a size
// check before unpacking); it is dropped first when space is needed.
func (m *Manager) OpenFile(ctx context.Context, entryID int64, path string, hold bool) (*Open, error) {
	format, ok := Detect(filepath.Base(path))
	if !ok {
		return nil, ErrNotArchive
	}
	if !format.Builtin() && !m.tool.Available() {
		return nil, ErrNoTool
	}
	m.mu.Lock()
	for _, a := range m.open {
		if a.Listing.Path == path && !a.Listing.Changed() {
			if hold {
				a.handles++
			}
			a.lastUsed = time.Now()
			m.mu.Unlock()
			return a, nil
		}
	}
	m.mu.Unlock()

	l, err := Read(ctx, path, format, m.tool)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, ErrUnknown
	}
	if m.next >= maxSlot {
		return nil, fmt.Errorf("%w: too many archives were opened", ErrTooLarge)
	}
	m.next++
	a := &Open{ID: m.next, EntryID: entryID, Listing: l, lastUsed: time.Now()}
	if hold {
		a.handles = 1
	}
	m.open[a.ID] = a
	m.evictLocked()
	return a, nil
}

// Get returns an open archive.
func (m *Manager) Get(id int64) (*Open, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a := m.open[id]
	if a == nil {
		return nil, ErrUnknown
	}
	a.lastUsed = time.Now()
	return a, nil
}

// Lookup returns the archive and entry index of an archive entry id.
func (m *Manager) Lookup(id int64) (*Open, int, error) {
	aid, i, ok := SplitID(id)
	if !ok {
		return nil, 0, ErrUnknown
	}
	a, err := m.Get(aid)
	if err != nil {
		return nil, 0, err
	}
	if i >= a.Listing.Len() {
		return nil, 0, ErrUnknown
	}
	return a, i, nil
}

// Source returns the session source of a folder of the archive (dirID 0 =
// the root, else a folder's entry id).
func (m *Manager) Source(archiveID, dirID int64) (*Source, error) {
	a, err := m.Get(archiveID)
	if err != nil {
		return nil, err
	}
	if dirID == 0 {
		return &Source{a: a, dir: -1}, nil
	}
	aid, i, ok := SplitID(dirID)
	if !ok || aid != archiveID || i >= a.Listing.Len() || a.Listing.entries[i].kind != KindDir {
		return nil, ErrUnknown
	}
	return &Source{a: a, dir: i}, nil
}

// Attach records a query session over an archive's source.
func (m *Manager) Attach(queryID int64, src *Source) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.open[src.a.ID] != src.a {
		return
	}
	src.a.sessions++
	// archive.open's handle passes to the first session: from now on the
	// sessions keep the archive open (a panel, a parked tab).
	if src.a.handles > 0 {
		src.a.handles--
	}
	m.byQuery[queryID] = src.a
}

// Dropped is called when a query session closes; an archive without
// sessions and handles is closed.
func (m *Manager) Dropped(queryID int64) {
	m.mu.Lock()
	a := m.byQuery[queryID]
	if a == nil {
		m.mu.Unlock()
		return
	}
	delete(m.byQuery, queryID)
	a.sessions--
	release := m.releaseLocked(a)
	m.mu.Unlock()
	if release {
		m.removeViews(a)
	}
}

// Close gives up one handle of archive.open; false if it was not open.
func (m *Manager) Close(id int64) bool {
	m.mu.Lock()
	a := m.open[id]
	if a == nil || a.handles == 0 {
		m.mu.Unlock()
		return a != nil
	}
	a.handles--
	release := m.releaseLocked(a)
	m.mu.Unlock()
	if release {
		m.removeViews(a)
	}
	return true
}

func (m *Manager) releaseLocked(a *Open) bool {
	if a.handles > 0 || a.sessions > 0 || m.open[a.ID] != a {
		return false
	}
	delete(m.open, a.ID)
	return true
}

// evictLocked drops the least recently used unheld archives beyond MaxOpen.
func (m *Manager) evictLocked() {
	for len(m.open) > MaxOpen {
		var oldest *Open
		for _, a := range m.open {
			// An open whose session never came (a superseded navigation) is
			// dropped after orphanAfter.
			unused := a.handles == 0 || time.Since(a.lastUsed) > orphanAfter
			if a.sessions == 0 && unused && (oldest == nil || a.lastUsed.Before(oldest.lastUsed)) {
				oldest = a
			}
		}
		if oldest == nil {
			return
		}
		delete(m.open, oldest.ID)
		go m.removeViews(oldest)
	}
}

// Shutdown closes every archive and removes the view files.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	m.closed = true
	m.open, m.byQuery = map[int64]*Open{}, map[int64]*Open{}
	m.mu.Unlock()
	_ = os.RemoveAll(m.tmpRoot)
}

// Stats is what a benchmark wants to know.
type Stats struct {
	Open    int
	Entries int
}

// Stats counts the open archives and their entries.
func (m *Manager) Stats() Stats {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := Stats{Open: len(m.open)}
	for _, a := range m.open {
		s.Entries += a.Listing.Len()
	}
	return s
}

func (m *Manager) viewDir(a *Open) string {
	return filepath.Join(m.tmpRoot, strconv.FormatInt(a.ID, 10))
}

func (m *Manager) removeViews(a *Open) {
	a.viewMu.Lock()
	a.views = nil
	a.viewMu.Unlock()
	if err := os.RemoveAll(m.viewDir(a)); err != nil {
		m.log.Warn("remove archive view files", "err", err)
	}
}

// View extracts one file to <cache>/tmp for viewing (F3, quick view, open
// with its program) and returns its path. It is removed when the archive
// closes, when more than maxViews were viewed, or at the next start.
func (m *Manager) View(ctx context.Context, id int64) (string, Entry, error) {
	a, i, err := m.Lookup(id)
	if err != nil {
		return "", Entry{}, err
	}
	e := a.Listing.Entry(i)
	if e.Kind == KindDir {
		return "", e, fmt.Errorf("%w: a folder has no contents to view", ErrNotArchive)
	}
	if e.Kind != KindFile {
		return "", e, fmt.Errorf("%w: links inside archives can't be viewed", ErrNotArchive)
	}
	if e.Size > MaxViewBytes {
		return "", e, fmt.Errorf("%w: %s is larger than 1 GiB; extract it with F5", ErrTooLarge, e.Name)
	}
	a.viewMu.Lock()
	defer a.viewMu.Unlock()
	for _, v := range a.views {
		if v.idx == i {
			if _, err := os.Stat(v.path); err == nil {
				return v.path, e, nil
			}
		}
	}
	if a.Listing.Changed() {
		return "", e, ErrChanged
	}
	dir := filepath.Join(m.viewDir(a), strconv.Itoa(i))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", e, err
	}
	var failed error
	written := ""
	o := &ExtractOptions{
		Dest:         dir,
		Base:         parentOf(e.Path),
		Include:      func(p string) bool { return p == e.Path },
		Selected:     []string{e.Path},
		MaxFileBytes: MaxViewBytes,
		Failed:       func(_ string, err error) { failed = err },
		Extracted: func(rel string, h *Header) {
			if h.Kind == KindFile {
				written = rel
			}
		},
		Conflict: func(string, *Header, os.FileInfo) (Decision, error) { return DecideReplace, nil },
	}
	if err := Extract(ctx, a.Listing.Path, a.Listing.Format, m.tool, nil, o); err != nil {
		_ = os.RemoveAll(dir)
		return "", e, err
	}
	if failed != nil || written == "" {
		_ = os.RemoveAll(dir)
		if failed == nil {
			failed = ErrChanged
		}
		return "", e, failed
	}
	p := filepath.Join(dir, filepath.FromSlash(written))
	a.views = append(a.views, view{idx: i, path: p})
	if len(a.views) > maxViews {
		_ = os.RemoveAll(filepath.Dir(a.views[0].path))
		a.views = a.views[1:]
	}
	return p, e, nil
}

// Selection is what a copy out of an archive panel extracts: entries of one
// folder of an open archive.
type Selection struct {
	Archive *Open
	// Base is the folder holding the entries ("" = the root).
	Base string
	// Paths are the entries' inner paths.
	Paths []string
	// Files and Bytes total the files below them (from the listing).
	Files int
	Bytes int64
}

// Select resolves archive entry ids (one archive, one folder) for an
// extraction.
func (m *Manager) Select(ids []int64) (*Selection, error) {
	if len(ids) == 0 {
		return nil, errors.New("archive: nothing selected")
	}
	var s *Selection
	for _, id := range ids {
		a, i, err := m.Lookup(id)
		if err != nil {
			return nil, err
		}
		e := a.Listing.Entry(i)
		if s == nil {
			s = &Selection{Archive: a, Base: parentOf(e.Path)}
		} else if a != s.Archive || parentOf(e.Path) != s.Base {
			return nil, errors.New("archive: the entries must come from one folder of one archive")
		}
		s.Paths = append(s.Paths, e.Path)
		if e.Kind == KindDir {
			s.Files += a.Listing.countFiles(i)
			s.Bytes += e.Size
		} else {
			s.Files++
			s.Bytes += e.Size
		}
	}
	return s, nil
}

// Include matches the selected entries and everything below them.
func (s *Selection) Include() func(string) bool {
	set := make(map[string]bool, len(s.Paths))
	for _, p := range s.Paths {
		set[p] = true
	}
	return func(p string) bool {
		for ; p != ""; p = parentOf(p) {
			if set[p] {
				return true
			}
		}
		return false
	}
}

// countFiles counts the files below folder i.
func (l *Listing) countFiles(i int) int {
	n := 0
	for _, c := range l.children[int32(i)] {
		if l.entries[c].kind == KindDir {
			n += l.countFiles(int(c))
		} else {
			n++
		}
	}
	return n
}

// Name of an entry for messages and properties: "photos.zip\docs\a.txt".
func (a *Open) Name(i int) string {
	return filepath.Join(filepath.Base(a.Listing.Path), filepath.FromSlash(a.Listing.entries[i].path))
}
