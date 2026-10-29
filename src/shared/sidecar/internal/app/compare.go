package app

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"time"

	"panelyth/sidecar/internal/archive"
	"panelyth/sidecar/internal/checksum"
	"panelyth/sidecar/internal/compare"
	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/pathkey"
	"panelyth/sidecar/internal/query"
	"panelyth/sidecar/internal/rpc"
	"panelyth/sidecar/internal/textdiff"
)

// Stage C08: compare directories (Shift+F2), the recursive compare behind
// the synchronize dialog (a query session over its rows, ADR-0017), the
// side-by-side text diff, and the sync, checksum and compare-by-content
// jobs. Wire types mirror src/shared/contracts/src/rpc.ts.

const evCompareProgress = "compare.progress"

// Limits of compare requests.
const (
	// MaxToleranceMs bounds the date tolerance (the FAT case needs 2 s).
	MaxToleranceMs = 60_000
	// MaxTextDiffs bounds the text comparisons kept open.
	MaxTextDiffs = 4
)

type (
	compareOptionsWire struct {
		ToleranceMs int  `json:"toleranceMs"`
		DST         bool `json:"dst"`
		IgnoreDates bool `json:"ignoreDates"`
	}
	compareDirsParams struct {
		LeftDirID  int64 `json:"leftDirId"`
		RightDirID int64 `json:"rightDirId"`
		compareOptionsWire
		Content    bool `json:"content"`
		Asymmetric bool `json:"asymmetric"`
	}
	compareStartResult struct {
		CompareID int64 `json:"compareId"`
		query.Snapshot
	}
	compareIDParams struct {
		CompareID int64 `json:"compareId"`
	}
	compareCancelResult struct {
		Cancelled bool `json:"cancelled"`
	}
	compareCloseResult struct {
		Closed bool `json:"closed"`
	}
	compareShowParams struct {
		CompareID int64    `json:"compareId"`
		Show      []string `json:"show"`
	}
	compareActionParams struct {
		CompareID int64         `json:"compareId"`
		Selection selectionWire `json:"selection"`
		// Action is a direction, or "default" for the one the compare chose.
		Action string `json:"action"`
	}
	// compareView is the table after a change: its session and its plan.
	compareView struct {
		query.Snapshot
		Plan compare.Summary `json:"plan"`
	}
	compareMarksParams struct {
		LeftQueryID  int64 `json:"leftQueryId"`
		RightQueryID int64 `json:"rightQueryId"`
		compareOptionsWire
	}
	compareMarksResult struct {
		Left       selectionWire `json:"left"`
		Right      selectionWire `json:"right"`
		LeftCount  int           `json:"leftCount"`
		RightCount int           `json:"rightCount"`
	}
	diffSideWire struct {
		SizeBytes  int64 `json:"sizeBytes"`
		ModifiedMs int64 `json:"modifiedMs"`
	}
	// diffWire is what a row of a compare's session adds to its item.
	diffWire struct {
		Dir    string        `json:"dir"`
		State  string        `json:"state"`
		Action string        `json:"action"`
		Left   *diffSideWire `json:"left"`
		Right  *diffSideWire `json:"right"`
	}
	textDiffOpenParams struct {
		LeftID  int64 `json:"leftId"`
		RightID int64 `json:"rightId"`
	}
	textDiffFile struct {
		Name      string `json:"name"`
		SizeBytes int64  `json:"sizeBytes"`
		Lines     int    `json:"lines"`
		// Encoding is "" when the file was not read as text.
		Encoding string `json:"encoding"`
	}
	textDiffOpenResult struct {
		// DiffID is 0 when the files are not compared as text; Reason says why.
		DiffID    int64        `json:"diffId"`
		Reason    string       `json:"reason"`
		Left      textDiffFile `json:"left"`
		Right     textDiffFile `json:"right"`
		Rows      int          `json:"rows"`
		Changes   int          `json:"changes"`
		Blocks    [][2]int     `json:"blocks"`
		Identical bool         `json:"identical"`
	}
	textDiffPageParams struct {
		DiffID int64 `json:"diffId"`
		Offset int   `json:"offset"`
		Limit  int   `json:"limit"`
	}
	textDiffRow struct {
		Op string `json:"op"`
		// L and R are line numbers from 1; 0 where a side has no line.
		L     int    `json:"l"`
		R     int    `json:"r"`
		Left  string `json:"left"`
		Right string `json:"right,omitempty"`
		Cut   bool   `json:"cut,omitempty"`
		// Spans: the words and characters that differ inside a changed row, as
		// groups of [left from, left to, right from, right to] in UTF-16 units
		// (Stage C10.5).
		Spans []int `json:"spans,omitempty"`
	}
	textDiffPageResult struct {
		Offset int           `json:"offset"`
		Rows   []textDiffRow `json:"rows"`
	}
	textDiffIDParams struct {
		DiffID int64 `json:"diffId"`
	}
)

