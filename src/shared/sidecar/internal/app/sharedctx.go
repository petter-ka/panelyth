package app

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"time"

	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/query"
	"panelyth/sidecar/internal/rpc"
)

// The shared context (ADR-0031, docs/shared/APP-SWITCHING.md): the folder
// and the entry the visible app is on. The app being left publishes it, the
// app being shown reads it. It lives in memory and is persisted as the
// shared.context setting, debounced and flushed on shutdown, so the next
// start opens the last used app.

const (
	sharedContextKey  = "shared.context"
	contextSaveDelay  = time.Second
	contextSaveBudget = 2 * time.Second
)

// Mirrors src/shared/contracts/src/rpc.ts.
type (
	contextPublishParams struct {
		App     string `json:"app"`
		DirID   int64  `json:"dirId"`
		FocusID *int64 `json:"focusId"`
		// Selection (Stage C02) is resolved to at most MaxContextSelection ids.
		// Absent (navigation publishes) keeps the carried selection for the
		// version that published it; null (a switch with nothing selected)
		// clears it.
		Selection json.RawMessage `json:"selection"`
	}
	// appSetVisibleParams names the app on screen (Stage P02, ADR-0026).
	// Electron main sends it at start and on every switch; no renderer can.
	appSetVisibleParams struct {
		App string `json:"app"`
		// Seq orders main's calls: requests are handled concurrently, and
		// after a quick switch there and back the later one must win.
		Seq int64 `json:"seq"`
	}
	contextGetResult struct {
		// Version counts publishes in this run; 0 = nothing published yet
		// (App and Path then come from the previous run, DirID is 0).
		Version int64  `json:"version"`
		App     string `json:"app"`
		DirID   int64  `json:"dirId"`
		Path    string `json:"path"`
		FocusID *int64 `json:"focusId"`
		// SelectionCount is the carried selection (0 = none); a larger
		// selection is not carried and sets SelectionTooLarge.
		SelectionCount    int  `json:"selectionCount"`
		SelectionTooLarge bool `json:"selectionTooLarge"`
	}
	selectionFromContextParams struct {
		Version int64 `json:"version"`
		QueryID int64 `json:"queryId"`
	}
	queryLocateParams struct {
		QueryID   int64  `json:"queryId"`
		Pattern   string `json:"pattern"`
		From      int    `json:"from"`
		Direction string `json:"direction"`
	}
	queryLocateResult struct {
		Index   int   `json:"index"`
		Version int64 `json:"version"`
	}
	queryMatchParams struct {
		QueryID int64  `json:"queryId"`
		Mask    string `json:"mask"`
	}
	queryMatchResult struct {
		Version int64    `json:"version"`
		Ranges  [][2]int `json:"ranges"`
		Count   int      `json:"count"`
	}
	queryIndexOfParams struct {
		QueryID int64 `json:"queryId"`
		EntryID int64 `json:"entryId"`
	}
	queryIndexOfResult struct {
		Index   int   `json:"index"`
		Version int64 `json:"version"`
	}
	// storedContext is the shared.context setting.
	storedContext struct {
		V       int    `json:"v"`
		App     string `json:"app"`
		Path    string `json:"path"`
		PathKey string `json:"pathKey"`
	}
)

type sharedContext struct {
	svc *indexService

	mu  sync.Mutex
	cur contextGetResult
	sel []int64 // the carried selection, in the leaving app's order
	// selVersion is the publish that carried sel (or cleared it); later
	// publishes without a selection leave it, so the app being shown can
	// still read it after publishing its own folder.
	selVersion int64
	selCount   int
	selTooBig  bool
	pathKey    string
	loaded     bool // cur holds the previous run's context (or none was stored)
	dirty      bool
	timer      *time.Timer
}

func validApp(app string) bool { return app == "viewer" || app == "commander" }

