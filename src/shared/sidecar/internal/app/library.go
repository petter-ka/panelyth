package app

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"time"

	"panelyth/sidecar/internal/archive"
	"panelyth/sidecar/internal/compare"
	"panelyth/sidecar/internal/editor"
	"panelyth/sidecar/internal/events"
	"panelyth/sidecar/internal/find"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/library"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/meta"
	"panelyth/sidecar/internal/pathkey"
	"panelyth/sidecar/internal/preview"
	"panelyth/sidecar/internal/query"
	"panelyth/sidecar/internal/rpc"
	"panelyth/sidecar/internal/scan"
	"panelyth/sidecar/internal/video"
	"panelyth/sidecar/internal/watch"
)

// Event channels (mirrors src/shared/contracts/src/events.ts).
const (
	evIndexProgress    = "index.progress"
	evQueryInvalidated = "query.invalidated"
	evPreviewReady     = "preview.ready"
	evFolderCovers     = "folder.covers"
)

// DefaultCacheMaxBytes is the preview cache ceiling unless
// PANELYTH_CACHE_MAX_BYTES overrides it.
const DefaultCacheMaxBytes = 2 << 30

// indexService wires store, scans, sessions, watcher and events together.
type indexService struct {
	log     *slog.Logger
	store   *index.Store
	scans   *scan.Manager
	queries *query.Manager
	finds   *find.Manager
	// archives are the open archives (Stage C07, ADR-0030).
	archives *archive.Manager
	// compares are the directory compares of synchronize dialogs, diffs the
	// open text comparisons (Stage C08).
	compares *compare.Manager
	diffs    textDiffs
	// previews holds the entries of the multi-rename being previewed (Stage C09).
	previews renamePreviews
	watcher  *watch.Watcher
	events   *events.Coalescer
	disk     *preview.DiskCache
	preview  *preview.Service
	video    *video.Tools
	jobs     *jobs.Manager
	meta     *meta.Extractor
	// editor holds the image editor's sessions, saves where its recent
	// saves wrote (Stage 12, ADR-0035).
	editor  *editor.Manager
	saves   editSaves
	clip    clipboard
	clipImg *clipImager
	context *sharedContext
	stopBg  context.CancelFunc
	bg      context.Context
	volumes volumeMonitor
	// lib is set before libReady closes; nil when library.db could not be
	// opened (user-data methods then fail, browsing keeps working).
	lib      *library.Library
	libReady chan struct{}
}

