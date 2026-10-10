package app

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"

	"panelyth/sidecar/internal/find"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/query"
	"panelyth/sidecar/internal/rpc"
	"panelyth/sidecar/internal/scan"
)

// Stage C06: find files. Wire types mirror src/shared/contracts/src/rpc.ts.

const evFindProgress = "find.progress"

type (
	findStartParams struct {
		Roots         []string `json:"roots"`
		Mask          string   `json:"mask"`
		Depth         int      `json:"depth"`
		Hidden        bool     `json:"hidden"`
		Text          string   `json:"text"`
		CaseSensitive bool     `json:"caseSensitive"`
		WholeWords    bool     `json:"wholeWords"`
		Encodings     []string `json:"encodings"`
		SkipBinary    bool     `json:"skipBinary"`
		// Optional bounds: null means none.
		MinSize        *int64 `json:"minSize"`
		MaxSize        *int64 `json:"maxSize"`
		ModifiedAfter  *int64 `json:"modifiedAfter"`
		ModifiedBefore *int64 `json:"modifiedBefore"`
		AttrsSet       int    `json:"attrsSet"`
		AttrsClear     int    `json:"attrsClear"`
	}
	findStartResult struct {
		FindID int64 `json:"findId"`
		query.Snapshot
	}
	findIDParams struct {
		FindID int64 `json:"findId"`
	}
	findCancelResult struct {
		Cancelled bool `json:"cancelled"`
	}
	dirOpenContainingParams struct {
		EntryID int64  `json:"entryId"`
		Lane    string `json:"lane"`
	}
)

func (s *indexService) registerFind(srv *rpc.Server) {
	rpc.Register(srv, "find.start", s.findStart)
	rpc.Register(srv, "find.cancel", func(_ context.Context, p findIDParams) (findCancelResult, error) {
		return findCancelResult{Cancelled: s.finds.Cancel(p.FindID)}, nil
	})
	rpc.Register(srv, "dir.openContaining", s.dirOpenContaining)
}

func optional(v *int64, none int64) int64 {
	if v == nil {
		return none
	}
	return *v
}

func (s *indexService) findStart(ctx context.Context, p findStartParams) (findStartResult, error) {
	spec := find.Spec{Roots: p.Roots, Mask: p.Mask, Depth: p.Depth, Hidden: p.Hidden, Text: p.Text,
		CaseSensitive: p.CaseSensitive, WholeWords: p.WholeWords, Encodings: p.Encodings, SkipBinary: p.SkipBinary,
		MinSize: optional(p.MinSize, -1), MaxSize: optional(p.MaxSize, -1),
		ModifiedAfter: optional(p.ModifiedAfter, 0), ModifiedBefore: optional(p.ModifiedBefore, 0),
		AttrsSet: p.AttrsSet, AttrsClear: p.AttrsClear}
	c, err := find.Compile(spec)
	if err != nil {
		return findStartResult{}, rpc.NewError(rpc.CodeInvalidArgument, err.Error())
	}
	for _, root := range c.Roots() {
		if err := probeDir(root); err != nil {
			return findStartResult{}, openError(err)
		}
		// The roots exist in the index, so results link up to them.
		if _, err := s.store.EnsureDir(ctx, root); err != nil {
			return findStartResult{}, dbError(err)
		}
	}
	// The results tab's session: every result, in found order. It opens
	// before the walk starts, so results only ever arrive as new versions.
	var snap query.Snapshot
	findID, _, err := s.finds.Start(c, func(src *find.Source) (int64, error) {
		var err error
		snap, err = s.queries.OpenSource(ctx, index.Descriptor{Scope: index.ScopeAll, ShowHidden: true}, src)
		return snap.QueryID, err
	})
	if err != nil {
		return findStartResult{}, dbError(err)
	}
	return findStartResult{FindID: findID, Snapshot: snap}, nil
}

// openFindQuery serves query.open for a search's results (a fed panel).
func (s *indexService) openFindQuery(ctx context.Context, findID int64, d index.Descriptor) (query.Snapshot, error) {
	src, err := s.finds.Source(findID)
	if errors.Is(err, find.ErrUnknown) {
		return query.Snapshot{}, rpc.NewError(rpc.CodeNotFound, "the search results are no longer available")
	}
	snap, err := s.queries.OpenSource(ctx, d, src)
	if err != nil {
		return snap, dbError(err)
	}
	s.finds.Attach(findID, snap.QueryID)
	return snap, nil
}

// dirOpenContaining opens the folder holding an entry ("Go to file").
func (s *indexService) dirOpenContaining(ctx context.Context, p dirOpenContainingParams) (dirOpenResult, error) {
	paths, err := s.store.EntryPaths(ctx, []int64{p.EntryID})
	if err != nil {
		return dirOpenResult{}, dbError(err)
	}
	if len(paths) == 0 {
		return dirOpenResult{}, rpc.NewError(rpc.CodeNotFound, "not in the index")
	}
	return s.dirOpen(ctx, dirOpenParams{Path: filepath.Dir(paths[0].Path), Lane: p.Lane})
}

// changed routes index changes to query sessions and to search results.
func (s *indexService) changed(changes []scan.Change) {
	s.queries.Changed(changes)
	s.finds.Changed(changes)
}

func (s *indexService) emitFind(p find.Progress) {
	s.events.Post(evFindProgress, strconv.FormatInt(p.FindID, 10), p)
}
