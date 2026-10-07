package app

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"fastview/sidecar/internal/fileops"
	"fastview/sidecar/internal/fsx"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/media"
	"fastview/sidecar/internal/pathkey"
	"fastview/sidecar/internal/rpc"
	"fastview/sidecar/internal/scan"
)

// Stage C04 methods: new folders (F7) and whether a folder's volume has a
// trash (the delete dialog says so before anything starts). Destinations of
// jobs resolve from folder ids here, never from renderer paths (ADR-0027).

// MaxMkdirComponents bounds an "a/b/c" chain.
const MaxMkdirComponents = 64

type (
	fsMkdirParams struct {
		ParentDirID int64  `json:"parentDirId"`
		Path        string `json:"path"`
	}
	fsMkdirResult struct {
		// EntryID is the first component (the folder the panel shows).
		EntryID int64 `json:"entryId"`
		// Created is false when the whole chain existed already.
		Created bool `json:"created"`
	}
	fsMkfileParams struct {
		ParentDirID int64  `json:"parentDirId"`
		Name        string `json:"name"`
	}
	fsMkfileResult struct {
		EntryID int64 `json:"entryId"`
		// Created is false when the file existed already (Shift+F4 then edits it).
		Created bool `json:"created"`
	}
	dirIDParams struct {
		DirID int64 `json:"dirId"`
	}
	fsCanTrashResult struct {
		Trash bool `json:"trash"`
	}
)

func (s *indexService) registerFsOps(srv *rpc.Server) {
	rpc.Register(srv, "fs.mkdir", s.fsMkdir)
	rpc.Register(srv, "fs.mkfile", s.fsMkfile)
	rpc.Register(srv, "fs.canTrash", func(ctx context.Context, p dirIDParams) (fsCanTrashResult, error) {
		dir, err := s.dirPath(ctx, p.DirID)
		if err != nil {
			return fsCanTrashResult{}, err
		}
		return fsCanTrashResult{Trash: fileops.CanTrash(dir)}, nil
	})
}

// dirPath resolves an indexed folder id to its path.
func (s *indexService) dirPath(ctx context.Context, id int64) (string, error) {
	if id <= 0 {
		return "", rpc.NewError(rpc.CodeInvalidArgument, "folder id required")
	}
	d, err := s.store.Dir(ctx, id)
	if errors.Is(err, index.ErrNotFound) {
		return "", rpc.NewError(rpc.CodeNotFound, "the folder is not in the index")
	}
	if err != nil {
		return "", dbError(err)
	}
	return d.Path, nil
}

// splitChain splits "a/b/c" (either separator) into checked components.
func splitChain(path string, windowsNames bool) ([]string, error) {
	parts := strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' })
	if len(parts) == 0 {
		return nil, rpc.NewError(rpc.CodeInvalidArgument, "enter a folder name")
	}
	if len(parts) > MaxMkdirComponents {
		return nil, rpc.NewError(rpc.CodeInvalidArgument, "too many nested folders")
	}
	for _, p := range parts {
		err := fileops.ValidateName(p)
		if err == nil && windowsNames {
			err = fileops.ValidateWindowsName(p)
		}
		if err != nil {
			e := rpc.NewError(rpc.CodeInvalidArgument, p+": "+err.Error())
			e.Details = map[string]string{"reason": fileops.CodeInvalidName}
			return nil, e
		}
	}
	return parts, nil
}

