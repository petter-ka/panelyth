package remote

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Entry ids of connections come from their own range (ADR-0017 as amended
// in Stage C10.5), above the rows of directory compares, so a selection
// descriptor over a remote session never names a local file: an id is
// IDBase + connection<<slotBits + entry index + 1. All stay below 2^53.
const (
	IDBase   int64 = 7 << 50
	slotBits       = 20
	slotMask       = 1<<slotBits - 1
	maxSlot        = 1<<(50-slotBits) - 1
	// MaxEntries bounds what one connection lists in its lifetime (about 70
	// bytes and a name each); beyond it the connection is opened anew.
	MaxEntries = 1<<slotBits - 1
)

// IsID reports whether id names an entry of a connection.
func IsID(id int64) bool { return id >= IDBase && id < 1<<53 }

// EntryID is the id of entry i of a connection.
func EntryID(connID int64, i int) int64 {
	return IDBase + connID<<slotBits + int64(i) + 1
}

// SplitID returns the connection and the entry index an id names.
func SplitID(id int64) (connID int64, entry int, ok bool) {
	if !IsID(id) {
		return 0, 0, false
	}
	v := id - IDBase
	i := int(v&slotMask) - 1
	return v >> slotBits, i, i >= 0
}

// Limits of a connection (ADR-0037).
const (
	MaxTransfers     = 4
	DefaultTransfers = 2
	// MaxConns bounds the connections open at once.
	MaxConns = 8
)

// IdleClose is how long a connection's sockets stay open without a command.
// The connection itself stays: the next command reconnects.
var IdleClose = 5 * time.Minute

// staleAfter: a control connection idle this long is checked before a
// command that must not run twice.
var staleAfter = 30 * time.Second

// ErrUnknown is returned for connections that are not open (any more).
var ErrUnknown = errors.New("remote: no such connection")

type entry struct {
	parent int32 // the folder holding it; -1 for the root
	name   string
	kind   Kind
	// gone: no longer in its folder's listing.
	gone  bool
	size  int64
	mtime int64
}

type dirState struct {
	kids     []int32
	rejected int
}

// Dialer opens a logged-in client; tests replace it.
type Dialer func(ctx context.Context, o Options) (Client, error)

// Conn is one connection to a server: the folders it has listed, the
// client it browses with, and a bounded pool of clients for transfers.
// Safe for concurrent use.
type Conn struct {
	ID   int64
	opts Options
	dial Dialer

	// browseMu serializes the browsing client: one command at a time.
	browseMu sync.Mutex
	browse   Client
	lastCmd  time.Time

	// slots bounds the transfers running at once; spare holds their idle clients.
	slots chan struct{}

	mu       sync.Mutex
	entries  []entry
	paths    map[string]int32 // folders known by path
	dirs     map[int32]*dirState
	spare    []Client
	features Features
	sessions int
	jobs     int
	lastUsed time.Time
	closed   bool

	// viewMu serializes downloads for viewing; views are the files kept, oldest first.
	viewMu sync.Mutex
	views  []view
}

// Manager owns the connections.
type Manager struct {
	log  *slog.Logger
	dial Dialer
	// tmpRoot holds the files downloaded for viewing ("" = none are kept).
	tmpRoot string

	mu      sync.Mutex
	conns   map[int64]*Conn
	byQuery map[int64]*Source
	next    int64
	closed  bool
	stop    chan struct{}
	done    chan struct{}
}

// NewManager creates a manager. dial nil = the FTP client. Files viewed
// from servers are downloaded below tmpRoot (<cache>/tmp/remote); leftovers
// of an earlier run are removed.
func NewManager(log *slog.Logger, dial Dialer, tmpRoot string) *Manager {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	if dial == nil {
		dial = Dial
	}
	if tmpRoot != "" {
		_ = os.RemoveAll(tmpRoot)
	}
	m := &Manager{log: log, dial: dial, tmpRoot: tmpRoot, conns: map[int64]*Conn{}, byQuery: map[int64]*Source{},
		stop: make(chan struct{}), done: make(chan struct{})}
	go m.reap()
	return m
}

// reap closes the sockets of connections nobody has used for IdleClose.
func (m *Manager) reap() {
	defer close(m.done)
	tick := time.NewTicker(max(IdleClose/5, time.Second))
	defer tick.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-tick.C:
			m.mu.Lock()
			conns := make([]*Conn, 0, len(m.conns))
			for _, c := range m.conns {
				conns = append(conns, c)
			}
			m.mu.Unlock()
			for _, c := range conns {
				c.closeIdle(IdleClose)
			}
		}
	}
}

