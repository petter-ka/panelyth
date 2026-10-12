package jobs

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/remote"
	"panelyth/sidecar/internal/remote/ftptest"
)

// Stage C10.5: download, upload and delete on a server (ADR-0037), against
// the loopback test server.

type remoteEnv struct {
	*env
	server  string // the folder the server serves
	s       *ftptest.Server
	conn    *remote.Conn
	changed []string
}

func newRemoteEnv(t *testing.T, o ftptest.Options) *remoteEnv {
	t.Helper()
	re := &remoteEnv{env: newEnv(t), server: t.TempDir()}
	o.Root = re.server
	s, err := ftptest.Start(o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	m := remote.NewManager(nil, nil, "")
	t.Cleanup(m.Shutdown)
	conn, err := m.Connect(ctx, remote.Options{Host: s.Host, Port: s.Port, TLS: remote.TLSNone}, 2)
	if err != nil {
		t.Fatal(err)
	}
	re.s, re.conn = s, conn
	return re
}

func (re *remoteEnv) put(rel, text string) {
	re.t.Helper()
	p := filepath.Join(re.server, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		re.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
		re.t.Fatal(err)
	}
}

// items lists a folder of the server and returns the named entries.
func (re *remoteEnv) items(dir string, names ...string) []remote.Info {
	re.t.Helper()
	dirID, _, err := re.conn.OpenDir(ctx, dir)
	if err != nil {
		re.t.Fatal(err)
	}
	src, _ := re.conn.Source(dirID)
	ids, _ := src.IDs(ctx, index.Descriptor{ShowHidden: true})
	var out []remote.Info
	for _, n := range names {
		for _, id := range ids {
			if in, ok := re.conn.Entry(id); ok && in.Name == n {
				out = append(out, in)
			}
		}
	}
	if len(out) != len(names) {
		re.t.Fatalf("%s: found %d of %v", dir, len(out), names)
	}
	return out
}

// allNames lists a local folder in the all scope (the commander's).
func (re *remoteEnv) allNames(dir index.DirInfo) []string {
	re.t.Helper()
	ids, err := re.store.QueryIDs(ctx, index.Descriptor{DirID: dir.ID, Scope: index.ScopeAll, ShowHidden: true,
		Sort: []index.SortKey{{Field: index.SortName}}}, dir.Key)
	if err != nil {
		re.t.Fatal(err)
	}
	items, _ := re.store.LoadItems(ctx, ids)
	out := []string{}
	for _, it := range items {
		out = append(out, it.Name)
	}
	return out
}

func (re *remoteEnv) spec(kind Kind, r RemoteSpec) Spec {
	r.Conn = re.conn
	r.Changed = func(dir string) { re.changed = append(re.changed, dir) }
	return Spec{Kind: kind, Conflict: ConflictAsk, Remote: &r}
}

func TestDownloadFilesAndFolders(t *testing.T) {
	re := newRemoteEnv(t, ftptest.Options{})
	re.put("readme.txt", "hello")
	re.put("photos/a.jpg", "aaaa")
	re.put("photos/trip/b.jpg", "bb")
	re.put("empty/.keep", "")
	_ = os.Remove(filepath.Join(re.server, "empty", ".keep"))
	old := time.Date(2021, 3, 4, 5, 6, 7, 0, time.UTC)
	_ = os.Chtimes(filepath.Join(re.server, "readme.txt"), old, old)
	dest := re.index(re.root)

	sp := re.spec(KindDownload, RemoteSpec{Items: re.items("/", "readme.txt", "photos", "empty")})
	sp.Destination = re.root
	s := re.run(sp)
	if s.State != StateCompleted || s.Total != 3 || s.Done != 3 || s.Failed != 0 || s.BytesDone != 11 || s.BytesTotal != 11 {
		t.Fatalf("job %+v %v", s, re.errors(s.JobID))
	}
	if read(filepath.Join(re.root, "readme.txt")) != "hello" ||
		read(filepath.Join(re.root, "photos", "a.jpg")) != "aaaa" ||
		read(filepath.Join(re.root, "photos", "trip", "b.jpg")) != "bb" {
		t.Error("contents")
	}
	if fi, err := os.Stat(filepath.Join(re.root, "empty")); err != nil || !fi.IsDir() {
		t.Errorf("the empty folder: %v", err)
	}
	// The date of the server is kept, so a later "replace older" has something to go by.
	if fi, _ := os.Stat(filepath.Join(re.root, "readme.txt")); !fi.ModTime().Equal(old) {
		t.Errorf("date %v, want %v", fi.ModTime().UTC(), old)
	}
	// No partial file stays behind, and the new entries are in the index at once.
	ents, _ := os.ReadDir(re.root)
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), fileops.PartialSuffix) {
			t.Errorf("left behind: %s", e.Name())
		}
	}
	if got := re.allNames(dest); !slices.Equal(got, []string{"empty", "photos", "readme.txt"}) {
		t.Errorf("index %v", got)
	}
	if laneOf(sp, re.store) != "remote:1" {
		t.Errorf("lane %q", laneOf(sp, re.store))
	}
}

