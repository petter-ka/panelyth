package jobs

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/library"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/pathkey"
)

// Copy and move (ADR-0021, ADR-0029). Each item is planned on the job's
// goroutine (conflicts are decided there, asking the user when the policy
// is "ask"); small files of a copy are then written by up to InFlight
// workers. Index and library changes are applied on the job's goroutine
// only, from the workers' results.

// plan is what happens to one item.
type plan struct {
	name  string // the name in the destination
	skip  bool
	merge bool // a folder onto an existing folder
	// replace overwrites an existing file of that name.
	replace bool
}

// itemResult is a finished item, applied on the job's goroutine.
type itemResult struct {
	t      index.Target
	plan   plan
	target string
	bytes  int64 // reported by this item (taken back if it failed)
	err    error
}

type transfer struct {
	m       *Manager
	j       *job
	a       *applier
	dest    string
	destKey string
	destDir index.DirInfo
	indexed bool
	lib     *library.Library
	base    fileops.CopyOptions
	mask    *index.Mask // the dialog's file mask, or nil

	results chan itemResult
	sem     chan struct{}
	wg      sync.WaitGroup
}

func (m *Manager) transfer(j *job, a *applier) (string, error) {
	dest := j.spec.Destination
	if fi, err := os.Stat(dest); err != nil || !fi.IsDir() {
		return "The destination folder doesn't exist any more.", nil
	}
	tr := &transfer{m: m, j: j, a: a, dest: dest, destKey: pathkey.DirKey(dest), lib: m.library(j.ctx)}
	if d, err := m.deps.Store.DirByPath(j.ctx, dest); err == nil {
		tr.destDir, tr.indexed = d, true
	}
	if sum, err := m.deps.Store.Summarize(j.ctx, j.spec.IDs); err == nil {
		j.update(func(s *Snapshot) { s.BytesTotal = sum.Bytes })
	}
	links := fileops.LinksSkip
	if j.spec.CopyLinks {
		links = fileops.LinksCopy
	}
	if j.spec.Mask != "" {
		if m := index.ParseMask(j.spec.Mask); len(m.Include) > 0 || len(m.Exclude) > 0 {
			tr.mask = &m
		}
	}
	tr.base = fileops.CopyOptions{
		Include:      tr.included,
		Gate:         j.gate,
		Verify:       j.spec.Verify,
		Links:        links,
		WindowsNames: fsx.WindowsNames(dest),
		InFlight:     1,
		Conflict:     tr.mergeDecision,
	}
	inFlight := 1
	if j.spec.Kind == KindCopy {
		if paths, err := m.deps.Store.EntryPaths(j.ctx, j.spec.IDs[:min(1, len(j.spec.IDs))]); err == nil && len(paths) > 0 {
			inFlight = inFlightFor(paths[0].Path, dest)
		}
		tr.base.InFlight = inFlight
	}
	tr.results = make(chan itemResult, inFlight)
	tr.sem = make(chan struct{}, inFlight)

	err := m.eachTarget(j, func(t index.Target) error {
		tr.drain(false)
		return tr.item(t)
	})
	tr.drain(true)
	return "", err
}

