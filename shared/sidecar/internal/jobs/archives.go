package jobs

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"fastview/sidecar/internal/archive"
	"fastview/sidecar/internal/fileops"
	"fastview/sidecar/internal/fsx"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/media"
	"fastview/sidecar/internal/pathkey"
)

// Archive jobs (Stage C07, ADR-0030): copy out of an archive and unpack
// (extract), pack, and test.
const (
	KindExtract     Kind = "extract"
	KindPack        Kind = "pack"
	KindTestArchive Kind = "testArchive"
)

// ArchiveSpec holds the archive fields of a Spec.
type ArchiveSpec struct {
	// Selection is set for a copy out of an archive panel; otherwise an
	// extract job unpacks the archives named by Spec.IDs.
	Selection *archive.Selection
	// Subfolders unpacks each archive into a folder named after it.
	Subfolders bool
	// Links creates links stored in archives (inside the target only).
	Links bool
	// Pack: the new archive's name, format, level and whether the packed
	// entries are deleted afterwards.
	Name            string
	Format          archive.Format
	Level           int
	DeleteOriginals bool
}

func validateArchive(s Spec) error {
	switch s.Kind {
	case KindExtract:
		if s.Destination == "" {
			return fmt.Errorf("%w: destination is required", ErrInvalid)
		}
		if !validPolicy(s.Conflict) {
			return fmt.Errorf("%w: unknown conflict policy %q", ErrInvalid, s.Conflict)
		}
	case KindPack:
		if s.Destination == "" {
			return fmt.Errorf("%w: destination is required", ErrInvalid)
		}
		if !validPolicy(s.Conflict) {
			return fmt.Errorf("%w: unknown conflict policy %q", ErrInvalid, s.Conflict)
		}
		if err := fileops.ValidateName(s.Archive.Name); err != nil {
			return fmt.Errorf("%w: %s", ErrInvalid, err.Error())
		}
		switch s.Archive.Format {
		case archive.FormatZip, archive.FormatTgz, archive.Format7z:
		default:
			return fmt.Errorf("%w: archives are created as zip, tar.gz or 7z", ErrInvalid)
		}
		if s.Archive.Level < 0 || s.Archive.Level > 9 {
			return fmt.Errorf("%w: the level must be 0..9", ErrInvalid)
		}
		if len(s.IDs) == 0 {
			return fmt.Errorf("%w: nothing to pack", ErrInvalid)
		}
	case KindTestArchive:
	}
	return nil
}

func validPolicy(p string) bool {
	for _, q := range policies {
		if q == p {
			return true
		}
	}
	return false
}

// archiveDecision answers an existing item with the job's policy, asking
// the user when it is "ask" (ADR-0029 policies).
func (m *Manager) archiveDecision(j *job, rel string, h *archive.Header, existing fs.FileInfo) (archive.Decision, error) {
	policy := j.currentPolicy()
	if policy == ConflictAsk {
		src := ConflictSide{Size: h.Size, ModifiedMs: h.MtimeNs / 1e6, IsDir: h.Kind == archive.KindDir}
		var err error
		if policy, err = m.ask(j, Conflict{Name: filepath.FromSlash(rel), Source: src, Target: side(0, existing)}); err != nil {
			return archive.DecideSkip, err
		}
	}
	switch policy {
	case ConflictSkip:
		return archive.DecideSkip, nil
	case ConflictRenameExisting:
		return archive.DecideRenameExisting, nil
	case ConflictReplace:
		return archive.DecideReplace, nil
	case ConflictReplaceOlder:
		if h.MtimeNs > existing.ModTime().UnixNano() {
			return archive.DecideReplace, nil
		}
		return archive.DecideSkip, nil
	case ConflictReplaceIfDifferentSize:
		if h.Size != existing.Size() {
			return archive.DecideReplace, nil
		}
		return archive.DecideSkip, nil
	}
	return archive.DecideKeepBoth, nil
}

// archiveKind maps an extracted entry to an index kind.
func archiveKind(h *archive.Header, name string) media.Kind {
	switch h.Kind {
	case archive.KindDir:
		return media.KindDir
	case archive.KindSymlink:
		return media.KindLink
	}
	if k, _, ok := media.Classify(name); ok {
		return k
	}
	return media.KindFile
}

