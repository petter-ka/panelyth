package jobs

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"

	"fastview/sidecar/internal/fileops"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/media"
	"fastview/sidecar/internal/scan"
)

// KindDirSize calculates folder sizes (Stage C02): the bytes of every file
// below each folder. Links, junctions and mount points are never followed,
// unreadable subfolders are counted as far as they can be read, and the
// result goes to the index (dir_size_bytes) so the listing shows it.
const KindDirSize Kind = "dirSize"

func (m *Manager) dirSizes(j *job) error {
	return m.eachTarget(j, func(t index.Target) error {
		if t.Kind != media.KindDir {
			j.update(func(s *Snapshot) { s.Skipped++ })
			return nil
		}
		bytes, unreadable, err := walkSize(j, t.Path)
		if err != nil {
			return err
		}
		if unreadable > 0 {
			j.fail(t.Name, fileops.CodePermission, "Some subfolders could not be read; the size counts the rest.")
		}
		if err := m.deps.Store.SetDirSize(context.WithoutCancel(j.ctx), t.ID, bytes); err != nil {
			return err
		}
		m.deps.Changed([]scan.Change{{DirID: t.ParentID}})
		j.update(func(s *Snapshot) { s.Done++ })
		m.emit(j, false)
		return nil
	})
}

// walkSize sums file sizes below root; the job's context cancels it.
func walkSize(j *job, root string) (bytes int64, unreadable int, err error) {
	err = filepath.WalkDir(root, func(_ string, d fs.DirEntry, werr error) error {
		if cerr := j.ctx.Err(); cerr != nil {
			return cerr
		}
		if werr != nil {
			unreadable++
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		// DirEntry types come from the directory read (Lstat semantics): a
		// link is never a directory here, so WalkDir never descends into it.
		if !d.Type().IsRegular() {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			unreadable++
			return nil
		}
		bytes += info.Size()
		j.update(func(s *Snapshot) { s.BytesDone += info.Size() })
		return nil
	})
	if errors.Is(err, context.Canceled) {
		return 0, 0, err
	}
	return bytes, unreadable, nil
}
