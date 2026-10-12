package remote

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/remote/ftptest"
)

func connect(t testing.TB, m *Manager, s *ftptest.Server, transfers int) *Conn {
	t.Helper()
	c, err := m.Connect(bg, plain(s), transfers)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	return c
}

func manager(t testing.TB) *Manager {
	t.Helper()
	m := NewManager(nil, nil, "")
	t.Cleanup(m.Shutdown)
	return m
}

// listed returns the names of a folder's session in a sort, with "/" after folders.
func listed(t testing.TB, c *Conn, dirID int64, d index.Descriptor) []string {
	t.Helper()
	src, err := c.Source(dirID)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := src.IDs(bg, d)
	if err != nil {
		t.Fatal(err)
	}
	items, _ := src.Items(bg, ids)
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.Name
		if it.Kind == media.KindDir {
			out[i] += "/"
		}
	}
	return out
}

func TestIDsHaveTheirOwnRange(t *testing.T) {
	for _, c := range []struct {
		conn  int64
		entry int
	}{{1, 0}, {1, MaxEntries - 1}, {maxSlot, 0}, {maxSlot, MaxEntries - 1}} {
		id := EntryID(c.conn, c.entry)
		conn, entry, ok := SplitID(id)
		if !ok || conn != c.conn || entry != c.entry || !IsID(id) || id >= 1<<53 {
			t.Errorf("%+v: id %d → %d %d %v", c, id, conn, entry, ok)
		}
	}
	for _, id := range []int64{0, 1, 1 << 50, 3 << 51, IDBase - 1, 1 << 53} {
		if IsID(id) {
			t.Errorf("%d is not a remote id", id)
		}
	}
	if _, _, ok := SplitID(IDBase); ok {
		t.Error("the base itself names no entry")
	}
}