func (s *indexService) registerCompare(srv *rpc.Server) {
	rpc.Register(srv, "compare.dirs", s.compareDirs)
	rpc.Register(srv, "compare.cancel", func(_ context.Context, p compareIDParams) (compareCancelResult, error) {
		return compareCancelResult{Cancelled: s.compares.Cancel(p.CompareID)}, nil
	})
	rpc.Register(srv, "compare.close", s.compareClose)
	rpc.Register(srv, "compare.show", s.compareShow)
	rpc.Register(srv, "compare.setAction", s.compareSetAction)
	rpc.Register(srv, "compare.plan", func(_ context.Context, p compareIDParams) (compare.Summary, error) {
		res, err := s.compareResult(p.CompareID)
		if err != nil {
			return compare.Summary{}, err
		}
		return res.Summary(), nil
	})
	rpc.Register(srv, "compare.marks", s.compareMarks)
	rpc.Register(srv, "diff.open", s.textDiffOpen)
	rpc.Register(srv, "diff.page", s.textDiffPage)
	rpc.Register(srv, "diff.close", func(_ context.Context, p textDiffIDParams) (okResult, error) {
		return okResult{OK: s.diffs.close(p.DiffID)}, nil
	})
}

func (o compareOptionsWire) options() (compare.Options, error) {
	if o.ToleranceMs < 0 || o.ToleranceMs > MaxToleranceMs {
		return compare.Options{}, rpc.NewError(rpc.CodeInvalidArgument, "the date tolerance must be 0..60000 ms")
	}
	return compare.Options{Tolerance: time.Duration(o.ToleranceMs) * time.Millisecond, DST: o.DST, IgnoreDates: o.IgnoreDates}, nil
}

func (s *indexService) compareResult(id int64) (*compare.Result, error) {
	res, err := s.compares.Result(id)
	if err != nil {
		return nil, rpc.NewError(rpc.CodeNotFound, "the comparison is no longer available; compare again")
	}
	return res, nil
}

// compareDirs starts the recursive compare of two indexed folders. Its rows
// are a session of their own, opened before the walk starts, so they only
// ever arrive as new versions.
func (s *indexService) compareDirs(ctx context.Context, p compareDirsParams) (compareStartResult, error) {
	opts, err := p.options()
	if err != nil {
		return compareStartResult{}, err
	}
	left, err := s.dirPath(ctx, p.LeftDirID)
	if err != nil {
		return compareStartResult{}, err
	}
	right, err := s.dirPath(ctx, p.RightDirID)
	if err != nil {
		return compareStartResult{}, err
	}
	if fileops.IsWithin(left, right) || fileops.IsWithin(right, left) {
		e := rpc.NewError(rpc.CodeInvalidArgument, "choose two separate folders: one can't be inside the other")
		e.Details = map[string]string{"reason": "nested"}
		return compareStartResult{}, e
	}
	for _, root := range []string{left, right} {
		if err := probeDir(root); err != nil {
			return compareStartResult{}, openError(err)
		}
	}
	spec := compare.Spec{Left: left, Right: right, Options: opts, Content: p.Content, Asymmetric: p.Asymmetric}
	var snap query.Snapshot
	res, err := s.compares.Start(spec, func(r *compare.Result) (int64, error) {
		var err error
		snap, err = s.queries.OpenSource(ctx, query.OwnerCommander, index.Descriptor{Scope: index.ScopeAll, ShowHidden: true}, r)
		return snap.QueryID, err
	})
	if err != nil {
		return compareStartResult{}, dbError(err)
	}
	return compareStartResult{CompareID: res.ID(), Snapshot: snap}, nil
}

// compareClose forgets a compare and closes the session over its rows.
func (s *indexService) compareClose(_ context.Context, p compareIDParams) (compareCloseResult, error) {
	sessions := s.compares.Sessions(p.CompareID)
	closed := s.compares.Close(p.CompareID)
	for _, id := range sessions {
		s.queries.Close(id)
	}
	return compareCloseResult{Closed: closed}, nil
}

