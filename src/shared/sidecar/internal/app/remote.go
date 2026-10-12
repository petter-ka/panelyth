package app

import (
	"context"
	"encoding/base64"
	"errors"
	"net"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/library"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/query"
	"panelyth/sidecar/internal/remote"
	"panelyth/sidecar/internal/rpc"
)

// Stage C10.5 (ADR-0037): FTP and FTPS servers browsed like folders. Saved
// connections live in library.db; a password is stored only as ciphertext
// that Electron main made, and reaches this process in the clear only as
// the parameter of one remote.connect. Wire types mirror
// src/shared/contracts/src/rpc.ts.

const evConnectionsChanged = "connections.changed"

// MaxPasswordBytes bounds a password given to remote.connect.
const MaxPasswordBytes = 1024

type (
	connectionsResult struct {
		Connections []library.Connection `json:"connections"`
	}
	saveConnectionParams struct {
		Connection library.Connection `json:"connection"`
		// Secret is the password as main encrypted it (base64); absent leaves
		// the stored one. Forget drops the stored one.
		Secret *string `json:"secret"`
		Forget bool    `json:"forget"`
	}
	connectionIDParams struct {
		ConnectionID int64 `json:"connectionId"`
	}
	connectionSecretResult struct {
		// Secret is the stored ciphertext (base64), "" when none is stored.
		Secret string `json:"secret"`
	}
	trustParams struct {
		ConnectionID int64  `json:"connectionId"`
		Fingerprint  string `json:"fingerprint"`
	}
	// remoteQuick is a connection that is not saved (quick connect).
	remoteQuick struct {
		Host      string `json:"host"`
		Port      int    `json:"port"`
		TLS       string `json:"tls"`
		User      string `json:"user"`
		Active    bool   `json:"active"`
		Encoding  string `json:"encoding"`
		Transfers int    `json:"transfers"`
	}
	remoteConnectParams struct {
		ConnectionID int64        `json:"connectionId"`
		Quick        *remoteQuick `json:"quick"`
		// Password in the clear: decrypted by main for this call, or typed.
		// It is never logged and never stored by this process.
		Password string `json:"password"`
		// Accept trusts the certificate with this fingerprint for this connect.
		Accept string `json:"accept"`
		// Attempt names the connect so that remote.cancel can stop it.
		Attempt int64 `json:"attempt"`
	}
	remoteFeatures struct {
		MLSD   bool `json:"mlsd"`
		Resume bool `json:"resume"`
		UTF8   bool `json:"utf8"`
	}
	remoteConnectResult struct {
		RemoteID int64  `json:"remoteId"`
		Host     string `json:"host"`
		Port     int    `json:"port"`
		User     string `json:"user"`
		// Encrypted: the control and data connections use TLS.
		Encrypted bool           `json:"encrypted"`
		Features  remoteFeatures `json:"features"`
		// StartPath is where the connection's panel opens first.
		StartPath string `json:"startPath"`
		// LocalPath is the folder the saved connection names for the other panel.
		LocalPath string `json:"localPath"`
	}
	remoteAttemptParams struct {
		Attempt int64 `json:"attempt"`
	}
	remoteIDParams struct {
		RemoteID int64 `json:"remoteId"`
	}
	remoteOpenParams struct {
		RemoteID int64 `json:"remoteId"`
		// Path opens a folder by its path on the server; DirID by its entry id.
		Path  string `json:"path"`
		DirID int64  `json:"dirId"`
		// Attempt names the listing for remote.cancel (0: it can't be cancelled).
		Attempt int64 `json:"attempt"`
	}
	remoteOpenResult struct {
		RemoteDirID int64  `json:"remoteDirId"`
		Path        string `json:"path"`
		Name        string `json:"name"`
		// Crumbs are the folder's ancestors, the server's root first.
		Crumbs []fsx.Crumb `json:"crumbs"`
		// Rejected entries have names that cannot be listed; they are left out.
		Rejected int `json:"rejected"`
	}
	remoteMkdirParams struct {
		RemoteDirID int64  `json:"remoteDirId"`
		Name        string `json:"name"`
	}
	remoteRenameParams struct {
		EntryID int64  `json:"entryId"`
		Name    string `json:"name"`
	}
	connectionsEvent struct {
		Connections []library.Connection `json:"connections"`
	}
)

// connecting holds the connects under way, so each can be cancelled.
type connecting struct {
	mu      sync.Mutex
	cancels map[int64]context.CancelFunc
}