func TestFolderAsASessionSource(t *testing.T) {
	root := t.TempDir()
	for name, size := range map[string]int{"b10.txt": 5, "b2.txt": 300, "a.JPG": 20, ".profile": 1, "notes.md": 7} {
		if err := os.WriteFile(filepath.Join(root, name), make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	_ = os.Chtimes(filepath.Join(root, "notes.md"), old, old)
	for _, dir := range []string{"zeta", "Alpha", ".git"} {
		if err := os.Mkdir(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	s := serve(t, ftptest.Options{Root: root})
	c := connect(t, manager(t), s, 0)
	dirID, rejected, err := c.OpenDir(bg, "/")
	if err != nil || rejected != 0 {
		t.Fatal(err, rejected)
	}
	lists := s.Count("MLSD")
	byName := index.Descriptor{Sort: []index.SortKey{{Field: index.SortName}}}
	// Folders first, natural order, dot names hidden.
	if got, want := listed(t, c, dirID, byName), []string{"Alpha/", "zeta/", "a.JPG", "b2.txt", "b10.txt", "notes.md"}; !slices.Equal(got, want) {
		t.Errorf("by name: %v, want %v", got, want)
	}
	hiddenToo := byName
	hiddenToo.ShowHidden = true
	if got := listed(t, c, dirID, hiddenToo); len(got) != 8 || got[0] != ".git/" || !slices.Contains(got, ".profile") {
		t.Errorf("with hidden: %v", got)
	}
	bySize := index.Descriptor{Sort: []index.SortKey{{Field: index.SortSize, Desc: true}}}
	if got, want := listed(t, c, dirID, bySize), []string{"Alpha/", "zeta/", "b2.txt", "a.JPG", "notes.md", "b10.txt"}; !slices.Equal(got, want) {
		t.Errorf("by size: %v, want %v", got, want)
	}
	byDate := index.Descriptor{Sort: []index.SortKey{{Field: index.SortModified}}}
	if got := listed(t, c, dirID, byDate); got[2] != "notes.md" {
		t.Errorf("by date: %v", got)
	}
	// A mask filters the files; folders stay.
	masked := byName
	masked.NameMask = "*.txt"
	if got, want := listed(t, c, dirID, masked), []string{"Alpha/", "zeta/", "b2.txt", "b10.txt"}; !slices.Equal(got, want) {
		t.Errorf("masked: %v, want %v", got, want)
	}
	// Sorting and filtering asked the server nothing.
	if s.Count("MLSD") != lists {
		t.Errorf("a session cost %d listings", s.Count("MLSD")-lists)
	}
	// Rows: kinds by name, quick-search names folded.
	src, _ := c.Source(dirID)
	ids, _ := src.IDs(bg, byName)
	items, _ := src.Items(bg, ids)
	if items[2].Kind != media.KindImage || items[2].Ext != "jpg" || items[2].Size != 20 || items[0].Kind != media.KindDir || items[0].DirSize != -1 {
		t.Errorf("rows %+v %+v", items[0], items[2])
	}
	names, _ := src.Names(bg)
	if row := names[ids[2]]; row.Name != index.FoldName("a.JPG") || row.IsDir || len(names) != 8 {
		t.Errorf("names: %+v (%d)", row, len(names))
	}
	if !src.SingleFolder() {
		t.Error("rows of one folder need no folder path")
	}
	if _, err := c.Source(EntryID(c.ID, 999)); !errors.Is(err, ErrUnknown) {
		t.Errorf("a folder that was not listed: %v", err)
	}
}

func TestEntriesKeepTheirIdsWhenAFolderIsReadAgain(t *testing.T) {
	root := tree(t)
	s := serve(t, ftptest.Options{Root: root})
	c := connect(t, manager(t), s, 0)
	dirID, _, err := c.OpenDir(bg, "/pub")
	if err != nil {
		t.Fatal(err)
	}
	src, _ := c.Source(dirID)
	all := index.Descriptor{Sort: []index.SortKey{{Field: index.SortName}}}
	before, _ := src.IDs(bg, all)
	if len(before) != 2 {
		t.Fatalf("ids %v", before)
	}
	if in, ok := c.Entry(before[0]); !ok || in.Path != "/pub/a.bin" || in.Size != 65536 {
		t.Errorf("entry %+v %v", in, ok)
	}
	// On the server: old.txt goes, new.txt comes, a.bin grows.
	_ = os.Remove(filepath.Join(root, "pub", "old.txt"))
	_ = os.WriteFile(filepath.Join(root, "pub", "new.txt"), []byte("n"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "pub", "a.bin"), []byte("grown, in fact shrunk"), 0o644)
	again, _, err := c.OpenDir(bg, "/pub")
	if err != nil || again != dirID {
		t.Fatalf("read again: %d (was %d) %v", again, dirID, err)
	}
	after, _ := src.IDs(bg, all)
	if len(after) != 2 || after[0] != before[0] || after[1] == before[1] {
		t.Errorf("ids before %v, after %v", before, after)
	}
	if in, _ := c.Entry(after[0]); in.Size != 21 {
		t.Errorf("a.bin after: %+v", in)
	}
	// The entry that is gone answers no more: a job over an old mark finds no file.
	if _, ok := c.Entry(before[1]); ok {
		t.Error("an entry that is gone was found")
	}
}

func TestAFolderReachedByItsPath(t *testing.T) {
	s := serve(t, ftptest.Options{})
	c := connect(t, manager(t), s, 0)
	// A typed path, deeper than anything listed so far.
	pub, _, err := c.OpenDir(bg, "/pub/")
	if err != nil {
		t.Fatal(err)
	}
	if p, ok := c.DirPath(pub); !ok || p != "/pub" {
		t.Errorf("path %q %v", p, ok)
	}
	// Its parent, listed later, has it under the same id.
	rootID, _, err := c.OpenDir(bg, "/")
	if err != nil {
		t.Fatal(err)
	}
	src, _ := c.Source(rootID)
	ids, _ := src.IDs(bg, index.Descriptor{})
	if !slices.Contains(ids, pub) {
		t.Errorf("the root lists %v, without %d", ids, pub)
	}
	if !c.Listed(pub) || c.Listed(EntryID(c.ID, 500)) {
		t.Error("Listed")
	}
	for _, bad := range []string{"pub", "/pub/../etc", "/a\nb", ""} {
		if _, _, err := c.OpenDir(bg, bad); !errors.Is(err, ErrUnsafeName) {
			t.Errorf("%q: %v", bad, err)
		}
	}
	if _, _, err := c.OpenDir(bg, "/nowhere"); err == nil {
		t.Error("a folder that is not there was opened")
	}
	// A file is not a folder.
	if _, ok := c.DirPath(ids[len(ids)-1]); ok {
		t.Error("a file has a folder path")
	}
}

func TestTransfersAreBounded(t *testing.T) {
	s := serve(t, ftptest.Options{})
	c := connect(t, manager(t), s, 2)
	if c.Transfers() != 2 {
		t.Fatalf("transfers %d", c.Transfers())
	}
	var running, most atomic.Int32
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			err := c.Transfer(bg, func(cl Client) error {
				n := running.Add(1)
				for {
					if m := most.Load(); n <= m || most.CompareAndSwap(m, n) {
						break
					}
				}
				time.Sleep(20 * time.Millisecond)
				running.Add(-1)
				return cl.Noop(bg)
			})
			if err != nil {
				t.Errorf("transfer: %v", err)
			}
		})
	}
	wg.Wait()
	if most.Load() != 2 {
		t.Errorf("%d transfers ran at once, want 2", most.Load())
	}
	// One socket for browsing and two for transfers, however many transfers ran.
	if got := s.Sessions.Load(); got != 3 {
		t.Errorf("%d connections were opened, want 3", got)
	}
	// A transfer that waits its turn gives up with its context.
	hold := make(chan struct{})
	for range 2 {
		go func() { _ = c.Transfer(bg, func(Client) error { <-hold; return nil }) }()
	}
	time.Sleep(50 * time.Millisecond)
	ctx, cancel := context.WithTimeout(bg, 50*time.Millisecond)
	defer cancel()
	if err := c.Transfer(ctx, func(Client) error { return nil }); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("a waiting transfer: %v", err)
	}
	close(hold)
	if n := connect(t, manager(t), s, 99).Transfers(); n != MaxTransfers {
		t.Errorf("clamped to %d", n)
	}
}

