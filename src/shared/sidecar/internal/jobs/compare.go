package jobs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"panelyth/sidecar/internal/archive"
	"panelyth/sidecar/internal/checksum"
	"panelyth/sidecar/internal/compare"
	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/pathkey"
)

// Compare jobs (Stage C08, ADR-0029): synchronize two trees by a compare's
// plan, create and verify checksum files, and compare two files by content.
const (
	KindSync         Kind = "sync"
	KindHashCreate   Kind = "hashCreate"
	KindHashVerify   Kind = "hashVerify"
	KindCompareFiles Kind = "compareFiles"
)

// Item codes of these jobs (mirror src/shared/contracts JobItemErrorCode).
const (
	// CodeChanged: an entry is not as the compare saw it; a sync leaves it alone.
	CodeChanged = "CHANGED"
	// CodeDifferent: two files compared by content are not the same.
	CodeDifferent = "DIFFERENT"
	// CodeMismatch: a file's checksum is not the one its list has.
	CodeMismatch = "CHECKSUM_MISMATCH"
)

// SyncSpec is what a sync job applies.
type SyncSpec struct {
	// Plan holds the actions of the rows the synchronize dialog showed.
	Plan *compare.Plan
	// Permanent deletes instead of moving to the trash.
	Permanent bool
}

// HashSpec holds the checksum fields of a Spec.
type HashSpec struct {
	Algo checksum.Algo
	// PerFile writes one checksum file beside each file; otherwise one list
	// named Name goes to Spec.Destination, with paths relative to it.
	PerFile bool
	Name    string
}

func validateCompare(s Spec) error {
	switch s.Kind {
	case KindSync:
		if s.Sync == nil || s.Sync.Plan == nil {
			return fmt.Errorf("%w: a sync needs a plan", ErrInvalid)
		}
	case KindHashCreate:
		if !s.Hash.Algo.Valid() {
			return fmt.Errorf("%w: unknown checksum algorithm %q", ErrInvalid, s.Hash.Algo)
		}
		if s.Hash.PerFile {
			break
		}
		if s.Destination == "" {
			return fmt.Errorf("%w: a checksum list needs a folder", ErrInvalid)
		}
		if err := fileops.ValidateName(s.Hash.Name); err != nil {
			return fmt.Errorf("%w: %s", ErrInvalid, err.Error())
		}
	case KindCompareFiles:
		// Two files, or (Stage C10.5) files each compared with the file of
		// its name in the folder Destination.
		if s.Destination == "" && len(s.IDs) != 2 {
			return fmt.Errorf("%w: two files are compared", ErrInvalid)
		}
		if s.Destination != "" && len(s.IDs) == 0 {
			return fmt.Errorf("%w: nothing to compare", ErrInvalid)
		}
	}
	return nil
}

// total is the number of items a job starts with.
func (s Spec) total() int {
	switch {
	case s.Kind == KindSync && s.Sync != nil && s.Sync.Plan != nil:
		return len(s.Sync.Plan.Items)
	case s.Kind == KindCompareFiles && s.Destination == "":
		return 1
	case s.Kind == KindUndoRename:
		return len(s.undo)
	case (s.Kind == KindDownload || s.Kind == KindRemoteDelete) && s.Remote != nil:
		return len(s.Remote.Items)
	case s.Kind == KindEditSave:
		return editSaveSteps
	case s.Kind == KindUndoEdit:
		return len(s.created)
	}
	return len(s.IDs)
}

// dirCache finds the index rows of folders a job writes into, so what it
// creates and removes shows in open listings at once.
type dirCache struct {
	m    *Manager
	j    *job
	a    *applier
	dirs map[string]*index.DirInfo
}

func newDirCache(m *Manager, j *job, a *applier) *dirCache {
	return &dirCache{m: m, j: j, a: a, dirs: map[string]*index.DirInfo{}}
}

// dir returns the index row of a folder, or nil when it is not indexed.
func (c *dirCache) dir(path string) *index.DirInfo {
	if d, ok := c.dirs[path]; ok {
		return d
	}
	var out *index.DirInfo
	if d, err := c.m.deps.Store.DirByPath(c.j.ctx, path); err == nil {
		out = &d
	}
	c.dirs[path] = out
	return out
}

