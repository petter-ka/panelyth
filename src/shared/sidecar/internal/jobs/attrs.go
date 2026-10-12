package jobs

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/pathkey"
)

// KindSetAttributes changes attributes (Windows), permissions (elsewhere)
// and dates of the selected entries, optionally of everything below the
// selected folders too (Stage C09). Links are never changed or followed.
const KindSetAttributes Kind = "setAttributes"

// AttrSpec is what a setAttributes job changes.
type AttrSpec struct {
	fileops.AttrChange
	// Recursive also changes everything below the selected folders.
	Recursive bool
}

// Dates a job may set: from 1980 (the first date FAT can store) to the year
// 9999.
var (
	minAttrTime = time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)
	maxAttrTime = time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC)
)

func validateAttrs(s Spec) error {
	c := s.Attrs
	switch {
	case c == nil || c.Empty():
		return fmt.Errorf("%w: nothing to change", ErrInvalid)
	case (c.Set|c.Clear)&^fileops.SettableAttrs != 0 || c.Set&c.Clear != 0:
		return fmt.Errorf("%w: attributes are read-only, hidden, system and archive, each set or cleared", ErrInvalid)
	case (c.ModeSet|c.ModeClear)&^fs.ModePerm != 0 || c.ModeSet&c.ModeClear != 0:
		return fmt.Errorf("%w: permissions are the nine rwx bits, each set or cleared", ErrInvalid)
	}
	for _, at := range []time.Time{c.Modified, c.Accessed} {
		if !at.IsZero() && (at.Before(minAttrTime) || at.After(maxAttrTime)) {
			return fmt.Errorf("%w: dates must be between 1980 and 9999", ErrInvalid)
		}
	}
	return nil
}

func isLink(mode fs.FileMode) bool { return mode&(fs.ModeSymlink|fs.ModeIrregular) != 0 }

// setAttributes applies the change to each selected entry; with Recursive,
// to everything below a folder first and then to the folder itself, so a
// folder that loses its write or search permission is still walked.
func (m *Manager) setAttributes(j *job, a *applier) error {
	c := j.spec.Attrs
	return m.eachTarget(j, func(t index.Target) error {
		fi, err := os.Lstat(t.Path)
		if err != nil {
			return m.itemFailed(j, t.Name, err)
		}
		if isLink(fi.Mode()) {
			j.update(func(s *Snapshot) { s.Skipped++ })
			return nil
		}
		var below attrWalk
		if c.Recursive && fi.IsDir() {
			if err := m.attrsBelow(j, t.Path, c.AttrChange, &below); err != nil {
				return err
			}
		}
		err = fileops.ApplyAttrs(t.Path, c.AttrChange)
		// The row shows the entry as it is now, also after a failure half way.
		if now, serr := fsx.Stat(t.Path); serr == nil {
			a.stat(index.Stat{ID: t.ID, MtimeNs: now.ModTime().UnixNano(), Attrs: fsx.AttrsOf(t.Name, now)})
		}
		a.touch(t.ParentID, pathkey.DirKey(filepath.Dir(t.Path)))
		a.count()
		switch {
		case err != nil:
			return m.itemFailed(j, t.Name, err)
		case below.failed > 0:
			j.fail(t.Name, fileops.Code(below.first), fmt.Sprintf("%d of the %d items below could not be changed: %s",
				below.failed, below.entries, message(below.first)))
		default:
			j.update(func(s *Snapshot) { s.Done++ })
		}
		m.emit(j, false)
		return nil
	})
}

// attrWalk counts what a recursive change did below one folder.
type attrWalk struct {
	entries int
	failed  int
	first   error // the first failure
}

func (w *attrWalk) fail(err error) {
	if w.failed++; w.first == nil {
		w.first = err
	}
}

// attrsBelow changes everything below dir, children before their folder.
// Links are skipped and never followed. It returns only the job's
// cancellation; failures are counted in w.
func (m *Manager) attrsBelow(j *job, dir string, c fileops.AttrChange, w *attrWalk) error {
	if err := j.gate(j.ctx); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		w.entries++
		w.fail(err)
		return nil
	}
	for _, e := range entries {
		if err := j.ctx.Err(); err != nil {
			return err
		}
		if isLink(e.Type()) {
			continue
		}
		path := filepath.Join(dir, e.Name())
		if e.IsDir() {
			if err := m.attrsBelow(j, path, c, w); err != nil {
				return err
			}
		}
		w.entries++
		if err := fileops.ApplyAttrs(path, c); err != nil {
			w.fail(err)
		}
		if w.entries%256 == 0 {
			j.update(func(s *Snapshot) { s.Current = truncate(e.Name()) })
			m.emit(j, false)
		}
	}
	return nil
}

// stat queues the dates and attributes of a changed entry for the index.
func (a *applier) stat(s index.Stat) { a.stats = append(a.stats, s) }

func (a *applier) flushStats(ctx context.Context) {
	if len(a.stats) == 0 {
		return
	}
	if err := a.m.deps.Store.SetStats(ctx, a.stats); err != nil {
		a.m.deps.Log.Warn("apply attribute changes to the index", "err", err)
	}
	a.stats = nil
}