// newIndexService opens index.db and the preview cache under cacheRoot
// (ADR-0016) and starts background maintenance.
func newIndexService(cacheRoot string, cacheMaxBytes int64, log *slog.Logger, emit events.EmitFunc, tools *video.Tools, sevenZip *archive.Tool) (*indexService, error) {
	store, err := index.Open(filepath.Join(cacheRoot, "db", "index.db"), log)
	if err != nil {
		return nil, err
	}
	disk, err := preview.OpenDiskCache(cacheRoot)
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	svc := &indexService{log: log, store: store, disk: disk, events: events.New(emit, 50*time.Millisecond),
		libReady: make(chan struct{}), video: tools, clipImg: newClipImager(cacheRoot)}
	svc.context = &sharedContext{svc: svc}
	svc.preview = preview.NewService(store, disk, log, preview.Options{Video: tools}, func(it preview.Item) {
		svc.events.Append(evPreviewReady, it)
	})
	svc.preview.SetCoverEmitter(func(it preview.CoverItem) {
		svc.events.Append(evFolderCovers, it)
	})
	bg, stop := context.WithCancel(context.Background())
	svc.stopBg, svc.bg = stop, bg
	preview.NewCleaner(store, disk, log, cacheMaxBytes).Start(bg, 30*time.Second, 30*time.Minute)
	// Dimensions and duration are extracted lazily, only for sessions
	// sorted by them (ADR-0021).
	svc.meta = meta.New(store, tools, log, meta.Options{}, func(id int64) { svc.queries.Refresh(id) })
	svc.queries = query.NewManager(store, log, query.Options{
		User: svc.userRows,
		Materialized: func(id int64, d index.Descriptor, ids []int64) {
			if slices.ContainsFunc(d.Sort, func(k index.SortKey) bool { return index.MetaSort(k.Field) }) {
				svc.meta.Want(id, ids)
			} else {
				svc.meta.Drop(id)
			}
		},
		Dropped: func(id int64) {
			svc.meta.Drop(id)
			svc.finds.Dropped(id)
			svc.archives.Dropped(id)
			svc.compares.Dropped(id)
		},
	}, func(s query.Snapshot) {
		svc.events.Post(evQueryInvalidated, strconv.FormatInt(s.QueryID, 10), s)
	})
	// Entries viewed from archives are extracted to <cache>/tmp/archive.
	svc.archives = archive.NewManager(sevenZip, filepath.Join(cacheRoot, "tmp", "archive"), log)
	svc.finds = find.NewManager(find.Deps{Store: store, Log: log, Progress: svc.emitFind, Refresh: svc.queries.Refresh})
	// A compare's session is current before its progress says so.
	svc.compares = compare.NewManager(compare.Deps{Log: log, Progress: svc.emitCompare,
		Refresh: func(id int64) { _, _ = svc.queries.RefreshNow(id) }})
	svc.scans = scan.NewManager(store, log, scan.Options{}, scan.Hooks{
		Progress: func(p scan.Progress) {
			svc.events.Post(evIndexProgress, strconv.FormatInt(p.ScanID, 10), p)
		},
		Changed: svc.changed,
	}, nil)
	svc.watcher = watch.New(log, svc.scans.Relist, 300*time.Millisecond, 2*time.Second)
	svc.jobs = jobs.NewManager(jobs.Deps{Store: store, Library: svc.library, Changed: svc.changed,
		Emit: svc.emitJob, Ask: svc.askJob, Archive: sevenZip, Log: log})
	// Frames go to <cache>/tmp/edit; a session's memory comes out of the
	// decode budget previews use.
	svc.editor = editor.NewManager(editor.Config{TmpDir: filepath.Join(cacheRoot, "tmp", "edit"),
		Reserve: svc.preview.ReserveDecode, Log: log})
	return svc, nil
}

func (s *indexService) close() {
	s.stopBg()
	s.jobs.Close()
	s.editor.Shutdown()
	s.finds.Close()
	s.compares.Shutdown()
	s.previews.drop()
	s.watcher.Close()
	s.scans.Close()
	s.meta.Close()
	s.preview.Close()
	s.queries.Shutdown()
	s.archives.Shutdown()
	s.events.Close()
	if err := s.store.Close(); err != nil {
		s.log.Warn("close index", "err", err)
	}
}