// item plans one target and runs it inline or on a worker.
func (tr *transfer) item(t index.Target) error {
	j := tr.j
	isDir := t.Kind == media.KindDir
	sameFolder := pathkey.DirKey(filepath.Dir(t.Path)) == tr.destKey
	if isDir && fileops.IsWithin(tr.dest, t.Path) {
		j.fail(t.Name, fileops.CodeIntoItself, "A folder can't be copied or moved into itself.")
		return nil
	}
	if j.spec.Kind == KindMove && sameFolder {
		j.update(func(s *Snapshot) { s.Skipped++; s.BytesDone += t.Size })
		return nil
	}
	if !isDir && !tr.included(t.Name) {
		j.update(func(s *Snapshot) { s.Skipped++; s.BytesDone += t.Size })
		return nil
	}
	if j.spec.Kind == KindCopy && t.Kind == media.KindLink && !j.spec.CopyLinks {
		j.fail(t.Name, fileops.CodeSkippedLink, "Links and special files are not copied.")
		return nil
	}
	p, err := tr.plan(t, sameFolder)
	if err != nil {
		return tr.m.itemFailed(j, t.Name, err)
	}
	if p.skip {
		j.update(func(s *Snapshot) { s.Skipped++; s.BytesDone += t.Size })
		return nil
	}
	if j.spec.Kind == KindMove && isDir && tr.mask != nil && !p.merge {
		p.merge = true // only the matching files move; the rest stay in the source folder
	}
	if err := tr.base.ValidName(p.name); err != nil {
		j.fail(t.Name, fileops.CodeInvalidName, err.Error())
		return nil
	}
	small := j.spec.Kind == KindCopy && t.Kind != media.KindDir && t.Kind != media.KindLink &&
		!p.merge && t.Size < fileops.SmallFile && cap(tr.sem) > 1
	if !small {
		tr.drain(true) // large items wait for the small ones in flight (bounded memory)
		return tr.finish(tr.run(t, p))
	}
	tr.sem <- struct{}{}
	tr.wg.Add(1)
	go func() {
		defer func() { <-tr.sem; tr.wg.Done() }()
		tr.results <- tr.run(t, p)
	}()
	return nil
}

// drain applies finished worker results (all of them when wait is set).
func (tr *transfer) drain(wait bool) {
	if wait {
		done := make(chan struct{})
		go func() { tr.wg.Wait(); close(done) }()
		for {
			select {
			case r := <-tr.results:
				_ = tr.finish(r)
			case <-done:
				for {
					select {
					case r := <-tr.results:
						_ = tr.finish(r)
					default:
						return
					}
				}
			}
		}
	}
	for {
		select {
		case r := <-tr.results:
			_ = tr.finish(r)
		default:
			return
		}
	}
}

// run copies or moves one item (any goroutine).
func (tr *transfer) run(t index.Target, p plan) itemResult {
	j := tr.j
	isDir := t.Kind == media.KindDir
	target := filepath.Join(tr.dest, p.name)
	var bytes atomic.Int64
	o := tr.base
	o.Progress = func(n int64) {
		bytes.Add(n)
		j.update(func(s *Snapshot) { s.BytesDone += n })
		tr.m.emit(j, false)
	}
	o.Skipped = func(path string) {
		rel, _ := filepath.Rel(filepath.Dir(t.Path), path)
		j.fail(rel, fileops.CodeSkippedLink, "Links and special files are not copied.")
	}
	var err error
	switch {
	case p.merge && j.spec.Kind == KindCopy:
		err = fileops.MergeCopy(j.ctx, t.Path, target, &o)
	case p.merge:
		if _, serr := os.Lstat(target); errors.Is(serr, fs.ErrNotExist) {
			err = os.Mkdir(target, 0o755) // a masked move into a new folder
		}
		if err == nil {
			err = fileops.MergeMove(j.ctx, t.Path, target, &o)
		}
	case j.spec.Kind == KindMove:
		err = fileops.Move(j.ctx, t.Path, target, isDir, p.replace, &o)
	case t.Kind == media.KindLink:
		if p.replace {
			_ = fileops.Delete(target, false)
		}
		err = fileops.CopyLink(t.Path, target)
	case isDir:
		if size, serr := fileops.TreeSize(j.ctx, t.Path); serr == nil {
			j.update(func(s *Snapshot) { s.BytesTotal += size })
		}
		err = fileops.CopyTree(j.ctx, t.Path, target, &o)
	default:
		err = fileops.CopyFile(j.ctx, t.Path, target, p.replace, &o)
	}
	return itemResult{t: t, plan: p, target: target, bytes: bytes.Load(), err: err}
}