// appSetVisible moves the watches to the folders of the app on screen; the
// folders it shows are re-listed if they were not watched while it was
// hidden (ADR-0020, ADR-0026).
func (s *indexService) appSetVisible(_ context.Context, p appSetVisibleParams) (okResult, error) {
	if !validApp(p.App) {
		return okResult{}, rpc.NewError(rpc.CodeInvalidArgument, "app must be viewer or commander")
	}
	s.visibleMu.Lock()
	defer s.visibleMu.Unlock()
	if p.Seq <= s.visibleSeq {
		return okResult{OK: false}, nil // overtaken by a later switch
	}
	s.visibleSeq = p.Seq
	s.watcher.Show(p.App)
	return okResult{OK: true}, nil
}

func (c *sharedContext) publish(ctx context.Context, p contextPublishParams) (okResult, error) {
	if !validApp(p.App) {
		return okResult{}, rpc.NewError(rpc.CodeInvalidArgument, "app must be viewer or commander")
	}
	if p.FocusID != nil && *p.FocusID <= 0 {
		return okResult{}, rpc.NewError(rpc.CodeInvalidArgument, "focusId must be a positive entry id")
	}
	dir, err := c.svc.store.Dir(ctx, p.DirID)
	if errors.Is(err, index.ErrNotFound) {
		return okResult{}, rpc.NewError(rpc.CodeNotFound, "folder is not in the index")
	}
	if err != nil {
		return okResult{}, dbError(err)
	}
	carries := len(p.Selection) > 0
	var sel []int64
	tooLarge := false
	if carries && string(p.Selection) != "null" {
		var wire selectionWire
		if err := json.Unmarshal(p.Selection, &wire); err != nil {
			return okResult{}, rpc.NewError(rpc.CodeInvalidArgument, "invalid selection")
		}
		ids, err := c.svc.resolveSelection(wire)
		if err != nil {
			return okResult{}, err
		}
		if len(ids) > MaxContextSelection {
			tooLarge = true
		} else {
			sel = ids
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.loaded = true
	c.cur = contextGetResult{Version: c.cur.Version + 1, App: p.App, DirID: dir.ID, Path: dir.Path, FocusID: p.FocusID}
	if carries {
		c.sel, c.selVersion, c.selCount, c.selTooBig = sel, c.cur.Version, len(sel), tooLarge
		c.cur.SelectionCount, c.cur.SelectionTooLarge = len(sel), tooLarge
	}
	c.pathKey = dir.Key
	c.dirty = true
	if c.timer == nil {
		c.timer = time.AfterFunc(contextSaveDelay, c.flush)
	}
	return okResult{OK: true}, nil
}

func (c *sharedContext) get(ctx context.Context) (contextGetResult, error) {
	c.mu.Lock()
	loaded := c.loaded
	c.mu.Unlock()
	if !loaded {
		c.load(ctx)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cur, nil
}

// load reads the previous run's context once; without library.db there is
// simply none.
func (c *sharedContext) load(ctx context.Context) {
	var stored storedContext
	if lib, err := c.svc.library(ctx); err == nil {
		if all, err := lib.Settings(ctx); err == nil {
			if raw, ok := all[sharedContextKey]; ok && json.Unmarshal(raw, &stored) != nil {
				stored = storedContext{}
			}
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.loaded {
		return // a publish arrived meanwhile and wins
	}
	c.loaded = true
	if stored.V == 1 && validApp(stored.App) {
		c.cur = contextGetResult{App: stored.App, Path: stored.Path}
		c.pathKey = stored.PathKey
	}
}

// flush writes the latest context; called by the debounce timer and on
// shutdown (before library.db closes).
func (c *sharedContext) flush() {
	c.mu.Lock()
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
	if !c.dirty {
		c.mu.Unlock()
		return
	}
	c.dirty = false
	value, _ := json.Marshal(storedContext{V: 1, App: c.cur.App, Path: c.cur.Path, PathKey: c.pathKey})
	c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), contextSaveBudget)
	defer cancel()
	lib, err := c.svc.library(ctx)
	if err == nil {
		err = lib.SetSetting(ctx, sharedContextKey, value)
	}
	if err != nil {
		c.svc.log.Warn("save shared context", "err", err)
	}
}

// MaxContextSelection bounds a carried selection (docs/shared/APP-SWITCHING.md).
const MaxContextSelection = 10_000

// fromContext maps the carried selection of context version onto a session
// of the app being shown: ranges of its current version; entries it does not
// list (other files in the viewer, hidden ones) are dropped.
func (c *sharedContext) fromContext(ctx context.Context, p selectionFromContextParams) (selectionWire, error) {
	c.mu.Lock()
	version, sel := c.selVersion, c.sel
	c.mu.Unlock()
	if p.Version != version {
		return selectionWire{}, rpc.NewError(rpc.CodeInvalidArgument, "that context carries no selection any more")
	}
	pos, qv, err := c.svc.queries.Positions(ctx, p.QueryID, sel)
	if errors.Is(err, query.ErrUnknownSession) {
		return selectionWire{}, rpc.NewError(rpc.CodeNotFound, "query session expired; reopen it")
	}
	if err != nil {
		return selectionWire{}, dbError(err)
	}
	slices.Sort(pos)
	return selectionWire{QueryID: p.QueryID, Version: qv, Ranges: toRanges(pos), Include: []int64{}, Exclude: []int64{}}, nil
}

// toRanges merges sorted indexes into [start, end) ranges.
func toRanges(sorted []int) [][2]int {
	out := [][2]int{}
	for _, i := range sorted {
		if n := len(out); n > 0 && out[n-1][1] == i {
			out[n-1][1]++
		} else if n == 0 || out[n-1][1] < i {
			out = append(out, [2]int{i, i + 1})
		}
	}
	return out
}

func (s *indexService) registerContext(srv *rpc.Server) {
	rpc.Register(srv, "context.publish", s.context.publish)
	rpc.Register(srv, "app.setVisible", s.appSetVisible)
	rpc.Register(srv, "context.get", func(ctx context.Context, _ emptyParams) (contextGetResult, error) {
		return s.context.get(ctx)
	})
	rpc.Register(srv, "selection.fromContext", s.context.fromContext)
	rpc.Register(srv, "query.locate", func(ctx context.Context, p queryLocateParams) (queryLocateResult, error) {
		if p.Direction != "forward" && p.Direction != "backward" {
			return queryLocateResult{}, rpc.NewError(rpc.CodeInvalidArgument, "direction must be forward or backward")
		}
		if len(p.Pattern) > index.MaxSearchLen {
			return queryLocateResult{}, rpc.NewError(rpc.CodeInvalidArgument, "pattern is too long")
		}
		at, version, err := s.queries.Locate(ctx, p.QueryID, p.Pattern, p.From, p.Direction == "backward")
		if errors.Is(err, query.ErrUnknownSession) {
			return queryLocateResult{}, rpc.NewError(rpc.CodeNotFound, "query session expired; reopen it")
		}
		if err != nil {
			return queryLocateResult{}, dbError(err)
		}
		return queryLocateResult{Index: at, Version: version}, nil
	})
	// Marking by mask: files only, as Total Commander's "Select group".
	rpc.Register(srv, "query.match", func(ctx context.Context, p queryMatchParams) (queryMatchResult, error) {
		if p.Mask == "" || len(p.Mask) > index.MaxMaskLen {
			return queryMatchResult{}, rpc.NewError(rpc.CodeInvalidArgument, "mask must be 1..256 characters")
		}
		at, version, err := s.queries.Match(ctx, p.QueryID, p.Mask, true)
		if errors.Is(err, query.ErrUnknownSession) {
			return queryMatchResult{}, rpc.NewError(rpc.CodeNotFound, "query session expired; reopen it")
		}
		if err != nil {
			return queryMatchResult{}, dbError(err)
		}
		return queryMatchResult{Version: version, Ranges: toRanges(at), Count: len(at)}, nil
	})
	rpc.Register(srv, "query.indexOf", func(_ context.Context, p queryIndexOfParams) (queryIndexOfResult, error) {
		at, version, err := s.queries.IndexOf(p.QueryID, p.EntryID)
		if errors.Is(err, query.ErrUnknownSession) {
			return queryIndexOfResult{}, rpc.NewError(rpc.CodeNotFound, "query session expired; reopen it")
		}
		return queryIndexOfResult{Index: at, Version: version}, err
	})
}