// added records a file or folder that was created or replaced.
func (c *dirCache) added(path string, isDir bool) {
	parent := c.dir(filepath.Dir(path))
	if parent == nil {
		return
	}
	name := filepath.Base(path)
	kind := media.KindDir
	if !isDir {
		var ok bool
		if kind, _, ok = media.Classify(name); !ok {
			kind = media.KindFile
		}
	}
	c.a.add(rowFor(*parent, index.Target{Kind: kind}, name, pathkey.ChildKey(parent.Key, name, isDir), path))
	c.a.touch(parent.ID, parent.Key)
	c.a.count()
}

// removed records a file or folder that is gone.
func (c *dirCache) removed(path string, isDir, permanent bool) {
	parentPath := filepath.Dir(path)
	key := pathkey.ChildKey(pathkey.DirKey(parentPath), filepath.Base(path), isDir)
	if id, err := c.m.deps.Store.IDByKey(c.j.ctx, key); err == nil && id > 0 {
		c.a.remove(id)
		if permanent {
			c.a.forget(key)
		}
	}
	if parent := c.dir(parentPath); parent != nil {
		c.a.touch(parent.ID, parent.Key)
	}
	c.a.count()
	delete(c.dirs, path)
}

// Sync ----------------------------------------------------------------------

// trashMany moves files to the trash; tests replace it.
var trashMany = fileops.TrashMany

var errChanged = fileops.Errorf(CodeChanged, "The item changed after the comparison, so it was left alone. Compare again.")

// unchanged reports whether path is still as the compare saw it: absent
// when side is nil, else a file of that size and date (a folder for isDir).
// A path that cannot be looked at counts as changed.
func unchanged(path string, side *compare.Side, isDir bool) bool {
	fi, err := os.Lstat(path)
	if side == nil {
		return errors.Is(err, fs.ErrNotExist)
	}
	switch {
	case err != nil:
		return false
	case isDir:
		return fi.IsDir()
	}
	return fi.Mode().IsRegular() && fi.Size() == side.Size && fi.ModTime().UnixNano() == side.MtimeNs
}

type syncer struct {
	m    *Manager
	j    *job
	plan *compare.Plan
	dirs *dirCache
	// made are the folders known to exist on the target sides.
	made map[string]bool
	// batch holds deletes on their way to the trash.
	batch []*compare.PlanItem
}

// sides returns an item's source and target (for a delete: the entry and
// where its counterpart would be).
func (s *syncer) sides(it *compare.PlanItem) (src, dst string, srcSide, dstSide *compare.Side, dstRoot string) {
	l, r := filepath.Join(s.plan.Left, it.Rel), filepath.Join(s.plan.Right, it.Rel)
	switch it.Action {
	case compare.ActionCopyLeft, compare.ActionDeleteRight:
		return r, l, it.Right, it.Left, s.plan.Left
	}
	return l, r, it.Left, it.Right, s.plan.Right
}

// sync applies a compare's plan: new folders and copies first, in the
// plan's order (a folder before what it holds), then the deletes, deepest
// first. Every entry is checked against what the compare saw right before
// it is touched; one that changed is reported and left alone.
func (m *Manager) sync(j *job, a *applier) (string, error) {
	spec := j.spec.Sync
	plan := spec.Plan
	for _, root := range []string{plan.Left, plan.Right} {
		if fi, err := os.Stat(root); err != nil || !fi.IsDir() {
			return "One of the two folders doesn't exist any more.", nil
		}
	}
	var total int64
	for i := range plan.Items {
		it := &plan.Items[i]
		switch {
		case it.IsDir:
		case it.Action == compare.ActionCopyRight && it.Left != nil:
			total += it.Left.Size
		case it.Action == compare.ActionCopyLeft && it.Right != nil:
			total += it.Right.Size
		}
	}
	j.update(func(s *Snapshot) { s.Total, s.BytesTotal = len(plan.Items), total })
	s := &syncer{m: m, j: j, plan: plan, dirs: newDirCache(m, j, a), made: map[string]bool{}}

	step := func(it *compare.PlanItem, fn func(*compare.PlanItem) error) error {
		if err := j.gate(j.ctx); err != nil { // pause point between items
			return err
		}
		j.update(func(s *Snapshot) { s.Current = truncate(filepath.Base(it.Rel)) })
		m.emit(j, false)
		if err := fn(it); err != nil {
			return m.itemFailed(j, it.Rel, err)
		}
		return nil
	}
	for i := range plan.Items {
		it := &plan.Items[i]
		if it.Action != compare.ActionCopyRight && it.Action != compare.ActionCopyLeft {
			continue
		}
		if err := step(it, s.copy); err != nil {
			return "", err
		}
	}
	for i := len(plan.Items) - 1; i >= 0; i-- {
		it := &plan.Items[i]
		if it.Action != compare.ActionDeleteRight && it.Action != compare.ActionDeleteLeft {
			continue
		}
		if err := step(it, s.remove); err != nil {
			return "", err
		}
	}
	return "", s.flush()
}