// finish records a finished item and its index and library changes (the
// job's goroutine only).
func (tr *transfer) finish(r itemResult) error {
	j, t, a := tr.j, r.t, tr.a
	isDir := t.Kind == media.KindDir
	if r.err != nil {
		// Bytes of a failed item don't count as done.
		j.update(func(s *Snapshot) { s.BytesDone -= r.bytes })
		if r.plan.merge {
			a.touch(tr.destDir.ID, tr.destKey) // what was merged before the failure
		}
		return tr.m.itemFailed(j, t.Name, r.err)
	}
	j.update(func(s *Snapshot) {
		s.Done++
		if r.bytes == 0 && !isDir { // same-volume move or clone: no bytes copied
			s.BytesDone += t.Size
		}
	})
	srcKey := pathkey.DirKey(filepath.Dir(t.Path))
	newKey := pathkey.ChildKey(tr.destKey, r.plan.name, isDir)
	if j.spec.Kind == KindCopy {
		if tr.indexed {
			if !r.plan.merge {
				a.add(rowFor(tr.destDir, t, r.plan.name, newKey, r.target))
			}
			a.touch(tr.destDir.ID, tr.destDir.Key)
			a.count()
		}
		return nil
	}
	if r.plan.merge {
		// The contents joined an existing folder: the source folder's rows go
		// (if it is gone), the destination is listed again when shown.
		if _, err := os.Lstat(t.Path); errors.Is(err, fs.ErrNotExist) {
			if tr.lib != nil {
				if err := tr.lib.Rekey(context.WithoutCancel(j.ctx), t.Key, newKey); err != nil {
					tr.m.deps.Log.Warn("move user metadata", "err", err)
				}
			}
			a.remove(t.ID)
		}
		a.touch(tr.destDir.ID, tr.destKey)
		a.touch(t.ParentID, srcKey)
		a.count()
		return nil
	}
	if tr.lib != nil {
		if err := tr.lib.Rekey(context.WithoutCancel(j.ctx), t.Key, newKey); err != nil {
			tr.m.deps.Log.Warn("move user metadata", "err", err)
		}
	}
	if tr.indexed {
		a.move(index.Moved{ID: t.ID, ParentID: tr.destDir.ID, Kind: t.Kind, Name: r.plan.name, Ext: extOf(r.plan.name, isDir),
			OldKey: t.Key, NewKey: newKey, OldPath: t.Path, NewPath: r.target})
		a.touch(tr.destDir.ID, tr.destDir.Key)
	} else {
		a.remove(t.ID)
	}
	a.touch(t.ParentID, srcKey)
	a.count()
	return nil
}

// included applies the job's file mask to a name.
func (tr *transfer) included(name string) bool {
	return tr.mask == nil || index.MatchMask(*tr.mask, index.FoldName(name))
}

// nameOf is the item's name in the destination: its own, or the job's new
// name for a single item (Shift+F5).
func (tr *transfer) nameOf(t index.Target) string {
	if tr.j.spec.Name != "" {
		return tr.j.spec.Name
	}
	return t.Name
}

// plan decides what happens to t when its name is taken in the destination
// (ADR-0029 policies; "ask" asks the user, the answer may apply to all).
func (tr *transfer) plan(t index.Target, sameFolder bool) (plan, error) {
	j := tr.j
	isDir := t.Kind == media.KindDir
	name := tr.nameOf(t)
	existing := filepath.Join(tr.dest, name)
	di, err := os.Lstat(existing)
	if errors.Is(err, fs.ErrNotExist) {
		return plan{name: name}, nil
	}
	if err != nil {
		return plan{}, err
	}
	policy := j.currentPolicy()
	if j.spec.Kind == KindCopy && sameFolder && j.spec.Name == "" {
		policy = ConflictKeepBoth // pasting into the source folder duplicates
	}
	if policy == ConflictAsk {
		si, serr := os.Lstat(t.Path)
		if serr != nil {
			return plan{}, serr
		}
		c := Conflict{Name: name, Source: side(t.ID, si), Target: side(tr.existingID(name, di.IsDir()), di)}
		if policy, err = tr.m.ask(j, c); err != nil {
			return plan{}, err
		}
	}
	bothDirs := isDir && di.IsDir()
	mismatch := isDir != di.IsDir()
	switch policy {
	case ConflictSkip:
		return plan{skip: true}, nil
	case ConflictRenameExisting:
		if err := tr.renameExisting(name, di); err != nil {
			return plan{}, err
		}
		return plan{name: name}, nil
	case ConflictReplace, ConflictReplaceOlder, ConflictReplaceIfDifferentSize:
		switch {
		case bothDirs:
			return plan{name: name, merge: true}, nil
		case mismatch:
			// A file never replaces a folder (or the other way round).
		default:
			si, serr := os.Lstat(t.Path)
			if serr != nil {
				return plan{}, serr
			}
			if replaces(policy, si, di) {
				return plan{name: name, replace: true}, nil
			}
			return plan{skip: true}, nil
		}
	}
	// keepBoth, renameNew, and a file/folder mismatch.
	n, ok := fileops.UniqueName(name, isDir, func(c string) bool { return exists(filepath.Join(tr.dest, c)) })
	if !ok {
		return plan{}, fileops.Errorf(fileops.CodeExists, "no free name was found in the destination")
	}
	return plan{name: n}, nil
}