// compareViewOf refreshes a compare's session at once and returns it with
// the plan, so the table follows a click without waiting for an event.
func (s *indexService) compareViewOf(res *compare.Result) (compareView, error) {
	view := compareView{Plan: res.Summary()}
	for _, id := range s.compares.Sessions(res.ID()) {
		snap, err := s.queries.RefreshNow(id)
		if err != nil {
			continue
		}
		view.Snapshot = snap
	}
	if view.QueryID == 0 {
		return view, rpc.NewError(rpc.CodeNotFound, "the comparison is no longer available; compare again")
	}
	return view, nil
}

func (s *indexService) compareShow(_ context.Context, p compareShowParams) (compareView, error) {
	show, ok := compare.ParseShow(p.Show)
	if !ok {
		return compareView{}, rpc.NewError(rpc.CodeInvalidArgument, "show takes copyRight, copyLeft, equal, different and delete")
	}
	res, err := s.compareResult(p.CompareID)
	if err != nil {
		return compareView{}, err
	}
	res.SetShow(show)
	return s.compareViewOf(res)
}

// compareSetAction gives the selected rows a direction.
func (s *indexService) compareSetAction(_ context.Context, p compareActionParams) (compareView, error) {
	action, ok := compare.ParseAction(p.Action)
	reset := p.Action == "default"
	if !ok && !reset {
		return compareView{}, rpc.NewError(rpc.CodeInvalidArgument, "unknown action")
	}
	res, err := s.compareResult(p.CompareID)
	if err != nil {
		return compareView{}, err
	}
	if s.compares.OfSession(p.Selection.QueryID) != res {
		return compareView{}, rpc.NewError(rpc.CodeInvalidArgument, "the selection is not of this comparison")
	}
	ids, err := s.resolveSelection(p.Selection)
	if err != nil {
		return compareView{}, err
	}
	if _, err := res.SetAction(ids, action, reset); errors.Is(err, compare.ErrRunning) {
		return compareView{}, rpc.NewError(rpc.CodeBusy, "the comparison is still running")
	}
	return s.compareViewOf(res)
}

// syncJob fills a sync job from the plan the user confirmed.
func (s *indexService) syncJob(p jobStartParams, spec *jobs.Spec) error {
	res, err := s.compareResult(p.CompareID)
	if err != nil {
		return err
	}
	plan, err := res.Plan(p.PlanVersion)
	switch {
	case errors.Is(err, compare.ErrRunning):
		return rpc.NewError(rpc.CodeBusy, "the comparison has not finished")
	case errors.Is(err, compare.ErrStalePlan):
		e := rpc.NewError(rpc.CodeInvalidArgument, "the comparison changed since it was confirmed; confirm again")
		e.Details = map[string]string{"reason": "stalePlan"}
		return e
	case err != nil:
		return dbError(err)
	}
	if len(plan.Items) == 0 {
		return rpc.NewError(rpc.CodeInvalidArgument, "nothing to synchronize")
	}
	spec.Sync = &jobs.SyncSpec{Plan: plan, Permanent: p.DeletePermanently}
	spec.Destination = plan.Right
	return nil
}

// compareJob fills the checksum and compare-by-content fields of a
// jobs.start request.
func (s *indexService) compareJob(ctx context.Context, p jobStartParams, spec *jobs.Spec) error {
	switch spec.Kind {
	case jobs.KindHashCreate:
		spec.Hash = jobs.HashSpec{Algo: checksum.Algo(p.Algorithm), PerFile: p.PerFile, Name: p.Name}
		spec.Name = ""
		if !p.PerFile {
			dest, err := s.dirPath(ctx, p.DestinationDirID)
			if err != nil {
				return err
			}
			spec.Destination = dest
		}
	case jobs.KindCompareFiles:
		if archive.IsID(p.LeftID) || archive.IsID(p.RightID) {
			return rpc.NewError(rpc.CodeInvalidArgument, "copy entries out of the archive to compare them")
		}
		spec.IDs = []int64{p.LeftID, p.RightID}
	}
	return nil
}