func (c *connecting) add(attempt int64, cancel context.CancelFunc) {
	c.mu.Lock()
	if c.cancels == nil {
		c.cancels = map[int64]context.CancelFunc{}
	}
	if old := c.cancels[attempt]; old != nil {
		old()
	}
	c.cancels[attempt] = cancel
	c.mu.Unlock()
}

func (c *connecting) done(attempt int64) {
	c.mu.Lock()
	delete(c.cancels, attempt)
	c.mu.Unlock()
}

func (c *connecting) cancel(attempt int64) bool {
	c.mu.Lock()
	cancel := c.cancels[attempt]
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return cancel != nil
}

func (s *indexService) registerRemote(srv *rpc.Server) {
	rpc.Register(srv, "remote.connections", func(ctx context.Context, _ emptyParams) (connectionsResult, error) {
		lib, err := s.library(ctx)
		if err != nil {
			return connectionsResult{}, err
		}
		list, err := lib.Connections(ctx)
		return connectionsResult{Connections: list}, libError(err)
	})
	// Named apart from the renderer's remote.saveConnection and remote.connect,
	// which Electron main answers: main encrypts a password before it is stored
	// and decrypts it for a connect. These two are called by main only.
	rpc.Register(srv, "remote.storeConnection", s.remoteSaveConnection)
	rpc.Register(srv, "remote.removeConnection", func(ctx context.Context, p connectionIDParams) (okResult, error) {
		lib, err := s.library(ctx)
		if err != nil {
			return okResult{}, err
		}
		if err := lib.RemoveConnection(ctx, p.ConnectionID); err != nil {
			return okResult{}, libError(err)
		}
		s.connectionsChanged(ctx)
		return okResult{OK: true}, nil
	})
	// Electron main only: the ciphertext it decrypts for one connect.
	rpc.Register(srv, "remote.secret", func(ctx context.Context, p connectionIDParams) (connectionSecretResult, error) {
		lib, err := s.library(ctx)
		if err != nil {
			return connectionSecretResult{}, err
		}
		secret, err := lib.ConnectionSecret(ctx, p.ConnectionID)
		if err != nil {
			return connectionSecretResult{}, libError(err)
		}
		return connectionSecretResult{Secret: base64.StdEncoding.EncodeToString(secret)}, nil
	})
	rpc.Register(srv, "remote.trust", func(ctx context.Context, p trustParams) (okResult, error) {
		lib, err := s.library(ctx)
		if err != nil {
			return okResult{}, err
		}
		if err := lib.SetConnectionFingerprint(ctx, p.ConnectionID, p.Fingerprint); err != nil {
			return okResult{}, libError(err)
		}
		s.connectionsChanged(ctx)
		return okResult{OK: true}, nil
	})
	rpc.Register(srv, "remote.dial", s.remoteConnect)
	rpc.Register(srv, "remote.cancel", func(_ context.Context, p remoteAttemptParams) (okResult, error) {
		return okResult{OK: s.connecting.cancel(p.Attempt)}, nil
	})
	rpc.Register(srv, "remote.disconnect", func(_ context.Context, p remoteIDParams) (okResult, error) {
		return okResult{OK: s.remotes.Disconnect(p.RemoteID)}, nil
	})
	rpc.Register(srv, "remote.open", s.remoteOpen)
	rpc.Register(srv, "remote.mkdir", s.remoteMkdir)
	rpc.Register(srv, "remote.rename", s.remoteRename)
}

// connectionsChanged tells both the dialog and any other listener.
func (s *indexService) connectionsChanged(ctx context.Context) {
	lib, err := s.library(ctx)
	if err != nil {
		return
	}
	list, err := lib.Connections(ctx)
	if err != nil {
		s.log.Warn("connections changed", "err", err)
		return
	}
	s.events.Post(evConnectionsChanged, "", connectionsEvent{Connections: list})
}

func (s *indexService) remoteSaveConnection(ctx context.Context, p saveConnectionParams) (library.Connection, error) {
	lib, err := s.library(ctx)
	if err != nil {
		return library.Connection{}, err
	}
	var secret []byte
	switch {
	case p.Forget:
		secret = []byte{}
	case p.Secret != nil:
		if secret, err = base64.StdEncoding.DecodeString(*p.Secret); err != nil || len(secret) == 0 {
			return library.Connection{}, rpc.NewError(rpc.CodeInvalidArgument, "the stored password is not valid")
		}
	}
	// What is saved must be something a connect accepts.
	if _, err := optionsOf(p.Connection, ""); err != nil {
		return library.Connection{}, err
	}
	saved, err := lib.SaveConnection(ctx, p.Connection, secret)
	if errors.Is(err, library.ErrTooManyItems) {
		return library.Connection{}, rpc.NewError(rpc.CodeInvalidArgument, "there is no room for another connection")
	}
	if err != nil {
		return library.Connection{}, libError(err)
	}
	s.connectionsChanged(ctx)
	return saved, nil
}

