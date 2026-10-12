package jobs

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/pathkey"
	"panelyth/sidecar/internal/remote"
)

// Jobs between a connection and this computer (Stage C10.5, ADR-0037 and
// ADR-0029): download copies entries of a server into a folder here, upload
// copies files and folders to a folder on the server, remoteDelete removes
// entries on the server. They run in a lane per connection, one file at a
// time per job, each on a transfer client of the connection's bounded pool.
const (
	KindDownload     Kind = "download"
	KindUpload       Kind = "upload"
	KindRemoteDelete Kind = "remoteDelete"
)

// maxRemoteDepth bounds how deep a job follows folders (a server can list a
// folder inside itself for ever).
const maxRemoteDepth = 64

// RemoteSpec is the server side of a transfer or delete job.
type RemoteSpec struct {
	Conn *remote.Conn
	// Items are what a download copies and a remoteDelete removes.
	Items []remote.Info
	// Dir is the folder on the server an upload writes into.
	Dir string
	// Move removes each source once its copy is complete and of the same size.
	Move bool
	// Changed reports a folder of the server whose listing the job changed.
	Changed func(dir string)
}

func validateRemote(s Spec) error {
	r := s.Remote
	if r == nil || r.Conn == nil {
		return fmt.Errorf("%w: a connection is needed", ErrInvalid)
	}
	switch s.Kind {
	case KindDownload:
		if len(r.Items) == 0 || s.Destination == "" {
			return fmt.Errorf("%w: a download needs entries and a folder", ErrInvalid)
		}
	case KindUpload:
		if len(s.IDs) == 0 || r.Dir == "" {
			return fmt.Errorf("%w: an upload needs files and a folder on the server", ErrInvalid)
		}
	case KindRemoteDelete:
		if len(r.Items) == 0 {
			return fmt.Errorf("%w: nothing to delete", ErrInvalid)
		}
		return nil
	}
	if !validPolicy(s.Conflict) {
		return fmt.Errorf("%w: unknown conflict policy %q", ErrInvalid, s.Conflict)
	}
	return nil
}

// remoteLane is the lane of a job on a connection: its jobs queue behind
// each other, and never behind the jobs of a disk or of another server.
func remoteLane(s Spec) (string, bool) {
	if s.Remote == nil || s.Remote.Conn == nil {
		return "", false
	}
	return "remote:" + strconv.FormatInt(s.Remote.Conn.ID, 10), true
}

func (r *RemoteSpec) changed(dir string) {
	if r.Changed != nil {
		r.Changed(dir)
	}
}

// remoteCode and remoteMessage word a failed item.
func remoteCode(err error) string {
	switch {
	case errors.Is(err, remote.ErrNotFound):
		return fileops.CodeNotFound
	case errors.Is(err, remote.ErrUnsafeName):
		return fileops.CodeInvalidName
	}
	var fe *fileops.Error
	if errors.As(err, &fe) {
		return fe.Code
	}
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission) || errors.Is(err, fs.ErrExist) {
		return fileops.Code(err)
	}
	return fileops.CodeIO
}

func remoteMessage(err error) string {
	var se *remote.ServerError
	switch {
	case errors.Is(err, remote.ErrNotFound):
		return "It is no longer on the server."
	case errors.Is(err, remote.ErrUnsafeName):
		return "This name can't be used on the server."
	case errors.Is(err, remote.ErrClosed), errors.Is(err, remote.ErrUnknown):
		return "The connection is closed."
	case errors.Is(err, remote.ErrAuth):
		return "The server refused the login."
	case errors.As(err, &se):
		return "The server said: " + se.Msg
	}
	if c := remoteCode(err); c != fileops.CodeIO {
		return message(err)
	}
	return "The transfer failed: " + err.Error()
}

// remoteFailed records a failed item unless the job was cancelled.
func (m *Manager) remoteFailed(j *job, name string, err error) error {
	if j.ctx.Err() != nil {
		return j.ctx.Err()
	}
	j.fail(name, remoteCode(err), remoteMessage(err))
	return nil
}

