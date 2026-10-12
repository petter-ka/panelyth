package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"panelyth/sidecar/internal/compare"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/rpc"
)

// Stage C08 through the RPC handlers: the compare's session and plan, the
// sync job started from it, Shift+F2's marks, the text diff, and the
// checksum and compare-by-content jobs.

var cmpT0 = time.Date(2024, 3, 9, 12, 0, 0, 0, time.UTC)

func putAt(t *testing.T, path, data string, sec int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	at := cmpT0.Add(time.Duration(sec) * time.Second)
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
}

// comparePair builds two folders and lists both.
func comparePair(t *testing.T, svc *indexService) (left, right string, leftID, rightID int64) {
	t.Helper()
	base := t.TempDir()
	left, right = filepath.Join(base, "left"), filepath.Join(base, "right")
	for _, root := range []string{left, right} {
		putAt(t, filepath.Join(root, "same.txt"), "same", 0)
	}
	putAt(t, filepath.Join(left, "newer.txt"), "new text", 100)
	putAt(t, filepath.Join(right, "newer.txt"), "old", 0)
	putAt(t, filepath.Join(left, "only-left.txt"), "l", 0)
	putAt(t, filepath.Join(right, "extra", "only-right.txt"), "r", 0)
	leftID, _ = openListed(t, svc, left)
	rightID, _ = openListed(t, svc, right)
	return left, right, leftID, rightID
}

// reasonOf is the details.reason of an RPC error.
func reasonOf(err error) string {
	var e *rpc.Error
	if errors.As(err, &e) {
		d, _ := e.Details.(map[string]string)
		return d["reason"]
	}
	return ""
}