// optionsOf turns a stored or typed connection into dial options.
func optionsOf(c library.Connection, password string) (remote.Options, error) {
	o := remote.Options{Host: strings.TrimSpace(c.Host), Port: c.Port, TLS: remote.TLSMode(c.TLS),
		User: strings.TrimSpace(c.User), Password: password, Active: c.Active, Encoding: c.Encoding,
		Fingerprint: c.Fingerprint}
	bad := func(msg string) (remote.Options, error) {
		return remote.Options{}, rpc.NewError(rpc.CodeInvalidArgument, msg)
	}
	switch {
	case o.Host == "" || len(o.Host) > 253 || strings.ContainsAny(o.Host, " \t\r\n/\\@"):
		return bad("the host is a name or an address")
	case o.Port < 1 || o.Port > 65535:
		return bad("the port is 1..65535")
	case !o.TLS.Valid():
		return bad("unknown encryption")
	case len(password) > MaxPasswordBytes || strings.ContainsAny(password, "\r\n\x00"):
		return bad("the password is one line of text")
	case strings.ContainsAny(o.User, "\r\n\x00") || len(o.User) > library.MaxConnectionName:
		return bad("the user name is one line of text")
	}
	return o, nil
}

// remoteError maps a failed connect or command to the protocol;
// details.reason lets the commander say what to do next.
func remoteError(err error) error {
	reasoned := func(code rpc.ErrorCode, reason, msg string, more map[string]any) error {
		e := rpc.NewError(code, msg)
		d := map[string]any{"reason": reason}
		for k, v := range more {
			d[k] = v
		}
		e.Details = d
		return e
	}
	var ce *remote.CertificateError
	var se *remote.ServerError
	var ne net.Error
	var dns *net.DNSError
	switch {
	case err == nil:
		return nil
	case errors.Is(err, context.Canceled):
		return err
	case errors.As(err, &ce):
		return reasoned(rpc.CodePermissionDenied, "certificate", "The server's certificate could not be verified.",
			map[string]any{"fingerprint": ce.Fingerprint, "subject": ce.Subject, "changed": ce.Changed})
	case errors.Is(err, remote.ErrTLSRequired):
		return reasoned(rpc.CodePermissionDenied, "tlsRequired", "The server does not offer encryption (TLS).", nil)
	case errors.Is(err, remote.ErrAuth):
		return reasoned(rpc.CodePermissionDenied, "auth", "The server refused the user name or the password.", nil)
	case errors.Is(err, remote.ErrNotFound):
		return reasoned(rpc.CodeNotFound, "notFound", "There is no such file or folder on the server.", nil)
	case errors.Is(err, remote.ErrUnsafeName):
		return reasoned(rpc.CodeInvalidPath, "name", "This name can't be used on a server.", nil)
	case errors.Is(err, remote.ErrUnknown), errors.Is(err, remote.ErrClosed):
		return reasoned(rpc.CodeNotFound, "closed", "The connection is closed.", nil)
	case errors.Is(err, remote.ErrTooLarge):
		return reasoned(rpc.CodeInvalidArgument, "tooLarge", "The connection has listed too many entries; connect again to go on.", nil)
	case errors.Is(err, remote.ErrUnsupported):
		return reasoned(rpc.CodeUnsupportedMedia, "unsupported", "The server does not support this.", nil)
	case errors.As(err, &se):
		// The server's own words.
		return reasoned(rpc.CodeInvalidArgument, "refused", se.Msg, map[string]any{"code": se.Code})
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return reasoned(rpc.CodeTimeout, "timeout", "The server did not answer in time.", nil)
	case errors.As(err, &dns):
		return reasoned(rpc.CodeNotFound, "host", "The server's name could not be found.", nil)
	}
	return reasoned(rpc.CodeInvalidPath, "unreachable", "The server could not be reached.", nil)
}

