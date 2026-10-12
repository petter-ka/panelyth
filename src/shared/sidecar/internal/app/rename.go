package app

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/pathkey"
	"panelyth/sidecar/internal/rename"
	"panelyth/sidecar/internal/rpc"
)

// Stage C09: the multi-rename preview (the same rename.Resolve the job
// applies), the undo of the last multi-rename, and the attribute and date
// changes. Wire types mirror src/shared/contracts/src/rpc.ts.

// Limits of rename requests.
const (
	MaxRenamePreviewPage = 500
	// maxPreviewNames bounds the folder names a preview keeps to tell which
	// names are taken; beyond it each name is looked up on disk.
	maxPreviewNames = 2_000_000
	// previewIdle is how long a preview's entries are kept after its last use.
	previewIdle = time.Minute
)

type (
	renamePlanWire struct {
		NameMask  string `json:"nameMask"`
		ExtMask   string `json:"extMask"`
		Search    string `json:"search"`
		Replace   string `json:"replace"`
		Regex     bool   `json:"regex"`
		MatchCase bool   `json:"matchCase"`
		Case      string `json:"case"`
		Start     int    `json:"start"`
		Step      int    `json:"step"`
		Digits    int    `json:"digits"`
	}
	renamePreviewParams struct {
		Selection selectionWire  `json:"selection"`
		Plan      renamePlanWire `json:"plan"`
		Offset    int            `json:"offset"`
		Limit     int            `json:"limit"`
	}
	renamePreviewRow struct {
		ID      int64  `json:"id"`
		Name    string `json:"name"`
		NewName string `json:"newName"`
		// Status is "rename", "unchanged", "invalid" or "conflict".
		Status string `json:"status"`
		// Reason: "duplicate", "exists" or "cycle" for a conflict, the
		// validation message for an invalid name.
		Reason string `json:"reason,omitempty"`
	}
	renamePreviewResult struct {
		Total     int `json:"total"`
		Renamed   int `json:"renamed"`
		Unchanged int `json:"unchanged"`
		Invalid   int `json:"invalid"`
		Conflicts int `json:"conflicts"`
		// FirstProblem is the first invalid or conflicting row, -1 without one.
		FirstProblem int                `json:"firstProblem"`
		Offset       int                `json:"offset"`
		Rows         []renamePreviewRow `json:"rows"`
	}
)

func (p renamePlanWire) spec() rename.Spec {
	return rename.Spec{NameMask: p.NameMask, ExtMask: p.ExtMask, Search: p.Search, Replace: p.Replace,
		Regex: p.Regex, MatchCase: p.MatchCase, Case: rename.Case(p.Case), Start: p.Start, Step: p.Step, Digits: p.Digits}
}

// planError tells the dialog which field cannot be used (details.field).
func planError(err error) error {
	e := rpc.NewError(rpc.CodeInvalidArgument, err.Error())
	details := map[string]string{"reason": "plan"}
	var pe *rename.PlanError
	if errors.As(err, &pe) {
		details["field"] = pe.Field
	}
	e.Details = details
	return e
}

// renamePreviews keeps the entries of the selection being previewed, so a
// key press in the dialog names them again without resolving the selection
// or reading folders. One selection at a time; it is dropped when unused.
type renamePreviews struct {
	mu      sync.Mutex
	key     string
	ids     []int64
	entries []rename.Entry
	// dirs holds each entry's folder as an index into paths.
	dirs  []int32
	paths []string
	// taken has the names of the folders read so far, as rename.Key.
	taken map[string]struct{}
	read  map[int32]bool
	// lookups: the folders are too large to keep; names are looked up on disk.
	lookups bool
	timer   *time.Timer
}

func (r *renamePreviews) drop() {
	r.mu.Lock()
	r.dropLocked()
	r.mu.Unlock()
}

func (r *renamePreviews) dropLocked() {
	r.key, r.ids, r.entries, r.dirs, r.paths, r.taken, r.read, r.lookups = "", nil, nil, nil, nil, nil, nil, false
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
}

// touchLocked restarts the idle timer.
func (r *renamePreviews) touchLocked() {
	if r.timer != nil {
		r.timer.Stop()
	}
	key := r.key
	r.timer = time.AfterFunc(previewIdle, func() {
		r.mu.Lock()
		if r.key == key {
			r.dropLocked()
		}
		r.mu.Unlock()
	})
}

// exists reports whether entry i's folder has an entry of that name. A
// folder is read once; one that cannot be read has no names here, and the
// job finds out.
func (r *renamePreviews) exists(i int, name string) bool {
	d := r.dirs[i]
	if r.lookups {
		_, err := os.Lstat(filepath.Join(r.paths[d], name))
		return err == nil
	}
	if !r.read[d] {
		r.read[d] = true
		if f, err := os.Open(r.paths[d]); err == nil {
			names, _ := f.Readdirnames(-1)
			_ = f.Close()
			if len(r.taken)+len(names) > maxPreviewNames {
				r.lookups, r.taken = true, nil
				return r.exists(i, name)
			}
			for _, n := range names {
				r.taken[rename.Key(r.entries[i].Dir, n)] = struct{}{}
			}
		}
	}
	_, ok := r.taken[rename.Key(r.entries[i].Dir, name)]
	return ok
}

func (s *indexService) registerRename(srv *rpc.Server) {
	rpc.Register(srv, "rename.preview", s.renamePreview)
	rpc.Register(srv, "rename.undoInfo", func(context.Context, emptyParams) (jobs.UndoInfo, error) {
		return s.jobs.UndoInfo(), nil
	})
}

