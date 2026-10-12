package app

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"runtime"
	"time"

	"panelyth/sidecar/internal/archive"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/library"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/pathkey"
	"panelyth/sidecar/internal/query"
	"panelyth/sidecar/internal/remote"
	"panelyth/sidecar/internal/rpc"
)

// Stage 05 workspace methods: sidebar filesystem, library.db user data,
// properties and selection descriptors (ADR-0017). Wire types mirror
// src/shared/contracts/src/rpc.ts.

// Selection bounds keep descriptors and resolved payloads small.
const (
	MaxSelectionRanges = 10_000
	MaxSelectionIDs    = 50_000
	// MaxCopyPaths caps selection.paths (clipboard); the result says when
	// it was truncated.
	MaxCopyPaths = 10_000
)

type (
	selectionWire struct {
		QueryID int64    `json:"queryId"`
		Version int64    `json:"version"`
		Ranges  [][2]int `json:"ranges"`
		Include []int64  `json:"include"`
		Exclude []int64  `json:"exclude"`
	}
	selectionParams struct {
		Selection selectionWire `json:"selection"`
	}
	selectionPathsParams struct {
		Selection selectionWire `json:"selection"`
		Limit     int           `json:"limit"`
	}
	selectionPathsResult struct {
		Paths     []string `json:"paths"`
		Truncated bool     `json:"truncated"`
	}
	fsVolumesResult struct {
		Volumes []fsx.Volume `json:"volumes"`
	}
	fsListDirsParams struct {
		Path string `json:"path"`
		// ShowHidden lists hidden and system folders too (the commander's
		// tree, Stage C10.5); the viewer never sends it.
		ShowHidden bool `json:"showHidden"`
	}
	fsListDirsResult struct {
		Path      string         `json:"path"`
		Dirs      []fsx.DirChild `json:"dirs"`
		Truncated bool           `json:"truncated"`
	}
	libraryState struct {
		Settings  map[string]json.RawMessage `json:"settings"`
		Bookmarks []library.Bookmark         `json:"bookmarks"`
		Recent    []library.RecentFolder     `json:"recent"`
	}
	setSettingParams struct {
		Key   string          `json:"key"`
		Value json.RawMessage `json:"value"`
	}
	okResult struct {
		OK bool `json:"ok"`
	}
	addBookmarkParams struct {
		Path  string `json:"path"`
		Label string `json:"label"`
		Group string `json:"group"`
	}
	updateBookmarkParams struct {
		ID    int64  `json:"id"`
		Path  string `json:"path"`
		Label string `json:"label"`
		Group string `json:"group"`
	}
	reorderBookmarksParams struct {
		IDs []int64 `json:"ids"`
	}
	bookmarksEvent struct {
		Bookmarks []library.Bookmark `json:"bookmarks"`
	}
	removeBookmarkParams struct {
		ID int64 `json:"id"`
	}
	entryParams struct {
		EntryID int64 `json:"entryId"`
	}
	// Returned to Electron main only (open / reveal in the file manager).
	entryPathResult struct {
		Path string `json:"path"`
		Kind string `json:"kind"`
		// Program: opening it may run code (fsx.IsProgram); the commander
		// asks first (ADR-0027).
		Program bool `json:"program"`
	}
	queryFacetsParams struct {
		QueryID int64 `json:"queryId"`
	}
	propsResult struct {
		ID         int64  `json:"id"`
		Kind       string `json:"kind"`
		Name       string `json:"name"`
		Ext        string `json:"ext"`
		Path       string `json:"path"`
		Exists     bool   `json:"exists"`
		SizeBytes  int64  `json:"sizeBytes"`
		ModifiedMs int64  `json:"modifiedMs"`
		CreatedMs  *int64 `json:"createdMs"`
		AccessedMs *int64 `json:"accessedMs"`
		Width      *int   `json:"width"`
		Height     *int   `json:"height"`
		// Attrs are the fsx.Attr* bits as they are now (omitted when none is
		// set, as on page rows); Permissions the permission bits (null on
		// Windows, which has none); LinkTarget where a link points, as it is
		// stored (Stage C09).
		Attrs       int     `json:"attrs,omitempty"`
		Permissions *int    `json:"permissions"`
		LinkTarget  *string `json:"linkTarget"`
		// Folders: counts from the last complete listing, null before it.
		ChildFolders *int `json:"childFolders"`
		ChildMedia   *int `json:"childMedia"`
		// User metadata (files only; Stage 07, label Stage 08).
		Favorite bool     `json:"favorite"`
		Rating   int      `json:"rating"`
		Label    int      `json:"label"`
		Tags     []string `json:"tags"`
	}
)

