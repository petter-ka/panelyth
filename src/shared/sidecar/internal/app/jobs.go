package app

import (
	"context"
	"errors"
	"strconv"
	"sync"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/library"
	"panelyth/sidecar/internal/pathkey"
	"panelyth/sidecar/internal/rpc"
)

// Stage 07 methods (ADR-0021): batch jobs, the internal clipboard, single
// rename and tags. Wire types mirror src/shared/contracts/src/rpc.ts.

const (
	evJobProgress = "job.progress"
	// evJobConflict asks about an item whose name is taken (ADR-0029).
	evJobConflict = "job.conflict"
)

// Limits of job requests.
const (
	MaxJobErrorsPage = 500
	MaxTagFilters    = 16
	MaxPatternBytes  = 255
)

type (
	jobSourceWire struct {
		Selection selectionWire `json:"selection"`
	}
	jobStartParams struct {
		Kind   string        `json:"kind"`
		Source jobSourceWire `json:"source"`
		// Copy, move: absolute folder path and conflict policy.
		Destination string `json:"destination"`
		// DestinationDirID names the destination by its folder id (the
		// commander, Stage C04); it wins over Destination.
		DestinationDirID int64  `json:"destinationDirId"`
		Conflict         string `json:"conflict"`
		// Mask limits the copy to matching files; Name renames a single item.
		Mask string `json:"mask"`
		Name string `json:"name"`
		// Verify hashes source and copy; Now starts the job ahead of its
		// lane (Stage P03).
		Verify bool `json:"verify"`
		Now    bool `json:"now"`
		// CopyLinks is set by Electron main from the calling app's profile
		// (the commander copies links as links), never by a renderer.
		CopyLinks bool `json:"copyLinks"`
		// Rename.
		Pattern string `json:"pattern"`
		Start   int    `json:"start"`
		// Favorite, rating, label, tag.
		Favorite bool   `json:"favorite"`
		Rating   int    `json:"rating"`
		Label    int    `json:"label"`
		Tag      string `json:"tag"`
		Add      bool   `json:"add"`
		// Archives (Stage C07): extract creates links (links) and unpacks
		// each archive into its own folder (subfolders); pack takes the
		// archive's name (name), format, level and deleteOriginals.
		Links           bool   `json:"links"`
		Subfolders      bool   `json:"subfolders"`
		Format          string `json:"format"`
		Level           int    `json:"level"`
		DeleteOriginals bool   `json:"deleteOriginals"`
		// Stage C08. sync: the compare and the plan the user confirmed (it
		// has no source). hashCreate: the algorithm, one file per file or one
		// list (name) in destinationDirId. compareFiles: two entries.
		CompareID         int64  `json:"compareId"`
		PlanVersion       int64  `json:"planVersion"`
		DeletePermanently bool   `json:"deletePermanently"`
		Algorithm         string `json:"algorithm"`
		PerFile           bool   `json:"perFile"`
		LeftID            int64  `json:"leftId"`
		RightID           int64  `json:"rightId"`
		// Stage C09. multiRename: the plan the dialog previewed. undoRename
		// has no fields. setAttributes: attribute bits to set and clear
		// (Windows), permission bits (elsewhere), dates, and recursive.
		Plan       *renamePlanWire `json:"plan"`
		SetAttrs   int             `json:"setAttrs"`
		ClearAttrs int             `json:"clearAttrs"`
		SetMode    int             `json:"setMode"`
		ClearMode  int             `json:"clearMode"`
		ModifiedMs *int64          `json:"modifiedMs"`
		AccessedMs *int64          `json:"accessedMs"`
		Recursive  bool            `json:"recursive"`
	}
	jobIDParams struct {
		JobID int64 `json:"jobId"`
	}
	jobResolveParams struct {
		JobID      int64  `json:"jobId"`
		Decision   string `json:"decision"`
		ApplyToAll bool   `json:"applyToAll"`
	}
	jobConflictEvent struct {
		JobID    int64         `json:"jobId"`
		Conflict jobs.Conflict `json:"conflict"`
	}
	jobCancelResult struct {
		Cancelled bool `json:"cancelled"`
	}
	jobErrorsParams struct {
		JobID  int64 `json:"jobId"`
		Offset int   `json:"offset"`
		Limit  int   `json:"limit"`
	}
	jobErrorsResult struct {
		Errors []jobs.ItemError `json:"errors"`
		Total  int              `json:"total"`
	}
	jobListResult struct {
		Jobs []jobs.Snapshot `json:"jobs"`
	}
	clipSetParams struct {
		Selection selectionWire `json:"selection"`
		Mode      string        `json:"mode"`
	}
	clipState struct {
		// Mode is "copy", "cut" or "" when the clipboard is empty.
		Mode  string `json:"mode"`
		Count int    `json:"count"`
	}
	clipPasteParams struct {
		Destination      string `json:"destination"`
		DestinationDirID int64  `json:"destinationDirId"`
		Conflict         string `json:"conflict"`
		CopyLinks        bool   `json:"copyLinks"`
	}
	entryRenameParams struct {
		EntryID int64  `json:"entryId"`
		Name    string `json:"name"`
	}
	entryRenameResult struct {
		Name string `json:"name"`
	}
	tagsResult struct {
		Tags []library.Tag `json:"tags"`
	}
	tagIDParams struct {
		ID int64 `json:"id"`
	}
)