func TestDownloadConflicts(t *testing.T) {
	re := newRemoteEnv(t, ftptest.Options{})
	re.put("a.txt", "from the server")
	newer := time.Now().Add(-time.Hour).Truncate(time.Second)
	_ = os.Chtimes(filepath.Join(re.server, "a.txt"), newer, newer)
	local := filepath.Join(re.root, "a.txt")
	reset := func(age time.Duration) {
		if err := os.WriteFile(local, []byte("local"), 0o644); err != nil {
			t.Fatal(err)
		}
		at := time.Now().Add(-age)
		_ = os.Chtimes(local, at, at)
		for _, extra := range []string{"a (2).txt"} {
			_ = os.Remove(filepath.Join(re.root, extra))
		}
	}
	run := func(policy string) Snapshot {
		sp := re.spec(KindDownload, RemoteSpec{Items: re.items("/", "a.txt")})
		sp.Destination, sp.Conflict = re.root, policy
		return re.run(sp)
	}
	reset(2 * time.Hour)
	if s := run(ConflictSkip); s.Skipped != 1 || s.Done != 0 || read(local) != "local" || re.s.Count("RETR") != 0 {
		t.Errorf("skip: %+v", s)
	}
	if s := run(ConflictReplace); s.Done != 1 || read(local) != "from the server" {
		t.Errorf("replace: %+v", s)
	}
	reset(2 * time.Hour)
	if s := run(ConflictKeepBoth); s.Done != 1 || read(local) != "local" || read(filepath.Join(re.root, "a (2).txt")) != "from the server" {
		t.Errorf("keep both: %+v", s)
	}
	reset(2 * time.Hour)
	if s := run(ConflictRenameExisting); s.Done != 1 || read(local) != "from the server" || read(filepath.Join(re.root, "a (2).txt")) != "local" {
		t.Errorf("rename existing: %+v", s)
	}
	// Replace older: the server's file is an hour old.
	reset(2 * time.Hour)
	if s := run(ConflictReplaceOlder); s.Done != 1 || read(local) != "from the server" {
		t.Errorf("replace older, local older: %+v", s)
	}
	reset(time.Minute)
	if s := run(ConflictReplaceOlder); s.Skipped != 1 || read(local) != "local" {
		t.Errorf("replace older, local newer: %+v", s)
	}
	reset(time.Minute)
	if s := run(ConflictReplaceIfDifferentSize); s.Done != 1 || read(local) != "from the server" {
		t.Errorf("another size: %+v", s)
	}

	// Ask: the job waits for its answer; the other panel's jobs are not its concern.
	reset(2 * time.Hour)
	sp := re.spec(KindDownload, RemoteSpec{Items: re.items("/", "a.txt")})
	sp.Destination = re.root
	started, err := re.m.Start(sp)
	if err != nil {
		t.Fatal(err)
	}
	asking := re.waitFor(started.JobID, "asks", func(s Snapshot) bool { return s.State == StateAsking })
	if c := asking.Conflict; c == nil || c.Name != "a.txt" || c.Source.Size != 15 || c.Target.Size != 5 {
		t.Errorf("question %+v", asking.Conflict)
	}
	if err := re.m.Resolve(started.JobID, ConflictReplace, false); err != nil {
		t.Fatal(err)
	}
	if s := re.wait(started.JobID); s.Done != 1 || read(local) != "from the server" {
		t.Errorf("answered: %+v", s)
	}
}