func (s *indexService) registerWorkspace(srv *rpc.Server) {
	rpc.Register(srv, "fs.volumes", func(context.Context, emptyParams) (fsVolumesResult, error) {
		// The first call starts the monitor behind volumes.changed.
		s.volumes.start(s.bg, s.emitVolumes, s.log)
		v, err := fsx.Volumes()
		if err != nil {
			return fsVolumesResult{}, rpc.NewError(rpc.CodeInternal, err.Error())
		}
		return fsVolumesResult{Volumes: v}, nil
	})
	rpc.Register(srv, "fs.listDirs", s.fsListDirs)
	rpc.Register(srv, "query.facets", func(ctx context.Context, p queryFacetsParams) (index.Facets, error) {
		f, err := s.queries.Facets(ctx, p.QueryID)
		if errors.Is(err, query.ErrUnknownSession) {
			return f, rpc.NewError(rpc.CodeNotFound, "query session expired; reopen it")
		}
		if err != nil {
			return f, dbError(err)
		}
		return f, nil
	})
	rpc.Register(srv, "props.get", s.propsGet)
	rpc.Register(srv, "entry.path", s.entryPath)
	rpc.Register(srv, "clipboard.image", s.clipboardImage)
	rpc.Register(srv, "selection.info", func(ctx context.Context, p selectionParams) (index.Summary, error) {
		ids, err := s.resolveSelection(p.Selection)
		if err != nil {
			return index.Summary{}, err
		}
		if remoteOnly(ids) {
			return s.remoteSummary(ids)
		}
		if archiveOnly(ids) {
			return s.archiveSummary(ids)
		}
		sum, err := s.store.Summarize(ctx, ids)
		if err != nil {
			return sum, dbError(err)
		}
		return sum, nil
	})
	rpc.Register(srv, "selection.rebase", s.selectionRebase)
	rpc.Register(srv, "selection.paths", s.selectionPaths)

	rpc.Register(srv, "library.get", func(ctx context.Context, _ emptyParams) (libraryState, error) {
		lib, err := s.library(ctx)
		if err != nil {
			return libraryState{}, err
		}
		st := libraryState{}
		if st.Settings, err = lib.Settings(ctx); err == nil {
			if st.Bookmarks, err = lib.Bookmarks(ctx); err == nil {
				st.Recent, err = lib.Recent(ctx, 20)
			}
		}
		if err != nil {
			return libraryState{}, dbError(err)
		}
		return st, nil
	})
	rpc.Register(srv, "library.setSetting", func(ctx context.Context, p setSettingParams) (okResult, error) {
		lib, err := s.library(ctx)
		if err != nil {
			return okResult{}, err
		}
		return okResult{OK: true}, libError(lib.SetSetting(ctx, p.Key, p.Value))
	})
	rpc.Register(srv, "library.addBookmark", func(ctx context.Context, p addBookmarkParams) (library.Bookmark, error) {
		lib, err := s.library(ctx)
		if err != nil {
			return library.Bookmark{}, err
		}
		clean, err := pathkey.Clean(p.Path)
		if err != nil {
			return library.Bookmark{}, rpc.NewError(rpc.CodeInvalidPath, "bookmark path must be absolute")
		}
		b, err := lib.AddBookmark(ctx, clean, p.Label, p.Group)
		if err == nil {
			s.bookmarksChanged(ctx, lib)
		}
		return b, libError(err)
	})
	rpc.Register(srv, "library.updateBookmark", func(ctx context.Context, p updateBookmarkParams) (library.Bookmark, error) {
		lib, err := s.library(ctx)
		if err != nil {
			return library.Bookmark{}, err
		}
		clean, err := pathkey.Clean(p.Path)
		if err != nil {
			return library.Bookmark{}, rpc.NewError(rpc.CodeInvalidPath, "bookmark path must be absolute")
		}
		b, err := lib.UpdateBookmark(ctx, library.Bookmark{ID: p.ID, Path: clean, Label: p.Label, Group: p.Group})
		if err == nil {
			s.bookmarksChanged(ctx, lib)
		}
		return b, libError(err)
	})
	rpc.Register(srv, "library.reorderBookmarks", func(ctx context.Context, p reorderBookmarksParams) (okResult, error) {
		lib, err := s.library(ctx)
		if err != nil {
			return okResult{}, err
		}
		if err := lib.ReorderBookmarks(ctx, p.IDs); err != nil {
			return okResult{}, libError(err)
		}
		s.bookmarksChanged(ctx, lib)
		return okResult{OK: true}, nil
	})
	rpc.Register(srv, "library.removeBookmark", func(ctx context.Context, p removeBookmarkParams) (okResult, error) {
		lib, err := s.library(ctx)
		if err != nil {
			return okResult{}, err
		}
		if err := lib.RemoveBookmark(ctx, p.ID); err != nil {
			return okResult{}, libError(err)
		}
		s.bookmarksChanged(ctx, lib)
		return okResult{OK: true}, nil
	})
}

