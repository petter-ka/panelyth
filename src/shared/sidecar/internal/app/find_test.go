package app

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"panelyth/sidecar/internal/find"
	"panelyth/sidecar/internal/rpc"
)

// Stage C06: find results work like a folder: pages, quick search and
// marks over them, a panel's own sorted session, file operations that
// remove results, and "Go to file".

func waitFind(t *testing.T, svc *indexService, findID int64) {
	t.Helper()
	svc.finds.Wait(findID)
}

// waitTotal polls a session until its total reaches want (refreshes are
// throttled).
func waitTotal(t *testing.T, svc *indexService, queryID int64, want int) []string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		page, err := svc.queryPage(context.Background(), queryPageParams{QueryID: queryID, Limit: 100})
		if err != nil {
			t.Fatal(err)
		}
		if page.Total == want && len(page.Items) == want {
			names := make([]string, len(page.Items))
			for i, it := range page.Items {
				names[i] = it.Name
			}
			return names
		}
		if time.Now().After(deadline) {
			t.Fatalf("session %d: total %d, want %d", queryID, page.Total, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestFindResultsAsAFolder(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	root := t.TempDir()
	for _, p := range []string{"b-report.txt", "sub/a-report.txt", "sub/deep/c-report.txt", "sub/other.md"} {
		path := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("quarterly numbers"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	res, err := svc.findStart(ctx, findStartParams{Roots: []string{root}, Mask: "*report*", Depth: -1, Text: "NUMBERS"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 0 || res.Version != 1 {
		t.Errorf("the results session starts empty: %+v", res)
	}
	waitFind(t, svc, res.FindID)
	found := waitTotal(t, svc, res.QueryID, 3)
	slices.Sort(found)
	if !slices.Equal(found, []string{"a-report.txt", "b-report.txt", "c-report.txt"}) {
		t.Errorf("found %v", found)
	}

	// A fed panel: its own session, sorted, with quick search and marks.
	panel, err := svc.queryOpen(ctx, queryOpenParams{FindID: res.FindID, Scope: "all",
		Sort: []sortKeyWire{{Field: "name", Direction: "desc"}}})
	if err != nil {
		t.Fatal(err)
	}
	if got := waitTotal(t, svc, panel.QueryID, 3); !slices.Equal(got, []string{"c-report.txt", "b-report.txt", "a-report.txt"}) {
		t.Errorf("panel order %v", got)
	}
	at, _, err := svc.queries.Locate(ctx, panel.QueryID, "a-r", 0, false)
	if err != nil || at != 2 {
		t.Errorf("quick search: %d %v", at, err)
	}
	marked, _, err := svc.queries.Match(ctx, panel.QueryID, "b*;c*", true)
	if err != nil || !slices.Equal(marked, []int{0, 1}) {
		t.Errorf("mark by mask: %v %v", marked, err)
	}
	filtered, err := svc.queryOpen(ctx, queryOpenParams{FindID: res.FindID, Scope: "all", NameMask: "a*"})
	if err != nil {
		t.Fatal(err)
	}
	if got := waitTotal(t, svc, filtered.QueryID, 1); got[0] != "a-report.txt" {
		t.Errorf("quick filter %v", got)
	}
	if _, err := svc.queryOpen(ctx, queryOpenParams{FindID: res.FindID, Scope: "media"}); err == nil {
		t.Error("find results opened in the media scope")
	}
	if _, err := svc.queryOpen(ctx, queryOpenParams{FindID: 999, Scope: "all"}); err == nil {
		t.Error("unknown search opened")
	} else if code, _ := rpcReason(err); code != rpc.CodeNotFound {
		t.Errorf("unknown search: %v", err)
	}

	// Go to file: the containing folder opens.
	page, _ := svc.queryPage(ctx, queryPageParams{QueryID: panel.QueryID, Limit: 3})
	deep := page.Items[0] // c-report.txt
	dir, err := svc.dirOpenContaining(ctx, dirOpenContainingParams{EntryID: deep.ID, Lane: "left"})
	if err != nil || dir.Path != filepath.Join(root, "sub", "deep") {
		t.Fatalf("go to file: %+v %v", dir, err)
	}
	svc.scans.Wait(dir.ScanID)

	// Deleting a result through a job (the panel's selection) removes it
	// from every session over the results.
	sel := selectionWire{QueryID: panel.QueryID, Version: page.Version, Ranges: [][2]int{{0, 1}}, Include: []int64{}, Exclude: []int64{}}
	snap, err := svc.jobsStart(ctx, jobStartParams{Kind: "delete", Source: jobSourceWire{Selection: sel}})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(root, "sub", "deep", "c-report.txt")); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job %d did not delete", snap.JobID)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := waitTotal(t, svc, panel.QueryID, 2); !slices.Equal(got, []string{"b-report.txt", "a-report.txt"}) {
		t.Errorf("after delete: %v", got)
	}
	waitTotal(t, svc, res.QueryID, 2)
}

func TestFindStartValidation(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	root := t.TempDir()
	for _, p := range []findStartParams{
		{},
		{Roots: []string{"relative/path"}},
		{Roots: []string{root}, Encodings: []string{"utf-32"}, Text: "x"},
		{Roots: []string{root}, AttrsSet: 1 << 10},
		{Roots: []string{filepath.Join(root, "missing")}},
	} {
		if _, err := svc.findStart(ctx, p); err == nil {
			t.Errorf("accepted %+v", p)
		}
	}
	// Cancelling an unknown or finished search is not an error.
	if svc.finds.Cancel(12345) {
		t.Error("cancelled an unknown search")
	}
	res, err := svc.findStart(ctx, findStartParams{Roots: []string{root}, Depth: -1})
	if err != nil {
		t.Fatal(err)
	}
	waitFind(t, svc, res.FindID)
	if svc.finds.Cancel(res.FindID) {
		t.Error("cancelled a finished search")
	}
	// Closing the last session forgets a finished search.
	svc.queries.Close(res.QueryID)
	if _, err := svc.finds.Source(res.FindID); err != find.ErrUnknown {
		t.Errorf("source kept: %v", err)
	}
}
