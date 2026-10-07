package jobs

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"time"

	"fastview/sidecar/internal/fileops"
	"fastview/sidecar/internal/fsx"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/library"
	"fastview/sidecar/internal/media"
	"fastview/sidecar/internal/pathkey"
	"fastview/sidecar/internal/scan"
)

// ErrInvalid wraps spec validation failures.
var ErrInvalid = errors.New("jobs: invalid job")

func validate(s Spec) error {
	switch s.Kind {
	case KindCopy, KindMove:
		if s.Destination == "" {
			return fmt.Errorf("%w: destination is required", ErrInvalid)
		}
		if !slices.Contains(policies, s.Conflict) {
			return fmt.Errorf("%w: unknown conflict policy %q", ErrInvalid, s.Conflict)
		}
		if s.Name != "" {
			if len(s.IDs) != 1 {
				return fmt.Errorf("%w: a new name needs exactly one item", ErrInvalid)
			}
			if err := fileops.ValidateName(s.Name); err != nil {
				return fmt.Errorf("%w: %s", ErrInvalid, err.Error())
			}
		}
		if len(s.Mask) > index.MaxMaskLen {
			return fmt.Errorf("%w: the mask is too long", ErrInvalid)
		}
	case KindExtract, KindPack, KindTestArchive:
		return validateArchive(s)
	case KindTrash, KindDelete, KindFavorite, KindDirSize:
	case KindRename:
		if _, err := ParsePattern(s.Pattern); err != nil {
			return fmt.Errorf("%w: the pattern needs {name} or {n} and only those tokens", ErrInvalid)
		}
		if s.Start < 0 || s.Start > 1_000_000_000 {
			return fmt.Errorf("%w: start number out of range", ErrInvalid)
		}
	case KindRating:
		if s.Rating < 0 || s.Rating > library.MaxRating {
			return fmt.Errorf("%w: rating must be 0..5", ErrInvalid)
		}
	case KindLabel:
		if s.Label < 0 || s.Label > library.MaxLabel {
			return fmt.Errorf("%w: label must be 0..7", ErrInvalid)
		}
	case KindTag:
		if _, err := library.CleanTag(s.Tag); err != nil {
			return fmt.Errorf("%w: tags are 1..64 characters", ErrInvalid)
		}
	default:
		return fmt.Errorf("%w: unknown kind %q", ErrInvalid, s.Kind)
	}
	return nil
}

func baseName(p string) string {
	if p == "" {
		return ""
	}
	return filepath.Base(p)
}

func removePartials(dir string) int { return fileops.RemovePartials(dir) }

// targetChunk bounds how many entries are resolved at once.
const targetChunk = 1000

// eachTarget resolves ids chunk by chunk and calls fn per entry. Ids that
// left the index since the selection was made fail as NOT_FOUND.
func (m *Manager) eachTarget(j *job, fn func(t index.Target) error) error {
	ids := j.spec.IDs
	for lo := 0; lo < len(ids); lo += targetChunk {
		if err := j.ctx.Err(); err != nil {
			return err
		}
		chunk := ids[lo:min(lo+targetChunk, len(ids))]
		targets, err := m.deps.Store.Targets(j.ctx, chunk)
		if err != nil {
			return err
		}
		for i := len(targets); i < len(chunk); i++ {
			j.fail("", fileops.CodeNotFound, "An item was removed before the job reached it.")
		}
		for _, t := range targets {
			if err := j.gate(j.ctx); err != nil { // pause point between items
				return err
			}
			j.update(func(s *Snapshot) { s.Current = truncate(t.Name) })
			m.emit(j, false)
			if err := fn(t); err != nil {
				return err
			}
		}
	}
	return nil
}

func truncate(s string) string {
	if len(s) <= maxCurrentBytes {
		return s
	}
	return s[:maxCurrentBytes]
}