// remoteConnect opens a connection: a saved one by id, or a typed one.
func (s *indexService) remoteConnect(ctx context.Context, p remoteConnectParams) (remoteConnectResult, error) {
	var c library.Connection
	switch {
	case p.ConnectionID > 0 && p.Quick == nil:
		lib, err := s.library(ctx)
		if err != nil {
			return remoteConnectResult{}, err
		}
		if c, err = lib.Connection(ctx, p.ConnectionID); err != nil {
			return remoteConnectResult{}, libError(err)
		}
	case p.ConnectionID == 0 && p.Quick != nil:
		q := p.Quick
		c = library.Connection{Host: q.Host, Port: q.Port, TLS: q.TLS, User: q.User, Active: q.Active,
			Encoding: q.Encoding, Transfers: q.Transfers}
	default:
		return remoteConnectResult{}, rpc.NewError(rpc.CodeInvalidArgument, "a saved connection or a typed one")
	}
	o, err := optionsOf(c, p.Password)
	if err != nil {
		return remoteConnectResult{}, err
	}
	if p.Accept != "" {
		// Trusted for this connect; remote.trust remembers it.
		o.Fingerprint = p.Accept
	}
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if p.Attempt != 0 {
		s.connecting.add(p.Attempt, cancel)
		defer s.connecting.done(p.Attempt)
	}
	start := time.Now()
	conn, err := s.remotes.Connect(cctx, o, c.Transfers)
	if err != nil {
		// Never the options: they hold the password.
		s.log.Info("remote connect failed", "host", o.Host, "port", o.Port, "tls", string(o.TLS), "err", err.Error())
		return remoteConnectResult{}, remoteError(err)
	}
	f := conn.Features()
	s.log.Info("remote connected", "remoteId", conn.ID, "host", o.Host, "port", o.Port, "tls", string(o.TLS),
		"mlsd", f.MLSD, "ms", time.Since(start).Milliseconds())
	startPath := c.StartPath
	if clean, ok := remote.CleanDir(startPath); ok {
		startPath = clean
	} else {
		startPath = "/"
	}
	return remoteConnectResult{RemoteID: conn.ID, Host: o.Host, Port: o.Port, User: o.User, Encrypted: f.TLS,
		Features:  remoteFeatures{MLSD: f.MLSD, Resume: f.Resume, UTF8: f.UTF8},
		StartPath: startPath, LocalPath: c.LocalPath}, nil
}

// remoteCrumbs are a folder's ancestors on the server, the root first.
func remoteCrumbs(path string) []fsx.Crumb {
	crumbs := []fsx.Crumb{{Name: "/", Path: "/"}}
	at := ""
	for part := range strings.SplitSeq(strings.Trim(path, "/"), "/") {
		if part == "" {
			continue
		}
		at += "/" + part
		crumbs = append(crumbs, fsx.Crumb{Name: part, Path: at})
	}
	return crumbs
}

// remoteOpen lists a folder of a connection from the server (the remote
// counterpart of dir.open). Sessions over the folder show the new listing.
func (s *indexService) remoteOpen(ctx context.Context, p remoteOpenParams) (remoteOpenResult, error) {
	conn, err := s.remotes.Get(p.RemoteID)
	if err != nil {
		return remoteOpenResult{}, remoteError(err)
	}
	path := p.Path
	if p.DirID != 0 {
		var ok bool
		if path, ok = conn.DirPath(p.DirID); !ok {
			return remoteOpenResult{}, rpc.NewError(rpc.CodeNotFound, "not a folder of this connection")
		}
	}
	// A server that stops answering holds this call for the command
	// timeout; remote.cancel ends it at once.
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if p.Attempt != 0 {
		s.connecting.add(p.Attempt, cancel)
		defer s.connecting.done(p.Attempt)
	}
	dirID, rejected, err := conn.OpenDir(cctx, path)
	if err != nil {
		return remoteOpenResult{}, remoteError(err)
	}
	s.refreshRemote(dirID)
	clean, _ := conn.DirPath(dirID)
	return remoteOpenResult{RemoteDirID: dirID, Path: clean, Name: remote.Base(clean), Crumbs: remoteCrumbs(clean),
		Rejected: rejected}, nil
}

// refreshRemote shows a folder's new listing in the sessions over it.
func (s *indexService) refreshRemote(dirID int64) {
	for _, q := range s.remotes.Sessions(dirID) {
		_, _ = s.queries.RefreshNow(q)
	}
}

// relist reads a folder again after this app changed it.
func (s *indexService) relist(ctx context.Context, conn *remote.Conn, path string) {
	if dirID, _, err := conn.OpenDir(ctx, path); err == nil {
		s.refreshRemote(dirID)
	}
}

