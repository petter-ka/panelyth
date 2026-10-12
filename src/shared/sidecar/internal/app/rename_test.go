package app

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"time"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/rpc"
)

// Stage C09 through the RPC handlers: the paged preview, the multi-rename
// job started from the same plan, its undo, attribute and date changes, and
// what properties say about attributes and links.

// listedQuery lists dir and opens its session in the commander's scope,
// sorted by name.
func listedQuery(t *testing.T, svc *indexService, dir string) (queryID, version int64, items map[string]contentItem) {
	t.Helper()
	ctx := context.Background()
	res, err := svc.dirOpen(ctx, dirOpenParams{Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	svc.scans.Wait(res.ScanID)
	snap, err := svc.queryOpen(ctx, queryOpenParams{DirID: res.DirID, Scope: "all", ShowHidden: true,
		Sort: []sortKeyWire{{Field: "name", Direction: "asc"}}})
	if err != nil {
		t.Fatal(err)
	}
	page, err := svc.queryPage(ctx, queryPageParams{QueryID: snap.QueryID, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	items = map[string]contentItem{}
	for _, it := range page.Items {
		items[it.Name] = it
	}
	return snap.QueryID, snap.Version, items
}

func plainPlan(name, ext string) renamePlanWire {
	return renamePlanWire{NameMask: name, ExtMask: ext, Start: 1, Step: 1, Digits: 1}
}

func previewRows(rows []renamePreviewRow) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Name + " > " + r.NewName + " " + r.Status
		if r.Reason != "" {
			out[i] += " " + r.Reason
		}
	}
	return out
}

func TestRenamePreviewJobAndUndo(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	dir := t.TempDir()
	for i, n := range []string{"IMG_1.jpg", "IMG_2.jpg", "IMG_3.jpg", "notes.txt", "taken.txt"} {
		putAt(t, filepath.Join(dir, n), "x", i)
	}
	queryID, version, items := listedQuery(t, svc, dir)
	all := selectionWire{QueryID: queryID, Version: version, Ranges: [][2]int{{0, 5}}, Include: []int64{}, Exclude: []int64{}}
	only := func(names ...string) selectionWire {
		sel := selectionWire{QueryID: queryID, Version: version, Ranges: [][2]int{}, Include: []int64{}, Exclude: []int64{}}
		for _, n := range names {
			sel.Include = append(sel.Include, items[n].ID)
		}
		return sel
	}

	// The first page of a batch, then the rest; the counter follows the order.
	plan := plainPlan("[N]-[C:2]", "[E]")
	first, err := svc.renamePreview(ctx, renamePreviewParams{Selection: all, Plan: plan, Limit: 3})
	if err != nil {
		t.Fatal(err)
	}
	if first.Total != 5 || first.Renamed != 5 || first.Conflicts+first.Invalid+first.Unchanged != 0 || first.FirstProblem != -1 {
		t.Fatalf("preview: %+v", first)
	}
	want := []string{"IMG_1.jpg > IMG_1-01.jpg rename", "IMG_2.jpg > IMG_2-02.jpg rename", "IMG_3.jpg > IMG_3-03.jpg rename"}
	if got := previewRows(first.Rows); !slices.Equal(got, want) || first.Rows[0].ID != items["IMG_1.jpg"].ID {
		t.Fatalf("first page: %v", got)
	}
	rest, err := svc.renamePreview(ctx, renamePreviewParams{Selection: all, Plan: plan, Offset: 3, Limit: 500})
	if err != nil {
		t.Fatal(err)
	}
	if got := previewRows(rest.Rows); !slices.Equal(got, []string{"notes.txt > notes-04.txt rename", "taken.txt > taken-05.txt rename"}) || rest.Offset != 3 {
		t.Fatalf("second page: %v", got)
	}
	// The selection was resolved once; an offset beyond the end gives no rows.
	if len(svc.previews.entries) != 5 || len(svc.previews.paths) != 1 {
		t.Fatalf("kept entries: %d in %d folders", len(svc.previews.entries), len(svc.previews.paths))
	}
	if beyond, err := svc.renamePreview(ctx, renamePreviewParams{Selection: all, Plan: plan, Offset: 99, Limit: 10}); err != nil || len(beyond.Rows) != 0 || beyond.Offset != 5 {
		t.Fatalf("beyond the end: %+v %v", beyond, err)
	}

	// Conflicts: the same name twice, a name an unselected entry has, an
	// invalid name, an unchanged one.
	dup, err := svc.renamePreview(ctx, renamePreviewParams{Selection: only("IMG_1.jpg", "IMG_2.jpg", "notes.txt"), Plan: plainPlan("taken", "[E]"), Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	want = []string{"IMG_1.jpg > taken.jpg conflict duplicate", "IMG_2.jpg > taken.jpg conflict duplicate", "notes.txt > taken.txt conflict exists"}
	if got := previewRows(dup.Rows); !slices.Equal(got, want) || dup.Conflicts != 3 || dup.FirstProblem != 0 {
		t.Fatalf("conflicts: %v %+v", got, dup)
	}
	odd := plainPlan("[N]", "[E]")
	odd.Search, odd.Replace, odd.Regex = `^IMG_1\.jpg$|^notes`, "..", true
	mixed, err := svc.renamePreview(ctx, renamePreviewParams{Selection: only("IMG_3.jpg", "IMG_1.jpg"), Plan: odd, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if mixed.Unchanged != 1 || mixed.Invalid != 1 || mixed.FirstProblem != 1 || mixed.Rows[1].Status != "invalid" || mixed.Rows[1].Reason == "" {
		t.Fatalf("unchanged and invalid: %+v", mixed)
	}

	// A plan that cannot be compiled names its field; bad pages are refused.
	_, err = svc.renamePreview(ctx, renamePreviewParams{Selection: all, Plan: plainPlan("[N", "[E]"), Limit: 10})
	var re *rpc.Error
	if !errors.As(err, &re) || re.Code != rpc.CodeInvalidArgument || reasonOf(err) != "plan" || re.Details.(map[string]string)["field"] != "nameMask" {
		t.Fatalf("open placeholder: %v", err)
	}
	bad := plainPlan("[N]", "[E]")
	bad.Search, bad.Regex = "(", true
	if _, err = svc.renamePreview(ctx, renamePreviewParams{Selection: all, Plan: bad, Limit: 10}); !errors.As(err, &re) || re.Details.(map[string]string)["field"] != "search" {
		t.Fatalf("bad expression: %v", err)
	}
	for _, p := range []renamePreviewParams{{Selection: all, Plan: plan, Limit: 0}, {Selection: all, Plan: plan, Limit: 501}, {Selection: all, Plan: plan, Offset: -1, Limit: 1}} {
		if _, err := svc.renamePreview(ctx, p); rpcCode(err) != rpc.CodeInvalidArgument {
			t.Fatalf("page %d+%d: %v", p.Offset, p.Limit, err)
		}
	}
	stale := all
	stale.Version++
	if _, err := svc.renamePreview(ctx, renamePreviewParams{Selection: stale, Plan: plan, Limit: 10}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Fatalf("stale selection: %v", err)
	}

	// Nothing to undo yet; then the job applies the plan the preview showed.
	if info := svc.jobs.UndoInfo(); info.Count != 0 {
		t.Fatalf("undo info: %+v", info)
	}
	if _, err := svc.jobsStart(ctx, jobStartParams{Kind: "undoRename"}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Fatalf("undo without a rename: %v", err)
	}
	if _, err := svc.jobsStart(ctx, jobStartParams{Kind: "multiRename", Source: jobSourceWire{Selection: all}}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Fatalf("multi-rename without a plan: %v", err)
	}
	broken := plainPlan("[Q]", "[E]")
	if _, err := svc.jobsStart(ctx, jobStartParams{Kind: "multiRename", Source: jobSourceWire{Selection: all}, Plan: &broken}); reasonOf(err) != "plan" {
		t.Fatalf("multi-rename with a bad plan: %v", err)
	}
	started, err := svc.jobsStart(ctx, jobStartParams{Kind: "multiRename", Source: jobSourceWire{Selection: all}, Plan: &plan})
	if err != nil {
		t.Fatal(err)
	}
	if done := waitJob(t, svc, started.JobID); done.State != jobs.StateCompleted || done.Done != 5 || done.Kind != jobs.KindMultiRename {
		t.Fatalf("multi-rename: %+v", done)
	}
	if svc.previews.entries != nil {
		t.Fatal("the preview's entries were kept after the job started")
	}
	names := func() []string {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		out := []string{}
		for _, e := range entries {
			out = append(out, e.Name())
		}
		return out
	}
	if got := names(); !slices.Equal(got, []string{"IMG_1-01.jpg", "IMG_2-02.jpg", "IMG_3-03.jpg", "notes-04.txt", "taken-05.txt"}) {
		t.Fatalf("after the rename: %v", got)
	}
	if info := svc.jobs.UndoInfo(); info.Count != 5 || info.Dir != dir {
		t.Fatalf("undo info: %+v", info)
	}
	undo, err := svc.jobsStart(ctx, jobStartParams{Kind: "undoRename"})
	if err != nil {
		t.Fatal(err)
	}
	if done := waitJob(t, svc, undo.JobID); done.State != jobs.StateCompleted || done.Done != 5 || done.Total != 5 {
		t.Fatalf("undo: %+v", done)
	}
	if got := names(); !slices.Equal(got, []string{"IMG_1.jpg", "IMG_2.jpg", "IMG_3.jpg", "notes.txt", "taken.txt"}) {
		t.Fatalf("after the undo: %v", got)
	}
}

func TestSetAttributesJobAndProperties(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	dir := t.TempDir()
	putAt(t, filepath.Join(dir, "doc.txt"), "x", 0)
	putAt(t, filepath.Join(dir, "sub", "inner.txt"), "x", 0)
	queryID, version, items := listedQuery(t, svc, dir)
	sel := selectionWire{QueryID: queryID, Version: version, Ranges: [][2]int{{0, 2}}, Include: []int64{}, Exclude: []int64{}}
	t.Cleanup(func() {
		_ = fileops.ApplyAttrs(filepath.Join(dir, "doc.txt"), fileops.AttrChange{Clear: fileops.SettableAttrs, ModeSet: 0o600})
		// The job takes the write permission from "sub" too; without it an
		// ordinary user cannot remove what is inside (Stage P04).
		_ = os.Chmod(filepath.Join(dir, "sub"), 0o755)
	})

	when := time.Date(2021, 4, 5, 6, 7, 8, 0, time.UTC).UnixMilli()
	p := jobStartParams{Kind: "setAttributes", Source: jobSourceWire{Selection: sel}, ModifiedMs: &when, Recursive: true,
		SetAttrs: fsx.AttrReadOnly, ClearAttrs: fsx.AttrArchive, ClearMode: 0o222}
	started, err := svc.jobsStart(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if done := waitJob(t, svc, started.JobID); done.State != jobs.StateCompleted || done.Done != 2 || done.Failed != 0 {
		errs, _, _ := svc.jobs.Errors(started.JobID, 0, 10)
		t.Fatalf("set attributes: %+v %v", done, errs)
	}
	for _, f := range []string{"doc.txt", "sub", filepath.Join("sub", "inner.txt")} {
		fi, err := os.Stat(filepath.Join(dir, f))
		if err != nil || fi.ModTime().UnixMilli() != when {
			t.Fatalf("%s: modified %v (%v)", f, fi.ModTime(), err)
		}
	}
	// Properties show the entry as it is now.
	props, err := svc.propsGet(ctx, entryParams{EntryID: items["doc.txt"].ID})
	if err != nil {
		t.Fatal(err)
	}
	if props.ModifiedMs != when || props.Attrs&fsx.AttrReadOnly == 0 || props.Attrs&fsx.AttrArchive != 0 || props.LinkTarget != nil {
		t.Fatalf("properties: %+v", props)
	}
	if windows := runtime.GOOS == "windows"; windows != (props.Permissions == nil) {
		t.Fatalf("permissions on %s: %v", runtime.GOOS, props.Permissions)
	} else if !windows && *props.Permissions&0o222 != 0 {
		t.Fatalf("permissions %o still writable", *props.Permissions)
	}
	// So does the listing, without a rescan.
	page, err := svc.queryPage(ctx, queryPageParams{QueryID: queryID, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range page.Items {
		if it.Name == "doc.txt" && (it.ModifiedMs != when || it.Attrs&fsx.AttrReadOnly == 0) {
			t.Fatalf("listed row: %+v", it)
		}
	}

	// Validation through the RPC.
	for name, bad := range map[string]jobStartParams{
		"nothing":     {Kind: "setAttributes", Source: jobSourceWire{Selection: sel}},
		"both":        {Kind: "setAttributes", Source: jobSourceWire{Selection: sel}, SetAttrs: fsx.AttrHidden, ClearAttrs: fsx.AttrHidden},
		"permissions": {Kind: "setAttributes", Source: jobSourceWire{Selection: sel}, SetMode: 0o1000},
	} {
		if _, err := svc.jobsStart(ctx, bad); rpcCode(err) != rpc.CodeInvalidArgument {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestPropertiesOfALink(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	dir := t.TempDir()
	target := filepath.Join(t.TempDir(), "target")
	putAt(t, filepath.Join(target, "a.txt"), "x", 0)
	link := filepath.Join(dir, "shortcut")
	if err := os.Symlink(target, link); err != nil {
		if out, jerr := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); jerr != nil {
			t.Skipf("no link could be made: %v / %v %s", err, jerr, out)
		}
	}
	_, _, items := listedQuery(t, svc, dir)
	props, err := svc.propsGet(ctx, entryParams{EntryID: items["shortcut"].ID})
	if err != nil {
		t.Fatal(err)
	}
	if props.Attrs&fsx.AttrLink == 0 || props.LinkTarget == nil || filepath.Clean(*props.LinkTarget) != target {
		t.Fatalf("link properties: attrs %b, target %v", props.Attrs, props.LinkTarget)
	}
}