// execute runs the job to its end state.
func (m *Manager) execute(j *job) (State, string) {
	a := &applier{m: m, j: j, dirs: map[int64]string{}, last: time.Now()}
	var err error
	var msg string
	switch j.spec.Kind {
	case KindCopy, KindMove:
		msg, err = m.transfer(j, a)
	case KindDelete:
		err = m.eachTarget(j, func(t index.Target) error {
			return m.removeOne(j, a, t, fileops.Delete(t.Path, t.Kind == media.KindDir))
		})
	case KindTrash:
		err = m.trash(j, a)
	case KindRename:
		err = m.rename(j, a)
	case KindFavorite, KindRating, KindTag, KindLabel:
		msg, err = m.annotate(j, a)
	case KindDirSize:
		err = m.dirSizes(j)
	case KindExtract:
		msg, err = m.extract(j, a)
	case KindPack:
		msg, err = m.pack(j, a)
	case KindTestArchive:
		err = m.testArchives(j)
	}
	a.flush()
	switch {
	case msg != "":
		return StateFailed, msg
	case errors.Is(err, context.Canceled):
		return StateCancelled, ""
	case err != nil:
		m.deps.Log.Warn("job failed", "jobId", j.snap.JobID, "err", err)
		return StateFailed, "Something went wrong: " + err.Error()
	}
	return StateCompleted, ""
}

func (m *Manager) library(ctx context.Context) *library.Library {
	if m.deps.Library == nil {
		return nil
	}
	lib, err := m.deps.Library(ctx)
	if err != nil {
		return nil
	}
	return lib
}

// itemFailed records err for t unless the job was cancelled (cancellation
// stops the job without blaming the item).
func (m *Manager) itemFailed(j *job, name string, err error) error {
	if j.ctx.Err() != nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)) {
		return context.Canceled
	}
	j.fail(name, fileops.Code(err), message(err))
	return nil
}

func message(err error) string {
	switch fileops.Code(err) {
	case fileops.CodeNotFound:
		return "The item no longer exists."
	case fileops.CodePermission:
		return "FastView doesn't have permission to change this item."
	case fileops.CodeExists:
		return "An item with this name already exists."
	case fileops.CodeNoSpace:
		return "There isn't enough space on the destination drive."
	case fileops.CodeInUse:
		return "The item is open in another program."
	case fileops.CodeTrashUnavailable:
		return "This drive has no trash. Delete permanently instead (Shift+Delete)."
	case fileops.CodeVerify:
		return "The copy differs from the original (verification failed); it was removed."
	}
	var e *fileops.Error
	if errors.As(err, &e) {
		return e.Err.Error()
	}
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err.Error()
	}
	var le *os.LinkError
	if errors.As(err, &le) {
		return le.Err.Error()
	}
	return err.Error()
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func extOf(name string, isDir bool) string {
	if isDir {
		return ""
	}
	return media.Ext(name)
}

// rowFor builds the index row of a fresh copy (stat of the new item).
func rowFor(dest index.DirInfo, t index.Target, name, key, path string) index.Row {
	r := index.Row{ParentID: dest.ID, ParentKey: dest.Key, Kind: t.Kind, Name: name, PathKey: key,
		Ext: extOf(name, t.Kind == media.KindDir), Path: path}
	if fi, err := os.Stat(path); err == nil {
		r.MtimeNs = fi.ModTime().UnixNano()
		r.BtimeNs = fsx.FileTimes(fi).BirthNs
		if !fi.IsDir() {
			r.Size = fi.Size()
		}
	}
	return r
}

// removeOne trashes or deletes one target. An item that is already gone
// counts as removed: the goal is reached and its row must go.
func (m *Manager) removeOne(j *job, a *applier, t index.Target, err error) error {
	if err != nil && fileops.Code(err) != fileops.CodeNotFound {
		return m.itemFailed(j, t.Name, err)
	}
	j.update(func(s *Snapshot) { s.Done++; s.BytesDone += t.Size })
	a.remove(t.ID)
	if j.spec.Kind == KindDelete {
		a.forget(t.Key)
	}
	a.touch(t.ParentID, pathkey.DirKey(filepath.Dir(t.Path)))
	a.count()
	return nil
}