func TestDownloadGoesOnAfterACut(t *testing.T) {
	for name, noRest := range map[string]bool{"where it stopped": false, "from the start without REST": true} {
		t.Run(name, func(t *testing.T) {
			re := newRemoteEnv(t, ftptest.Options{DropAfter: 20_000, NoREST: noRest})
			body := strings.Repeat("0123456789abcdef", 8192)
			re.put("big.bin", body)
			sp := re.spec(KindDownload, RemoteSpec{Items: re.items("/", "big.bin")})
			sp.Destination = re.root
			s := re.run(sp)
			if s.State != StateCompleted || s.Done != 1 || s.Failed != 0 {
				t.Fatalf("job %+v %v", s, re.errors(s.JobID))
			}
			if read(filepath.Join(re.root, "big.bin")) != body {
				t.Error("the file is not whole")
			}
			if s.BytesDone != int64(len(body)) {
				t.Errorf("counted %d bytes of %d", s.BytesDone, len(body))
			}
			if got := re.s.Count("REST"); (got == 1) == noRest {
				t.Errorf("REST sent %d times", got)
			}
		})
	}
}

func TestDownloadNeverWritesOutsideItsFolder(t *testing.T) {
	re := newRemoteEnv(t, ftptest.Options{ExtraList: []string{"type=OS.unix=slink:/etc/passwd;size=11; passwd"}})
	re.put("readme.txt", "hello")
	// What a broken or hostile listing could hand a job. The connection's own
	// listing never has such names; the job does not rely on that.
	crafted := []remote.Info{}
	for _, name := range []string{"../evil.txt", "sub/evil.txt", ".."} {
		crafted = append(crafted, remote.Info{Path: "/readme.txt", Entry: remote.Entry{Name: name, Size: 5}})
	}
	if runtime.GOOS == "windows" {
		// A backslash separates folders on Windows only (see below).
		for _, name := range []string{`..\evil.txt`, "con", "a:b.txt", "trailing."} {
			crafted = append(crafted, remote.Info{Path: "/readme.txt", Entry: remote.Entry{Name: name, Size: 5}})
		}
	}
	sp := re.spec(KindDownload, RemoteSpec{Items: crafted})
	sp.Destination, sp.Conflict = re.root, ConflictReplace
	s := re.run(sp)
	if s.Done != 0 || s.Failed != len(crafted) || re.s.Count("RETR") != 0 {
		t.Fatalf("job %+v, %d downloads", s, re.s.Count("RETR"))
	}
	for _, e := range re.errors(s.JobID) {
		if e.Code != fileops.CodeInvalidName && e.Code != "UNSAFE_PATH" {
			t.Errorf("%s: %s", e.Name, e.Code)
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(re.root), "evil.txt")); err == nil {
		t.Fatal("a file was written outside the destination")
	}
	// A link on the server is reported and left alone.
	sp = re.spec(KindDownload, RemoteSpec{Items: re.items("/", "passwd")})
	sp.Destination = re.root
	s = re.run(sp)
	if errs := re.errors(s.JobID); s.Failed != 1 || s.Skipped != 1 || errs[0].Code != fileops.CodeSkippedLink || re.s.Count("RETR") != 0 {
		t.Errorf("a link: %+v %v", s, errs)
	}
	// A destination that is gone ends the job with a reason.
	sp = re.spec(KindDownload, RemoteSpec{Items: re.items("/", "readme.txt")})
	sp.Destination = filepath.Join(re.root, "gone")
	if s := re.run(sp); s.State != StateFailed || s.Error == "" {
		t.Errorf("a missing destination: %+v", s)
	}
	if runtime.GOOS != "windows" {
		// Outside Windows a backslash is a character of a name like any
		// other: the file is written under that name, inside the folder
		// (Stage P04; the Linux run found the test expecting a refusal).
		name := `..\evil.txt`
		sp = re.spec(KindDownload, RemoteSpec{Items: []remote.Info{{Path: "/readme.txt", Entry: remote.Entry{Name: name, Size: 5}}}})
		sp.Destination, sp.Conflict = re.root, ConflictReplace
		if s := re.run(sp); s.Done != 1 || s.Failed != 0 {
			t.Fatalf("a name with a backslash: %+v", s)
		}
		if data, err := os.ReadFile(filepath.Join(re.root, name)); err != nil || string(data) != "hello" {
			t.Fatalf("%q in the destination: %q, %v", name, data, err)
		}
		if _, err := os.Stat(filepath.Join(filepath.Dir(re.root), "evil.txt")); err == nil {
			t.Fatal("a file was written outside the destination")
		}
	}
}

