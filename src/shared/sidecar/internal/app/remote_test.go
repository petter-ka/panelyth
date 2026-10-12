package app

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"panelyth/sidecar/internal/archive"
	"panelyth/sidecar/internal/compare"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/library"
	"panelyth/sidecar/internal/remote"
	"panelyth/sidecar/internal/remote/ftptest"
	"panelyth/sidecar/internal/rpc"
)

// Stage C10.5 (ADR-0037): connections over the RPC layer, against the
// loopback test server.

func remoteReason(err error) string {
	var e *rpc.Error
	if errors.As(err, &e) {
		if d, ok := e.Details.(map[string]any); ok {
			r, _ := d["reason"].(string)
			return r
		}
	}
	return ""
}

func ftpServer(t *testing.T, o ftptest.Options) (*ftptest.Server, string) {
	t.Helper()
	if o.Root == "" {
		o.Root = t.TempDir()
	}
	s, err := ftptest.Start(o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s, o.Root
}

func quick(s *ftptest.Server) *remoteQuick {
	return &remoteQuick{Host: s.Host, Port: s.Port, TLS: "none", Transfers: 2}
}

// remoteNames pages a folder of a connection and returns its rows by name.
func remoteNames(t *testing.T, svc *indexService, remoteID, dirID int64) (queryPageResult, map[string]contentItem) {
	t.Helper()
	ctx := context.Background()
	snap, err := svc.queryOpen(ctx, queryOpenParams{DirID: 1, Scope: "all", RemoteID: remoteID, RemoteDirID: dirID,
		Sort: []sortKeyWire{{Field: "name", Direction: "asc"}}})
	if err != nil {
		t.Fatal(err)
	}
	page, err := svc.queryPage(ctx, queryPageParams{QueryID: snap.QueryID, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]contentItem{}
	for _, it := range page.Items {
		out[it.Name] = it
	}
	return page, out
}

func TestRemoteFolderBrowsedOverRPC(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	s, root := ftpServer(t, ftptest.Options{})
	putAt(t, filepath.Join(root, "readme.txt"), "hello", 0)
	putAt(t, filepath.Join(root, "pub", "photo.jpg"), "jpegdata", 0)
	putAt(t, filepath.Join(root, "pub", "deep", "x.txt"), "x", 0)

	// Nothing is connected until asked.
	if st := svc.remotes.Stats(); st.Conns != 0 || s.Sessions.Load() != 0 {
		t.Fatalf("connected at start: %+v", st)
	}
	conn, err := svc.remoteConnect(ctx, remoteConnectParams{Quick: quick(s)})
	if err != nil {
		t.Fatal(err)
	}
	if conn.RemoteID == 0 || conn.Encrypted || !conn.Features.MLSD || conn.StartPath != "/" || conn.Host != s.Host {
		t.Fatalf("connected %+v", conn)
	}
	opened, err := svc.remoteOpen(ctx, remoteOpenParams{RemoteID: conn.RemoteID, Path: "/"})
	if err != nil || opened.Path != "/" || opened.Name != "/" || len(opened.Crumbs) != 1 {
		t.Fatalf("open /: %+v %v", opened, err)
	}
	page, rows := remoteNames(t, svc, conn.RemoteID, opened.RemoteDirID)
	if page.Total != 2 || rows["pub"].Kind != "dir" || rows["readme.txt"].SizeBytes != 5 {
		t.Fatalf("rows %+v", rows)
	}
	// Ids of a connection are no other kind of id.
	for _, it := range rows {
		if !remote.IsID(it.ID) || archive.IsID(it.ID) || compare.IsID(it.ID) {
			t.Errorf("id %d of %s", it.ID, it.Name)
		}
	}
	// Into a folder by its entry id: crumbs lead back to the root.
	pub, err := svc.remoteOpen(ctx, remoteOpenParams{RemoteID: conn.RemoteID, DirID: rows["pub"].ID})
	if err != nil || pub.Path != "/pub" || pub.Name != "pub" || len(pub.Crumbs) != 2 || pub.Crumbs[1].Path != "/pub" {
		t.Fatalf("open pub: %+v %v", pub, err)
	}
	_, inPub := remoteNames(t, svc, conn.RemoteID, pub.RemoteDirID)
	if inPub["photo.jpg"].Kind != "image" || inPub["deep"].Kind != "dir" {
		t.Errorf("rows of pub %+v", inPub)
	}

	// The status line's count and size, and properties, from the listing.
	sel := selectionWire{QueryID: page.QueryID, Version: page.Version, Ranges: [][2]int{{0, 2}}}
	if _, err := svc.resolveSelection(sel); err != nil {
		t.Fatal(err)
	}
	if sum, err := svc.remoteSummary([]int64{rows["pub"].ID, rows["readme.txt"].ID}); err != nil || sum.Count != 2 || sum.Dirs != 1 || sum.Bytes != 5 {
		t.Errorf("summary %+v %v", sum, err)
	}
	props, err := svc.propsGet(ctx, entryParams{EntryID: inPub["photo.jpg"].ID})
	if err != nil || props.SizeBytes != 8 || !strings.HasPrefix(props.Path, "ftp://127.0.0.1:") || !strings.HasSuffix(props.Path, "/pub/photo.jpg") {
		t.Errorf("props %+v %v", props, err)
	}
	// Nothing on a server has a path here: it is not started, revealed or handed to a command.
	if _, err := svc.entryPath(ctx, entryParams{EntryID: rows["readme.txt"].ID}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Errorf("entry.path: %v", err)
	}

	// New folder and rename: the session over the folder shows them at once.
	if _, err := svc.remoteMkdir(ctx, remoteMkdirParams{RemoteDirID: opened.RemoteDirID, Name: "new folder"}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.remoteRename(ctx, remoteRenameParams{EntryID: rows["readme.txt"].ID, Name: "read me.txt"}); err != nil {
		t.Fatal(err)
	}
	again, err := svc.queryPage(ctx, queryPageParams{QueryID: page.QueryID, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, it := range again.Items {
		names = append(names, it.Name)
	}
	if !slices.Equal(names, []string{"new folder", "pub", "read me.txt"}) || again.Version <= page.Version {
		t.Errorf("after mkdir and rename: %v (version %d → %d)", names, page.Version, again.Version)
	}
	for name, bad := range map[string]string{"a separator": "a/b", "a line end": "a\nb", "dots": "..", "nothing": "  "} {
		if _, err := svc.remoteMkdir(ctx, remoteMkdirParams{RemoteDirID: opened.RemoteDirID, Name: bad}); rpcCode(err) != rpc.CodeInvalidArgument {
			t.Errorf("mkdir with %s: %v", name, err)
		}
	}
	if s.Count("MKD") != 1 {
		t.Errorf("MKD sent %d times", s.Count("MKD"))
	}

	// Errors a panel shows: a folder that is not there, a closed connection.
	if _, err := svc.remoteOpen(ctx, remoteOpenParams{RemoteID: conn.RemoteID, Path: "/nowhere"}); remoteReason(err) == "" {
		t.Errorf("a missing folder: %v", err)
	}
	if _, err := svc.remoteOpen(ctx, remoteOpenParams{RemoteID: conn.RemoteID, Path: "../etc"}); remoteReason(err) != "name" {
		t.Errorf("a bad path: %v", err)
	}
	if !svc.remotes.Disconnect(conn.RemoteID) {
		t.Fatal("disconnect")
	}
	if _, err := svc.remoteOpen(ctx, remoteOpenParams{RemoteID: conn.RemoteID, Path: "/"}); remoteReason(err) != "closed" {
		t.Errorf("after disconnect: %v", err)
	}
}

func TestRemoteJobsOverRPC(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	s, root := ftpServer(t, ftptest.Options{})
	putAt(t, filepath.Join(root, "a.txt"), "from the server", 0)
	putAt(t, filepath.Join(root, "dir", "b.txt"), "b", 0)
	local := t.TempDir()
	putAt(t, filepath.Join(local, "up.txt"), "from here", 0)
	localID, localItems := openListed(t, svc, local)
	localSnap, _ := svc.queryOpen(ctx, queryOpenParams{DirID: localID, Scope: "all"})

	conn, err := svc.remoteConnect(ctx, remoteConnectParams{Quick: quick(s)})
	if err != nil {
		t.Fatal(err)
	}
	opened, _ := svc.remoteOpen(ctx, remoteOpenParams{RemoteID: conn.RemoteID, Path: "/"})
	page, rows := remoteNames(t, svc, conn.RemoteID, opened.RemoteDirID)
	all := jobSourceWire{Selection: selectionWire{QueryID: page.QueryID, Version: page.Version, Ranges: [][2]int{{0, page.Total}}}}

	// Download everything into the local folder.
	job, err := svc.jobsStart(ctx, jobStartParams{Kind: "download", Source: all, DestinationDirID: localID, Conflict: "ask"})
	if err != nil {
		t.Fatal(err)
	}
	if st := waitJob(t, svc, job.JobID); st.State != jobs.StateCompleted || st.Done != 2 || st.Failed != 0 {
		t.Fatalf("download: %+v", st)
	}
	if b, _ := os.ReadFile(filepath.Join(local, "dir", "b.txt")); string(b) != "b" {
		t.Error("the folder was not downloaded")
	}

	// Upload a local file into /dir: the session over that folder shows it.
	dir, _ := svc.remoteOpen(ctx, remoteOpenParams{RemoteID: conn.RemoteID, DirID: rows["dir"].ID})
	dirPage, _ := remoteNames(t, svc, conn.RemoteID, dir.RemoteDirID)
	one := jobSourceWire{Selection: selectionWire{QueryID: localSnap.QueryID, Version: localSnap.Version, Include: []int64{localItems["up.txt"].ID}}}
	job, err = svc.jobsStart(ctx, jobStartParams{Kind: "upload", Source: one, RemoteDirID: dir.RemoteDirID, Conflict: "ask"})
	if err != nil {
		t.Fatal(err)
	}
	if st := waitJob(t, svc, job.JobID); st.Done != 1 || st.Failed != 0 {
		t.Fatalf("upload: %+v", st)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "dir", "up.txt")); string(b) != "from here" {
		t.Error("the file is not on the server")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		after, _ := svc.queryPage(ctx, queryPageParams{QueryID: dirPage.QueryID, Limit: 10})
		if after.Total == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the folder's session still lists %d entries", after.Total)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Delete on the server.
	del := jobSourceWire{Selection: selectionWire{QueryID: page.QueryID, Version: page.Version, Include: []int64{rows["a.txt"].ID}}}
	job, err = svc.jobsStart(ctx, jobStartParams{Kind: "remoteDelete", Source: del})
	if err != nil {
		t.Fatal(err)
	}
	if st := waitJob(t, svc, job.JobID); st.Done != 1 {
		t.Fatalf("delete: %+v", st)
	}
	if _, err := os.Stat(filepath.Join(root, "a.txt")); err == nil {
		t.Error("the file is still on the server")
	}

	// What does not belong together is refused before anything starts.
	for name, p := range map[string]jobStartParams{
		"a copy of server entries":      {Kind: "copy", Source: all, DestinationDirID: localID, Conflict: "ask"},
		"a trash of server entries":     {Kind: "trash", Source: all},
		"a checksum of server entries":  {Kind: "hashVerify", Source: all},
		"a download of local files":     {Kind: "download", Source: one, DestinationDirID: localID, Conflict: "ask"},
		"an upload of server entries":   {Kind: "upload", Source: all, RemoteDirID: dir.RemoteDirID, Conflict: "ask"},
		"an upload into a local folder": {Kind: "upload", Source: one, RemoteDirID: localID, Conflict: "ask"},
		"a delete of local files":       {Kind: "remoteDelete", Source: one},
		"a download without a folder":   {Kind: "download", Source: all, Conflict: "ask"},
		"a download with a bad policy":  {Kind: "download", Source: all, DestinationDirID: localID, Conflict: "maybe"},
	} {
		if _, err := svc.jobsStart(ctx, p); err == nil {
			t.Errorf("%s started", name)
		}
	}
	if _, err := svc.clipSet(ctx, clipSetParams{Selection: all.Selection, Mode: "copy"}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Errorf("clipboard of server entries: %v", err)
	}
}

func TestRemoteFileIsDownloadedToBeViewed(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	s, root := ftpServer(t, ftptest.Options{})
	putAt(t, filepath.Join(root, "notes.txt"), "to be read", 0)
	putAt(t, filepath.Join(root, "Odd Name.TXT"), "x", 0)
	_ = os.Mkdir(filepath.Join(root, "folder"), 0o755)
	conn, _ := svc.remoteConnect(ctx, remoteConnectParams{Quick: quick(s)})
	opened, _ := svc.remoteOpen(ctx, remoteOpenParams{RemoteID: conn.RemoteID, Path: "/"})
	_, rows := remoteNames(t, svc, conn.RemoteID, opened.RemoteDirID)

	res, err := svc.fileResolve(ctx, mediaResolveParams{EntryID: rows["notes.txt"].ID})
	if err != nil || res.SizeBytes != 10 {
		t.Fatalf("resolve: %+v %v", res, err)
	}
	if b, _ := os.ReadFile(res.Path); string(b) != "to be read" {
		t.Errorf("the copy holds %q", b)
	}
	// The copy lives in the cache's temporary folder, under a name of ours.
	if !strings.Contains(res.Path, filepath.Join("tmp", "remote")) || filepath.Base(res.Path) != "file.txt" {
		t.Errorf("path %s", res.Path)
	}
	// Viewed again, it is not downloaded again.
	retr := s.Count("RETR")
	if again, err := svc.fileResolve(ctx, mediaResolveParams{EntryID: rows["notes.txt"].ID}); err != nil || again.Path != res.Path || s.Count("RETR") != retr {
		t.Errorf("viewed again: %v, %d downloads", err, s.Count("RETR")-retr)
	}
	// Whatever the server calls a file, its copy has a name of ours.
	odd, err := svc.fileResolve(ctx, mediaResolveParams{EntryID: rows["Odd Name.TXT"].ID})
	if err != nil || filepath.Base(odd.Path) != "file.txt" || odd.Path == res.Path {
		t.Errorf("another file: %+v %v", odd, err)
	}
	if _, err := svc.fileResolve(ctx, mediaResolveParams{EntryID: rows["folder"].ID}); remoteReason(err) != "view" && rpcCode(err) != rpc.CodeInvalidArgument {
		t.Errorf("a folder: %v", err)
	}
	// The copies go with the connection.
	svc.remotes.Disconnect(conn.RemoteID)
	if _, err := os.Stat(res.Path); err == nil {
		t.Error("the copy outlived its connection")
	}
}

func TestSavedConnectionsAndTheirSecret(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	s, _ := ftpServer(t, ftptest.Options{User: "alice", Password: "s3cret"})
	c := library.Connection{Name: "Test", Host: s.Host, Port: s.Port, TLS: "none", User: "alice", StartPath: "/", Transfers: 2}

	// Main hands over ciphertext; this process stores it without reading it.
	cipher := base64.StdEncoding.EncodeToString([]byte{0x00, 0xff, 0x10, 0x80})
	saved, err := svc.remoteSaveConnection(ctx, saveConnectionParams{Connection: c, Secret: &cipher})
	if err != nil || !saved.HasPassword || saved.ID == 0 {
		t.Fatalf("save: %+v %v", saved, err)
	}
	lib, _ := svc.library(ctx)
	list, _ := lib.Connections(ctx)
	if len(list) != 1 || !list[0].HasPassword {
		t.Fatalf("list %+v", list)
	}
	raw, _ := lib.ConnectionSecret(ctx, saved.ID)
	if base64.StdEncoding.EncodeToString(raw) != cipher {
		t.Error("the stored secret is not what main gave")
	}
	// Changed without a password: the stored one stays. Forget drops it.
	saved.Group = "Work"
	if again, err := svc.remoteSaveConnection(ctx, saveConnectionParams{Connection: saved}); err != nil || !again.HasPassword {
		t.Errorf("change: %+v %v", again, err)
	}
	if forgot, err := svc.remoteSaveConnection(ctx, saveConnectionParams{Connection: saved, Forget: true}); err != nil || forgot.HasPassword {
		t.Errorf("forget: %+v %v", forgot, err)
	}
	bad := "not base64!"
	if _, err := svc.remoteSaveConnection(ctx, saveConnectionParams{Connection: saved, Secret: &bad}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Errorf("a bad secret: %v", err)
	}
	for name, change := range map[string]func(*library.Connection){
		"no host":      func(c *library.Connection) { c.Host = "" },
		"a bad port":   func(c *library.Connection) { c.Port = 0 },
		"a bad mode":   func(c *library.Connection) { c.TLS = "sometimes" },
		"a user@host":  func(c *library.Connection) { c.Host = "bob@" + s.Host },
		"a line in it": func(c *library.Connection) { c.User = "a\r\nb" },
	} {
		wrong := c
		wrong.Name = "wrong"
		change(&wrong)
		if _, err := svc.remoteSaveConnection(ctx, saveConnectionParams{Connection: wrong}); rpcCode(err) != rpc.CodeInvalidArgument {
			t.Errorf("%s: %v", name, err)
		}
	}

	// A connect by id takes the password main decrypted; a wrong one is refused as such.
	if _, err := svc.remoteConnect(ctx, remoteConnectParams{ConnectionID: saved.ID, Password: "guess"}); remoteReason(err) != "auth" {
		t.Errorf("a wrong password: %v", err)
	}
	conn, err := svc.remoteConnect(ctx, remoteConnectParams{ConnectionID: saved.ID, Password: "s3cret"})
	if err != nil || conn.User != "alice" || conn.StartPath != "/" {
		t.Fatalf("connect: %+v %v", conn, err)
	}
	for name, p := range map[string]remoteConnectParams{
		"neither a saved nor a typed connection": {},
		"both":                                   {ConnectionID: saved.ID, Quick: quick(s)},
		"an unknown connection":                  {ConnectionID: 999},
		"a password of two lines":                {Quick: quick(s), Password: "a\r\nDELE x"},
	} {
		if _, err := svc.remoteConnect(ctx, p); err == nil {
			t.Errorf("%s: connected", name)
		}
	}
	// Removing a connection forgets its secret.
	if err := lib.RemoveConnection(ctx, saved.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := lib.ConnectionSecret(ctx, saved.ID); !errors.Is(err, library.ErrNotFound) {
		t.Errorf("the secret of a removed connection: %v", err)
	}
}

func TestConnectFailuresSayWhy(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	plainServer, _ := ftpServer(t, ftptest.Options{User: "alice", Password: "s3cret"})

	// TLS asked for, none on offer: refused, and the password never left.
	q := quick(plainServer)
	q.TLS = "explicit"
	if _, err := svc.remoteConnect(ctx, remoteConnectParams{Quick: q, Password: "s3cret"}); remoteReason(err) != "tlsRequired" {
		t.Errorf("no TLS: %v", err)
	}
	if plainServer.Count("PASS") != 0 {
		t.Error("the password was sent without TLS")
	}

	// A certificate nobody vouches for: its fingerprint comes back; accepted, it connects.
	cert, leaf, err := ftptest.SelfSigned("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	tlsServer, _ := ftpServer(t, ftptest.Options{TLS: &tls.Config{Certificates: []tls.Certificate{cert}}})
	q = quick(tlsServer)
	q.TLS = "explicit"
	_, err = svc.remoteConnect(ctx, remoteConnectParams{Quick: q})
	var re *rpc.Error
	if !errors.As(err, &re) || remoteReason(err) != "certificate" {
		t.Fatalf("an unverified certificate: %v", err)
	}
	print, _ := re.Details.(map[string]any)["fingerprint"].(string)
	if print != remote.Fingerprint(leaf) {
		t.Errorf("fingerprint %q", print)
	}
	conn, err := svc.remoteConnect(ctx, remoteConnectParams{Quick: q, Accept: print})
	if err != nil || !conn.Encrypted {
		t.Fatalf("accepted: %+v %v", conn, err)
	}
	// Remembered on a saved connection, it needs no accepting again; another certificate is refused.
	lib, _ := svc.library(ctx)
	saved, err := lib.SaveConnection(ctx, library.Connection{Name: "tls", Host: tlsServer.Host, Port: tlsServer.Port, TLS: "explicit", Transfers: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := lib.SetConnectionFingerprint(ctx, saved.ID, print); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.remoteConnect(ctx, remoteConnectParams{ConnectionID: saved.ID}); err != nil {
		t.Errorf("a pinned certificate: %v", err)
	}
	_ = lib.SetConnectionFingerprint(ctx, saved.ID, strings.Repeat("cd", 32))
	_, err = svc.remoteConnect(ctx, remoteConnectParams{ConnectionID: saved.ID})
	if remoteReason(err) != "certificate" {
		t.Errorf("a changed certificate: %v", err)
	}
	if errors.As(err, &re) {
		if changed, _ := re.Details.(map[string]any)["changed"].(bool); !changed {
			t.Error("the change was not reported")
		}
	}

	// A server that does not answer: the connect is cancelled by its attempt.
	stalled, _ := ftpServer(t, ftptest.Options{StallOn: "GREETING"})
	done := make(chan error, 1)
	go func() {
		_, err := svc.remoteConnect(ctx, remoteConnectParams{Quick: quick(stalled), Attempt: 42})
		done <- err
	}()
	<-stalled.Stalled
	start := time.Now()
	for !svc.connecting.cancel(42) {
		time.Sleep(time.Millisecond)
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) && rpcCode(err) != rpc.CodeCancelled {
			t.Errorf("a cancelled connect: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the connect was not cancelled")
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("cancel took %v", time.Since(start))
	}
	if svc.connecting.cancel(42) {
		t.Error("a finished attempt can still be cancelled")
	}
	// Nothing is listening: unreachable, not a hang.
	gone := quick(plainServer)
	gone.Port = 1
	if _, err := svc.remoteConnect(ctx, remoteConnectParams{Quick: gone}); remoteReason(err) == "" {
		t.Errorf("a closed port: %v", err)
	}
}

// A server that stops answering holds a listing for the command timeout;
// remote.cancel ends it at once, and the connection works again afterwards.
func TestAListingThatHangsIsCancelled(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	s, root := ftpServer(t, ftptest.Options{StallOn: "LIST", NoMLSD: true})
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	conn, err := svc.remoteConnect(ctx, remoteConnectParams{Quick: quick(s)})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := svc.remoteOpen(ctx, remoteOpenParams{RemoteID: conn.RemoteID, Path: "/", Attempt: 41})
		done <- err
	}()
	select {
	case <-s.Stalled:
	case <-time.After(5 * time.Second):
		t.Fatal("the server never got the listing")
	}
	start := time.Now()
	if !svc.connecting.cancel(41) {
		t.Fatal("the listing was not registered for cancelling")
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a cancelled listing returned a folder")
		}
		if took := time.Since(start); took > 200*time.Millisecond {
			t.Errorf("cancel took %v, budget 200ms", took)
		} else {
			t.Logf("cancel effective after %v", took)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the listing went on after cancel")
	}
	// Nothing is left registered, and the next command gets a fresh socket.
	if svc.connecting.cancel(41) {
		t.Error("the attempt is still registered")
	}
	s.Release()
	if _, err := svc.remoteOpen(ctx, remoteOpenParams{RemoteID: conn.RemoteID, Path: "/"}); err != nil {
		t.Errorf("the connection after a cancelled listing: %v", err)
	}
}