// trashBatch is how many items one Recycle Bin call takes (Stage P03).
const trashBatch = 200

// trash moves the targets to the trash in batches; each item still gets its
// own result.
func (m *Manager) trash(j *job, a *applier) error {
	var batch []index.Target
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		paths := make([]string, len(batch))
		for i, t := range batch {
			paths[i] = t.Path
		}
		errs := fileops.TrashMany(paths)
		for i, t := range batch {
			if err := m.removeOne(j, a, t, errs[i]); err != nil {
				return err
			}
		}
		batch = batch[:0]
		m.emit(j, false)
		return j.gate(j.ctx)
	}
	err := m.eachTarget(j, func(t index.Target) error {
		batch = append(batch, t)
		if len(batch) >= trashBatch {
			return flush()
		}
		return nil
	})
	if err == nil {
		err = flush()
	}
	return err
}

type renameItem struct {
	t       index.Target
	newName string
	origKey string // key of the current name (collision detection)
}

// rename applies a pattern. Items are renamed in selection order; an item
// whose new name is still taken by another selected item waits for it, and
// what remains after a pass without progress (a cycle, such as swapping two
// names) fails rather than using hidden temporary names.
func (m *Manager) rename(j *job, a *applier) error {
	p, _ := ParsePattern(j.spec.Pattern)
	var pending []renameItem
	waiting := map[string]bool{}
	n := j.spec.Start
	err := m.eachTarget(j, func(t index.Target) error {
		isDir := t.Kind == media.KindDir
		newName := p.Apply(t.Name, isDir, n)
		n++
		if err := fileops.ValidateName(newName); err != nil {
			j.fail(t.Name, fileops.CodeInvalidName, err.Error())
			return nil
		}
		parentKey := pathkey.DirKey(filepath.Dir(t.Path))
		it := renameItem{t: t, newName: newName, origKey: pathkey.ChildKey(parentKey, t.Name, isDir)}
		pending = append(pending, it)
		waiting[it.origKey] = true
		return nil
	})
	if err != nil {
		return err
	}
	lib := m.library(j.ctx)
	for len(pending) > 0 {
		progressed := false
		var next []renameItem
		for _, it := range pending {
			if err := j.ctx.Err(); err != nil {
				return err
			}
			isDir := it.t.Kind == media.KindDir
			dir := filepath.Dir(it.t.Path)
			parentKey := pathkey.DirKey(dir)
			newKey := pathkey.ChildKey(parentKey, it.newName, isDir)
			if newKey != it.origKey && waiting[newKey] && exists(filepath.Join(dir, it.newName)) {
				next = append(next, it) // its name is still held by another selected item
				continue
			}
			progressed = true
			delete(waiting, it.origKey)
			j.update(func(s *Snapshot) { s.Current = truncate(it.t.Name) })
			m.emit(j, false)
			if it.newName == it.t.Name {
				j.update(func(s *Snapshot) { s.Skipped++ })
				continue
			}
			newPath, err := fileops.Rename(it.t.Path, it.newName)
			if err != nil {
				if cerr := m.itemFailed(j, it.t.Name, err); cerr != nil {
					return cerr
				}
				continue
			}
			j.update(func(s *Snapshot) { s.Done++ })
			if lib != nil {
				if err := lib.Rekey(context.WithoutCancel(j.ctx), it.t.Key, newKey); err != nil {
					m.deps.Log.Warn("rename user metadata", "err", err)
				}
			}
			a.move(index.Moved{ID: it.t.ID, ParentID: it.t.ParentID, Kind: it.t.Kind, Name: it.newName,
				Ext: extOf(it.newName, isDir), OldKey: it.t.Key, NewKey: newKey, OldPath: it.t.Path, NewPath: newPath})
			a.touch(it.t.ParentID, parentKey)
			a.count()
		}
		if !progressed {
			for _, it := range next {
				j.fail(it.t.Name, fileops.CodeExists, "The new name is taken by another selected item.")
			}
			break
		}
		pending = next
	}
	return nil
}