func TestCancelADownloadRemovesItsPartialFile(t *testing.T) {
	re := newRemoteEnv(t, ftptest.Options{StallOn: "RETR"})
	re.put("big.bin", strings.Repeat("x", 1<<20))
	sp := re.spec(KindDownload, RemoteSpec{Items: re.items("/", "big.bin")})
	sp.Destination = re.root
	started, err := re.m.Start(sp)
	if err != nil {
		t.Fatal(err)
	}
	<-re.s.Stalled
	begin := time.Now()
	if !re.m.Cancel(started.JobID) {
		t.Fatal("cancel")
	}
	s := re.wait(started.JobID)
	if s.State != StateCancelled || time.Since(begin) > 3*time.Second {
		t.Errorf("job %+v after %v", s, time.Since(begin))
	}
	ents, _ := os.ReadDir(re.root)
	if len(ents) != 0 {
		t.Errorf("left behind: %v", ents)
	}
	// The connection is still good for the next job.
	re.s.Release()
	sp = re.spec(KindDownload, RemoteSpec{Items: re.items("/", "big.bin")})
	sp.Destination = re.root
	if s := re.run(sp); s.Done != 1 {
		t.Errorf("after the cancel: %+v %v", s, re.errors(s.JobID))
	}
}

func TestUploadFilesAndFolders(t *testing.T) {
	re := newRemoteEnv(t, ftptest.Options{})
	re.put("incoming/.keep", "")
	write(t, filepath.Join(re.root, "notes.txt"), 300)
	write(t, filepath.Join(re.root, "album", "one.jpg"), 10)
	write(t, filepath.Join(re.root, "album", "deep", "two.jpg"), 20)
	dir := re.index(re.root)

	sp := re.spec(KindUpload, RemoteSpec{Dir: "/incoming"})
	sp.IDs = re.allIDs(dir, "album", "notes.txt")
	s := re.run(sp)
	if s.State != StateCompleted || s.Total != 2 || s.Done != 2 || s.Failed != 0 || s.BytesDone != 330 || s.BytesTotal != 330 {
		t.Fatalf("job %+v %v", s, re.errors(s.JobID))
	}
	for rel, size := range map[string]int{"incoming/notes.txt": 300, "incoming/album/one.jpg": 10, "incoming/album/deep/two.jpg": 20} {
		if fi, err := os.Stat(filepath.Join(re.server, filepath.FromSlash(rel))); err != nil || fi.Size() != int64(size) {
			t.Errorf("%s: %v", rel, err)
		}
	}
	// The folder's listing changed: the panel showing it is told.
	if !slices.Contains(re.changed, "/incoming") {
		t.Errorf("changed %v", re.changed)
	}
	// The originals are where they were.
	if _, err := os.Stat(filepath.Join(re.root, "notes.txt")); err != nil {
		t.Error(err)
	}
	// A folder that is gone on the server ends the job with a reason.
	sp = re.spec(KindUpload, RemoteSpec{Dir: "/nowhere"})
	sp.IDs = re.allIDs(dir, "notes.txt")
	if s := re.run(sp); s.State != StateFailed || !strings.Contains(s.Error, "can't be read") {
		t.Errorf("a missing folder: %+v", s)
	}
}