// clipboard holds resolved ids in Go so they survive navigation (ADR-0021).
type clipboard struct {
	mu  sync.Mutex
	ids []int64
	cut bool
	gen uint64
	// pasteJob is the move job of the last cut paste; the clipboard is
	// cleared when it completes, unless it was replaced since (gen).
	pasteJob int64
	pasteGen uint64
}

func (c *clipboard) state() clipState {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case len(c.ids) == 0:
		return clipState{}
	case c.cut:
		return clipState{Mode: "cut", Count: len(c.ids)}
	}
	return clipState{Mode: "copy", Count: len(c.ids)}
}

// jobDone clears a cut clipboard after its paste completed.
func (c *clipboard) jobDone(s jobs.Snapshot) {
	if s.State != jobs.StateCompleted {
		return
	}
	c.mu.Lock()
	if s.JobID == c.pasteJob && c.gen == c.pasteGen {
		c.ids, c.cut, c.pasteJob = nil, false, 0
		c.gen++
	}
	c.mu.Unlock()
}

// emitJob publishes job.progress, coalesced per job id (the latest snapshot
// wins; the final one is never dropped).
func (s *indexService) emitJob(snap jobs.Snapshot) {
	s.clip.jobDone(snap)
	s.events.Post(evJobProgress, strconv.FormatInt(snap.JobID, 10), snap)
}

// askJob publishes a job's conflict question (one per job at a time).
func (s *indexService) askJob(jobID int64, c jobs.Conflict) {
	s.events.Post(evJobConflict, strconv.FormatInt(jobID, 10), jobConflictEvent{JobID: jobID, Conflict: c})
}

func (s *indexService) registerJobs(srv *rpc.Server) {
	rpc.Register(srv, "jobs.start", s.jobsStart)
	rpc.Register(srv, "jobs.cancel", func(_ context.Context, p jobIDParams) (jobCancelResult, error) {
		return jobCancelResult{Cancelled: s.jobs.Cancel(p.JobID)}, nil
	})
	// Stage P03 (ADR-0029): pause, resume, start now, answer a conflict.
	rpc.Register(srv, "jobs.pause", func(_ context.Context, p jobIDParams) (okResult, error) {
		return okResult{OK: s.jobs.Pause(p.JobID)}, nil
	})
	rpc.Register(srv, "jobs.resume", func(_ context.Context, p jobIDParams) (okResult, error) {
		return okResult{OK: s.jobs.Resume(p.JobID)}, nil
	})
	rpc.Register(srv, "jobs.startNow", func(_ context.Context, p jobIDParams) (okResult, error) {
		return okResult{OK: s.jobs.StartNow(p.JobID)}, nil
	})
	rpc.Register(srv, "jobs.resolve", func(_ context.Context, p jobResolveParams) (okResult, error) {
		err := s.jobs.Resolve(p.JobID, p.Decision, p.ApplyToAll)
		switch {
		case errors.Is(err, jobs.ErrInvalid):
			return okResult{}, rpc.NewError(rpc.CodeInvalidArgument, "unknown decision")
		case errors.Is(err, jobs.ErrUnknownJob):
			return okResult{}, rpc.NewError(rpc.CodeNotFound, "the job is no longer running")
		case errors.Is(err, jobs.ErrNotAsking):
			return okResult{OK: false}, nil
		}
		return okResult{OK: err == nil}, err
	})
	rpc.Register(srv, "jobs.errors", func(_ context.Context, p jobErrorsParams) (jobErrorsResult, error) {
		if p.Offset < 0 || p.Limit < 1 || p.Limit > MaxJobErrorsPage {
			return jobErrorsResult{}, rpc.NewError(rpc.CodeInvalidArgument, "offset must be >= 0 and limit 1..500")
		}
		errs, total, err := s.jobs.Errors(p.JobID, p.Offset, p.Limit)
		if errors.Is(err, jobs.ErrUnknownJob) {
			return jobErrorsResult{}, rpc.NewError(rpc.CodeNotFound, "the job is no longer known")
		}
		if errs == nil {
			errs = []jobs.ItemError{}
		}
		return jobErrorsResult{Errors: errs, Total: total}, err
	})
	rpc.Register(srv, "jobs.list", func(context.Context, emptyParams) (jobListResult, error) {
		return jobListResult{Jobs: s.jobs.List()}, nil
	})
	s.registerFsOps(srv)
	rpc.Register(srv, "clip.set", s.clipSet)
	rpc.Register(srv, "clip.get", func(context.Context, emptyParams) (clipState, error) {
		return s.clip.state(), nil
	})
	rpc.Register(srv, "clip.paste", s.clipPaste)
	rpc.Register(srv, "entry.rename", s.entryRename)
	rpc.Register(srv, "library.tags", func(ctx context.Context, _ emptyParams) (tagsResult, error) {
		lib, err := s.library(ctx)
		if err != nil {
			return tagsResult{}, err
		}
		tags, err := lib.Tags(ctx)
		if err != nil {
			return tagsResult{}, dbError(err)
		}
		return tagsResult{Tags: tags}, nil
	})
	rpc.Register(srv, "library.deleteTag", func(ctx context.Context, p tagIDParams) (okResult, error) {
		lib, err := s.library(ctx)
		if err != nil {
			return okResult{}, err
		}
		return okResult{OK: true}, libError(lib.DeleteTag(ctx, p.ID))
	})
}