// annotate applies a favorite, rating or tag change to the selected files
// (folders carry no user metadata and are skipped).
func (m *Manager) annotate(j *job, a *applier) (string, error) {
	lib, err := m.deps.Library(j.ctx)
	if err != nil || lib == nil {
		return "The library database is unavailable, so favorites, ratings, labels and tags can't be changed.", nil
	}
	var keys []string
	flush := func() error {
		if len(keys) == 0 {
			return nil
		}
		done := func(n int) {
			j.update(func(s *Snapshot) { s.Done += n })
			m.emit(j, false)
		}
		var err error
		switch j.spec.Kind {
		case KindFavorite:
			err = lib.SetFavorite(j.ctx, keys, j.spec.Favorite, done)
		case KindRating:
			err = lib.SetRating(j.ctx, keys, j.spec.Rating, done)
		case KindTag:
			err = lib.SetTag(j.ctx, keys, j.spec.Tag, j.spec.Add, done)
		case KindLabel:
			err = lib.SetLabel(j.ctx, keys, j.spec.Label, done)
		}
		keys = keys[:0]
		return err
	}
	err = m.eachTarget(j, func(t index.Target) error {
		if t.Kind == media.KindDir {
			j.update(func(s *Snapshot) { s.Skipped++ })
			return nil
		}
		keys = append(keys, t.Key)
		a.touch(t.ParentID, pathkey.DirKey(filepath.Dir(t.Path)))
		if len(keys) >= library.ChunkSize {
			return flush()
		}
		return nil
	})
	if err == nil {
		err = flush()
	}
	if errors.Is(err, library.ErrTooManyTags) {
		return "There are too many tags. Remove unused tags first.", nil
	}
	return "", err
}

// applier batches index edits and session notifications of one job. It
// flushes every flushEvery or flushItems, and always at the end, with a
// context that ignores the job's cancellation: what was done on disk must
// reach the index.
type applier struct {
	m       *Manager
	j       *job
	changes index.Changes
	added   []index.Row
	forgets []string
	dirs    map[int64]string
	pending int
	last    time.Time
}

func (a *applier) remove(id int64)     { a.changes.Removed = append(a.changes.Removed, id) }
func (a *applier) move(mv index.Moved) { a.changes.Moved = append(a.changes.Moved, mv) }
func (a *applier) add(r index.Row)     { a.added = append(a.added, r) }
func (a *applier) forget(key string)   { a.forgets = append(a.forgets, key) }
func (a *applier) touch(id int64, k string) {
	if id > 0 {
		a.dirs[id] = k
	}
}

// count notes one applied item and flushes when a batch is due.
func (a *applier) count() {
	a.pending++
	if a.pending >= flushItems || time.Since(a.last) >= flushEvery {
		a.flush()
	}
}

func (a *applier) flush() {
	ctx := context.WithoutCancel(a.j.ctx)
	store := a.m.deps.Store
	if err := store.ApplyChanges(ctx, a.changes); err != nil {
		a.m.deps.Log.Warn("apply job changes to the index", "err", err)
	}
	if len(a.added) > 0 {
		if _, err := store.Commit(ctx, store.NextGeneration(), a.added, nil); err != nil {
			a.m.deps.Log.Warn("index copied items", "err", err)
		}
	}
	if len(a.forgets) > 0 {
		if lib := a.m.library(ctx); lib != nil {
			if err := lib.Forget(ctx, a.forgets); err != nil {
				a.m.deps.Log.Warn("forget user metadata", "err", err)
			}
		}
	}
	if len(a.dirs) > 0 && a.m.deps.Changed != nil {
		changes := make([]scan.Change, 0, len(a.dirs))
		for id, k := range a.dirs {
			changes = append(changes, scan.Change{DirID: id, DirKey: k})
		}
		a.m.deps.Changed(changes)
	}
	a.changes, a.added, a.forgets, a.dirs = index.Changes{}, nil, nil, map[int64]string{}
	a.pending, a.last = 0, time.Now()
}
