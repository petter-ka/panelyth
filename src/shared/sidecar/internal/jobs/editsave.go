package jobs

import (
	"errors"
	"fmt"
	"path/filepath"

	"panelyth/sidecar/internal/editor"
	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/imaging"
)

// KindEditSave writes an edited picture (Stage 12, ADR-0035): one file,
// rendered at full resolution and written atomically. Its progress counts
// the save's steps.
const KindEditSave Kind = "editSave"

// EditSpec is the save of an editSave job.
type EditSpec struct {
	Save editor.SaveRequest
}

// editSaveSteps mirrors the steps editor.Save reports.
const editSaveSteps = 5

func validateEdit(s Spec) error {
	if s.Edit == nil || s.Edit.Save.Dest == "" || s.Edit.Save.Source.Path == "" {
		return fmt.Errorf("%w: nothing to save", ErrInvalid)
	}
	if _, ok := imaging.SaveFormats[s.Edit.Save.Format]; !ok {
		return fmt.Errorf("%w: unknown format %q", ErrInvalid, s.Edit.Save.Format)
	}
	if err := s.Edit.Save.Edits.Validate(); err != nil {
		return fmt.Errorf("%w: %s", ErrInvalid, err.Error())
	}
	return nil
}

// editLane is the lane of a save: the volume it reads and the one it writes.
func editLane(s Spec) string {
	return fsx.VolumeID(s.Edit.Save.Source.Path) + ">" + fsx.VolumeID(s.Edit.Save.Dest)
}

// editSave runs the save and puts the new file into the index. A failure
// is the job's failure, with one item error that carries its code.
func (m *Manager) editSave(j *job, a *applier) (string, error) {
	req := j.spec.Edit.Save
	name := filepath.Base(req.Dest)
	j.update(func(s *Snapshot) { s.Current = truncate(name) })
	m.emit(j, true)
	req.Step = func(done, _ int, bytes int64) {
		j.update(func(s *Snapshot) { s.Done, s.BytesDone = min(done, editSaveSteps), bytes })
		m.emit(j, false)
	}
	if err := j.gate(j.ctx); err != nil {
		return "", err
	}
	res, err := editor.Save(j.ctx, req)
	if res.Path != "" {
		// Written, or the original went to the trash: the folder changed
		// either way.
		dirs := newDirCache(m, j, a)
		if res.Trashed && err != nil {
			dirs.removed(req.Source.Path, false, false)
		} else {
			dirs.added(res.Path, false)
		}
	}
	if err == nil {
		j.update(func(s *Snapshot) { s.Done, s.BytesTotal, s.BytesDone = editSaveSteps, res.Bytes, res.Bytes })
		return "", nil
	}
	if j.ctx.Err() != nil {
		return "", j.ctx.Err()
	}
	code, msg := fileops.Code(err), message(err)
	switch {
	case errors.Is(err, editor.ErrChanged):
		code, msg = fileops.CodeIO, "The file changed on disk since it was opened. Close the editor and open the picture again."
	case errors.Is(err, editor.ErrTooLarge), errors.Is(err, imaging.ErrTooLarge):
		code, msg = fileops.CodeIO, "The picture is too large to save."
	case errors.Is(err, imaging.ErrCorrupt), errors.Is(err, imaging.ErrUnsupported):
		code, msg = fileops.CodeIO, "The picture can no longer be read."
	case code == fileops.CodeTrashUnavailable:
		msg = "This drive has no trash, so the original was not replaced. Save a copy instead."
	}
	j.fail(name, code, msg)
	return msg, nil
}
