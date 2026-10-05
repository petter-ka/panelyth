package app

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/query"
	"fastview/sidecar/internal/rpc"
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

// Mirrors shared/contracts/src/rpc.ts.
type (
	contextPublishParams struct {
		App     string `json:"app"`
		DirID   int64  `json:"dirId"`
		FocusID *int64 `json:"focusId"`
	}
	contextGetResult struct {
		// Version counts publishes in this run; 0 = nothing published yet
		// (App and Path then come from the previous run, DirID is 0).
		Version int64  `json:"version"`
		App     string `json:"app"`
		DirID   int64  `json:"dirId"`
		Path    string `json:"path"`
		FocusID *int64 `json:"focusId"`
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

	mu      sync.Mutex
	cur     contextGetResult
	pathKey string
	loaded  bool // cur holds the previous run's context (or none was stored)
	dirty   bool
	timer   *time.Timer
}

func validApp(app string) bool { return app == "viewer" || app == "commander" }

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
	c.mu.Lock()
	defer c.mu.Unlock()
	c.loaded = true
	c.cur = contextGetResult{Version: c.cur.Version + 1, App: p.App, DirID: dir.ID, Path: dir.Path, FocusID: p.FocusID}
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

func (s *indexService) registerContext(srv *rpc.Server) {
	rpc.Register(srv, "context.publish", s.context.publish)
	rpc.Register(srv, "context.get", func(ctx context.Context, _ emptyParams) (contextGetResult, error) {
		return s.context.get(ctx)
	})
	rpc.Register(srv, "query.indexOf", func(_ context.Context, p queryIndexOfParams) (queryIndexOfResult, error) {
		at, version, err := s.queries.IndexOf(p.QueryID, p.EntryID)
		if errors.Is(err, query.ErrUnknownSession) {
			return queryIndexOfResult{}, rpc.NewError(rpc.CodeNotFound, "query session expired; reopen it")
		}
		return queryIndexOfResult{Index: at, Version: version}, err
	})
}