// replaces applies a replace policy to two files.
func replaces(policy string, si, di fs.FileInfo) bool {
	switch policy {
	case ConflictReplaceOlder:
		return si.ModTime().After(di.ModTime())
	case ConflictReplaceIfDifferentSize:
		return si.Size() != di.Size()
	}
	return true
}

func side(id int64, fi fs.FileInfo) ConflictSide {
	s := ConflictSide{ID: id, ModifiedMs: fi.ModTime().UnixMilli(), IsDir: fi.IsDir()}
	if !fi.IsDir() {
		s.Size = fi.Size()
	}
	return s
}

func (tr *transfer) existingID(name string, isDir bool) int64 {
	id, err := tr.m.deps.Store.IDByKey(tr.j.ctx, pathkey.ChildKey(tr.destKey, name, isDir))
	if err != nil {
		return 0
	}
	return id
}

// renameExisting moves the existing item aside ("name (2).ext") and keeps
// its index row and user metadata with it.
func (tr *transfer) renameExisting(name string, di fs.FileInfo) error {
	isDir := di.IsDir()
	newName, ok := fileops.UniqueName(name, isDir, func(c string) bool { return exists(filepath.Join(tr.dest, c)) })
	if !ok {
		return fileops.Errorf(fileops.CodeExists, "no free name was found for the existing %s", name)
	}
	oldPath := filepath.Join(tr.dest, name)
	newPath, err := fileops.Rename(oldPath, newName)
	if err != nil {
		return err
	}
	oldKey := pathkey.ChildKey(tr.destKey, name, isDir)
	newKey := pathkey.ChildKey(tr.destKey, newName, isDir)
	if tr.lib != nil {
		if err := tr.lib.Rekey(context.WithoutCancel(tr.j.ctx), oldKey, newKey); err != nil {
			tr.m.deps.Log.Warn("rename user metadata", "err", err)
		}
	}
	if id := tr.existingID(name, isDir); id > 0 && tr.indexed {
		if ts, err := tr.m.deps.Store.Targets(tr.j.ctx, []int64{id}); err == nil && len(ts) == 1 {
			tr.a.move(index.Moved{ID: id, ParentID: tr.destDir.ID, Kind: ts[0].Kind, Name: newName,
				Ext: extOf(newName, isDir), OldKey: oldKey, NewKey: newKey, OldPath: oldPath, NewPath: newPath})
		}
	}
	tr.a.touch(tr.destDir.ID, tr.destKey)
	return nil
}

// mergeDecision answers a file that exists on both sides of a folder merge
// with the job's policy, asking the user when it is "ask".
func (tr *transfer) mergeDecision(_ context.Context, c fileops.MergeConflict) (fileops.MergeDecision, error) {
	j := tr.j
	policy := j.currentPolicy()
	if policy == ConflictAsk {
		rel, err := filepath.Rel(tr.dest, c.Target)
		if err != nil {
			rel = filepath.Base(c.Target)
		}
		if policy, err = tr.m.ask(j, Conflict{Name: rel, Source: side(0, c.Src), Target: side(0, c.Dst)}); err != nil {
			return fileops.MergeSkip, err
		}
	}
	switch policy {
	case ConflictSkip:
		return fileops.MergeSkip, nil
	case ConflictRenameExisting:
		return fileops.MergeRenameExisting, nil
	case ConflictReplace, ConflictReplaceOlder, ConflictReplaceIfDifferentSize:
		if replaces(policy, c.Src, c.Dst) {
			return fileops.MergeReplace, nil
		}
		return fileops.MergeSkip, nil
	}
	return fileops.MergeRenameNew, nil
}