func rpcCode(err error) rpc.ErrorCode {
	var e *rpc.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

func TestCompareSessionPlanAndSync(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	left, right, leftID, rightID := comparePair(t, svc)

	started, err := svc.compareDirs(ctx, compareDirsParams{LeftDirID: leftID, RightDirID: rightID, Asymmetric: true})
	if err != nil {
		t.Fatal(err)
	}
	if started.CompareID == 0 || started.QueryID == 0 || started.Total != 0 {
		t.Fatalf("started %+v", started)
	}
	svc.compares.Wait(started.CompareID)

	// The rows are a session: paged like any other, each with its diff.
	rows := func() []string {
		t.Helper()
		page, err := svc.queryPage(ctx, queryPageParams{QueryID: started.QueryID, Limit: 100})
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, it := range page.Items {
			if it.Diff == nil || !compare.IsID(it.ID) || it.DirPath != "" {
				t.Fatalf("row %+v", it)
			}
			name := it.Name
			if it.Diff.Dir != "" {
				name = it.Diff.Dir + "/" + name
			}
			out = append(out, name+" "+it.Diff.State+" "+it.Diff.Action)
		}
		return out
	}
	want := []string{"extra rightOnly deleteRight", "newer.txt leftNewer copyRight", "only-left.txt leftOnly copyRight",
		"extra/only-right.txt rightOnly deleteRight"}
	if got := rows(); !slices.Equal(got, want) {
		t.Fatalf("rows %v", got)
	}
	page, _ := svc.queryPage(ctx, queryPageParams{QueryID: started.QueryID, Limit: 100})
	if d := page.Items[1].Diff; d.Left == nil || d.Right == nil || d.Left.SizeBytes != 8 || d.Right.SizeBytes != 3 ||
		d.Left.ModifiedMs-d.Right.ModifiedMs != 100_000 || page.Items[0].Kind != "dir" || page.Items[3].Diff.Left != nil {
		t.Errorf("sides %+v", d)
	}

	// The filter: with the equal rows.
	view, err := svc.compareShow(ctx, compareShowParams{CompareID: started.CompareID, Show: []string{"copyRight", "copyLeft", "equal", "different", "delete"}})
	if err != nil || view.Total != 5 || view.QueryID != started.QueryID || view.Plan.Counts.Equal != 1 {
		t.Fatalf("show: %+v, %v", view, err)
	}
	if _, err := svc.compareShow(ctx, compareShowParams{CompareID: started.CompareID, Show: []string{"all"}}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Errorf("an unknown filter: %v", err)
	}
	// Hiding the deletes takes them out of the plan.
	view, _ = svc.compareShow(ctx, compareShowParams{CompareID: started.CompareID, Show: []string{"copyRight"}})
	if view.Total != 2 || view.Plan.DeleteRight != 0 || view.Plan.Counts.Delete != 2 || view.Plan.CopyRight.Files != 2 {
		t.Errorf("deletes hidden: %+v", view)
	}
	view, _ = svc.compareShow(ctx, compareShowParams{CompareID: started.CompareID, Show: []string{"copyRight", "copyLeft", "different", "delete"}})
	if view.Plan.DeleteRight != 2 || view.Plan.CopyRight.Bytes != 9 {
		t.Errorf("default filter: %+v", view.Plan)
	}

	// A direction for a row, by a selection of the compare's session.
	sel := func(lo, hi int) selectionWire {
		return selectionWire{QueryID: view.QueryID, Version: view.Version, Ranges: [][2]int{{lo, hi}}}
	}
	view, err = svc.compareSetAction(ctx, compareActionParams{CompareID: started.CompareID, Selection: sel(2, 3), Action: "none"})
	if err != nil || view.Plan.CopyRight.Files != 1 || view.Total != 4 {
		t.Fatalf("set action: %+v, %v", view, err)
	}
	if got := rows(); got[2] != "only-left.txt leftOnly none" {
		t.Errorf("rows after the change %v", got)
	}
	if _, err := svc.compareSetAction(ctx, compareActionParams{CompareID: started.CompareID, Selection: sel(0, 1), Action: "shred"}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Errorf("an unknown action: %v", err)
	}
	// A selection of another session is not of this compare.
	leftQ, _ := svc.queryOpen(ctx, queryOpenParams{DirID: leftID, Scope: "all"})
	other := selectionWire{QueryID: leftQ.QueryID, Version: leftQ.Version, Ranges: [][2]int{{0, 3}}}
	if _, err := svc.compareSetAction(ctx, compareActionParams{CompareID: started.CompareID, Selection: other, Action: "copyRight"}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Errorf("a panel's selection: %v", err)
	}
	view, _ = svc.compareSetAction(ctx, compareActionParams{CompareID: started.CompareID, Selection: sel(0, 4), Action: "default"})
	if view.Plan.CopyRight.Files != 2 {
		t.Errorf("reset: %+v", view.Plan)
	}

	// The compare's rows are not files: a delete job over them deletes nothing.
	del, err := svc.jobsStart(ctx, jobStartParams{Kind: "delete", Source: jobSourceWire{Selection: selectionWire{
		QueryID: view.QueryID, Version: view.Version, Ranges: [][2]int{{0, 4}}}}})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitJob(t, svc, del.JobID); s.Done != 0 {
		t.Errorf("a delete over compare rows did something: %+v", s)
	}
	if _, err := os.Stat(filepath.Join(left, "newer.txt")); err != nil {
		t.Fatal("a file was deleted through the compare's session")
	}

	// A sync needs the plan the user saw.
	plan, err := svc.compareSetAction(ctx, compareActionParams{CompareID: started.CompareID, Selection: sel(0, 0), Action: "none"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.jobsStart(ctx, jobStartParams{Kind: "sync", CompareID: started.CompareID, PlanVersion: plan.Plan.Version - 1, DeletePermanently: true})
	if reasonOf(err) != "stalePlan" {
		t.Fatalf("a stale plan: %v", err)
	}
	job, err := svc.jobsStart(ctx, jobStartParams{Kind: "sync", CompareID: started.CompareID, PlanVersion: plan.Plan.Version, DeletePermanently: true})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitJob(t, svc, job.JobID); s.State != jobs.StateCompleted || s.Failed != 0 || s.Done != 4 || s.Kind != jobs.KindSync {
		errs, _, _ := svc.jobs.Errors(job.JobID, 0, 10)
		t.Fatalf("sync: %+v %v", s, errs)
	}
	if b, _ := os.ReadFile(filepath.Join(right, "newer.txt")); string(b) != "new text" {
		t.Errorf("newer.txt = %q", b)
	}
	if _, err := os.Stat(filepath.Join(right, "extra")); !errors.Is(err, os.ErrNotExist) {
		t.Error("the right-only folder is still there")
	}
	if _, err := os.Stat(filepath.Join(right, "only-left.txt")); err != nil {
		t.Error("only-left.txt was not copied")
	}

	// Closing forgets the compare and its session.
	if closed, _ := svc.compareClose(ctx, compareIDParams{CompareID: started.CompareID}); !closed.Closed {
		t.Error("close")
	}
	if _, err := svc.queryPage(ctx, queryPageParams{QueryID: started.QueryID, Limit: 10}); rpcCode(err) != rpc.CodeNotFound {
		t.Errorf("the session after close: %v", err)
	}
	if _, err := svc.compareShow(ctx, compareShowParams{CompareID: started.CompareID, Show: []string{"equal"}}); rpcCode(err) != rpc.CodeNotFound {
		t.Errorf("show after close: %v", err)
	}
	if _, err := svc.jobsStart(ctx, jobStartParams{Kind: "sync", CompareID: started.CompareID, PlanVersion: 1}); rpcCode(err) != rpc.CodeNotFound {
		t.Errorf("a sync of a closed compare: %v", err)
	}
}

func TestCompareRefusesBadRoots(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	_, right, leftID, rightID := comparePair(t, svc)
	innerID, _ := openListed(t, svc, filepath.Join(right, "extra"))

	_, err := svc.compareDirs(ctx, compareDirsParams{LeftDirID: rightID, RightDirID: innerID})
	if reasonOf(err) != "nested" {
		t.Errorf("a folder against its subfolder: %v", err)
	}
	if _, err := svc.compareDirs(ctx, compareDirsParams{LeftDirID: leftID, RightDirID: leftID}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Errorf("a folder against itself: %v", err)
	}
	if _, err := svc.compareDirs(ctx, compareDirsParams{LeftDirID: leftID, RightDirID: 999_999}); rpcCode(err) != rpc.CodeNotFound {
		t.Errorf("an unknown folder: %v", err)
	}
	if _, err := svc.compareDirs(ctx, compareDirsParams{LeftDirID: leftID, RightDirID: rightID,
		compareOptionsWire: compareOptionsWire{ToleranceMs: -1}}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Errorf("a negative tolerance: %v", err)
	}
	// A folder that is gone by the time it is compared.
	if err := os.RemoveAll(filepath.Join(right, "extra")); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.compareDirs(ctx, compareDirsParams{LeftDirID: leftID, RightDirID: innerID}); rpcCode(err) != rpc.CodeNotFound {
		t.Errorf("a missing folder: %v", err)
	}
	// A sync while the compare is not finished is refused.
	res, err := svc.compares.Start(compare.Spec{Left: right, Right: filepath.Join(right, "missing")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	svc.compares.Wait(res.ID())
	if _, err := svc.jobsStart(ctx, jobStartParams{Kind: "sync", CompareID: res.ID(), PlanVersion: 1}); rpcCode(err) != rpc.CodeBusy {
		t.Errorf("a sync of a failed compare: %v", err)
	}
}

func TestCompareMarks(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	_, _, leftID, rightID := comparePair(t, svc)
	open := func(dirID int64) (int64, []string) {
		snap, err := svc.queryOpen(ctx, queryOpenParams{DirID: dirID, Scope: "all", ShowHidden: true,
			Sort: []sortKeyWire{{Field: "name", Direction: "asc"}}})
		if err != nil {
			t.Fatal(err)
		}
		_, names := pageNames(t, svc, snap.QueryID)
		return snap.QueryID, names
	}
	lq, lnames := open(leftID)
	rq, rnames := open(rightID)
	res, err := svc.compareMarks(ctx, compareMarksParams{LeftQueryID: lq, RightQueryID: rq})
	if err != nil {
		t.Fatal(err)
	}
	marked := func(names []string, sel selectionWire) []string {
		var out []string
		for _, r := range sel.Ranges {
			out = append(out, names[r[0]:r[1]]...)
		}
		return out
	}
	// Left: newer.txt, only-left.txt, same.txt. Right: extra/, newer.txt, same.txt.
	if got := marked(lnames, res.Left); !slices.Equal(got, []string{"newer.txt", "only-left.txt"}) || res.LeftCount != 2 || res.Left.QueryID != lq {
		t.Errorf("left marks %v (%+v)", got, res.Left)
	}
	if got := marked(rnames, res.Right); len(got) != 0 || res.RightCount != 0 || res.Right.Ranges == nil {
		t.Errorf("right marks %v", got)
	}
	// The other way round, dates ignored: only the size counts.
	res, _ = svc.compareMarks(ctx, compareMarksParams{LeftQueryID: rq, RightQueryID: lq, compareOptionsWire: compareOptionsWire{IgnoreDates: true}})
	if got := marked(rnames, res.Left); !slices.Equal(got, []string{"newer.txt"}) {
		t.Errorf("ignoring dates, right panel %v", got)
	}
	if got := marked(lnames, res.Right); !slices.Equal(got, []string{"newer.txt", "only-left.txt"}) {
		t.Errorf("ignoring dates, left panel %v", got)
	}
	// The marks are descriptors of the panels' sessions: selection.info reads them.
	sum, err := svc.store.Summarize(ctx, mustResolve(t, svc, res.Right))
	if err != nil || sum.Count != 2 {
		t.Errorf("the marks as a selection: %+v, %v", sum, err)
	}
	if _, err := svc.compareMarks(ctx, compareMarksParams{LeftQueryID: lq, RightQueryID: 9999}); rpcCode(err) != rpc.CodeNotFound {
		t.Errorf("an expired session: %v", err)
	}
}

func mustResolve(t *testing.T, svc *indexService, sel selectionWire) []int64 {
	t.Helper()
	ids, err := svc.resolveSelection(sel)
	if err != nil {
		t.Fatal(err)
	}
	return ids
}

func TestTextDiffOverRPC(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	root := t.TempDir()
	putAt(t, filepath.Join(root, "a.txt"), "one\ntwo\nthree\n", 0)
	putAt(t, filepath.Join(root, "b.txt"), "one\n2\nthree\nfour\n", 0)
	putAt(t, filepath.Join(root, "c.bin"), "\x00\x01\x02\x00\x00\x03", 0)
	_ = os.Mkdir(filepath.Join(root, "folder"), 0o755)
	_, items := openListed(t, svc, root)

	res, err := svc.textDiffOpen(ctx, textDiffOpenParams{LeftID: items["a.txt"].ID, RightID: items["b.txt"].ID})
	if err != nil {
		t.Fatal(err)
	}
	if res.DiffID == 0 || res.Reason != "" || res.Rows != 4 || res.Changes != 2 || res.Identical || res.Left.Name != "a.txt" ||
		res.Right.Lines != 4 || res.Left.Encoding != "utf-8" || !slices.Equal(res.Blocks, [][2]int{{1, 1}, {3, 1}}) {
		t.Fatalf("open %+v", res)
	}
	page, err := svc.textDiffPage(ctx, textDiffPageParams{DiffID: res.DiffID, Offset: 1, Limit: 3})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, r := range page.Rows {
		got = append(got, strings.Join([]string{r.Op, r.Left, r.Right}, "|"))
	}
	if !slices.Equal(got, []string{"changed|two|2", "equal|three|", "added||four"}) || page.Offset != 1 || page.Rows[2].L != 0 || page.Rows[2].R != 4 {
		t.Errorf("page %v %+v", got, page.Rows)
	}
	if _, err := svc.textDiffPage(ctx, textDiffPageParams{DiffID: res.DiffID, Limit: 501}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Errorf("a page too large: %v", err)
	}
	// The same file against itself.
	same, err := svc.textDiffOpen(ctx, textDiffOpenParams{LeftID: items["a.txt"].ID, RightID: items["a.txt"].ID})
	if err != nil || !same.Identical || same.Changes != 0 {
		t.Errorf("a file against itself: %+v, %v", same, err)
	}
	// Not text: no diff, and the reason; sizes are there for the answer.
	bin, err := svc.textDiffOpen(ctx, textDiffOpenParams{LeftID: items["a.txt"].ID, RightID: items["c.bin"].ID})
	if err != nil || bin.DiffID != 0 || bin.Reason != "binary" || bin.Right.SizeBytes != 6 || bin.Blocks == nil {
		t.Errorf("binary: %+v, %v", bin, err)
	}
	if _, err := svc.textDiffOpen(ctx, textDiffOpenParams{LeftID: items["a.txt"].ID, RightID: items["folder"].ID}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Errorf("a folder: %v", err)
	}
	if _, err := svc.textDiffOpen(ctx, textDiffOpenParams{LeftID: items["a.txt"].ID, RightID: 987_654}); rpcCode(err) != rpc.CodeNotFound {
		t.Errorf("an unknown entry: %v", err)
	}
	// A file edited after the diff: its rows are refused, not misread.
	putAt(t, filepath.Join(root, "b.txt"), "something else entirely\n", 50)
	_, err = svc.textDiffPage(ctx, textDiffPageParams{DiffID: res.DiffID, Limit: 10})
	if reasonOf(err) != "changed" {
		t.Errorf("a changed file: %v", err)
	}
	if !svc.diffs.close(res.DiffID) || svc.diffs.close(res.DiffID) {
		t.Error("close")
	}
	if _, err := svc.textDiffPage(ctx, textDiffPageParams{DiffID: res.DiffID, Limit: 10}); rpcCode(err) != rpc.CodeNotFound {
		t.Errorf("a closed diff: %v", err)
	}
	// Only a few diffs stay open.
	var ids []int64
	for range MaxTextDiffs + 1 {
		r, err := svc.textDiffOpen(ctx, textDiffOpenParams{LeftID: items["a.txt"].ID, RightID: items["a.txt"].ID})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, r.DiffID)
	}
	if svc.diffs.get(ids[0]) != nil || svc.diffs.get(ids[len(ids)-1]) == nil {
		t.Error("the oldest diff was kept")
	}
}

func TestChecksumAndCompareJobsOverRPC(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	root := t.TempDir()
	putAt(t, filepath.Join(root, "a.txt"), "xxx", 0)
	putAt(t, filepath.Join(root, "b.txt"), "xxx", 0)
	putAt(t, filepath.Join(root, "c.txt"), "xxy", 0)
	dirID, items := openListed(t, svc, root)
	snap, _ := svc.queryOpen(ctx, queryOpenParams{DirID: dirID, Scope: "all", Sort: []sortKeyWire{{Field: "name", Direction: "asc"}}})
	all := jobSourceWire{Selection: selectionWire{QueryID: snap.QueryID, Version: snap.Version, Ranges: [][2]int{{0, 3}}}}

	job, err := svc.jobsStart(ctx, jobStartParams{Kind: "hashCreate", Source: all, Algorithm: "sha256", DestinationDirID: dirID, Name: "sums.sha256"})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitJob(t, svc, job.JobID); s.State != jobs.StateCompleted || s.Done != 3 {
		t.Fatalf("create: %+v", s)
	}
	list, _ := os.ReadFile(filepath.Join(root, "sums.sha256"))
	if n := strings.Count(string(list), "\n"); n != 3 || !strings.Contains(string(list), " *c.txt\n") {
		t.Errorf("list %q", list)
	}
	for name, p := range map[string]jobStartParams{
		"an unknown algorithm":  {Kind: "hashCreate", Source: all, Algorithm: "whirlpool", PerFile: true},
		"a list without a name": {Kind: "hashCreate", Source: all, Algorithm: "md5", DestinationDirID: dirID},
	} {
		if _, err := svc.jobsStart(ctx, p); rpcCode(err) != rpc.CodeInvalidArgument {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := svc.jobsStart(ctx, jobStartParams{Kind: "hashCreate", Source: all, Algorithm: "md5", Name: "x.md5"}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Errorf("a list without a folder: %v", err)
	}

	// Verify the new list (the session lists it once it is refreshed).
	_, items = openListed(t, svc, root)
	snap, _ = svc.queryOpen(ctx, queryOpenParams{DirID: dirID, Scope: "all", Sort: []sortKeyWire{{Field: "name", Direction: "asc"}}})
	listSel := jobSourceWire{Selection: selectionWire{QueryID: snap.QueryID, Version: snap.Version, Include: []int64{items["sums.sha256"].ID}}}
	putAt(t, filepath.Join(root, "b.txt"), "xxz", 0)
	job, err = svc.jobsStart(ctx, jobStartParams{Kind: "hashVerify", Source: listSel})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitJob(t, svc, job.JobID); s.Done != 2 || s.Failed != 1 || s.Total != 3 {
		t.Errorf("verify: %+v", s)
	}
	errs, _, _ := svc.jobs.Errors(job.JobID, 0, 10)
	if len(errs) != 1 || errs[0].Name != "b.txt" || errs[0].Code != jobs.CodeMismatch {
		t.Errorf("verify errors %v", errs)
	}

	// Compare by content: two entries by id.
	job, err = svc.jobsStart(ctx, jobStartParams{Kind: "compareFiles", LeftID: items["a.txt"].ID, RightID: items["c.txt"].ID})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitJob(t, svc, job.JobID); s.Failed != 1 || s.Total != 1 {
		t.Errorf("different files: %+v", s)
	}
	putAt(t, filepath.Join(root, "b.txt"), "xxx", 0)
	job, _ = svc.jobsStart(ctx, jobStartParams{Kind: "compareFiles", LeftID: items["a.txt"].ID, RightID: items["b.txt"].ID})
	if s := waitJob(t, svc, job.JobID); s.Done != 1 || s.Failed != 0 {
		t.Errorf("identical files: %+v", s)
	}
}