// listRemote reads a folder of the server for a job (nothing is kept).
func listRemote(j *job, conn *remote.Conn, dir string) ([]remote.Entry, error) {
	var out []remote.Entry
	err := conn.Do(j.ctx, true, func(c remote.Client) error {
		var lerr error
		out, _, lerr = c.List(j.ctx, dir)
		return lerr
	})
	return out, err
}

// decide answers a name that is taken, by the job's policy (asking when it
// is "ask"): skip, replace, a free name for the new item, or the existing
// item moved aside.
type remoteDecision int

const (
	remoteSkip remoteDecision = iota
	remoteReplace
	remoteKeepBoth
	remoteRenameExisting
)

func (m *Manager) remoteDecide(j *job, rel string, src, dst ConflictSide) (remoteDecision, error) {
	policy := j.currentPolicy()
	if policy == ConflictAsk {
		var err error
		if policy, err = m.ask(j, Conflict{Name: rel, Source: src, Target: dst}); err != nil {
			return remoteSkip, err
		}
	}
	switch policy {
	case ConflictSkip:
		return remoteSkip, nil
	case ConflictReplace:
		return remoteReplace, nil
	case ConflictRenameExisting:
		return remoteRenameExisting, nil
	case ConflictReplaceOlder:
		// A date unknown on either side is no reason to replace.
		if src.ModifiedMs > 0 && dst.ModifiedMs > 0 && src.ModifiedMs > dst.ModifiedMs {
			return remoteReplace, nil
		}
		return remoteSkip, nil
	case ConflictReplaceIfDifferentSize:
		if src.Size != dst.Size {
			return remoteReplace, nil
		}
		return remoteSkip, nil
	}
	return remoteKeepBoth, nil
}

// counter adds what a transfer moves to the job's progress; its Write and
// Read are the job's pause points inside a file.
type counter struct {
	m *Manager
	j *job
	w io.Writer
	r io.Reader
	n int64
}

func (c *counter) add(n int) {
	c.n += int64(n)
	c.j.update(func(s *Snapshot) { s.BytesDone += int64(n) })
	c.m.emit(c.j, false)
}

func (c *counter) Write(p []byte) (int, error) {
	if err := c.j.gate(c.j.ctx); err != nil {
		return 0, err
	}
	n, err := c.w.Write(p)
	c.add(n)
	return n, err
}

func (c *counter) Read(p []byte) (int, error) {
	if err := c.j.gate(c.j.ctx); err != nil {
		return 0, err
	}
	n, err := c.r.Read(p)
	c.add(n)
	return n, err
}

// Download ------------------------------------------------------------------------------

func (m *Manager) download(j *job, a *applier) (string, error) {
	dest, destDir, indexed, msg := m.archiveDestination(j)
	if msg != "" {
		return msg, nil
	}
	r := j.spec.Remote
	defer r.Conn.Hold()()
	var total int64
	for _, it := range r.Items {
		if it.Kind == remote.KindFile {
			total += it.Size
		}
	}
	j.update(func(s *Snapshot) { s.BytesTotal = total })
	for _, it := range r.Items {
		if err := j.gate(j.ctx); err != nil {
			return "", err
		}
		j.update(func(s *Snapshot) { s.Current = truncate(it.Name) })
		m.emit(j, false)
		failedBefore := j.failedCount()
		name, err := m.downloadEntry(j, it.Path, it.Entry, dest, it.Name, 0)
		if err != nil {
			return "", err
		}
		if name == "" {
			continue // skipped or failed; said so already
		}
		if j.failedCount() == failedBefore {
			j.update(func(s *Snapshot) { s.Done++ })
		}
		if indexed && dest == destDir.Path {
			t := index.Target{Kind: media.KindFile}
			switch {
			case it.Kind == remote.KindDir:
				t.Kind = media.KindDir
			default:
				if k, _, ok := media.Classify(name); ok {
					t.Kind = k
				}
			}
			a.add(rowFor(destDir, t, name, pathkey.ChildKey(destDir.Key, name, t.Kind == media.KindDir), filepath.Join(dest, name)))
			a.touch(destDir.ID, destDir.Key)
			a.count()
		}
		// A move: the source goes once all of it has arrived.
		if r.Move && j.failedCount() == failedBefore {
			if err := m.removeRemote(j, r.Conn, it.Path, it.Entry, 0); err != nil {
				if cerr := m.remoteFailed(j, it.Name, err); cerr != nil {
					return "", cerr
				}
			} else {
				r.changed(remote.Parent(it.Path))
			}
		}
	}
	return "", nil
}