// compareWithFolderJob is the other form of a compareFiles job (Stage
// C10.5): the selected files, each against the file of its name in the
// folder destinationDirId.
func (s *indexService) compareWithFolderJob(ctx context.Context, p jobStartParams, spec *jobs.Spec) error {
	ids, err := s.resolveSelection(p.Source.Selection)
	if err != nil {
		return err
	}
	if slices.ContainsFunc(ids, archive.IsID) {
		return rpc.NewError(rpc.CodeInvalidArgument, "copy entries out of the archive to compare them")
	}
	dest, err := s.dirPath(ctx, p.DestinationDirID)
	if err != nil {
		return err
	}
	spec.IDs, spec.Destination = ids, dest
	return nil
}

// compareMarks is Shift+F2: it compares the listings of two sessions by
// name, size and date and returns what to mark in each.
func (s *indexService) compareMarks(ctx context.Context, p compareMarksParams) (compareMarksResult, error) {
	opts, err := p.options()
	if err != nil {
		return compareMarksResult{}, err
	}
	type side struct {
		entries   []compare.Entry
		positions []int
		version   int64
	}
	load := func(id int64) (side, error) {
		items, positions, version, err := s.queries.Rows(ctx, id)
		if errors.Is(err, query.ErrUnknownSession) {
			return side{}, rpc.NewError(rpc.CodeNotFound, "query session expired; reopen it")
		}
		if err != nil {
			return side{}, dbError(err)
		}
		entries := make([]compare.Entry, len(items))
		for i, it := range items {
			entries[i] = compare.Entry{Key: pathkey.NameKey(it.Name), IsDir: it.Kind == media.KindDir,
				Size: it.Size, MtimeNs: it.MtimeNs}
		}
		return side{entries: entries, positions: positions, version: version}, nil
	}
	l, err := load(p.LeftQueryID)
	if err != nil {
		return compareMarksResult{}, err
	}
	r, err := load(p.RightQueryID)
	if err != nil {
		return compareMarksResult{}, err
	}
	lm, rm := compare.Marks(l.entries, r.entries, opts)
	descriptor := func(queryID int64, sd side, marks []bool) (selectionWire, int) {
		sel := selectionWire{QueryID: queryID, Version: sd.version, Ranges: [][2]int{}, Include: []int64{}, Exclude: []int64{}}
		n := 0
		for i, m := range marks {
			if !m {
				continue
			}
			n++
			at := sd.positions[i]
			if k := len(sel.Ranges) - 1; k >= 0 && sel.Ranges[k][1] == at {
				sel.Ranges[k][1] = at + 1
			} else {
				sel.Ranges = append(sel.Ranges, [2]int{at, at + 1})
			}
		}
		return sel, n
	}
	var res compareMarksResult
	res.Left, res.LeftCount = descriptor(p.LeftQueryID, l, lm)
	res.Right, res.RightCount = descriptor(p.RightQueryID, r, rm)
	return res, nil
}

// compareDiffs returns the compare data of a page of a compare's session.
func (s *indexService) compareDiffs(queryID int64, items []index.Item) map[int64]compare.Diff {
	res := s.compares.OfSession(queryID)
	if res == nil {
		return nil
	}
	ids := make([]int64, len(items))
	for i, it := range items {
		ids[i] = it.ID
	}
	return res.Diffs(ids)
}

func diffOf(d compare.Diff) *diffWire {
	side := func(sd *compare.Side) *diffSideWire {
		if sd == nil {
			return nil
		}
		return &diffSideWire{SizeBytes: sd.Size, ModifiedMs: sd.MtimeNs / int64(time.Millisecond)}
	}
	return &diffWire{Dir: d.Dir, State: d.State.String(), Action: d.Action.String(), Left: side(d.Left), Right: side(d.Right)}
}

func (s *indexService) emitCompare(p compare.Progress) {
	s.events.Post(evCompareProgress, strconv.FormatInt(p.CompareID, 10), p)
}

// Text diffs -------------------------------------------------------------------

// textDiffs keeps the few text comparisons that are open (their line
// tables, not their text); the oldest goes first.
type textDiffs struct {
	mu    sync.Mutex
	next  int64
	open  map[int64]*textdiff.Diff
	order []int64
}

func (t *textDiffs) add(d *textdiff.Diff) int64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.open == nil {
		t.open = map[int64]*textdiff.Diff{}
	}
	t.next++
	t.open[t.next] = d
	t.order = append(t.order, t.next)
	for len(t.order) > MaxTextDiffs {
		delete(t.open, t.order[0])
		t.order = t.order[1:]
	}
	return t.next
}