// destination resolves the job's target folder and its index row.
func (m *Manager) archiveDestination(j *job) (string, index.DirInfo, bool, string) {
	dest := j.spec.Destination
	if fi, err := os.Stat(dest); err != nil || !fi.IsDir() {
		return "", index.DirInfo{}, false, "The destination folder doesn't exist any more."
	}
	d, err := m.deps.Store.DirByPath(j.ctx, dest)
	return dest, d, err == nil, ""
}

// extractOptions are the options every extraction of a job shares; dest is
// the folder written to, top the folder whose new children get index rows.
func (m *Manager) extractOptions(j *job, a *applier, dest string, destDir index.DirInfo, indexed bool, label func(string) string) *archive.ExtractOptions {
	return &archive.ExtractOptions{
		Dest:         dest,
		Links:        j.spec.Archive.Links,
		WindowsNames: fsx.WindowsNames(dest),
		Gate:         j.gate,
		Conflict: func(rel string, h *archive.Header, fi fs.FileInfo) (archive.Decision, error) {
			return m.archiveDecision(j, label(rel), h, fi)
		},
		Failed: func(rel string, err error) {
			j.fail(label(rel), fileops.Code(err), message(err))
		},
		Extracted: func(rel string, h *archive.Header) {
			if !strings.Contains(rel, "/") && indexed && dest == destDir.Path {
				name := rel
				t := index.Target{Kind: archiveKind(h, name)}
				a.add(rowFor(destDir, t, name, pathkey.ChildKey(destDir.Key, name, t.Kind == media.KindDir), filepath.Join(dest, name)))
				a.touch(destDir.ID, destDir.Key)
				a.count()
			}
		},
	}
}

// extract copies entries out of an archive panel, or unpacks archives.
func (m *Manager) extract(j *job, a *applier) (string, error) {
	dest, destDir, indexed, msg := m.archiveDestination(j)
	if msg != "" {
		return msg, nil
	}
	if sel := j.spec.Archive.Selection; sel != nil {
		return m.extractSelection(j, a, sel, dest, destDir, indexed)
	}
	var total int64
	if sum, err := m.deps.Store.Summarize(j.ctx, j.spec.IDs); err == nil {
		total = sum.Bytes
	}
	j.update(func(s *Snapshot) { s.BytesTotal = total })
	err := m.eachTarget(j, func(t index.Target) error {
		format, ok := archive.Detect(t.Name)
		if !ok || t.Kind == media.KindDir {
			j.fail(t.Name, archive.CodeCorrupt, "This is not an archive FastView can unpack.")
			return nil
		}
		target, top := dest, dest
		if j.spec.Archive.Subfolders {
			top = filepath.Join(dest, archive.StripExt(t.Name))
			if err := os.Mkdir(top, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
				return m.itemFailed(j, t.Name, err)
			}
			target = top
		}
		var done int64
		o := m.extractOptions(j, a, target, destDir, indexed, func(rel string) string {
			return t.Name + string(filepath.Separator) + filepath.FromSlash(rel)
		})
		failedBefore := j.snapshot().Failed
		err := archive.Extract(j.ctx, t.Path, format, m.deps.Archive, func(n int64) {
			done += n
			j.update(func(s *Snapshot) { s.BytesDone += n })
			m.emit(j, false)
		}, o)
		j.update(func(s *Snapshot) { s.BytesDone += max(t.Size-done, 0) })
		if j.spec.Archive.Subfolders && indexed {
			a.add(rowFor(destDir, index.Target{Kind: media.KindDir}, filepath.Base(top),
				pathkey.ChildKey(destDir.Key, filepath.Base(top), true), top))
			a.touch(destDir.ID, destDir.Key)
			a.count()
		}
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return err
			}
			j.fail(t.Name, archiveCode(err), archiveMessage(err))
			return nil
		}
		if j.snapshot().Failed == failedBefore {
			j.update(func(s *Snapshot) { s.Done++ })
		}
		return nil
	})
	return "", err
}