// Wire types (mirror src/shared/contracts/src/rpc.ts).
type (
	dirOpenParams struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
		// Lane names the caller's foreground scan slot (a commander panel);
		// a new scan cancels only the previous one in its lane.
		Lane string `json:"lane"`
	}
	dirOpenResult struct {
		DirID        int64  `json:"dirId"`
		Path         string `json:"path"`
		Name         string `json:"name"`
		ScanID       int64  `json:"scanId"`
		Recursive    bool   `json:"recursive"`
		ListedBefore bool   `json:"listedBefore"`
		LastListedAt *int64 `json:"lastListedAt"`
		// Crumbs are the folder's ancestors, root first, ending with itself.
		Crumbs []fsx.Crumb `json:"crumbs"`
	}
	dirOpenEntryParams struct {
		EntryID   int64  `json:"entryId"`
		Recursive bool   `json:"recursive"`
		Lane      string `json:"lane"`
	}
	cancelScanParams struct {
		ScanID int64 `json:"scanId"`
	}
	cancelScanResult struct {
		Cancelled bool `json:"cancelled"`
	}
	sortKeyWire struct {
		Field     string `json:"field"`
		Direction string `json:"direction"`
	}
	queryOpenParams struct {
		DirID     int64         `json:"dirId"`
		Recursive bool          `json:"recursive"`
		Sort      []sortKeyWire `json:"sort"`
		Kinds     []string      `json:"kinds"`
		Search    string        `json:"search"`
		Exts      []string      `json:"exts"`
		// User-data filters (Stage 07, ADR-0021).
		Favorite  bool     `json:"favorite"`
		MinRating int      `json:"minRating"`
		Tags      []string `json:"tags"`
		// Entry scope (Stage P02, ADR-0026); the viewer sends none of these.
		Scope      string `json:"scope"`
		ShowHidden bool   `json:"showHidden"`
		NameMask   string `json:"nameMask"`
		// FindID opens a session over a search's results (Stage C06); the
		// folder fields do not apply then.
		FindID int64 `json:"findId"`
		// ArchiveID opens a folder of an open archive (Stage C07):
		// ArchiveDirID is the folder's entry id, 0 for the root.
		ArchiveID    int64 `json:"archiveId"`
		ArchiveDirID int64 `json:"archiveDirId"`
	}
	queryPageParams struct {
		QueryID int64 `json:"queryId"`
		Offset  int   `json:"offset"`
		Limit   int   `json:"limit"`
		// ThumbProfile, when set, attaches already-cached preview URLs.
		ThumbProfile string `json:"thumbProfile"`
	}
	contentItem struct {
		ID         int64  `json:"id"`
		Kind       string `json:"kind"`
		Name       string `json:"name"`
		Ext        string `json:"ext"`
		SizeBytes  int64  `json:"sizeBytes"`
		ModifiedMs int64  `json:"modifiedMs"`
		Favorite   bool   `json:"favorite"`
		Rating     int    `json:"rating"`
		Label      int    `json:"label"`
		// Attrs is the fsx.Attr* bit set; sent only in the all scope.
		Attrs int `json:"attrs,omitempty"`
		// DirSizeBytes is a folder's calculated size (Stage C02); omitted until calculated.
		DirSizeBytes *int64 `json:"dirSizeBytes,omitempty"`
		// DirPath is the entry's folder, in sessions spanning folders (find
		// results, branch views; Stage C06).
		DirPath string `json:"dirPath,omitempty"`
		// Diff is set on the rows of a directory compare (Stage C08).
		Diff  *diffWire `json:"diff,omitempty"`
		Thumb *thumb    `json:"thumb"`
	}
	thumb struct {
		URL    string `json:"url"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	}
	previewEnsureItem struct {
		ID       int64 `json:"id"`
		Priority int   `json:"priority"`
	}
	previewEnsureParams struct {
		Lane    string              `json:"lane"`
		Epoch   uint64              `json:"epoch"`
		Profile string              `json:"profile"`
		Items   []previewEnsureItem `json:"items"`
		Force   []int64             `json:"force"`
	}
	previewEnsureResult struct {
		Items    []preview.Item `json:"items"`
		Queued   int            `json:"queued"`
		Deferred int            `json:"deferred"`
	}
	folderCoversParams struct {
		Lane    string              `json:"lane"`
		Epoch   uint64              `json:"epoch"`
		Profile string              `json:"profile"`
		Items   []previewEnsureItem `json:"items"`
	}
	folderCoversResult struct {
		Items []preview.FolderCover `json:"items"`
	}
	queryPageResult struct {
		QueryID int64         `json:"queryId"`
		Version int64         `json:"version"`
		Total   int           `json:"total"`
		Offset  int           `json:"offset"`
		Items   []contentItem `json:"items"`
	}
	queryCloseParams struct {
		QueryID int64 `json:"queryId"`
	}
	queryCloseResult struct {
		Closed bool `json:"closed"`
	}
)

func (s *indexService) register(srv *rpc.Server) {
	rpc.Register(srv, "dir.open", s.dirOpen)
	rpc.Register(srv, "dir.openEntry", s.dirOpenEntry)
	rpc.Register(srv, "dir.cancelScan", func(_ context.Context, p cancelScanParams) (cancelScanResult, error) {
		return cancelScanResult{Cancelled: s.scans.Cancel(p.ScanID)}, nil
	})
	rpc.Register(srv, "query.open", s.queryOpen)
	rpc.Register(srv, "query.page", s.queryPage)
	rpc.Register(srv, "preview.ensure", s.previewEnsure)
	rpc.Register(srv, "folder.covers", s.folderCovers)
	s.registerMedia(srv)
	s.registerWorkspace(srv)
	s.registerJobs(srv)
	s.registerContext(srv)
	s.registerFind(srv)
	s.registerArchives(srv)
	s.registerCompare(srv)
	s.registerRename(srv)
	s.registerEditor(srv)
	s.registerBatch(srv)
	rpc.Register(srv, "query.close", func(_ context.Context, p queryCloseParams) (queryCloseResult, error) {
		return queryCloseResult{Closed: s.queries.Close(p.QueryID)}, nil
	})
}

func (s *indexService) dirOpen(ctx context.Context, p dirOpenParams) (dirOpenResult, error) {
	clean, err := pathkey.Clean(p.Path)
	if err != nil {
		return dirOpenResult{}, rpc.NewError(rpc.CodeInvalidPath, "folder path must be absolute")
	}
	fi, err := os.Stat(clean)
	if err == nil && !fi.IsDir() {
		return dirOpenResult{}, rpc.NewError(rpc.CodeInvalidPath, "path is not a folder")
	}
	if err == nil {
		// Windows stats folders the user cannot list: read one name so a
		// denied folder is an error here, not an empty listing (CFR-28).
		err = probeDir(clean)
	}
	if err != nil {
		return dirOpenResult{}, openError(err)
	}
	info, err := s.store.EnsureDir(ctx, clean)
	if err != nil {
		return dirOpenResult{}, dbError(err)
	}
	if len(p.Lane) > 16 {
		return dirOpenResult{}, rpc.NewError(rpc.CodeInvalidArgument, "lane must be at most 16 characters")
	}
	scanID, err := s.scans.Open(info, p.Recursive, p.Lane)
	if err != nil {
		return dirOpenResult{}, dbError(err)
	}
	s.watcher.Watch(info.ID, clean)
	if lib, lerr := s.library(ctx); lerr == nil {
		if err := lib.TouchRecent(ctx, info.Key, info.Path); err != nil {
			s.log.Warn("record recent folder", "err", err)
		}
	}
	res := dirOpenResult{
		DirID: info.ID, Path: info.Path, Name: filepath.Base(info.Path), ScanID: scanID, Recursive: p.Recursive,
		ListedBefore: info.ListingState == index.ListingComplete, Crumbs: fsx.Crumbs(info.Path),
	}
	if info.Name != "" {
		res.Name = info.Name
	}
	if info.LastListedAt > 0 {
		res.LastListedAt = &info.LastListedAt
	}
	return res, nil
}

func (s *indexService) queryOpen(ctx context.Context, p queryOpenParams) (query.Snapshot, error) {
	d := index.Descriptor{DirID: p.DirID, Recursive: p.Recursive, Scope: index.Scope(p.Scope), ShowHidden: p.ShowHidden}
	if !index.ValidScope(d.Scope) {
		return query.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "scope must be media or all")
	}
	if p.ShowHidden && d.Scope != index.ScopeAll {
		return query.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "showHidden needs the all scope")
	}
	if len(p.NameMask) > index.MaxMaskLen {
		return query.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "name mask is too long")
	}
	d.NameMask = p.NameMask
	if len(p.Sort) > 4 {
		return query.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "at most 4 sort keys")
	}
	for _, k := range p.Sort {
		f := index.SortField(k.Field)
		if !index.ValidSortField(f) || (k.Direction != "asc" && k.Direction != "desc") {
			return query.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "invalid sort key "+k.Field+" "+k.Direction)
		}
		d.Sort = append(d.Sort, index.SortKey{Field: f, Desc: k.Direction == "desc"})
	}
	if len(p.Search) > index.MaxSearchLen {
		return query.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "search is too long")
	}
	d.Search = p.Search
	if len(p.Exts) > index.MaxExts {
		return query.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "too many extensions")
	}
	for _, e := range p.Exts {
		if !validExt(e) {
			return query.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "invalid extension "+e)
		}
		d.Exts = append(d.Exts, e)
	}
	for _, k := range p.Kinds {
		kind, ok := media.ParseKind(k)
		if !ok {
			return query.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "invalid kind "+k)
		}
		d.Kinds = append(d.Kinds, kind)
	}
	if p.MinRating < 0 || p.MinRating > library.MaxRating {
		return query.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "minRating must be 0..5")
	}
	if len(p.Tags) > MaxTagFilters {
		return query.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "at most 16 tags")
	}
	for _, t := range p.Tags {
		clean, err := library.CleanTag(t)
		if err != nil {
			return query.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "invalid tag "+t)
		}
		d.Tags = append(d.Tags, clean)
	}
	d.FavoriteOnly, d.MinRating = p.Favorite, p.MinRating
	if p.ArchiveID != 0 {
		if d.Scope != index.ScopeAll || d.Recursive || p.FindID != 0 {
			return query.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "archive folders need the all scope and no recursion")
		}
		return s.openArchiveQuery(ctx, p.ArchiveID, p.ArchiveDirID, d)
	}
	if p.FindID != 0 {
		if d.Scope != index.ScopeAll || d.Recursive {
			return query.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "search results need the all scope and no recursion")
		}
		return s.openFindQuery(ctx, p.FindID, d)
	}
	snap, err := s.queries.Open(ctx, d)
	if errors.Is(err, index.ErrNotFound) {
		return snap, rpc.NewError(rpc.CodeNotFound, "folder is not indexed")
	}
	if err != nil {
		return snap, dbError(err)
	}
	return snap, nil
}

func (s *indexService) queryPage(ctx context.Context, p queryPageParams) (queryPageResult, error) {
	if p.Offset < 0 || p.Limit < 1 || p.Limit > query.MaxPageSize {
		return queryPageResult{}, rpc.NewError(rpc.CodeInvalidArgument, "offset must be >= 0 and limit 1..1000")
	}
	page, err := s.queries.Page(ctx, p.QueryID, p.Offset, p.Limit)
	if errors.Is(err, query.ErrUnknownSession) {
		return queryPageResult{}, rpc.NewError(rpc.CodeNotFound, "query session expired; reopen it")
	}
	if err != nil {
		return queryPageResult{}, dbError(err)
	}
	var thumbs map[int64]preview.Item
	if p.ThumbProfile != "" {
		thumbs, err = s.preview.Thumbs(ctx, page.Items, preview.Profile(p.ThumbProfile))
		if errors.Is(err, preview.ErrUnknownProfile) {
			return queryPageResult{}, rpc.NewError(rpc.CodeInvalidArgument, "unknown thumbnail profile")
		}
		if err != nil {
			return queryPageResult{}, dbError(err)
		}
	}
	var dirs map[int64]string
	if s.queries.SpansFolders(p.QueryID) {
		ids := make([]int64, len(page.Items))
		for i, it := range page.Items {
			ids[i] = it.ID
		}
		if dirs, err = s.store.ParentPaths(ctx, ids); err != nil {
			return queryPageResult{}, dbError(err)
		}
	}
	ann := s.annotations(ctx, page.Items)
	diffs := s.compareDiffs(p.QueryID, page.Items)
	items := make([]contentItem, len(page.Items))
	for i, it := range page.Items {
		a := ann[it.PathKey]
		items[i] = contentItem{ID: it.ID, Kind: it.Kind.String(), Name: it.Name, Ext: it.Ext,
			SizeBytes: it.Size, ModifiedMs: it.MtimeNs / int64(time.Millisecond), Favorite: a.Favorite, Rating: a.Rating, Label: a.Label,
			Attrs: it.Attrs, DirPath: dirs[it.ID]}
		if it.DirSize >= 0 {
			items[i].DirSizeBytes = &it.DirSize
		}
		if t, ok := thumbs[it.ID]; ok {
			items[i].Thumb = &thumb{URL: t.URL, Width: t.Width, Height: t.Height}
		}
		if d, ok := diffs[it.ID]; ok {
			items[i].Diff = diffOf(d)
		}
	}
	return queryPageResult{QueryID: page.QueryID, Version: page.Version, Total: page.Total, Offset: page.Offset, Items: items}, nil
}

// probeDir reads the first name of a folder.
func probeDir(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Readdirnames(1); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

// openError maps a folder that cannot be opened to the protocol. Volumes
// that are there but unreadable right now carry details.reason "notReady"
// or "network" (CFR-28).
func openError(err error) error {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return rpc.NewError(rpc.CodeNotFound, "folder does not exist")
	case errors.Is(err, fs.ErrPermission):
		return rpc.NewError(rpc.CodePermissionDenied, "no permission to open this folder")
	}
	switch reason := fsx.Unavailable(err); reason {
	case "notReady":
		e := rpc.NewError(rpc.CodeInvalidPath, "the drive is not ready")
		e.Retryable, e.Details = true, map[string]string{"reason": reason}
		return e
	case "network":
		e := rpc.NewError(rpc.CodeInvalidPath, "the network location is unavailable")
		e.Retryable, e.Details = true, map[string]string{"reason": reason}
		return e
	}
	return rpc.NewError(rpc.CodeInvalidPath, err.Error())
}

func dbError(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return rpc.NewError(rpc.CodeDBError, err.Error())
}

// MaxEnsureItems bounds one preview.ensure call (visible range + overscan).
const MaxEnsureItems = 500

func (s *indexService) previewEnsure(ctx context.Context, p previewEnsureParams) (previewEnsureResult, error) {
	if len(p.Items) > MaxEnsureItems || len(p.Force) > MaxEnsureItems {
		return previewEnsureResult{}, rpc.NewError(rpc.CodeInvalidArgument, "at most 500 items per call")
	}
	if p.Lane == "" || len(p.Lane) > 32 {
		return previewEnsureResult{}, rpc.NewError(rpc.CodeInvalidArgument, "lane must be 1..32 characters")
	}
	req := preview.EnsureRequest{Lane: p.Lane, Epoch: p.Epoch, Profile: preview.Profile(p.Profile), Force: p.Force}
	for _, it := range p.Items {
		if it.Priority < int(preview.PriorityVisible) || it.Priority > int(preview.PriorityIdle) {
			return previewEnsureResult{}, rpc.NewError(rpc.CodeInvalidArgument, "priority must be 0..3")
		}
		req.Items = append(req.Items, preview.EnsureItem{ID: it.ID, Priority: preview.Priority(it.Priority)})
	}
	res, err := s.preview.Ensure(ctx, req)
	if errors.Is(err, preview.ErrUnknownProfile) {
		return previewEnsureResult{}, rpc.NewError(rpc.CodeInvalidArgument, "unknown preview profile")
	}
	if err != nil {
		return previewEnsureResult{}, dbError(err)
	}
	return previewEnsureResult{Items: res.Items, Queued: res.Queued, Deferred: res.Deferred}, nil
}

// MaxCoverDirs bounds one folder.covers call (visible folder tiles + overscan).
const MaxCoverDirs = 200

// folderCovers returns up to four media previews per folder tile (ADR-0024).
func (s *indexService) folderCovers(ctx context.Context, p folderCoversParams) (folderCoversResult, error) {
	if len(p.Items) > MaxCoverDirs {
		return folderCoversResult{}, rpc.NewError(rpc.CodeInvalidArgument, "at most 200 folders per call")
	}
	if p.Lane == "" || len(p.Lane) > 32 {
		return folderCoversResult{}, rpc.NewError(rpc.CodeInvalidArgument, "lane must be 1..32 characters")
	}
	req := preview.CoversRequest{Lane: p.Lane, Epoch: p.Epoch, Profile: preview.Profile(p.Profile)}
	for _, it := range p.Items {
		if it.Priority < int(preview.PriorityVisible) || it.Priority > int(preview.PriorityIdle) {
			return folderCoversResult{}, rpc.NewError(rpc.CodeInvalidArgument, "priority must be 0..3")
		}
		req.Items = append(req.Items, preview.EnsureItem{ID: it.ID, Priority: preview.Priority(it.Priority)})
	}
	items, err := s.preview.Covers(ctx, req)
	if errors.Is(err, preview.ErrUnknownProfile) {
		return folderCoversResult{}, rpc.NewError(rpc.CodeInvalidArgument, "unknown preview profile")
	}
	if err != nil {
		return folderCoversResult{}, dbError(err)
	}
	if items == nil {
		items = []preview.FolderCover{}
	}
	return folderCoversResult{Items: items}, nil
}

// dirOpenEntry opens a folder by its index id (a folder tile), so the
// renderer never assembles OS paths from names.
func (s *indexService) dirOpenEntry(ctx context.Context, p dirOpenEntryParams) (dirOpenResult, error) {
	info, err := s.store.Dir(ctx, p.EntryID)
	if errors.Is(err, index.ErrNotFound) {
		return dirOpenResult{}, rpc.NewError(rpc.CodeNotFound, "folder is not in the index")
	}
	if err != nil {
		return dirOpenResult{}, dbError(err)
	}
	return s.dirOpen(ctx, dirOpenParams{Path: info.Path, Recursive: p.Recursive, Lane: p.Lane})
}