func (t *textDiffs) get(id int64) *textdiff.Diff {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.open[id]
}

func (t *textDiffs) close(id int64) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.open[id]; !ok {
		return false
	}
	delete(t.open, id)
	for i, v := range t.order {
		if v == id {
			t.order = append(t.order[:i], t.order[i+1:]...)
			break
		}
	}
	return true
}

// textDiffOpen compares two files line by line. Files that are not text, or
// too large for it, come back without a diff: the caller compares them by
// content with a compareFiles job.
func (s *indexService) textDiffOpen(ctx context.Context, p textDiffOpenParams) (textDiffOpenResult, error) {
	if archive.IsID(p.LeftID) || archive.IsID(p.RightID) {
		return textDiffOpenResult{}, rpc.NewError(rpc.CodeInvalidArgument, "copy entries out of the archive to compare them")
	}
	paths, err := s.store.EntryPaths(ctx, []int64{p.LeftID, p.RightID})
	if err != nil {
		return textDiffOpenResult{}, dbError(err)
	}
	if len(paths) != 2 && !(len(paths) == 1 && p.LeftID == p.RightID) {
		return textDiffOpenResult{}, rpc.NewError(rpc.CodeNotFound, "not in the index")
	}
	left, right := paths[0], paths[len(paths)-1]
	if left.ID != p.LeftID {
		left, right = right, left
	}
	res := textDiffOpenResult{Blocks: [][2]int{}}
	for i, e := range []index.EntryPath{left, right} {
		fi, err := os.Stat(e.Path)
		if err != nil {
			return res, statError(err, "file")
		}
		if e.Kind == media.KindDir || !fi.Mode().IsRegular() {
			return res, rpc.NewError(rpc.CodeInvalidArgument, "only files can be compared by content")
		}
		f := textDiffFile{Name: filepath.Base(e.Path), SizeBytes: fi.Size()}
		if i == 0 {
			res.Left = f
		} else {
			res.Right = f
		}
	}
	d, err := textdiff.Open(ctx, left.Path, right.Path)
	switch {
	case errors.Is(err, textdiff.ErrBinary):
		res.Reason = "binary"
		return res, nil
	case errors.Is(err, textdiff.ErrTooLarge):
		res.Reason = "tooLarge"
		return res, nil
	case errors.Is(err, textdiff.ErrChanged):
		return res, rpc.NewError(rpc.CodeBusy, "a file changed while it was read; compare again")
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return res, err
	case err != nil:
		return res, statError(err, "file")
	}
	in := d.Info()
	res.DiffID = s.diffs.add(d)
	res.Left.Lines, res.Left.Encoding = in.Left.Lines, string(in.Left.Encoding)
	res.Right.Lines, res.Right.Encoding = in.Right.Lines, string(in.Right.Encoding)
	res.Rows, res.Changes, res.Blocks, res.Identical = in.Rows, in.Changes, in.Blocks, in.Identical
	return res, nil
}

func (s *indexService) textDiffPage(_ context.Context, p textDiffPageParams) (textDiffPageResult, error) {
	if p.Offset < 0 || p.Limit < 1 || p.Limit > textdiff.MaxPageRows {
		return textDiffPageResult{}, rpc.NewError(rpc.CodeInvalidArgument, "offset must be >= 0 and limit 1..500")
	}
	d := s.diffs.get(p.DiffID)
	if d == nil {
		return textDiffPageResult{}, rpc.NewError(rpc.CodeNotFound, "the comparison is no longer open; compare again")
	}
	rows, err := d.Page(p.Offset, p.Limit)
	if errors.Is(err, textdiff.ErrChanged) || errors.Is(err, fs.ErrNotExist) {
		e := rpc.NewError(rpc.CodeNotFound, "a file changed since it was compared; compare again")
		e.Details = map[string]string{"reason": "changed"}
		return textDiffPageResult{}, e
	}
	if err != nil {
		return textDiffPageResult{}, statError(err, "file")
	}
	out := textDiffPageResult{Offset: min(p.Offset, d.Info().Rows), Rows: make([]textDiffRow, len(rows))}
	for i, r := range rows {
		out.Rows[i] = textDiffRow{Op: r.Op.String(), L: r.L, R: r.R, Left: r.Left, Right: r.Right, Cut: r.Cut, Spans: r.Spans}
	}
	return out, nil
}
