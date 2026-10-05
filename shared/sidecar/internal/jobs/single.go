package jobs

import (
	"context"
	"fmt"
	"path/filepath"

	"fastview/sidecar/internal/fileops"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/media"
	"fastview/sidecar/internal/pathkey"
	"fastview/sidecar/internal/scan"
)

// RenameOne renames a single entry synchronously (F2): the inline editor
// needs its validation error immediately, so this is not a job (ADR-0021).
// A file must keep a supported extension of the same kind, so a rename
// never turns a media file into an unindexed one. Errors are *fileops.Error
// (codes NOT_FOUND, INVALID_NAME, ALREADY_EXISTS, …).
func (m *Manager) RenameOne(ctx context.Context, id int64, newName string) (string, error) {
	targets, err := m.deps.Store.Targets(ctx, []int64{id})
	if err != nil {
		return "", err
	}
	if len(targets) == 0 {
		return "", fileops.Errorf(fileops.CodeNotFound, "the item is no longer in the index")
	}
	t := targets[0]
	if err := fileops.ValidateName(newName); err != nil {
		return "", fileops.Errorf(fileops.CodeInvalidName, "%s", err.Error())
	}
	isDir := t.Kind == media.KindDir
	if !isDir {
		if kind, _, ok := media.Classify(newName); !ok || kind != t.Kind {
			return "", fileops.Errorf(fileops.CodeInvalidName, "keep the .%s extension", media.Ext(t.Name))
		}
	}
	if newName == t.Name {
		return newName, nil
	}
	newPath, err := fileops.Rename(t.Path, newName)
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(t.Path)
	parentKey := pathkey.DirKey(dir)
	newKey := pathkey.ChildKey(parentKey, newName, isDir)
	// The file is renamed: index and library must follow even if the
	// caller goes away now.
	ctx = context.WithoutCancel(ctx)
	if lib := m.library(ctx); lib != nil {
		if err := lib.Rekey(ctx, t.Key, newKey); err != nil {
			m.deps.Log.Warn("rename user metadata", "err", err)
		}
	}
	mv := index.Moved{ID: t.ID, ParentID: t.ParentID, Kind: t.Kind, Name: newName, Ext: extOf(newName, isDir),
		OldKey: t.Key, NewKey: newKey, OldPath: t.Path, NewPath: newPath}
	if err := m.deps.Store.ApplyChanges(ctx, index.Changes{Moved: []index.Moved{mv}}); err != nil {
		// The next listing of the folder reconciles the index (ADR-0015).
		m.deps.Log.Warn("apply rename to the index", "err", fmt.Errorf("%s: %w", t.Name, err))
	}
	if m.deps.Changed != nil {
		m.deps.Changed([]scan.Change{{DirID: t.ParentID, DirKey: parentKey}})
	}
	return newName, nil
}