// fsMkdir creates a folder, or a chain of them, inside an indexed folder.
// Existing components are kept (a file in the way fails); the first one is
// indexed so the panel can put its cursor on it.
func (s *indexService) fsMkdir(ctx context.Context, p fsMkdirParams) (fsMkdirResult, error) {
	parent, err := s.store.Dir(ctx, p.ParentDirID)
	if errors.Is(err, index.ErrNotFound) {
		return fsMkdirResult{}, rpc.NewError(rpc.CodeNotFound, "the folder is not in the index")
	}
	if err != nil {
		return fsMkdirResult{}, dbError(err)
	}
	parts, err := splitChain(p.Path, fsx.WindowsNames(parent.Path))
	if err != nil {
		return fsMkdirResult{}, err
	}
	created := false
	cur := parent.Path
	for _, part := range parts {
		cur = filepath.Join(cur, part)
		err := os.Mkdir(cur, 0o755)
		switch {
		case err == nil:
			created = true
		case errors.Is(err, fs.ErrExist):
			if fi, serr := os.Stat(cur); serr != nil || !fi.IsDir() {
				e := rpc.NewError(rpc.CodeInvalidArgument, part+" exists and is not a folder")
				e.Details = map[string]string{"reason": fileops.CodeExists}
				return fsMkdirResult{}, e
			}
		case errors.Is(err, fs.ErrPermission):
			return fsMkdirResult{}, rpc.NewError(rpc.CodePermissionDenied, "no permission to create a folder here")
		default:
			return fsMkdirResult{}, rpc.NewError(rpc.CodeInternal, err.Error())
		}
	}
	first, err := s.store.EnsureDir(ctx, filepath.Join(parent.Path, parts[0]))
	if err != nil {
		return fsMkdirResult{}, dbError(err)
	}
	// The parent's sessions show the new folder at once; its listing (and
	// the watcher) fills in the rest.
	s.changed([]scan.Change{{DirID: parent.ID, DirKey: parent.Key}})
	return fsMkdirResult{EntryID: first.ID, Created: created}, nil
}

// fsMkfile creates an empty file in an indexed folder (Stage C05, Shift+F4)
// and indexes it, so the caller can open it in the editor by id at once. An
// existing file is kept and returned; a folder of that name fails.
func (s *indexService) fsMkfile(ctx context.Context, p fsMkfileParams) (fsMkfileResult, error) {
	parent, err := s.store.Dir(ctx, p.ParentDirID)
	if errors.Is(err, index.ErrNotFound) {
		return fsMkfileResult{}, rpc.NewError(rpc.CodeNotFound, "the folder is not in the index")
	}
	if err != nil {
		return fsMkfileResult{}, dbError(err)
	}
	name := strings.TrimSpace(p.Name)
	err = fileops.ValidateName(name)
	if err == nil && strings.ContainsAny(name, `/\`) {
		err = errors.New("a file name cannot contain / or \\")
	}
	if err == nil && fsx.WindowsNames(parent.Path) {
		err = fileops.ValidateWindowsName(name)
	}
	if err != nil {
		e := rpc.NewError(rpc.CodeInvalidArgument, err.Error())
		e.Details = map[string]string{"reason": fileops.CodeInvalidName}
		return fsMkfileResult{}, e
	}
	path := filepath.Join(parent.Path, name)
	created := false
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	switch {
	case err == nil:
		created = true
		if err := f.Close(); err != nil {
			return fsMkfileResult{}, rpc.NewError(rpc.CodeInternal, err.Error())
		}
	case errors.Is(err, fs.ErrExist):
	case errors.Is(err, fs.ErrPermission):
		return fsMkfileResult{}, rpc.NewError(rpc.CodePermissionDenied, "no permission to create a file here")
	default:
		// Windows reports a folder of that name as "is a directory".
		if _, serr := os.Stat(path); serr != nil {
			return fsMkfileResult{}, rpc.NewError(rpc.CodeInternal, err.Error())
		}
	}
	fi, err := os.Stat(path)
	if err != nil {
		return fsMkfileResult{}, statError(err, "file")
	}
	if !fi.Mode().IsRegular() {
		e := rpc.NewError(rpc.CodeInvalidArgument, name+" exists and is not a file")
		e.Details = map[string]string{"reason": fileops.CodeExists}
		return fsMkfileResult{}, e
	}
	kind, ext, ok := media.Classify(name)
	if !ok {
		kind = media.KindFile
	}
	key := pathkey.ChildKey(parent.Key, name, false)
	row := index.Row{ParentID: parent.ID, ParentKey: parent.Key, Kind: kind, Name: name, PathKey: key, Ext: ext,
		Size: fi.Size(), MtimeNs: fi.ModTime().UnixNano(), BtimeNs: fsx.FileTimes(fi).BirthNs, Attrs: fsx.AttrsOf(name, fi)}
	if _, err := s.store.Commit(ctx, s.store.NextGeneration(), []index.Row{row}, nil); err != nil {
		return fsMkfileResult{}, dbError(err)
	}
	id, err := s.store.IDByKey(ctx, key)
	if err != nil {
		return fsMkfileResult{}, dbError(err)
	}
	s.changed([]scan.Change{{DirID: parent.ID, DirKey: parent.Key}})
	return fsMkfileResult{EntryID: id, Created: created}, nil
}