// Connect opens a connection and logs in. transfers is how many transfers
// may run at once on it (clamped to 1..MaxTransfers).
func (m *Manager) Connect(ctx context.Context, o Options, transfers int) (*Conn, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, ErrUnknown
	}
	if len(m.conns) >= MaxConns {
		m.mu.Unlock()
		return nil, errors.New("remote: too many connections are open; disconnect one first")
	}
	m.mu.Unlock()
	client, err := m.dial(ctx, o)
	if err != nil {
		return nil, err
	}
	transfers = min(max(transfers, 1), MaxTransfers)
	c := &Conn{opts: o, dial: m.dial, browse: client, lastCmd: time.Now(), features: client.Features(),
		slots: make(chan struct{}, transfers), paths: map[string]int32{"/": 0}, dirs: map[int32]*dirState{},
		entries: []entry{{parent: -1, kind: KindDir}}, lastUsed: time.Now()}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.next >= maxSlot {
		_ = client.Close()
		return nil, ErrUnknown
	}
	m.next++
	c.ID = m.next
	m.conns[c.ID] = c
	return c, nil
}

// Get returns an open connection.
func (m *Manager) Get(id int64) (*Conn, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.conns[id]
	if c == nil {
		return nil, ErrUnknown
	}
	return c, nil
}

// Lookup returns the connection of an entry id and the entry's index.
func (m *Manager) Lookup(id int64) (*Conn, int, error) {
	cid, i, ok := SplitID(id)
	if !ok {
		return nil, 0, ErrUnknown
	}
	c, err := m.Get(cid)
	if err != nil {
		return nil, 0, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if i >= len(c.entries) {
		return nil, 0, ErrUnknown
	}
	return c, i, nil
}

// Disconnect closes a connection for good; false if it was not open. Its
// sessions answer nothing from then on and its jobs fail.
func (m *Manager) Disconnect(id int64) bool {
	m.mu.Lock()
	c := m.conns[id]
	delete(m.conns, id)
	for q, src := range m.byQuery {
		if src.c == c {
			delete(m.byQuery, q)
		}
	}
	m.mu.Unlock()
	if c == nil {
		return false
	}
	c.shutdown()
	m.removeViews(c)
	return true
}

// Attach records a query session over a connection's folder.
func (m *Manager) Attach(queryID int64, src *Source) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.conns[src.c.ID] != src.c {
		return
	}
	m.byQuery[queryID] = src
	src.c.mu.Lock()
	src.c.sessions++
	src.c.mu.Unlock()
}

// Dropped is called when a query session closes.
func (m *Manager) Dropped(queryID int64) {
	m.mu.Lock()
	src := m.byQuery[queryID]
	delete(m.byQuery, queryID)
	m.mu.Unlock()
	if src != nil {
		src.c.mu.Lock()
		src.c.sessions--
		src.c.mu.Unlock()
	}
}

// Sessions returns the query sessions over a folder: they are refreshed
// when the folder is read again.
func (m *Manager) Sessions(dirID int64) []int64 {
	cid, i, ok := SplitID(dirID)
	if !ok {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []int64
	for q, src := range m.byQuery {
		if src.c.ID == cid && src.dir == int32(i) {
			out = append(out, q)
		}
	}
	return out
}

// Shutdown closes every connection.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	conns := m.conns
	m.conns, m.byQuery = map[int64]*Conn{}, map[int64]*Source{}
	m.mu.Unlock()
	close(m.stop)
	<-m.done
	for _, c := range conns {
		c.shutdown()
	}
	if m.tmpRoot != "" {
		_ = os.RemoveAll(m.tmpRoot)
	}
}

// Stats is what tests and benchmarks want to know.
type Stats struct {
	Conns   int
	Entries int
	// Sockets counts the clients that are connected right now.
	Sockets int
}

func (m *Manager) Stats() Stats {
	m.mu.Lock()
	conns := make([]*Conn, 0, len(m.conns))
	for _, c := range m.conns {
		conns = append(conns, c)
	}
	m.mu.Unlock()
	s := Stats{Conns: len(conns)}
	for _, c := range conns {
		c.mu.Lock()
		s.Entries += len(c.entries)
		s.Sockets += len(c.spare) + len(c.slots)
		c.mu.Unlock()
		c.browseMu.Lock()
		if c.browse != nil && !c.browse.Broken() {
			s.Sockets++
		}
		c.browseMu.Unlock()
	}
	return s
}