func TestUploadConflicts(t *testing.T) {
	re := newRemoteEnv(t, ftptest.Options{})
	write(t, filepath.Join(re.root, "a.txt"), 7)
	dir := re.index(re.root)
	onServer := filepath.Join(re.server, "a.txt")
	reset := func() {
		re.put("a.txt", "server")
		_ = os.Remove(filepath.Join(re.server, "a (2).txt"))
	}
	run := func(policy string) Snapshot {
		sp := re.spec(KindUpload, RemoteSpec{Dir: "/"})
		sp.IDs, sp.Conflict = re.allIDs(dir, "a.txt"), policy
		return re.run(sp)
	}
	reset()
	if s := run(ConflictSkip); s.Skipped != 1 || s.Done != 0 || read(onServer) != "server" || re.s.Count("STOR") != 0 {
		t.Errorf("skip: %+v", s)
	}
	if s := run(ConflictReplace); s.Done != 1 || read(onServer) != "xxxxxxx" {
		t.Errorf("replace: %+v %v", s, re.errors(s.JobID))
	}
	reset()
	if s := run(ConflictKeepBoth); s.Done != 1 || read(onServer) != "server" || read(filepath.Join(re.server, "a (2).txt")) != "xxxxxxx" {
		t.Errorf("keep both: %+v", s)
	}
	reset()
	if s := run(ConflictRenameExisting); s.Done != 1 || read(onServer) != "xxxxxxx" || read(filepath.Join(re.server, "a (2).txt")) != "server" {
		t.Errorf("rename existing: %+v %v", s, re.errors(s.JobID))
	}
	reset()
	if s := run(ConflictReplaceIfDifferentSize); s.Done != 1 || read(onServer) != "xxxxxxx" {
		t.Errorf("another size: %+v", s)
	}
	// The same size: left alone.
	if s := run(ConflictReplaceIfDifferentSize); s.Skipped != 1 {
		t.Errorf("the same size: %+v", s)
	}
}