func TestIdleSocketsCloseAndTheNextCommandReconnects(t *testing.T) {
	s := serve(t, ftptest.Options{})
	m := manager(t)
	c := connect(t, m, s, 1)
	if _, _, err := c.OpenDir(bg, "/"); err != nil {
		t.Fatal(err)
	}
	_ = c.Transfer(bg, func(cl Client) error { return cl.Noop(bg) })
	if st := m.Stats(); st.Sockets != 2 || st.Conns != 1 {
		t.Fatalf("stats %+v", st)
	}
	// A job holds the sockets open between its files.
	release := c.Hold()
	c.closeIdle(0)
	if st := m.Stats(); st.Sockets != 2 {
		t.Errorf("held: %+v", st)
	}
	release()
	c.closeIdle(0)
	if st := m.Stats(); st.Sockets != 0 || st.Conns != 1 {
		t.Errorf("idle: %+v", st)
	}
	// The connection is still there: its listing answers, and a command reconnects.
	before := s.Sessions.Load()
	dirID, _, err := c.OpenDir(bg, "/pub")
	if err != nil || s.Sessions.Load() != before+1 {
		t.Fatalf("after idle: %v, %d new connections", err, s.Sessions.Load()-before)
	}
	if got := listed(t, c, dirID, index.Descriptor{}); len(got) != 2 {
		t.Errorf("listed %v", got)
	}
}