// Connection ------------------------------------------------------------------------

// Options returns what the connection was opened with, without its password.
func (c *Conn) Options() Options {
	o := c.opts
	o.Password = ""
	return o
}

// Features returns what the server supports.
func (c *Conn) Features() Features {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.features
}

// Transfers is how many transfers may run at once.
func (c *Conn) Transfers() int { return cap(c.slots) }

func (c *Conn) touch() {
	c.mu.Lock()
	c.lastUsed = time.Now()
	c.mu.Unlock()
}

// Hold marks a job as using the connection, so its sockets are not closed
// as idle between the job's files. The returned function ends the hold.
func (c *Conn) Hold() (release func()) {
	c.mu.Lock()
	c.jobs++
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		c.jobs--
		c.lastUsed = time.Now()
		c.mu.Unlock()
	}
}

func (c *Conn) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// client returns the browsing client, connecting again when the last one
// is gone. browseMu is held.
func (c *Conn) client(ctx context.Context) (Client, error) {
	if c.isClosed() {
		return nil, ErrClosed
	}
	if c.browse != nil && !c.browse.Broken() {
		return c.browse, nil
	}
	if c.browse != nil {
		_ = c.browse.Close()
		c.browse = nil
	}
	client, err := c.dial(ctx, c.opts)
	if err != nil {
		return nil, err
	}
	c.browse, c.lastCmd = client, time.Now()
	c.mu.Lock()
	c.features = client.Features()
	c.mu.Unlock()
	return client, nil
}

// Do runs a browsing command. safe says the command may run twice (a
// listing): it is repeated once on a new connection when the old one turns
// out to be gone. A command that may not run twice checks an idle
// connection first instead.
func (c *Conn) Do(ctx context.Context, safe bool, fn func(Client) error) error {
	c.touch()
	c.browseMu.Lock()
	defer c.browseMu.Unlock()
	client, err := c.client(ctx)
	if err != nil {
		return err
	}
	if !safe && time.Since(c.lastCmd) >= staleAfter {
		if err := client.Noop(ctx); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if client, err = c.client(ctx); err != nil {
				return err
			}
		}
	}
	err = fn(client)
	if err != nil && safe && client.Broken() && ctx.Err() == nil {
		// The server had hung up on an idle connection: once more, afresh.
		if client, err = c.client(ctx); err != nil {
			return err
		}
		err = fn(client)
	}
	c.lastCmd = time.Now()
	c.touch()
	return err
}

// Transfer runs fn with a client of its own, for a download or an upload.
// At most Transfers of them run at once; the others wait their turn.
func (c *Conn) Transfer(ctx context.Context, fn func(Client) error) error {
	select {
	case c.slots <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-c.slots }()
	c.touch()
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrClosed
	}
	var client Client
	for len(c.spare) > 0 && client == nil {
		client = c.spare[len(c.spare)-1]
		c.spare = c.spare[:len(c.spare)-1]
		if client.Broken() {
			_ = client.Close()
			client = nil
		}
	}
	c.mu.Unlock()
	if client == nil {
		var err error
		if client, err = c.dial(ctx, c.opts); err != nil {
			return err
		}
	}
	err := fn(client)
	c.mu.Lock()
	if client.Broken() || c.closed {
		c.mu.Unlock()
		_ = client.Close()
	} else {
		c.spare = append(c.spare, client)
		c.lastUsed = time.Now()
		c.mu.Unlock()
	}
	return err
}

// closeIdle closes the sockets of a connection nobody used for d. Sessions
// do not count: a panel that shows a folder needs no socket until the next
// command.
func (c *Conn) closeIdle(d time.Duration) {
	c.mu.Lock()
	idle := !c.closed && c.jobs == 0 && time.Since(c.lastUsed) >= d
	var spare []Client
	if idle {
		spare, c.spare = c.spare, nil
	}
	c.mu.Unlock()
	if !idle {
		return
	}
	for _, s := range spare {
		_ = s.Close()
	}
	if c.browseMu.TryLock() {
		if c.browse != nil {
			_ = c.browse.Close()
			c.browse = nil
		}
		c.browseMu.Unlock()
	}
}