func (j *job) failedCount() int {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.snap.Failed
}

// downloadEntry copies one entry of the server into dir. It returns the
// name it wrote ("" when the entry was skipped or failed, which is recorded)
// and an error only when the job has to stop. rel names the entry in
// questions and failures.
func (m *Manager) downloadEntry(j *job, path string, e remote.Entry, dir, rel string, depth int) (string, error) {
	conn := j.spec.Remote.Conn
	// A name this computer cannot hold is never written, whatever the server calls it.
	if err := fileops.ValidateName(e.Name); err != nil {
		j.fail(rel, fileops.CodeInvalidName, "The name can't be used on this computer: "+err.Error())
		return "", nil
	}
	target := filepath.Join(dir, e.Name)
	// Belt and braces: the target is a child of dir.
	if filepath.Dir(target) != filepath.Clean(dir) {
		j.fail(rel, "UNSAFE_PATH", "The name would leave the destination folder.")
		return "", nil
	}
	switch e.Kind {
	case remote.KindLink:
		j.update(func(s *Snapshot) { s.Skipped++ })
		j.fail(rel, fileops.CodeSkippedLink, "Links on a server are not followed or copied.")
		return "", nil
	case remote.KindDir:
		if depth >= maxRemoteDepth {
			j.fail(rel, fileops.CodeIO, "The folders are nested too deeply.")
			return "", nil
		}
		fi, err := os.Lstat(target)
		switch {
		case err == nil && !fi.IsDir():
			j.fail(rel, fileops.CodeExists, "A file of this name is in the way of the folder.")
			return "", nil
		case errors.Is(err, fs.ErrNotExist):
			if err := os.Mkdir(target, 0o755); err != nil {
				return "", m.remoteFailed(j, rel, err)
			}
		case err != nil:
			return "", m.remoteFailed(j, rel, err)
		}
		kids, err := listRemote(j, conn, path)
		if err != nil {
			return "", m.remoteFailed(j, rel, err)
		}
		for _, k := range kids {
			if k.Kind == remote.KindFile {
				j.update(func(s *Snapshot) { s.BytesTotal += k.Size })
			}
		}
		for _, k := range kids {
			if err := j.gate(j.ctx); err != nil {
				return "", err
			}
			if _, err := m.downloadEntry(j, remote.Join(path, k.Name), k, target, rel+"/"+k.Name, depth+1); err != nil {
				return "", err
			}
		}
		return e.Name, nil
	}
	// A file. A name that is taken is answered by the job's policy.
	name := e.Name
	if fi, err := os.Lstat(target); err == nil {
		src := ConflictSide{Size: e.Size, ModifiedMs: e.MtimeNs / int64(time.Millisecond)}
		d, err := m.remoteDecide(j, rel, src, side(0, fi))
		if err != nil {
			return "", err
		}
		switch d {
		case remoteSkip:
			j.update(func(s *Snapshot) { s.Skipped++; s.BytesTotal -= e.Size })
			return "", nil
		case remoteReplace:
			if fi.IsDir() {
				j.fail(rel, fileops.CodeExists, "A folder of this name is in the way of the file.")
				return "", nil
			}
		case remoteRenameExisting:
			if err := renameExistingAside(target); err != nil {
				return "", m.remoteFailed(j, rel, err)
			}
		case remoteKeepBoth:
			free, ok := fileops.UniqueName(e.Name, false, func(c string) bool { return exists(filepath.Join(dir, c)) })
			if !ok {
				j.fail(rel, fileops.CodeExists, "No free name was found.")
				return "", nil
			}
			name, target = free, filepath.Join(dir, free)
		}
	}
	if err := m.downloadFile(j, conn, path, e, dir, name); err != nil {
		return "", m.remoteFailed(j, rel, err)
	}
	return name, nil
}