// bookmarksChanged sends the whole list (at most MaxBookmarks small rows)
// to both apps, so the viewer's bookmarks and the commander's hotlist stay
// one list (ADR-0031). Coalesced: a burst of edits sends the last list.
func (s *indexService) bookmarksChanged(ctx context.Context, lib *library.Library) {
	list, err := lib.Bookmarks(ctx)
	if err != nil {
		s.log.Warn("bookmarks changed", "err", err)
		return
	}
	s.events.Post(evBookmarksChanged, "", bookmarksEvent{Bookmarks: list})
}

// library waits for library.db to finish opening (tens of milliseconds
// after start at most).
func (s *indexService) library(ctx context.Context) (*library.Library, error) {
	select {
	case <-s.libReady:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if s.lib == nil {
		return nil, rpc.NewError(rpc.CodeDBError, "the library database is unavailable")
	}
	return s.lib, nil
}

func libError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, library.ErrInvalid):
		return rpc.NewError(rpc.CodeInvalidArgument, err.Error())
	case errors.Is(err, library.ErrNotFound):
		return rpc.NewError(rpc.CodeNotFound, err.Error())
	case errors.Is(err, library.ErrDuplicate):
		e := rpc.NewError(rpc.CodeInvalidArgument, err.Error())
		e.Details = map[string]string{"reason": "duplicate"}
		return e
	case errors.Is(err, library.ErrTooManyItems):
		return rpc.NewError(rpc.CodeInvalidArgument, err.Error())
	}
	return dbError(err)
}