// renameEntries resolves a selection into the entries of a multi-rename.
func (s *indexService) renameEntries(ctx context.Context, sel selectionWire) ([]int64, []index.Target, error) {
	ids, err := s.resolveSelection(sel)
	if err != nil {
		return nil, nil, err
	}
	if archiveOnly(ids) {
		return nil, nil, rpc.NewError(rpc.CodeInvalidArgument, "entries inside an archive can't be renamed")
	}
	if len(ids) > jobs.MaxMultiRename {
		e := rpc.NewError(rpc.CodeInvalidArgument, "a multi-rename takes at most 100,000 entries")
		e.Details = map[string]string{"reason": "tooMany"}
		return nil, nil, e
	}
	targets := make([]index.Target, 0, len(ids))
	for lo := 0; lo < len(ids); lo += 1000 {
		chunk, err := s.store.Targets(ctx, ids[lo:min(lo+1000, len(ids))])
		if err != nil {
			return nil, nil, dbError(err)
		}
		targets = append(targets, chunk...)
	}
	return ids, targets, nil
}

// renamePreview names the selection with the plan and returns a page of old
// and new names with what would happen to each. The whole batch is resolved
// every time (conflicts depend on all of it); its entries are kept between
// calls.
func (s *indexService) renamePreview(ctx context.Context, p renamePreviewParams) (renamePreviewResult, error) {
	if p.Offset < 0 || p.Limit < 1 || p.Limit > MaxRenamePreviewPage {
		return renamePreviewResult{}, rpc.NewError(rpc.CodeInvalidArgument, "offset must be >= 0 and limit 1..500")
	}
	plan, err := rename.Compile(p.Plan.spec())
	if err != nil {
		return renamePreviewResult{}, planError(err)
	}
	key, _ := json.Marshal(p.Selection)
	r := &s.previews
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.key != string(key) {
		_, targets, err := s.renameEntries(ctx, p.Selection)
		if err != nil {
			return renamePreviewResult{}, err
		}
		r.dropLocked()
		r.key = string(key)
		r.ids, r.entries, r.dirs = make([]int64, len(targets)), make([]rename.Entry, len(targets)), make([]int32, len(targets))
		r.taken, r.read = map[string]struct{}{}, map[int32]bool{}
		byPath := map[string]int32{}
		for i, t := range targets {
			dir := filepath.Dir(t.Path)
			d, ok := byPath[dir]
			if !ok {
				d = int32(len(r.paths))
				byPath[dir] = d
				r.paths = append(r.paths, dir)
			}
			r.ids[i], r.dirs[i] = t.ID, d
			r.entries[i] = rename.Entry{
				Item: rename.Item{Name: t.Name, IsDir: t.Kind == media.KindDir, ModNs: t.MtimeNs},
				Dir:  pathkey.DirKey(dir),
			}
		}
	}
	r.touchLocked()
	res := rename.Resolve(plan, r.entries, r.exists)
	out := renamePreviewResult{Total: len(r.entries), Renamed: res.Renamed, Unchanged: res.Unchanged, Invalid: res.Invalid,
		Conflicts: res.Conflicts, FirstProblem: -1, Offset: min(p.Offset, len(r.entries))}
	if res.Invalid+res.Conflicts > 0 {
		for i, o := range res.Outcomes {
			if o.Status == rename.Invalid || o.Status == rename.Conflict {
				out.FirstProblem = i
				break
			}
		}
	}
	hi := min(out.Offset+p.Limit, len(r.entries))
	out.Rows = make([]renamePreviewRow, 0, hi-out.Offset)
	for i := out.Offset; i < hi; i++ {
		o := res.Outcomes[i]
		out.Rows = append(out.Rows, renamePreviewRow{ID: r.ids[i], Name: r.entries[i].Name, NewName: o.Name,
			Status: renameStatus(o.Status), Reason: o.Reason})
	}
	return out, nil
}

func renameStatus(s rename.Status) string {
	switch s {
	case rename.Unchanged:
		return "unchanged"
	case rename.Invalid:
		return "invalid"
	case rename.Conflict:
		return "conflict"
	}
	return "rename"
}

// renameJob fills the Stage C09 fields of a jobs.start request.
func (s *indexService) renameJob(p jobStartParams, spec *jobs.Spec) error {
	switch spec.Kind {
	case jobs.KindMultiRename, jobs.KindSetAttributes:
		if archiveOnly(spec.IDs) {
			return rpc.NewError(rpc.CodeInvalidArgument, "entries inside an archive can't be changed")
		}
	}
	switch spec.Kind {
	case jobs.KindMultiRename:
		if p.Plan == nil {
			return rpc.NewError(rpc.CodeInvalidArgument, "a multi-rename needs its plan")
		}
		plan := p.Plan.spec()
		if _, err := rename.Compile(plan); err != nil {
			return planError(err)
		}
		spec.Rename = &plan
		// The dialog is done with its preview.
		s.previews.drop()
	case jobs.KindSetAttributes:
		c := fileops.AttrChange{Set: p.SetAttrs, Clear: p.ClearAttrs,
			ModeSet: fs.FileMode(p.SetMode), ModeClear: fs.FileMode(p.ClearMode)}
		if p.SetMode < 0 || p.SetMode > 0o777 || p.ClearMode < 0 || p.ClearMode > 0o777 {
			return rpc.NewError(rpc.CodeInvalidArgument, "permissions are the nine rwx bits")
		}
		if p.ModifiedMs != nil {
			c.Modified = time.UnixMilli(*p.ModifiedMs)
		}
		if p.AccessedMs != nil {
			c.Accessed = time.UnixMilli(*p.AccessedMs)
		}
		spec.Attrs = &jobs.AttrSpec{AttrChange: c, Recursive: p.Recursive}
	}
	return nil
}