// openRemoteQuery serves query.open for a listed folder of a connection.
func (s *indexService) openRemoteQuery(ctx context.Context, remoteID, dirID int64, d index.Descriptor) (query.Snapshot, error) {
	conn, err := s.remotes.Get(remoteID)
	if err != nil {
		return query.Snapshot{}, remoteError(err)
	}
	src, err := conn.Source(dirID)
	if err != nil {
		return query.Snapshot{}, remoteError(err)
	}
	snap, err := s.queries.OpenSource(ctx, d, src)
	if err != nil {
		return snap, dbError(err)
	}
	s.remotes.Attach(snap.QueryID, src)
	return snap, nil
}

// remoteName checks a name typed for a new folder or a rename.
func remoteName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if !remote.SafeName(name) {
		return "", rpc.NewError(rpc.CodeInvalidArgument, "This name can't be used on a server.")
	}
	return name, nil
}

func (s *indexService) remoteMkdir(ctx context.Context, p remoteMkdirParams) (okResult, error) {
	conn, _, err := s.remotes.Lookup(p.RemoteDirID)
	if err != nil {
		return okResult{}, remoteError(err)
	}
	dir, ok := conn.DirPath(p.RemoteDirID)
	if !ok {
		return okResult{}, rpc.NewError(rpc.CodeNotFound, "not a folder of this connection")
	}
	name, err := remoteName(p.Name)
	if err != nil {
		return okResult{}, err
	}
	if err := conn.Do(ctx, false, func(c remote.Client) error { return c.Mkdir(ctx, remote.Join(dir, name)) }); err != nil {
		return okResult{}, remoteError(err)
	}
	s.relist(ctx, conn, dir)
	return okResult{OK: true}, nil
}

func (s *indexService) remoteRename(ctx context.Context, p remoteRenameParams) (okResult, error) {
	conn, _, err := s.remotes.Lookup(p.EntryID)
	if err != nil {
		return okResult{}, remoteError(err)
	}
	in, ok := conn.Entry(p.EntryID)
	if !ok || in.Path == "/" {
		return okResult{}, rpc.NewError(rpc.CodeNotFound, "the entry is no longer listed")
	}
	name, err := remoteName(p.Name)
	if err != nil {
		return okResult{}, err
	}
	if name == in.Name {
		return okResult{OK: true}, nil
	}
	dir := remote.Parent(in.Path)
	if err := conn.Do(ctx, false, func(c remote.Client) error { return c.Rename(ctx, in.Path, remote.Join(dir, name)) }); err != nil {
		return okResult{}, remoteError(err)
	}
	s.relist(ctx, conn, dir)
	return okResult{OK: true}, nil
}

// Jobs, properties and viewing ------------------------------------------------------------

func remoteOnly(ids []int64) bool {
	return len(ids) > 0 && remote.IsID(ids[0])
}

// remoteInfos resolves entry ids of one connection.
func (s *indexService) remoteInfos(ids []int64) (*remote.Conn, []remote.Info, error) {
	var conn *remote.Conn
	out := make([]remote.Info, 0, len(ids))
	for _, id := range ids {
		c, _, err := s.remotes.Lookup(id)
		if err != nil {
			return nil, nil, remoteError(err)
		}
		if conn == nil {
			conn = c
		} else if c != conn {
			return nil, nil, rpc.NewError(rpc.CodeInvalidArgument, "entries of two connections can't be mixed")
		}
		// An entry that left its folder since it was marked is simply not there.
		if in, ok := c.Entry(id); ok {
			out = append(out, in)
		}
	}
	if conn == nil || len(out) == 0 {
		return nil, nil, rpc.NewError(rpc.CodeNotFound, "the entries are no longer listed")
	}
	return conn, out, nil
}