// downloadFile writes one file through a partial file, renamed into place
// when all of it has arrived. A transfer that is cut off is taken up once
// where it stopped (or from the start, where the server cannot resume).
func (m *Manager) downloadFile(j *job, conn *remote.Conn, path string, e remote.Entry, dir, name string) error {
	partial := fileops.PartialName(dir, name)
	var have int64
	for attempt := 0; ; attempt++ {
		flags := os.O_WRONLY | os.O_CREATE
		if have == 0 {
			flags |= os.O_TRUNC
		}
		f, err := os.OpenFile(partial, flags, 0o644)
		if err != nil {
			return err
		}
		if _, err := f.Seek(have, io.SeekStart); err != nil {
			_ = f.Close()
			return err
		}
		cw := &counter{m: m, j: j, w: f}
		err = conn.Transfer(j.ctx, func(c remote.Client) error {
			if have > 0 && !c.Features().Resume {
				// From the start again: what was counted is taken back.
				if terr := f.Truncate(0); terr != nil {
					return terr
				}
				if _, serr := f.Seek(0, io.SeekStart); serr != nil {
					return serr
				}
				j.update(func(s *Snapshot) { s.BytesDone -= have })
				have = 0
			}
			return c.Retrieve(j.ctx, path, have, cw)
		})
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		have += cw.n
		if err == nil {
			break
		}
		if j.ctx.Err() != nil || attempt >= 1 || errors.Is(err, remote.ErrNotFound) || errors.Is(err, remote.ErrClosed) {
			_ = os.Remove(partial)
			if j.ctx.Err() != nil {
				return j.ctx.Err()
			}
			return err
		}
	}
	if e.MtimeNs > 0 {
		t := time.Unix(0, e.MtimeNs)
		_ = os.Chtimes(partial, t, t)
	}
	if err := os.Rename(partial, filepath.Join(dir, name)); err != nil {
		_ = os.Remove(partial)
		return err
	}
	return nil
}

// Upload ---------------------------------------------------------------------------------

func (m *Manager) upload(j *job, a *applier) (string, error) {
	r := j.spec.Remote
	defer r.Conn.Hold()()
	listing, err := m.remoteNames(j, r.Dir)
	if err != nil {
		if j.ctx.Err() != nil {
			return "", j.ctx.Err()
		}
		return "The folder on the server can't be read: " + remoteMessage(err), nil
	}
	defer r.changed(r.Dir)
	return "", m.eachTarget(j, func(t index.Target) error {
		fi, err := os.Lstat(t.Path)
		if err != nil {
			return m.itemFailed(j, t.Name, err)
		}
		failedBefore := j.failedCount()
		done, err := m.uploadEntry(j, t.Path, fi, r.Dir, listing, t.Name, 0)
		if err != nil {
			return err
		}
		if !done || j.failedCount() != failedBefore {
			return nil
		}
		j.update(func(s *Snapshot) { s.Done++ })
		if r.Move {
			// All of it is on the server, at the same sizes: the original goes.
			if err := os.RemoveAll(t.Path); err != nil {
				j.fail(t.Name, fileops.Code(err), "Uploaded, but not removed here: "+message(err))
				return nil
			}
			a.remove(t.ID)
			a.forget(t.Key)
			a.touch(t.ParentID, pathkey.DirKey(filepath.Dir(t.Path)))
			a.count()
		}
		return nil
	})
}