func (m *Manager) extractSelection(j *job, a *applier, sel *archive.Selection, dest string, destDir index.DirInfo, indexed bool) (string, error) {
	l := sel.Archive.Listing
	if l.Changed() {
		return "The archive changed since it was opened. Open it again and repeat the copy.", nil
	}
	j.update(func(s *Snapshot) { s.Total, s.BytesTotal = sel.Files, sel.Bytes })
	o := m.extractOptions(j, a, dest, destDir, indexed, func(rel string) string { return rel })
	o.Base, o.Include, o.Selected = sel.Base, sel.Include(), sel.Paths
	o.Progress = func(n int64) {
		j.update(func(s *Snapshot) { s.BytesDone += n })
		m.emit(j, false)
	}
	extracted := o.Extracted
	o.Extracted = func(rel string, h *archive.Header) {
		extracted(rel, h)
		if h.Kind != archive.KindDir {
			j.update(func(s *Snapshot) { s.Done++; s.Current = truncate(baseOf(rel)) })
			m.emit(j, false)
		}
	}
	o.Skipped = func(rel string, h *archive.Header) {
		if h.Kind != archive.KindDir {
			j.update(func(s *Snapshot) { s.Skipped++; s.BytesDone += h.Size })
		}
	}
	err := archive.Extract(j.ctx, l.Path, l.Format, m.deps.Archive, nil, o)
	switch {
	case err == nil, errors.Is(err, context.Canceled):
		return "", err
	case errors.Is(err, archive.ErrCorrupt), errors.Is(err, archive.ErrEncrypted), errors.Is(err, archive.ErrNoTool):
		return archiveMessage(err), nil
	}
	return "", err
}

func baseOf(rel string) string {
	if i := strings.LastIndexByte(rel, '/'); i >= 0 {
		return rel[i+1:]
	}
	return rel
}

func archiveCode(err error) string {
	switch {
	case errors.Is(err, archive.ErrEncrypted):
		return archive.CodeEncrypted
	case errors.Is(err, archive.ErrCorrupt), errors.Is(err, archive.ErrNotArchive), errors.Is(err, archive.ErrNoTool):
		return archive.CodeCorrupt
	}
	return fileops.Code(err)
}

func archiveMessage(err error) string {
	switch {
	case errors.Is(err, archive.ErrEncrypted):
		return "The archive is protected by a password; FastView can't open it."
	case errors.Is(err, archive.ErrNoTool):
		return "This format needs 7-Zip, which was not found. Install 7-Zip to open it."
	case errors.Is(err, archive.ErrCorrupt):
		return "The archive is damaged: " + strings.TrimPrefix(err.Error(), archive.ErrCorrupt.Error()+": ")
	}
	return message(err)
}

// testArchives reads every archive through, verifying checksums.
func (m *Manager) testArchives(j *job) error {
	if sum, err := m.deps.Store.Summarize(j.ctx, j.spec.IDs); err == nil {
		j.update(func(s *Snapshot) { s.BytesTotal = sum.Bytes })
	}
	return m.eachTarget(j, func(t index.Target) error {
		format, ok := archive.Detect(t.Name)
		if !ok || t.Kind == media.KindDir {
			j.fail(t.Name, archive.CodeCorrupt, "This is not an archive FastView can test.")
			return nil
		}
		var done int64
		_, err := archive.Test(j.ctx, t.Path, format, m.deps.Archive, func(n int64) {
			done += n
			j.update(func(s *Snapshot) { s.BytesDone += n })
			m.emit(j, false)
		})
		j.update(func(s *Snapshot) { s.BytesDone += max(t.Size-done, 0) })
		switch {
		case errors.Is(err, context.Canceled):
			return err
		case err != nil:
			j.fail(t.Name, archiveCode(err), archiveMessage(err))
		default:
			j.update(func(s *Snapshot) { s.Done++ })
		}
		m.emit(j, false)
		return nil
	})
}