// remoteJob fills the remote side of a jobs.start request. Entries of a
// connection go only into the jobs that are made for them.
func (s *indexService) remoteJob(ctx context.Context, p jobStartParams, spec *jobs.Spec, ids []int64) error {
	onServer := slices.ContainsFunc(ids, remote.IsID)
	changed := func(conn *remote.Conn) func(string) {
		// After the job: the folders it changed are read again, off the job's own context.
		return func(dir string) { s.relist(s.bg, conn, dir) }
	}
	switch spec.Kind {
	case jobs.KindDownload, jobs.KindRemoteDelete:
		if !onServer || slices.ContainsFunc(ids, func(id int64) bool { return !remote.IsID(id) }) {
			return rpc.NewError(rpc.CodeInvalidArgument, "this job takes entries of a connection")
		}
		conn, items, err := s.remoteInfos(ids)
		if err != nil {
			return err
		}
		spec.IDs = nil
		spec.Remote = &jobs.RemoteSpec{Conn: conn, Items: items, Move: p.Move, Changed: changed(conn)}
		if spec.Kind == jobs.KindDownload {
			dest, err := s.dirPath(ctx, p.DestinationDirID)
			if err != nil {
				return err
			}
			spec.Destination = dest
		}
	case jobs.KindUpload:
		if onServer || archiveOnly(ids) {
			return rpc.NewError(rpc.CodeInvalidArgument, "an upload takes files of this computer")
		}
		conn, _, err := s.remotes.Lookup(p.RemoteDirID)
		if err != nil {
			return remoteError(err)
		}
		dir, ok := conn.DirPath(p.RemoteDirID)
		if !ok {
			return rpc.NewError(rpc.CodeNotFound, "not a folder of this connection")
		}
		spec.Remote = &jobs.RemoteSpec{Conn: conn, Dir: dir, Move: p.Move, Changed: changed(conn)}
	default:
		if onServer {
			return rpc.NewError(rpc.CodeInvalidArgument, "this is not available on a connection")
		}
	}
	return nil
}

// remoteSummary is selection.info for entries of a connection.
func (s *indexService) remoteSummary(ids []int64) (index.Summary, error) {
	var sum index.Summary
	for _, id := range ids {
		c, _, err := s.remotes.Lookup(id)
		if err != nil {
			return sum, remoteError(err)
		}
		in, ok := c.Entry(id)
		if !ok {
			continue
		}
		sum.Count++
		switch {
		case in.Kind == remote.KindDir:
			sum.Dirs++
		default:
			sum.Bytes += in.Size
			if k, _, ok := media.Classify(in.Name); ok {
				switch k {
				case media.KindImage:
					sum.Images++
				case media.KindVideo:
					sum.Videos++
				}
			}
		}
	}
	return sum, nil
}

// remoteProps is props.get for an entry of a connection: what its folder's
// listing knows. The path is shown as an address, never used as one.
func (s *indexService) remoteProps(id int64) (propsResult, error) {
	c, _, err := s.remotes.Lookup(id)
	if err != nil {
		return propsResult{}, remoteError(err)
	}
	in, ok := c.Entry(id)
	if !ok {
		return propsResult{}, rpc.NewError(rpc.CodeNotFound, "the entry is no longer listed")
	}
	o := c.Options()
	kind, ext := media.KindFile, media.Ext(in.Name)
	switch in.Kind {
	case remote.KindDir:
		kind, ext = media.KindDir, ""
	case remote.KindLink:
		kind = media.KindLink
	default:
		if k, _, ok := media.Classify(in.Name); ok {
			kind = k
		}
	}
	return propsResult{ID: id, Kind: kind.String(), Name: in.Name, Ext: ext,
		Path: "ftp://" + net.JoinHostPort(o.Host, strconv.Itoa(o.Port)) + in.Path, Exists: true,
		SizeBytes: in.Size, ModifiedMs: in.MtimeNs / int64(time.Millisecond), Tags: []string{}}, nil
}

// remoteFileResolve is file.resolve for a file on a server: it is
// downloaded to the cache's temporary folder (bounded) and served from there.
func (s *indexService) remoteFileResolve(ctx context.Context, id int64) (fileResolveResult, error) {
	path, in, err := s.remotes.View(ctx, id)
	if err != nil {
		if errors.Is(err, remote.ErrTooLarge) || errors.Is(err, remote.ErrUnsupported) {
			e := rpc.NewError(rpc.CodeInvalidArgument, strings.TrimPrefix(err.Error(), "remote: "))
			e.Details = map[string]string{"reason": "view"}
			return fileResolveResult{}, e
		}
		return fileResolveResult{}, remoteError(err)
	}
	kind, mime := media.KindFile, "application/octet-stream"
	if k, ext, ok := media.Classify(in.Name); ok {
		kind = k
		if m, ok := mimeByExt[ext]; ok {
			mime = m
		}
	}
	fi, err := os.Stat(path)
	if err != nil {
		return fileResolveResult{}, statError(err, "file")
	}
	return fileResolveResult{Path: path, Kind: kind.String(), Mime: mime, SizeBytes: fi.Size()}, nil
}
