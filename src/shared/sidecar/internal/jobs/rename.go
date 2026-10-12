package jobs

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/pathkey"
	"panelyth/sidecar/internal/rename"
)

// Stage C09: the commander's multi-rename and its undo. Both rename kinds
// (the viewer's "rename" with a {name}{n} pattern, and "multiRename" with
// Total Commander masks) compile to one rename.Plan and are applied the same
// way; only a multi-rename keeps a journal.
const (
	KindMultiRename Kind = "multiRename"
	// KindUndoRename takes the names of the last multi-rename back. It has no
	// selection: its items are the journal's.
	KindUndoRename Kind = "undoRename"
)

// MaxMultiRename bounds a multi-rename, and with it the journal and a
// preview's names.
const MaxMultiRename = 100_000

// RenameStep is one applied rename of the journal.
type RenameStep struct {
	Dir string // clean folder path
	Old string
	New string
}

// UndoInfo describes the multi-rename that can be undone.
type UndoInfo struct {
	// Count is 0 when there is nothing to undo.
	Count int `json:"count"`
	// Dir is the folder of the renamed entries (the first one's, when they
	// are from several folders).
	Dir        string `json:"dir"`
	FinishedMs int64  `json:"finishedMs"`
}

// undoJournal is the one level of undo (ADR-0029): the renames of the last
// multi-rename that renamed anything, in the order they were applied. It
// lives in memory and ends with the sidecar.
type undoJournal struct {
	mu         sync.Mutex
	steps      []RenameStep
	finishedMs int64
	// gen changes with every new journal, so an undo that stopped half way
	// does not put its rest back over a newer one.
	gen uint64
}

func (u *undoJournal) set(steps []RenameStep) {
	if len(steps) == 0 {
		return
	}
	u.mu.Lock()
	u.steps, u.finishedMs = steps, time.Now().UnixMilli()
	u.gen++
	u.mu.Unlock()
}

// take hands the journal to an undo job; nothing else can undo it then.
func (u *undoJournal) take() ([]RenameStep, uint64) {
	u.mu.Lock()
	defer u.mu.Unlock()
	steps := u.steps
	u.steps = nil
	return steps, u.gen
}

// restore puts back what an undo did not get to.
func (u *undoJournal) restore(steps []RenameStep, gen uint64) {
	u.mu.Lock()
	if u.gen == gen && u.steps == nil && len(steps) > 0 {
		u.steps = steps
	}
	u.mu.Unlock()
}

// UndoInfo reports the multi-rename an undoRename job would take back.
func (m *Manager) UndoInfo() UndoInfo {
	m.undo.mu.Lock()
	defer m.undo.mu.Unlock()
	if len(m.undo.steps) == 0 {
		return UndoInfo{}
	}
	return UndoInfo{Count: len(m.undo.steps), Dir: m.undo.steps[0].Dir, FinishedMs: m.undo.finishedMs}
}

func validateRename(s Spec) error {
	switch s.Kind {
	case KindRename:
		if _, err := rename.ParseViewer(s.Pattern, s.Start); err != nil {
			return fmt.Errorf("%w: the pattern needs {name} or {n} and only those tokens, and a start of 0 or more", ErrInvalid)
		}
	case KindMultiRename:
		if s.Rename == nil {
			return fmt.Errorf("%w: a multi-rename needs its masks", ErrInvalid)
		}
		if _, err := rename.Compile(*s.Rename); err != nil {
			return fmt.Errorf("%w: %s", ErrInvalid, err.Error())
		}
		if len(s.IDs) > MaxMultiRename {
			return fmt.Errorf("%w: a multi-rename takes at most %d entries", ErrInvalid, MaxMultiRename)
		}
	case KindUndoRename:
		if len(s.undo) == 0 {
			return fmt.Errorf("%w: there is no multi-rename to undo", ErrInvalid)
		}
	}
	return nil
}

// renameLane is the volume of an undo's first step.
func renameLane(s Spec) (string, bool) {
	if s.Kind != KindUndoRename || len(s.undo) == 0 {
		return "", false
	}
	v := fsx.VolumeID(s.undo[0].Dir)
	return v + ">" + v, true
}