func TestUploadGoesOnAfterACut(t *testing.T) {
	re := newRemoteEnv(t, ftptest.Options{DropStoreAfter: 20_000})
	body := bytes.Repeat([]byte("0123456789abcdef"), 8192)
	if err := os.WriteFile(filepath.Join(re.root, "big.bin"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	dir := re.index(re.root)
	sp := re.spec(KindUpload, RemoteSpec{Dir: "/"})
	sp.IDs = re.allIDs(dir, "big.bin")
	s := re.run(sp)
	if s.State != StateCompleted || s.Done != 1 || s.Failed != 0 {
		t.Fatalf("job %+v %v", s, re.errors(s.JobID))
	}
	got, _ := os.ReadFile(filepath.Join(re.server, "big.bin"))
	if !bytes.Equal(got, body) {
		t.Errorf("on the server: %d bytes, want %d", len(got), len(body))
	}
	if re.s.Count("REST") != 1 || re.s.Count("STOR") != 2 || s.BytesDone != int64(len(body)) {
		t.Errorf("REST %d, STOR %d, counted %d", re.s.Count("REST"), re.s.Count("STOR"), s.BytesDone)
	}
}

func TestMoveRemovesTheSourceOnlyWhenTheCopyIsWhole(t *testing.T) {
	re := newRemoteEnv(t, ftptest.Options{})
	re.put("out/a.txt", "aaa")
	re.put("out/sub/b.txt", "b")
	dest := re.index(re.root)

	// Server → here: the folder leaves the server.
	sp := re.spec(KindDownload, RemoteSpec{Items: re.items("/", "out"), Move: true})
	sp.Destination = re.root
	s := re.run(sp)
	if s.Done != 1 || s.Failed != 0 {
		t.Fatalf("move down: %+v %v", s, re.errors(s.JobID))
	}
	if _, err := os.Stat(filepath.Join(re.server, "out")); err == nil {
		t.Error("the folder is still on the server")
	}
	if read(filepath.Join(re.root, "out", "sub", "b.txt")) != "b" {
		t.Error("contents")
	}

	// Here → server: the originals and their index rows go.
	dest = re.index(re.root)
	sp = re.spec(KindUpload, RemoteSpec{Dir: "/", Move: true})
	sp.IDs = re.allIDs(dest, "out")
	s = re.run(sp)
	if s.Done != 1 || s.Failed != 0 {
		t.Fatalf("move up: %+v %v", s, re.errors(s.JobID))
	}
	if _, err := os.Stat(filepath.Join(re.root, "out")); err == nil {
		t.Error("the folder is still here")
	}
	if got := re.allNames(dest); len(got) != 0 {
		t.Errorf("index %v", got)
	}
	if read(filepath.Join(re.server, "out", "a.txt")) != "aaa" {
		t.Error("contents on the server")
	}

	// A skipped file keeps its source: nothing is removed that was not copied.
	re.put("keep.txt", "server")
	write(t, filepath.Join(re.root, "keep.txt"), 3)
	sp = re.spec(KindDownload, RemoteSpec{Items: re.items("/", "keep.txt"), Move: true})
	sp.Destination, sp.Conflict = re.root, ConflictSkip
	if s := re.run(sp); s.Skipped != 1 || read(filepath.Join(re.server, "keep.txt")) != "server" {
		t.Errorf("a skipped move: %+v", s)
	}
}

func TestDeleteOnTheServer(t *testing.T) {
	re := newRemoteEnv(t, ftptest.Options{})
	re.put("gone.txt", "x")
	re.put("tree/a/b/c.txt", "c")
	re.put("tree/d.txt", "d")
	re.put("stays.txt", "s")
	sp := re.spec(KindRemoteDelete, RemoteSpec{Items: re.items("/", "gone.txt", "tree")})
	s := re.run(sp)
	if s.State != StateCompleted || s.Total != 2 || s.Done != 2 || s.Failed != 0 {
		t.Fatalf("job %+v %v", s, re.errors(s.JobID))
	}
	ents, _ := os.ReadDir(re.server)
	if len(ents) != 1 || ents[0].Name() != "stays.txt" {
		t.Errorf("left on the server: %v", ents)
	}
	if !slices.Contains(re.changed, "/") {
		t.Errorf("changed %v", re.changed)
	}
	// An entry that is gone meanwhile is reported; the others still go.
	re.put("one.txt", "1")
	items := re.items("/", "one.txt", "stays.txt")
	_ = os.Remove(filepath.Join(re.server, "one.txt"))
	s = re.run(re.spec(KindRemoteDelete, RemoteSpec{Items: items}))
	if errs := re.errors(s.JobID); s.Done != 1 || s.Failed != 1 || errs[0].Code != fileops.CodeNotFound {
		t.Errorf("a missing entry: %+v %v", s, errs)
	}
	// The root of a server is never deleted.
	s = re.run(re.spec(KindRemoteDelete, RemoteSpec{Items: []remote.Info{{Path: "/", Entry: remote.Entry{Kind: remote.KindDir}}}}))
	if s.Failed != 1 || s.Done != 0 {
		t.Errorf("the root: %+v", s)
	}
}

func TestRemoteJobsAreValidated(t *testing.T) {
	re := newRemoteEnv(t, ftptest.Options{})
	re.put("a.txt", "a")
	items := re.items("/", "a.txt")
	for name, spec := range map[string]Spec{
		"a download without a connection": {Kind: KindDownload, Destination: re.root, Conflict: ConflictAsk},
		"a download without entries":      {Kind: KindDownload, Destination: re.root, Conflict: ConflictAsk, Remote: &RemoteSpec{Conn: re.conn}},
		"a download without a folder":     {Kind: KindDownload, Conflict: ConflictAsk, Remote: &RemoteSpec{Conn: re.conn, Items: items}},
		"a download with a bad policy":    {Kind: KindDownload, Destination: re.root, Conflict: "maybe", Remote: &RemoteSpec{Conn: re.conn, Items: items}},
		"an upload without files":         {Kind: KindUpload, Conflict: ConflictAsk, Remote: &RemoteSpec{Conn: re.conn, Dir: "/"}},
		"an upload without a folder":      {Kind: KindUpload, Conflict: ConflictAsk, IDs: []int64{1}, Remote: &RemoteSpec{Conn: re.conn}},
		"a delete of nothing":             {Kind: KindRemoteDelete, Remote: &RemoteSpec{Conn: re.conn}},
	} {
		if _, err := re.m.Start(spec); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
}