// remoteNames lists a folder of the server by name.
func (m *Manager) remoteNames(j *job, dir string) (map[string]remote.Entry, error) {
	entries, err := listRemote(j, j.spec.Remote.Conn, dir)
	if err != nil {
		return nil, err
	}
	out := make(map[string]remote.Entry, len(entries))
	for _, e := range entries {
		out[e.Name] = e
	}
	return out, nil
}

// uploadEntry copies one local file or folder into a folder of the server;
// existing lists that folder by name. done is false when the entry was
// skipped or failed (recorded).
func (m *Manager) uploadEntry(j *job, local string, fi fs.FileInfo, dir string, existing map[string]remote.Entry, rel string, depth int) (done bool, err error) {
	conn := j.spec.Remote.Conn
	name := fi.Name()
	if !remote.SafeName(name) {
		j.fail(rel, fileops.CodeInvalidName, "This name can't be used on the server.")
		return false, nil
	}
	switch {
	case fi.Mode()&fs.ModeSymlink != 0 || (!fi.IsDir() && !fi.Mode().IsRegular()):
		j.update(func(s *Snapshot) { s.Skipped++ })
		j.fail(rel, fileops.CodeSkippedLink, "Links and special files are not uploaded.")
		return false, nil
	case fi.IsDir():
		if depth >= maxRemoteDepth {
			j.fail(rel, fileops.CodeIO, "The folders are nested too deeply.")
			return false, nil
		}
		target := remote.Join(dir, name)
		if have, ok := existing[name]; ok && have.Kind != remote.KindDir {
			j.fail(rel, fileops.CodeExists, "A file of this name is in the way of the folder on the server.")
			return false, nil
		} else if !ok {
			if err := conn.Do(j.ctx, false, func(c remote.Client) error { return c.Mkdir(j.ctx, target) }); err != nil {
				return false, m.remoteFailed(j, rel, err)
			}
		}
		inside, err := m.remoteNames(j, target)
		if err != nil {
			return false, m.remoteFailed(j, rel, err)
		}
		ents, err := os.ReadDir(local)
		if err != nil {
			return false, m.itemFailed(j, rel, err)
		}
		all := true
		for _, e := range ents {
			if err := j.gate(j.ctx); err != nil {
				return false, err
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			ok, err := m.uploadEntry(j, filepath.Join(local, e.Name()), info, target, inside, rel+"/"+e.Name(), depth+1)
			if err != nil {
				return false, err
			}
			all = all && ok
		}
		return all, nil
	}
	// A file.
	j.update(func(s *Snapshot) { s.BytesTotal += fi.Size() })
	target := name
	if have, ok := existing[name]; ok {
		src := side(0, fi)
		dst := ConflictSide{Size: have.Size, ModifiedMs: have.MtimeNs / int64(time.Millisecond), IsDir: have.Kind == remote.KindDir}
		d, err := m.remoteDecide(j, rel, src, dst)
		if err != nil {
			return false, err
		}
		free := func() (string, bool) {
			return fileops.UniqueName(name, false, func(c string) bool { _, taken := existing[c]; return taken })
		}
		switch d {
		case remoteSkip:
			j.update(func(s *Snapshot) { s.Skipped++; s.BytesTotal -= fi.Size() })
			return false, nil
		case remoteReplace:
			if have.Kind == remote.KindDir {
				j.fail(rel, fileops.CodeExists, "A folder of this name is in the way of the file on the server.")
				return false, nil
			}
		case remoteRenameExisting:
			aside, ok := free()
			if !ok {
				j.fail(rel, fileops.CodeExists, "No free name was found on the server.")
				return false, nil
			}
			if err := conn.Do(j.ctx, false, func(c remote.Client) error {
				return c.Rename(j.ctx, remote.Join(dir, name), remote.Join(dir, aside))
			}); err != nil {
				return false, m.remoteFailed(j, rel, err)
			}
			existing[aside] = have
		case remoteKeepBoth:
			var ok bool
			if target, ok = free(); !ok {
				j.fail(rel, fileops.CodeExists, "No free name was found on the server.")
				return false, nil
			}
		}
	}
	if err := m.uploadFile(j, conn, local, fi.Size(), remote.Join(dir, target)); err != nil {
		return false, m.remoteFailed(j, rel, err)
	}
	existing[target] = remote.Entry{Name: target, Size: fi.Size(), MtimeNs: fi.ModTime().UnixNano()}
	return true, nil
}

// uploadFile sends one file. An upload that is cut off is taken up once
// from what the server says it has; then its size on the server is checked.
func (m *Manager) uploadFile(j *job, conn *remote.Conn, local string, size int64, path string) error {
	var offset int64
	for attempt := 0; ; attempt++ {
		f, err := os.Open(local)
		if err != nil {
			return err
		}
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			_ = f.Close()
			return err
		}
		cr := &counter{m: m, j: j, r: f}
		err = conn.Transfer(j.ctx, func(c remote.Client) error { return c.Store(j.ctx, path, offset, cr) })
		_ = f.Close()
		if err == nil {
			break
		}
		if j.ctx.Err() != nil {
			return j.ctx.Err()
		}
		if attempt >= 1 || errors.Is(err, remote.ErrClosed) || errors.Is(err, remote.ErrUnsafeName) {
			return err
		}
		// How much arrived? Resume there when the server can; else once more from the start.
		var have int64
		_ = conn.Do(j.ctx, true, func(c remote.Client) error {
			if n, serr := c.Size(j.ctx, path); serr == nil && c.Features().Resume && n <= size {
				have = n
			}
			return nil
		})
		sent := offset + cr.n
		j.update(func(s *Snapshot) { s.BytesDone -= sent - have })
		offset = have
	}
	// What the server holds is what was sent (a move relies on it).
	var onServer int64 = -1
	_ = conn.Do(j.ctx, true, func(c remote.Client) error {
		if n, serr := c.Size(j.ctx, path); serr == nil {
			onServer = n
		}
		return nil
	})
	if onServer >= 0 && onServer != size {
		return fileops.Errorf(fileops.CodeVerify, "the server holds %d of %d bytes", onServer, size)
	}
	return nil
}