// mkdirs creates dir and its missing parents below a root.
func (s *syncer) mkdirs(dir string) error {
	if s.made[dir] {
		return nil
	}
	// The topmost folder that is new gets an index row.
	top := ""
	for p := dir; !s.made[p]; p = filepath.Dir(p) {
		if _, err := os.Lstat(p); err == nil || filepath.Dir(p) == p {
			break
		}
		top = p
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if top != "" {
		s.dirs.added(top, true)
	}
	s.made[dir] = true
	return nil
}

func (s *syncer) copy(it *compare.PlanItem) error {
	src, dst, srcSide, dstSide, dstRoot := s.sides(it)
	o := fileops.CopyOptions{Gate: s.j.gate, WindowsNames: fsx.WindowsNames(dstRoot), InFlight: 1}
	for _, part := range strings.Split(it.Rel, string(filepath.Separator)) {
		if err := o.ValidName(part); err != nil {
			return fileops.Errorf(fileops.CodeInvalidName, "%s", err.Error())
		}
	}
	if it.IsDir {
		// The folder itself; what it holds has items of its own.
		if !unchanged(src, srcSide, true) {
			return errChanged
		}
		if fi, err := os.Lstat(dst); err == nil && !fi.IsDir() {
			return errChanged
		}
		if err := s.mkdirs(dst); err != nil {
			return err
		}
		s.j.update(func(sn *Snapshot) { sn.Done++ })
		return nil
	}
	if !unchanged(src, srcSide, false) || !unchanged(dst, dstSide, false) {
		return errChanged
	}
	if err := s.mkdirs(filepath.Dir(dst)); err != nil {
		return err
	}
	var copied int64
	o.Progress = func(n int64) {
		copied += n
		s.j.update(func(sn *Snapshot) { sn.BytesDone += n })
		s.m.emit(s.j, false)
	}
	if err := fileops.CopyFile(s.j.ctx, src, dst, dstSide != nil, &o); err != nil {
		s.j.update(func(sn *Snapshot) { sn.BytesDone -= copied })
		return err
	}
	s.j.update(func(sn *Snapshot) {
		sn.Done++
		if copied == 0 && srcSide != nil { // a clone: no bytes reported
			sn.BytesDone += srcSide.Size
		}
	})
	s.dirs.added(dst, false)
	return nil
}

// remove deletes a one-sided entry: files go to the trash in batches (or
// are deleted with Permanent), a folder is removed only when it is empty.
func (s *syncer) remove(it *compare.PlanItem) error {
	path, other, side, _, _ := s.sides(it)
	// Still one-sided, and still the entry the table showed.
	if !unchanged(other, nil, false) || !unchanged(path, side, it.IsDir) {
		return errChanged
	}
	if it.IsDir {
		if err := s.flush(); err != nil { // its files leave first
			return err
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			if ents, rerr := os.ReadDir(path); rerr == nil && len(ents) > 0 {
				return fileops.Errorf(CodeChanged, "The folder is not empty, so it was kept.")
			}
			return err
		}
		s.done(it, path)
		return nil
	}
	if s.j.spec.Sync.Permanent {
		if err := fileops.Delete(path, false); err != nil && fileops.Code(err) != fileops.CodeNotFound {
			return err
		}
		s.done(it, path)
		return nil
	}
	s.batch = append(s.batch, it)
	if len(s.batch) >= trashBatch {
		return s.flush()
	}
	return nil
}

func (s *syncer) done(it *compare.PlanItem, path string) {
	s.j.update(func(sn *Snapshot) { sn.Done++ })
	s.dirs.removed(path, it.IsDir, s.j.spec.Sync.Permanent)
}

// flush moves the waiting deletes to the trash.
func (s *syncer) flush() error {
	if len(s.batch) == 0 {
		return nil
	}
	paths := make([]string, len(s.batch))
	for i, it := range s.batch {
		paths[i], _, _, _, _ = s.sides(it)
	}
	errs := trashMany(paths)
	batch := s.batch
	s.batch = nil
	for i, it := range batch {
		switch err := errs[i]; {
		case err == nil, fileops.Code(err) == fileops.CodeNotFound:
			s.done(it, paths[i])
		case fileops.Code(err) == fileops.CodeTrashUnavailable:
			s.j.fail(it.Rel, fileops.CodeTrashUnavailable, "This drive has no trash. Choose to delete permanently in the synchronize dialog.")
		default:
			if cerr := s.m.itemFailed(s.j, it.Rel, err); cerr != nil {
				return cerr
			}
		}
	}
	s.m.emit(s.j, false)
	return nil
}

// Checksums -------------------------------------------------------------------

type hashFile struct {
	path string
	// name is what errors call the file: its path below the marked entry.
	name string
	size int64
}

// hashFiles lists the files of the job's entries; folders are walked, links
// and special files are not hashed.
func (m *Manager) hashFiles(j *job) ([]hashFile, int64, error) {
	var files []hashFile
	var total int64
	err := m.eachTarget(j, func(t index.Target) error {
		switch t.Kind {
		case media.KindLink:
			j.update(func(s *Snapshot) { s.Skipped++ })
			return nil
		case media.KindDir:
		default:
			files = append(files, hashFile{path: t.Path, name: t.Name, size: t.Size})
			total += t.Size
			return nil
		}
		return filepath.WalkDir(t.Path, func(p string, d fs.DirEntry, werr error) error {
			if err := j.ctx.Err(); err != nil {
				return err
			}
			if werr != nil {
				rel, _ := filepath.Rel(filepath.Dir(t.Path), p)
				j.fail(rel, fileops.Code(werr), message(werr))
				if d != nil && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			// Types come from the directory read: a link is never entered.
			if !d.Type().IsRegular() {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			rel, _ := filepath.Rel(filepath.Dir(t.Path), p)
			files = append(files, hashFile{path: p, name: rel, size: info.Size()})
			total += info.Size()
			return nil
		})
	})
	return files, total, err
}

// writeChecksums writes a checksum file through a partial file; an existing
// one of that name is replaced.
func writeChecksums(path, text string) error {
	partial := fileops.PartialName(filepath.Dir(path), filepath.Base(path))
	if err := os.WriteFile(partial, []byte(text), 0o644); err != nil {
		fileops.RemovePartial(partial, false)
		return err
	}
	return fileops.CommitFile(partial, path, true)
}

// hashCreate writes checksum files: one beside each file, or one list for
// all of them in the job's folder.
func (m *Manager) hashCreate(j *job, a *applier) (string, error) {
	h := j.spec.Hash
	dest := j.spec.Destination
	listPath := ""
	if !h.PerFile {
		if fi, err := os.Stat(dest); err != nil || !fi.IsDir() {
			return "The folder for the checksum file doesn't exist any more.", nil
		}
		listPath = filepath.Join(dest, h.Name)
	}
	files, total, err := m.hashFiles(j)
	if err != nil {
		return "", err
	}
	j.update(func(s *Snapshot) { s.Total, s.BytesTotal = len(files)+s.Failed+s.Skipped, total })
	dirs := newDirCache(m, j, a)
	o := &checksum.Options{Gate: j.gate, Progress: func(n int64) {
		j.update(func(s *Snapshot) { s.BytesDone += n })
		m.emit(j, false)
	}}
	var list strings.Builder
	listed := 0
	for _, f := range files {
		if err := j.gate(j.ctx); err != nil {
			return "", err
		}
		// Checksum files of this kind are not hashed into themselves.
		if (h.PerFile && strings.EqualFold(filepath.Ext(f.path), h.Algo.Ext())) || (listPath != "" && pathkey.DirKey(f.path) == pathkey.DirKey(listPath)) {
			j.update(func(s *Snapshot) { s.Skipped++; s.BytesDone += f.size })
			continue
		}
		j.update(func(s *Snapshot) { s.Current = truncate(filepath.Base(f.path)) })
		m.emit(j, false)
		rel := filepath.Base(f.path)
		if !h.PerFile {
			if rel, err = filepath.Rel(dest, f.path); err != nil || !filepath.IsLocal(rel) {
				j.fail(f.name, fileops.CodeIO, "The file is outside the folder of the checksum list.")
				continue
			}
		}
		sum, err := checksum.File(j.ctx, f.path, h.Algo, o)
		if err == nil && h.PerFile {
			out := f.path + h.Algo.Ext()
			if err = writeChecksums(out, checksum.Header(h.Algo)+checksum.Line(h.Algo, sum, rel)); err == nil {
				dirs.added(out, false)
			}
		}
		if err != nil {
			if cerr := m.itemFailed(j, f.name, err); cerr != nil {
				return "", cerr
			}
			continue
		}
		if !h.PerFile {
			list.WriteString(checksum.Line(h.Algo, sum, filepath.ToSlash(rel)))
			listed++
		}
		j.update(func(s *Snapshot) { s.Done++ })
	}
	if listed > 0 {
		if err := writeChecksums(listPath, checksum.Header(h.Algo)+list.String()); err != nil {
			return "The checksum file could not be written: " + message(err), nil
		}
		dirs.added(listPath, false)
	}
	return "", nil
}

type hashEntry struct {
	algo checksum.Algo
	// name is the path as its list has it; path is "" when the list names a
	// file outside its folder.
	name, path, sum string
}

// hashVerify checks the files that checksum files list. Every listed file
// is an item: it matches, differs, is missing or cannot be read.
func (m *Manager) hashVerify(j *job) error {
	var entries []hashEntry
	var total int64
	lists := 0
	err := m.eachTarget(j, func(t index.Target) error {
		algo, ok := checksum.ByName(t.Name)
		if !ok || t.Kind == media.KindDir {
			j.fail(t.Name, archive.CodeCorrupt, "This is not a checksum file (.sha256, .sha1, .md5 or .sfv).")
			return nil
		}
		f, err := os.Open(t.Path)
		if err != nil {
			return m.itemFailed(j, t.Name, err)
		}
		parsed, err := checksum.Parse(f, algo)
		_ = f.Close()
		if errors.Is(err, checksum.ErrFormat) {
			j.fail(t.Name, archive.CodeCorrupt, "The checksum file can't be read: "+strings.TrimPrefix(err.Error(), checksum.ErrFormat.Error()+": ")+".")
			return nil
		}
		if err != nil {
			return m.itemFailed(j, t.Name, err)
		}
		lists++
		dir := filepath.Dir(t.Path)
		for _, e := range parsed {
			he := hashEntry{algo: algo, name: filepath.FromSlash(e.Path), sum: e.Sum}
			if p, ok := checksum.Resolve(dir, e.Path); ok {
				he.path = p
				if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() {
					total += fi.Size()
				}
			}
			entries = append(entries, he)
		}
		return nil
	})
	if err != nil {
		return err
	}
	j.update(func(s *Snapshot) { s.Total, s.BytesTotal = len(entries)+s.Failed, total })
	o := &checksum.Options{Gate: j.gate, Progress: func(n int64) {
		j.update(func(s *Snapshot) { s.BytesDone += n })
		m.emit(j, false)
	}}
	for _, e := range entries {
		if err := j.gate(j.ctx); err != nil {
			return err
		}
		j.update(func(s *Snapshot) { s.Current = truncate(filepath.Base(e.name)) })
		m.emit(j, false)
		if e.path == "" {
			j.fail(e.name, archive.CodeUnsafePath, "The list names a file outside its folder; it was not read.")
			continue
		}
		sum, err := checksum.File(j.ctx, e.path, e.algo, o)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			j.fail(e.name, fileops.CodeNotFound, "The file is missing.")
		case err != nil:
			if cerr := m.itemFailed(j, e.name, err); cerr != nil {
				return cerr
			}
		case !strings.EqualFold(sum, e.sum):
			j.fail(e.name, CodeMismatch, "The checksum doesn't match: the file was changed or is damaged.")
		default:
			j.update(func(s *Snapshot) { s.Done++ })
		}
	}
	return nil
}

// Compare by content -----------------------------------------------------------

// compareFiles reads two files side by side: done when they are the same,
// a DIFFERENT item when they are not.
func (m *Manager) compareFiles(j *job) error {
	if j.spec.Destination != "" {
		return m.compareWithFolder(j)
	}
	targets, err := m.deps.Store.Targets(j.ctx, j.spec.IDs)
	if err != nil {
		return err
	}
	if len(targets) != 2 {
		j.fail("", fileops.CodeNotFound, "One of the two files no longer exists.")
		return nil
	}
	l, r := targets[0], targets[1]
	name := l.Name
	if r.Name != l.Name {
		name = l.Name + " / " + r.Name
	}
	j.update(func(s *Snapshot) { s.Current = truncate(name) })
	sizes := [2]int64{}
	for i, t := range targets {
		fi, err := os.Stat(t.Path)
		if err != nil {
			return m.itemFailed(j, t.Name, err)
		}
		if !fi.Mode().IsRegular() {
			j.fail(t.Name, fileops.CodeIO, "Only files can be compared by content.")
			return nil
		}
		sizes[i] = fi.Size()
	}
	if sizes[0] != sizes[1] {
		j.fail(name, CodeDifferent, fmt.Sprintf("The files differ in size: %d and %d bytes.", sizes[0], sizes[1]))
		return nil
	}
	j.update(func(s *Snapshot) { s.BytesTotal = sizes[0] })
	equal, at, err := compare.EqualFiles(j.ctx, l.Path, r.Path, &compare.StreamOptions{Gate: j.gate, Progress: func(n int64) {
		j.update(func(s *Snapshot) { s.BytesDone += n })
		m.emit(j, false)
	}})
	switch {
	case err != nil:
		return m.itemFailed(j, name, err)
	case !equal:
		j.fail(name, CodeDifferent, fmt.Sprintf("The files have the same size but differ; the first difference is at byte %d.", at))
	default:
		j.update(func(s *Snapshot) { s.Done++ })
	}
	return nil
}

// compareWithFolder compares each file with the file of its name in another
// folder (Stage C10.5): done when the two are the same, a DIFFERENT item
// when they are not, NOT_FOUND when the other folder has no such file.
// Folders and links are skipped. One file is read at a time, with the two
// pooled buffers of a comparison of two files.
func (m *Manager) compareWithFolder(j *job) error {
	other := j.spec.Destination
	o := &compare.StreamOptions{Gate: j.gate, Progress: func(n int64) {
		j.update(func(s *Snapshot) { s.BytesDone += n })
		m.emit(j, false)
	}}
	return m.eachTarget(j, func(t index.Target) error {
		lfi, err := os.Lstat(t.Path)
		if err != nil {
			return m.itemFailed(j, t.Name, err)
		}
		if !lfi.Mode().IsRegular() {
			j.update(func(s *Snapshot) { s.Skipped++ })
			return nil
		}
		right := filepath.Join(other, t.Name)
		rfi, err := os.Stat(right)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			j.fail(t.Name, fileops.CodeNotFound, "The other folder has no file of this name.")
			return nil
		case err != nil:
			return m.itemFailed(j, t.Name, err)
		case !rfi.Mode().IsRegular():
			j.fail(t.Name, fileops.CodeNotFound, "The other folder has a folder of this name, not a file.")
			return nil
		case os.SameFile(lfi, rfi):
			// Both panels show one folder: a file is the same as itself.
			j.update(func(s *Snapshot) { s.Done++ })
			return nil
		case lfi.Size() != rfi.Size():
			j.fail(t.Name, CodeDifferent, fmt.Sprintf("The files differ in size: %d and %d bytes.", lfi.Size(), rfi.Size()))
			return nil
		}
		equal, at, err := compare.EqualFiles(j.ctx, t.Path, right, o)
		switch {
		case err != nil:
			return m.itemFailed(j, t.Name, err)
		case !equal:
			j.fail(t.Name, CodeDifferent, fmt.Sprintf("The files have the same size but differ; the first difference is at byte %d.", at))
		default:
			j.update(func(s *Snapshot) { s.Done++ })
		}
		return nil
	})
}

// syncLane is a sync's lane: the volumes of its two roots.
func syncLane(s Spec) (string, bool) {
	if s.Kind != KindSync || s.Sync == nil || s.Sync.Plan == nil {
		return "", false
	}
	return fsx.VolumeID(s.Sync.Plan.Left) + ">" + fsx.VolumeID(s.Sync.Plan.Right), true
}