func (s *indexService) jobsStart(ctx context.Context, p jobStartParams) (jobs.Snapshot, error) {
	spec := jobs.Spec{Kind: jobs.Kind(p.Kind), Conflict: p.Conflict, Pattern: p.Pattern, Start: p.Start,
		Favorite: p.Favorite, Rating: p.Rating, Label: p.Label, Tag: p.Tag, Add: p.Add,
		Verify: p.Verify, Now: p.Now, CopyLinks: p.CopyLinks, Mask: p.Mask, Name: p.Name}
	if len(p.Pattern) > MaxPatternBytes {
		return jobs.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "the pattern is too long")
	}
	if spec.Kind == jobs.KindCopy || spec.Kind == jobs.KindMove || spec.Kind == jobs.KindExtract || spec.Kind == jobs.KindPack {
		dest, err := s.jobDestination(ctx, p.DestinationDirID, p.Destination)
		if err != nil {
			return jobs.Snapshot{}, err
		}
		spec.Destination = dest
	}
	// Stage C08: a sync applies a compare's plan and comparing two files
	// names them by id; neither has a selection.
	switch spec.Kind {
	case jobs.KindSync:
		if err := s.syncJob(p, &spec); err != nil {
			return jobs.Snapshot{}, err
		}
		return s.startJob(spec)
	case jobs.KindCompareFiles:
		if err := s.compareJob(ctx, p, &spec); err != nil {
			return jobs.Snapshot{}, err
		}
		return s.startJob(spec)
	case jobs.KindUndoRename:
		// Stage C09: its items are the journal of the last multi-rename.
		return s.startJob(spec)
	}
	ids, err := s.resolveSelection(p.Source.Selection)
	if err != nil {
		return jobs.Snapshot{}, err
	}
	spec.IDs = ids
	if err := s.archiveJob(p, &spec, ids); err != nil {
		return jobs.Snapshot{}, err
	}
	if err := s.compareJob(ctx, p, &spec); err != nil {
		return jobs.Snapshot{}, err
	}
	if err := s.renameJob(p, &spec); err != nil {
		return jobs.Snapshot{}, err
	}
	return s.startJob(spec)
}

// jobDestination resolves a folder id (preferred) or an absolute path.
func (s *indexService) jobDestination(ctx context.Context, dirID int64, path string) (string, error) {
	if dirID > 0 {
		return s.dirPath(ctx, dirID)
	}
	return destination(path)
}

func destination(p string) (string, error) {
	clean, err := pathkey.Clean(p)
	if err != nil {
		return "", rpc.NewError(rpc.CodeInvalidPath, "the destination must be an absolute folder path")
	}
	return clean, nil
}

func (s *indexService) startJob(spec jobs.Spec) (jobs.Snapshot, error) {
	snap, err := s.jobs.Start(spec)
	switch {
	case errors.Is(err, jobs.ErrBusy):
		return snap, rpc.NewError(rpc.CodeBusy, "too many operations are waiting; try again when some have finished")
	case errors.Is(err, jobs.ErrInvalid):
		return snap, rpc.NewError(rpc.CodeInvalidArgument, err.Error())
	case err != nil:
		return snap, dbError(err)
	}
	return snap, nil
}