func (c *Conn) shutdown() {
	c.mu.Lock()
	c.closed = true
	spare := c.spare
	c.spare = nil
	c.mu.Unlock()
	for _, s := range spare {
		_ = s.Close()
	}
	c.browseMu.Lock()
	if c.browse != nil {
		_ = c.browse.Close()
		c.browse = nil
	}
	c.browseMu.Unlock()
}

// Folders and entries ------------------------------------------------------------------

// pathOf builds an entry's path from its parents. c.mu is held.
func (c *Conn) pathOf(i int32) string {
	if i == 0 {
		return "/"
	}
	var parts []string
	for ; i > 0; i = c.entries[i].parent {
		parts = append(parts, c.entries[i].name)
	}
	n := 0
	for _, p := range parts {
		n += len(p) + 1
	}
	b := make([]byte, 0, n)
	for k := len(parts) - 1; k >= 0; k-- {
		b = append(b, '/')
		b = append(b, parts[k]...)
	}
	return string(b)
}

// folder returns the entry of a folder path, adding the folders that lead
// to it when the connection has not seen them. c.mu is held.
func (c *Conn) folder(path string) (int32, error) {
	if i, ok := c.paths[path]; ok {
		return i, nil
	}
	parent, err := c.folder(Parent(path))
	if err != nil {
		return 0, err
	}
	name := Base(path)
	// Listed already as a child of its parent?
	if d := c.dirs[parent]; d != nil {
		for _, k := range d.kids {
			if e := &c.entries[k]; e.name == name && e.kind == KindDir {
				c.paths[path] = k
				return k, nil
			}
		}
	}
	if len(c.entries) >= MaxEntries {
		return 0, ErrTooLarge
	}
	c.entries = append(c.entries, entry{parent: parent, name: name, kind: KindDir})
	i := int32(len(c.entries) - 1)
	c.paths[path] = i
	return i, nil
}