// renameBatch names the job's entries with its plan and renames the ones
// whose new name is valid and free, each after the entry that still has its
// name (rename.Resolve). Names exchanged in a cycle fail rather than going
// through hidden temporary names (ADR-0021). A multi-rename records what it
// renamed for the undo.
func (m *Manager) renameBatch(j *job, a *applier) error {
	var plan *rename.Plan
	if j.spec.Kind == KindMultiRename {
		plan, _ = rename.Compile(*j.spec.Rename)
	} else {
		plan, _ = rename.ParseViewer(j.spec.Pattern, j.spec.Start)
	}
	var targets []index.Target
	var entries []rename.Entry
	err := m.eachTarget(j, func(t index.Target) error {
		targets = append(targets, t)
		entries = append(entries, rename.Entry{
			Item: rename.Item{Name: t.Name, IsDir: t.Kind == media.KindDir, ModNs: t.MtimeNs},
			Dir:  pathkey.DirKey(filepath.Dir(t.Path)),
		})
		return nil
	})
	if err != nil {
		return err
	}
	res := rename.Resolve(plan, entries, func(i int, name string) bool {
		return exists(filepath.Join(filepath.Dir(targets[i].Path), name))
	})
	for i, o := range res.Outcomes {
		switch o.Status {
		case rename.Unchanged:
			j.update(func(s *Snapshot) { s.Skipped++ })
		case rename.Invalid:
			j.fail(targets[i].Name, fileops.CodeInvalidName, o.Reason)
		case rename.Conflict:
			j.fail(targets[i].Name, fileops.CodeExists, conflictMessage(o.Reason))
		}
	}
	var steps []RenameStep
	if j.spec.Kind == KindMultiRename {
		// Whatever was renamed can be undone, also after a cancel.
		defer func() { m.undo.set(steps) }()
	}
	for _, i := range res.Order {
		if err := j.gate(j.ctx); err != nil {
			return err
		}
		t, newName := targets[i], res.Outcomes[i].Name
		j.update(func(s *Snapshot) { s.Current = truncate(t.Name) })
		m.emit(j, false)
		newPath, err := fileops.Rename(t.Path, newName)
		if err != nil {
			// An entry waiting for this one's name finds it taken and fails too.
			if cerr := m.itemFailed(j, t.Name, err); cerr != nil {
				return cerr
			}
			continue
		}
		j.update(func(s *Snapshot) { s.Done++ })
		isDir := t.Kind == media.KindDir
		newKey := pathkey.ChildKey(entries[i].Dir, newName, isDir)
		a.rekey(t.Key, newKey)
		a.move(index.Moved{ID: t.ID, ParentID: t.ParentID, Kind: t.Kind, Name: newName,
			Ext: extOf(newName, isDir), OldKey: t.Key, NewKey: newKey, OldPath: t.Path, NewPath: newPath})
		a.touch(t.ParentID, entries[i].Dir)
		a.count()
		if j.spec.Kind == KindMultiRename {
			steps = append(steps, RenameStep{Dir: filepath.Dir(t.Path), Old: t.Name, New: newName})
		}
	}
	return nil
}

func conflictMessage(reason string) string {
	switch reason {
	case rename.ReasonDuplicate:
		return "Another selected item gets the same name."
	case rename.ReasonCycle:
		return "The new name is taken by another selected item."
	}
	return "An item with this name already exists."
}

// undoRename takes the journal's renames back, the last one first. An entry
// that is no longer there under its new name, or whose old name is taken
// again, fails and stays as it is. What a cancelled undo did not reach can
// be undone later.
func (m *Manager) undoRename(j *job, a *applier) (err error) {
	steps := j.spec.undo
	left := len(steps)
	defer func() { m.undo.restore(steps[:left], j.spec.undoGen) }()
	dirs := map[string]index.DirInfo{}
	for left > 0 {
		if err := j.gate(j.ctx); err != nil {
			return err
		}
		st := steps[left-1]
		left--
		j.update(func(s *Snapshot) { s.Current = truncate(st.New) })
		m.emit(j, false)
		current := filepath.Join(st.Dir, st.New)
		fi, err := os.Lstat(current)
		if err != nil {
			j.fail(st.New, fileops.CodeNotFound, "The item is no longer there under this name.")
			continue
		}
		newPath, err := fileops.Rename(current, st.Old)
		if err != nil {
			if cerr := m.itemFailed(j, st.New, err); cerr != nil {
				left++ // not undone: it stays in the journal
				return cerr
			}
			continue
		}
		j.update(func(s *Snapshot) { s.Done++ })
		// The index follows where it knows the entry; a listing reconciles
		// the rest (ADR-0015).
		ctx := context.WithoutCancel(j.ctx)
		dirKey := pathkey.DirKey(st.Dir)
		isDir := fi.IsDir()
		curKey, oldKey := pathkey.ChildKey(dirKey, st.New, isDir), pathkey.ChildKey(dirKey, st.Old, isDir)
		a.rekey(curKey, oldKey)
		if id, err := m.deps.Store.IDByKey(ctx, curKey); err == nil && id > 0 {
			if ts, err := m.deps.Store.Targets(ctx, []int64{id}); err == nil && len(ts) == 1 {
				a.move(index.Moved{ID: id, ParentID: ts[0].ParentID, Kind: ts[0].Kind, Name: st.Old,
					Ext: extOf(st.Old, isDir), OldKey: curKey, NewKey: oldKey, OldPath: current, NewPath: newPath})
			}
		}
		dir, known := dirs[st.Dir]
		if !known {
			dir, _ = m.deps.Store.DirByPath(ctx, st.Dir)
			dirs[st.Dir] = dir
		}
		a.touch(dir.ID, dirKey)
		a.count()
	}
	return nil
}