func (s *indexService) clipSet(_ context.Context, p clipSetParams) (clipState, error) {
	if p.Mode != "copy" && p.Mode != "cut" {
		return clipState{}, rpc.NewError(rpc.CodeInvalidArgument, `mode must be "copy" or "cut"`)
	}
	ids, err := s.resolveSelection(p.Selection)
	if err != nil {
		return clipState{}, err
	}
	if archiveOnly(ids) {
		return clipState{}, rpc.NewError(rpc.CodeInvalidArgument, "entries inside an archive are copied out with F5")
	}
	s.clip.mu.Lock()
	s.clip.ids, s.clip.cut = ids, p.Mode == "cut"
	s.clip.gen++
	s.clip.mu.Unlock()
	return s.clip.state(), nil
}

// clipPaste copies or moves the clipboard into a folder.
func (s *indexService) clipPaste(ctx context.Context, p clipPasteParams) (jobs.Snapshot, error) {
	dest, err := s.jobDestination(ctx, p.DestinationDirID, p.Destination)
	if err != nil {
		return jobs.Snapshot{}, err
	}
	s.clip.mu.Lock()
	ids, cut, gen := s.clip.ids, s.clip.cut, s.clip.gen
	s.clip.mu.Unlock()
	if len(ids) == 0 {
		return jobs.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "the clipboard is empty")
	}
	kind := jobs.KindCopy
	if cut {
		kind = jobs.KindMove
	}
	// The lock is not held across Start: the manager may emit (and so call
	// jobDone) from inside it.
	snap, err := s.startJob(jobs.Spec{Kind: kind, IDs: ids, Destination: dest, Conflict: p.Conflict, CopyLinks: p.CopyLinks})
	if err != nil || !cut {
		return snap, err
	}
	s.clip.mu.Lock()
	if s.clip.gen == gen {
		s.clip.pasteJob, s.clip.pasteGen = snap.JobID, gen
	}
	s.clip.mu.Unlock()
	// The job may have completed before it was recorded.
	for _, j := range s.jobs.List() {
		if j.JobID == snap.JobID {
			s.clip.jobDone(j)
		}
	}
	return snap, nil
}

func (s *indexService) entryRename(ctx context.Context, p entryRenameParams) (entryRenameResult, error) {
	name, err := s.jobs.RenameOne(ctx, p.EntryID, p.Name)
	if err == nil {
		return entryRenameResult{Name: name}, nil
	}
	code := fileops.Code(err)
	msg := err.Error()
	var fe *fileops.Error
	if errors.As(err, &fe) {
		msg = fe.Err.Error()
	}
	switch code {
	case fileops.CodeNotFound:
		return entryRenameResult{}, rpc.NewError(rpc.CodeNotFound, "the item no longer exists")
	case fileops.CodePermission:
		return entryRenameResult{}, rpc.NewError(rpc.CodePermissionDenied, "no permission to rename this item")
	case fileops.CodeInvalidName, fileops.CodeExists, fileops.CodeInUse:
		e := rpc.NewError(rpc.CodeInvalidArgument, msg)
		e.Details = map[string]string{"reason": code}
		return entryRenameResult{}, e
	}
	if errors.Is(err, context.Canceled) {
		return entryRenameResult{}, err
	}
	return entryRenameResult{}, rpc.NewError(rpc.CodeInternal, msg)
}

// userRows loads the annotations of a query scope (ADR-0021: passed to the
// index query instead of an ATTACHed library.db).
func (s *indexService) userRows(ctx context.Context, d index.Descriptor, dirKey string) ([]index.UserRow, error) {
	lib, err := s.library(ctx)
	if err != nil {
		return nil, err
	}
	lo, hi := pathkey.SubtreeRange(dirKey)
	rows, err := lib.Scope(ctx, lo, hi, d.Tags)
	if err != nil {
		return nil, err
	}
	out := make([]index.UserRow, len(rows))
	for i, r := range rows {
		out[i] = index.UserRow{Key: r.Key, Favorite: r.Favorite, Rating: r.Rating, FirstTag: r.FirstTag, Match: r.Match}
	}
	return out, nil
}

// annotations returns favorite and rating per path key for page rows; an
// unavailable library leaves them empty (browsing never depends on it).
func (s *indexService) annotations(ctx context.Context, items []index.Item) map[string]library.Annotation {
	select {
	case <-s.libReady:
	default:
		return nil // still opening: rows refresh on the next invalidation
	}
	if s.lib == nil {
		return nil
	}
	keys := make([]string, 0, len(items))
	for _, it := range items {
		if it.PathKey != "" {
			keys = append(keys, it.PathKey)
		}
	}
	ann, err := s.lib.Annotations(ctx, keys, false)
	if err != nil {
		if ctx.Err() == nil {
			s.log.Warn("page annotations", "err", err)
		}
		return nil
	}
	return ann
}