// Delete on the server ------------------------------------------------------------------------

func (m *Manager) remoteDelete(j *job) error {
	r := j.spec.Remote
	defer r.Conn.Hold()()
	dirs := map[string]struct{}{}
	defer func() {
		for dir := range dirs {
			r.changed(dir)
		}
	}()
	for _, it := range r.Items {
		if err := j.gate(j.ctx); err != nil {
			return err
		}
		j.update(func(s *Snapshot) { s.Current = truncate(it.Name) })
		m.emit(j, false)
		dirs[remote.Parent(it.Path)] = struct{}{}
		if err := m.removeRemote(j, r.Conn, it.Path, it.Entry, 0); err != nil {
			if cerr := m.remoteFailed(j, it.Name, err); cerr != nil {
				return cerr
			}
			continue
		}
		j.update(func(s *Snapshot) { s.Done++ })
	}
	return nil
}

// removeRemote deletes a file, a link, or a folder with everything in it.
// A link is removed as a link: what it points at is never touched.
func (m *Manager) removeRemote(j *job, conn *remote.Conn, path string, e remote.Entry, depth int) error {
	if path == "/" || path == "" {
		return fileops.Errorf(fileops.CodeIO, "the root of a server is not deleted")
	}
	if e.Kind != remote.KindDir {
		return conn.Do(j.ctx, false, func(c remote.Client) error { return c.Delete(j.ctx, path) })
	}
	if depth >= maxRemoteDepth {
		return fileops.Errorf(fileops.CodeIO, "the folders are nested too deeply")
	}
	kids, err := listRemote(j, conn, path)
	if err != nil {
		return err
	}
	for _, k := range kids {
		if err := j.gate(j.ctx); err != nil {
			return err
		}
		if err := m.removeRemote(j, conn, remote.Join(path, k.Name), k, depth+1); err != nil {
			return err
		}
	}
	return conn.Do(j.ctx, false, func(c remote.Client) error { return c.Rmdir(j.ctx, path) })
}