// OpenDir lists a folder from the server and returns its id. Entries keep
// their ids across listings of the same folder, so sessions and marks over
// it stay valid; entries that are gone no longer show.
func (c *Conn) OpenDir(ctx context.Context, path string) (dirID int64, rejected int, err error) {
	clean, ok := CleanDir(path)
	if !ok {
		return 0, 0, ErrUnsafeName
	}
	var listed []Entry
	err = c.Do(ctx, true, func(cl Client) error {
		var lerr error
		listed, rejected, lerr = cl.List(ctx, clean)
		return lerr
	})
	if err != nil {
		return 0, 0, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	di, err := c.folder(clean)
	if err != nil {
		return 0, 0, err
	}
	old := c.dirs[di]
	byName := map[string]int32{}
	if old != nil {
		for _, k := range old.kids {
			byName[c.entries[k].name] = k
		}
	}
	kids := make([]int32, 0, len(listed))
	seen := make(map[int32]struct{}, len(listed))
	for _, e := range listed {
		k, known := byName[e.Name]
		if !known && e.Kind == KindDir {
			// A folder first reached by its path (a typed path, a restored tab).
			k, known = c.paths[Join(clean, e.Name)]
		}
		if _, dup := seen[k]; known && dup {
			continue // a server that lists a name twice
		}
		if known {
			en := &c.entries[k]
			en.kind, en.size, en.mtime, en.gone = e.Kind, e.Size, e.MtimeNs, false
		} else {
			if len(c.entries) >= MaxEntries {
				return 0, 0, ErrTooLarge
			}
			// A copy of the name: the one parsed out of the listing would keep
			// its whole line alive (measured: 126 → 78 bytes per entry).
			c.entries = append(c.entries, entry{parent: di, name: strings.Clone(e.Name), kind: e.Kind, size: e.Size, mtime: e.MtimeNs})
			k = int32(len(c.entries) - 1)
		}
		seen[k] = struct{}{}
		kids = append(kids, k)
	}
	if old != nil {
		for _, k := range old.kids {
			if _, still := seen[k]; !still {
				c.entries[k].gone = true
			}
		}
	}
	c.dirs[di] = &dirState{kids: kids, rejected: rejected}
	return EntryID(c.ID, int(di)), rejected, nil
}

// Info is an entry as the app layer sees it.
type Info struct {
	ID   int64
	Path string
	Entry
}

// Entry returns an entry of this connection by id; false for one that its
// folder's latest listing no longer has.
func (c *Conn) Entry(id int64) (Info, bool) {
	cid, i, ok := SplitID(id)
	c.mu.Lock()
	defer c.mu.Unlock()
	if !ok || cid != c.ID || i >= len(c.entries) || c.entries[i].gone {
		return Info{}, false
	}
	e := &c.entries[i]
	return Info{ID: id, Path: c.pathOf(int32(i)),
		Entry: Entry{Name: e.name, Kind: e.kind, Size: e.size, MtimeNs: e.mtime}}, true
}

// DirPath returns the path of a folder id.
func (c *Conn) DirPath(dirID int64) (string, bool) {
	in, ok := c.Entry(dirID)
	if !ok || in.Kind != KindDir {
		return "", false
	}
	return in.Path, true
}

// Listed reports whether a folder's listing is held.
func (c *Conn) Listed(dirID int64) bool {
	cid, i, ok := SplitID(dirID)
	c.mu.Lock()
	defer c.mu.Unlock()
	return ok && cid == c.ID && c.dirs[int32(i)] != nil
}

// Viewing ---------------------------------------------------------------------------------

// MaxViewBytes bounds a file downloaded just to be looked at (F3, quick
// view, Enter); larger files are copied with F5 first.
const MaxViewBytes = 256 << 20

// maxViews bounds the files of one connection kept for viewing; the oldest
// goes when another is viewed.
const maxViews = 16

type view struct {
	entry int
	dir   string
}

// View downloads one file to the manager's temporary folder and returns
// where it is. The same file, unchanged in its folder's listing, is served
// from there again without a download. The files go when the connection
// closes and at the next start.
func (m *Manager) View(ctx context.Context, id int64) (string, Info, error) {
	c, i, err := m.Lookup(id)
	if err != nil {
		return "", Info{}, err
	}
	in, ok := c.Entry(id)
	switch {
	case !ok:
		return "", Info{}, ErrNotFound
	case m.tmpRoot == "":
		return "", in, ErrUnsupported
	case in.Kind != KindFile:
		return "", in, fmt.Errorf("%w: only files have contents to view", ErrUnsupported)
	case in.Size > MaxViewBytes:
		return "", in, fmt.Errorf("%w: %s is larger than 256 MiB; copy it with F5 first", ErrTooLarge, in.Name)
	}
	c.viewMu.Lock()
	defer c.viewMu.Unlock()
	dir := filepath.Join(m.tmpRoot, strconv.FormatInt(c.ID, 10), strconv.Itoa(i))
	// The name on this computer is ours: the server's name only lends its extension.
	file := filepath.Join(dir, "file"+safeExt(in.Name))
	if fi, err := os.Stat(file); err == nil && fi.Size() == in.Size && (in.MtimeNs == 0 || fi.ModTime().UnixNano() == in.MtimeNs) {
		return file, in, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", in, err
	}
	partial := file + ".part"
	f, err := os.Create(partial)
	if err != nil {
		return "", in, err
	}
	// A listing's size can be out of date: the limit holds for what arrives.
	lw := &limitWriter{w: f, left: MaxViewBytes}
	err = c.Transfer(ctx, func(cl Client) error { return cl.Retrieve(ctx, in.Path, 0, lw) })
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(partial)
		return "", in, err
	}
	if in.MtimeNs > 0 {
		t := time.Unix(0, in.MtimeNs)
		_ = os.Chtimes(partial, t, t)
	}
	if err := os.Rename(partial, file); err != nil {
		_ = os.Remove(partial)
		return "", in, err
	}
	c.views = append(c.views, view{entry: i, dir: dir})
	for len(c.views) > maxViews {
		if c.views[0].entry != i {
			_ = os.RemoveAll(c.views[0].dir)
		}
		c.views = c.views[1:]
	}
	return file, in, nil
}

// limitWriter stops a download that grows beyond what a view may hold.
type limitWriter struct {
	w    io.Writer
	left int64
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > l.left {
		return 0, fmt.Errorf("%w: the file is larger than 256 MiB", ErrTooLarge)
	}
	n, err := l.w.Write(p)
	l.left -= int64(n)
	return n, err
}

// safeExt is a name's extension when it is short and plain, else "".
func safeExt(name string) string {
	dot := strings.LastIndex(name, ".")
	if dot <= 0 || len(name)-dot > 11 || dot == len(name)-1 {
		return ""
	}
	for _, r := range name[dot+1:] {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return ""
		}
	}
	return strings.ToLower(name[dot:])
}

func (m *Manager) removeViews(c *Conn) {
	if m.tmpRoot != "" {
		_ = os.RemoveAll(filepath.Join(m.tmpRoot, strconv.FormatInt(c.ID, 10)))
	}
}