func validExt(e string) bool {
	if e == "" || len(e) > 10 {
		return false
	}
	for _, c := range e {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

func statError(err error, what string) error {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return rpc.NewError(rpc.CodeNotFound, what+" does not exist")
	case errors.Is(err, fs.ErrPermission):
		return rpc.NewError(rpc.CodePermissionDenied, "no permission to open this "+what)
	}
	return rpc.NewError(rpc.CodeInvalidPath, err.Error())
}

func (s *indexService) fsListDirs(ctx context.Context, p fsListDirsParams) (fsListDirsResult, error) {
	clean, err := pathkey.Clean(p.Path)
	if err != nil {
		return fsListDirsResult{}, rpc.NewError(rpc.CodeInvalidPath, "folder path must be absolute")
	}
	dirs, truncated, err := fsx.ListDirs(ctx, clean, fsx.ListOptions{ShowHidden: p.ShowHidden})
	if err != nil {
		if ctx.Err() != nil {
			return fsListDirsResult{}, ctx.Err()
		}
		return fsListDirsResult{}, statError(err, "folder")
	}
	if dirs == nil {
		dirs = []fsx.DirChild{}
	}
	return fsListDirsResult{Path: clean, Dirs: dirs, Truncated: truncated}, nil
}

func (s *indexService) entryPath(ctx context.Context, p entryParams) (entryPathResult, error) {
	if remote.IsID(p.EntryID) {
		// A file on a server has no path on this computer: nothing is started
		// with it, revealed or handed to a command (ADR-0037).
		return entryPathResult{}, rpc.NewError(rpc.CodeInvalidArgument, "this is not available on a connection")
	}
	if archive.IsID(p.EntryID) {
		// Opened with its program from a temporary extraction (Stage C07).
		f, err := s.archiveFileResolve(ctx, p.EntryID)
		if err != nil {
			return entryPathResult{}, err
		}
		fi, err := os.Stat(f.Path)
		if err != nil {
			return entryPathResult{}, statError(err, "file")
		}
		return entryPathResult{Path: f.Path, Kind: f.Kind, Program: fsx.IsProgram(f.Path, fi)}, nil
	}
	paths, err := s.store.EntryPaths(ctx, []int64{p.EntryID})
	if err != nil {
		return entryPathResult{}, dbError(err)
	}
	if len(paths) == 0 {
		return entryPathResult{}, rpc.NewError(rpc.CodeNotFound, "not in the index")
	}
	fi, err := os.Stat(paths[0].Path)
	if err != nil {
		return entryPathResult{}, statError(err, "file")
	}
	return entryPathResult{Path: paths[0].Path, Kind: paths[0].Kind.String(), Program: fsx.IsProgram(paths[0].Path, fi)}, nil
}

func msPtr(ns int64) *int64 {
	if ns <= 0 {
		return nil
	}
	ms := ns / int64(time.Millisecond)
	return &ms
}

func (s *indexService) propsGet(ctx context.Context, p entryParams) (propsResult, error) {
	if remote.IsID(p.EntryID) {
		return s.remoteProps(p.EntryID)
	}
	if archive.IsID(p.EntryID) {
		return s.archiveProps(p.EntryID)
	}
	d, err := s.store.Entry(ctx, p.EntryID)
	if errors.Is(err, index.ErrNotFound) {
		return propsResult{}, rpc.NewError(rpc.CodeNotFound, "not in the index")
	}
	if err != nil {
		return propsResult{}, dbError(err)
	}
	res := propsResult{ID: d.ID, Kind: d.Kind.String(), Name: d.Name, Ext: d.Ext, Path: d.Path,
		SizeBytes: d.Size, ModifiedMs: d.MtimeNs / int64(time.Millisecond), CreatedMs: msPtr(d.BtimeNs)}
	// Live stat: properties show the file as it is now, and access time is
	// not indexed.
	if fi, err := fsx.Stat(d.Path); err == nil {
		t := fsx.FileTimes(fi)
		res.Exists = true
		res.ModifiedMs = fi.ModTime().UnixMilli()
		res.CreatedMs, res.AccessedMs = msPtr(t.BirthNs), msPtr(t.AccessNs)
		if !fi.IsDir() {
			res.SizeBytes = fi.Size()
		}
	}
	// The entry itself, not what a link points to.
	if li, err := os.Lstat(d.Path); err == nil {
		res.Exists = true
		res.Attrs = fsx.AttrsOf(d.Name, li)
		if runtime.GOOS != "windows" {
			mode := int(li.Mode().Perm())
			res.Permissions = &mode
		}
		if res.Attrs&fsx.AttrLink != 0 {
			if target, err := os.Readlink(d.Path); err == nil {
				res.LinkTarget = &target
			}
		}
	}
	if d.Width > 0 && d.Height > 0 {
		res.Width, res.Height = &d.Width, &d.Height
	}
	if d.Listed {
		res.ChildFolders, res.ChildMedia = &d.ChildDirs, &d.ChildMedia
	}
	res.Tags = []string{}
	if d.Kind != media.KindDir {
		s.addAnnotation(ctx, &res)
	}
	return res, nil
}

// addAnnotation fills favorite, rating and tags; without library.db they
// stay empty, as on page rows.
func (s *indexService) addAnnotation(ctx context.Context, res *propsResult) {
	targets, err := s.store.Targets(ctx, []int64{res.ID})
	if err != nil || len(targets) == 0 {
		return
	}
	lib, err := s.library(ctx)
	if err != nil {
		return
	}
	ann, err := lib.Annotations(ctx, []string{targets[0].Key}, true)
	if err != nil {
		s.log.Warn("properties annotations", "err", err)
		return
	}
	if a, ok := ann[targets[0].Key]; ok {
		res.Favorite, res.Rating, res.Label = a.Favorite, a.Rating, a.Label
		if a.Tags != nil {
			res.Tags = a.Tags
		}
	}
}

// resolveSelection turns a descriptor into ids in session order (ranges
// first, then explicit additions), without duplicates.
func (s *indexService) resolveSelection(sel selectionWire) ([]int64, error) {
	if len(sel.Ranges) > MaxSelectionRanges || len(sel.Include) > MaxSelectionIDs || len(sel.Exclude) > MaxSelectionIDs {
		return nil, rpc.NewError(rpc.CodeInvalidArgument, "selection descriptor is too large")
	}
	ids, _, err := s.queries.IDs(sel.QueryID, sel.Version)
	switch {
	case errors.Is(err, query.ErrUnknownSession):
		return nil, rpc.NewError(rpc.CodeNotFound, "query session expired; reopen it")
	case errors.Is(err, query.ErrStaleVersion):
		return nil, rpc.NewError(rpc.CodeInvalidArgument, "selection refers to an outdated version of the folder")
	case err != nil:
		return nil, dbError(err)
	}
	return applySelection(ids, sel)
}

func applySelection(ids []int64, sel selectionWire) ([]int64, error) {
	exclude := make(map[int64]bool, len(sel.Exclude))
	for _, id := range sel.Exclude {
		exclude[id] = true
	}
	seen := map[int64]bool{}
	out := []int64{}
	for _, r := range sel.Ranges {
		if r[0] < 0 || r[1] < r[0] {
			return nil, rpc.NewError(rpc.CodeInvalidArgument, "selection ranges must be [start, end) with 0 <= start <= end")
		}
		for _, id := range ids[min(r[0], len(ids)):min(r[1], len(ids))] {
			if !exclude[id] && !seen[id] {
				seen[id] = true
				out = append(out, id)
			}
		}
	}
	for _, id := range sel.Include {
		if !exclude[id] && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

// selectionRebase maps a descriptor onto the session's current version as
// ranges only; entries that left the session drop out.
func (s *indexService) selectionRebase(_ context.Context, p selectionParams) (selectionWire, error) {
	chosen, err := s.resolveSelection(p.Selection)
	if err != nil {
		return selectionWire{}, err
	}
	ids, cur, err := s.queries.Current(p.Selection.QueryID)
	if err != nil {
		return selectionWire{}, rpc.NewError(rpc.CodeNotFound, "query session expired; reopen it")
	}
	return rebase(ids, chosen, p.Selection.QueryID, cur), nil
}

func rebase(current, chosen []int64, queryID, version int64) selectionWire {
	want := make(map[int64]bool, len(chosen))
	for _, id := range chosen {
		want[id] = true
	}
	out := selectionWire{QueryID: queryID, Version: version, Ranges: [][2]int{}, Include: []int64{}, Exclude: []int64{}}
	start := -1
	for i, id := range current {
		switch {
		case want[id] && start < 0:
			start = i
		case !want[id] && start >= 0:
			out.Ranges = append(out.Ranges, [2]int{start, i})
			start = -1
		}
	}
	if start >= 0 {
		out.Ranges = append(out.Ranges, [2]int{start, len(current)})
	}
	return out
}

func (s *indexService) selectionPaths(ctx context.Context, p selectionPathsParams) (selectionPathsResult, error) {
	limit := p.Limit
	if limit <= 0 || limit > MaxCopyPaths {
		limit = MaxCopyPaths
	}
	ids, err := s.resolveSelection(p.Selection)
	if err != nil {
		return selectionPathsResult{}, err
	}
	res := selectionPathsResult{Truncated: len(ids) > limit}
	paths, err := s.store.EntryPaths(ctx, ids[:min(len(ids), limit)])
	if err != nil {
		return res, dbError(err)
	}
	res.Paths = make([]string, len(paths))
	for i, p := range paths {
		res.Paths[i] = p.Path
	}
	return res, nil
}