func TestAServerThatHungUp(t *testing.T) {
	root := tree(t)
	s := serve(t, ftptest.Options{Root: root})
	c := connect(t, manager(t), s, 1)
	// A listing may run twice: it is repeated on a new connection.
	s.DropConnections()
	if _, _, err := c.OpenDir(bg, "/"); err != nil {
		t.Fatalf("a listing after the server hung up: %v", err)
	}
	// A command that may not run twice checks an idle connection first.
	prev := staleAfter
	staleAfter = 0
	defer func() { staleAfter = prev }()
	s.DropConnections()
	if err := c.Do(bg, false, func(cl Client) error { return cl.Mkdir(bg, "/made once") }); err != nil {
		t.Fatalf("mkdir after the server hung up: %v", err)
	}
	if s.Count("MKD") != 1 {
		t.Errorf("MKD was sent %d times", s.Count("MKD"))
	}
	if _, err := os.Stat(filepath.Join(root, "made once")); err != nil {
		t.Error(err)
	}
}

func TestDisconnect(t *testing.T) {
	s := serve(t, ftptest.Options{})
	m := manager(t)
	c := connect(t, m, s, 1)
	dirID, _, _ := c.OpenDir(bg, "/")
	src, _ := c.Source(dirID)
	m.Attach(7, src)
	if o := c.Options(); o.Host != s.Host || o.Password != "" {
		t.Errorf("options %+v", o)
	}
	if got, i, err := m.Lookup(dirID); err != nil || got != c || i != 0 {
		t.Errorf("lookup: %v %d %v", got, i, err)
	}
	if !m.Disconnect(c.ID) || m.Disconnect(c.ID) {
		t.Error("disconnect")
	}
	if _, err := m.Get(c.ID); !errors.Is(err, ErrUnknown) {
		t.Errorf("get: %v", err)
	}
	if _, _, err := m.Lookup(dirID); !errors.Is(err, ErrUnknown) {
		t.Errorf("lookup: %v", err)
	}
	if _, _, err := c.OpenDir(bg, "/"); !errors.Is(err, ErrClosed) {
		t.Errorf("a command on a closed connection: %v", err)
	}
	if err := c.Transfer(bg, func(Client) error { return nil }); !errors.Is(err, ErrClosed) {
		t.Errorf("a transfer on a closed connection: %v", err)
	}
	m.Dropped(7) // the session that was attached closes later; nothing happens
	if st := m.Stats(); st.Conns != 0 {
		t.Errorf("stats %+v", st)
	}
}

func TestConnectionsAreBounded(t *testing.T) {
	s := serve(t, ftptest.Options{})
	m := manager(t)
	for range MaxConns {
		connect(t, m, s, 1)
	}
	if _, err := m.Connect(bg, plain(s), 1); err == nil {
		t.Error("one connection too many")
	}
	// A failed login leaves nothing behind.
	bad := plain(s)
	bad.Port = 1
	m2 := manager(t)
	if _, err := m2.Connect(bg, bad, 1); err == nil {
		t.Error("connected to nothing")
	}
	if st := m2.Stats(); st.Conns != 0 {
		t.Errorf("stats %+v", st)
	}
	m2.Shutdown()
	if _, err := m2.Connect(bg, plain(s), 1); !errors.Is(err, ErrUnknown) {
		t.Errorf("connect after shutdown: %v", err)
	}
}

// The budget of docs/commander/PERFORMANCE.md ("Memory per remote entry"):
// what a connection keeps for each entry it has listed. Sessions over the
// folder hold ids only.
func TestMemoryPerListedEntry(t *testing.T) {
	const n = 100_000
	lines := make([]string, n)
	for i := range lines {
		lines[i] = fmt.Sprintf("type=file;size=%d;modify=20260102030405; IMG_%06d.jpg", i, i)
	}
	s := serve(t, ftptest.Options{ExtraList: lines})
	c := connect(t, manager(t), s, 1)
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	dirID, _, err := c.OpenDir(bg, "/empty")
	if err != nil {
		t.Fatal(err)
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	if got := len(listed(t, c, dirID, index.Descriptor{Scope: index.ScopeAll})); got != n {
		t.Fatalf("listed %d entries, want %d", got, n)
	}
	per := float64(after.HeapAlloc-before.HeapAlloc) / n
	t.Logf("%.1f bytes per listed entry (%d entries, names of 14 bytes)", per, n)
	if per > 120 {
		t.Errorf("%.1f bytes per entry, budget 120", per)
	}
	runtime.KeepAlive(c)
}