// pack creates an archive from the marked entries in the destination.
func (m *Manager) pack(j *job, a *applier) (string, error) {
	dest, destDir, indexed, msg := m.archiveDestination(j)
	if msg != "" {
		return msg, nil
	}
	spec := j.spec.Archive
	var targets []index.Target
	if err := m.eachTarget(j, func(t index.Target) error {
		targets = append(targets, t)
		return nil
	}); err != nil {
		return "", err
	}
	if len(targets) == 0 {
		return "Nothing to pack: the marked entries no longer exist.", nil
	}
	items := make([]archive.PackItem, len(targets))
	var total int64
	for i, t := range targets {
		items[i] = archive.PackItem{Path: t.Path, Name: t.Name}
		if t.Kind == media.KindDir {
			if size, err := fileops.TreeSize(j.ctx, t.Path); err == nil {
				total += size
			}
		} else {
			total += t.Size
		}
		if t.Kind == media.KindDir && fileops.IsWithin(dest, t.Path) {
			return "The archive can't be created inside a folder that is being packed.", nil
		}
	}
	j.update(func(s *Snapshot) { s.BytesTotal, s.Current = total, truncate(spec.Name) })

	name := spec.Name
	replace := false
	if fi, err := os.Lstat(filepath.Join(dest, name)); err == nil {
		h := &archive.Header{Kind: archive.KindFile}
		d, err := m.archiveDecision(j, name, h, fi)
		if err != nil {
			return "", err
		}
		switch d {
		case archive.DecideSkip:
			j.update(func(s *Snapshot) { s.Skipped = len(targets) })
			return "", nil
		case archive.DecideReplace:
			if fi.IsDir() {
				return "A folder already has this name.", nil
			}
			replace = true
		case archive.DecideRenameExisting:
			if err := renameExistingAside(filepath.Join(dest, name)); err != nil {
				return "", m.itemFailed(j, name, err)
			}
		default:
			n, ok := fileops.UniqueName(name, false, func(c string) bool { return exists(filepath.Join(dest, c)) })
			if !ok {
				return "No free name was found for the archive.", nil
			}
			name = n
		}
	}
	failedItem := make([]bool, len(targets))
	err := archive.Pack(j.ctx, m.deps.Archive, &archive.PackOptions{
		Format: spec.Format, Level: spec.Level, Items: items, Target: filepath.Join(dest, name), Replace: replace,
		Gate: j.gate,
		Progress: func(n int64) {
			j.update(func(s *Snapshot) { s.BytesDone += n })
			m.emit(j, false)
		},
		Failed: func(item int, rel string, err error) {
			failedItem[item] = true
			j.fail(filepath.FromSlash(rel), fileops.Code(err), message(err))
		},
	})
	switch {
	case errors.Is(err, context.Canceled):
		return "", err
	case errors.Is(err, archive.ErrNoTool):
		return archiveMessage(err), nil
	case err != nil:
		return "The archive could not be written: " + message(err), nil
	}
	if indexed {
		a.add(rowFor(destDir, index.Target{Kind: media.KindFile}, name, pathkey.ChildKey(destDir.Key, name, false), filepath.Join(dest, name)))
		a.touch(destDir.ID, destDir.Key)
		a.count()
	}
	for i, t := range targets {
		if failedItem[i] {
			continue
		}
		j.update(func(s *Snapshot) { s.Done++ })
		if !spec.DeleteOriginals {
			continue
		}
		// Only entries packed completely are deleted.
		if err := fileops.Delete(t.Path, t.Kind == media.KindDir); err != nil && fileops.Code(err) != fileops.CodeNotFound {
			j.fail(t.Name, fileops.Code(err), "Packed, but not deleted: "+message(err))
			continue
		}
		a.remove(t.ID)
		a.forget(t.Key)
		a.touch(t.ParentID, pathkey.DirKey(filepath.Dir(t.Path)))
		a.count()
	}
	return "", nil
}

func renameExistingAside(p string) error {
	fi, err := os.Lstat(p)
	if err != nil {
		return err
	}
	n, ok := fileops.UniqueName(filepath.Base(p), fi.IsDir(), func(c string) bool { return exists(filepath.Join(filepath.Dir(p), c)) })
	if !ok {
		return fileops.Errorf(fileops.CodeExists, "no free name was found for the existing %s", filepath.Base(p))
	}
	_, err = fileops.Rename(p, n)
	return err
}
