package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"

	"panelyth/sidecar/internal/query"
	"panelyth/sidecar/internal/rpc"
)

// Stage P02 (ADR-0026): one sidecar serves both apps. Main names the calling
// app on dir.open and query.open and the app on screen with app.setVisible;
// sessions are budgeted per app and only the visible app's folders are
// watched.

var visibleCalls int64

// seq numbers the app.setVisible calls as main does.
func seq() int64 {
	visibleCalls++
	return visibleCalls
}

func mkdirs(t *testing.T, names ...string) []string {
	t.Helper()
	root := t.TempDir()
	var out []string
	for _, n := range names {
		dir := filepath.Join(root, n)
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "a.jpg"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		out = append(out, dir)
	}
	return out
}

func mustOpenDir(t *testing.T, svc *indexService, p dirOpenParams) dirOpenResult {
	t.Helper()
	res, err := svc.dirOpen(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	svc.scans.Wait(res.ScanID)
	return res
}

func watchedNames(svc *indexService) []string {
	var names []string
	for _, p := range svc.watcher.Watched() {
		names = append(names, filepath.Base(p))
	}
	slices.Sort(names)
	return names
}

func TestOnlyTheVisibleAppsFoldersAreWatched(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	dirs := mkdirs(t, "photos", "left", "right", "target")

	if _, err := svc.appSetVisible(ctx, appSetVisibleParams{App: "viewer", Seq: seq()}); err != nil {
		t.Fatal(err)
	}
	mustOpenDir(t, svc, dirOpenParams{Path: dirs[0], App: "viewer"})
	if svc.watcher.Watched() == nil {
		t.Skip("file watching is unavailable here")
	}
	mustOpenDir(t, svc, dirOpenParams{Path: dirs[1], App: "commander", Lane: "left"})
	mustOpenDir(t, svc, dirOpenParams{Path: dirs[2], App: "commander", Lane: "right"})
	// A destination typed into a copy dialog: opened, never on screen.
	mustOpenDir(t, svc, dirOpenParams{Path: dirs[3], App: "commander"})
	if got := watchedNames(svc); !slices.Contains(got, "photos") || slices.Contains(got, "left") || slices.Contains(got, "target") {
		t.Fatalf("with the viewer on screen the watched folders are %v", got)
	}

	if _, err := svc.appSetVisible(ctx, appSetVisibleParams{App: "commander", Seq: seq()}); err != nil {
		t.Fatal(err)
	}
	got := watchedNames(svc)
	if !slices.Contains(got, "left") || !slices.Contains(got, "right") || slices.Contains(got, "photos") || slices.Contains(got, "target") {
		t.Fatalf("with the commander on screen the watched folders are %v", got)
	}

	var bad *rpc.Error
	if _, err := svc.appSetVisible(ctx, appSetVisibleParams{App: "shell", Seq: seq()}); !errors.As(err, &bad) || bad.Code != rpc.CodeInvalidArgument {
		t.Fatalf("an unknown app must be refused: %v", err)
	}
	if _, err := svc.dirOpen(ctx, dirOpenParams{Path: dirs[0], App: "shell"}); !errors.As(err, &bad) || bad.Code != rpc.CodeInvalidArgument {
		t.Fatalf("dir.open with an unknown app must be refused: %v", err)
	}
}

// A file that appeared in a panel's folder while the viewer was on screen is
// listed when the commander is shown again, with no event from the OS.
func TestAHiddenAppsFolderIsRelistedWhenShown(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	dirs := mkdirs(t, "photos", "left")
	if _, err := svc.appSetVisible(ctx, appSetVisibleParams{App: "commander", Seq: seq()}); err != nil {
		t.Fatal(err)
	}
	panel := mustOpenDir(t, svc, dirOpenParams{Path: dirs[1], App: "commander", Lane: "left"})
	if svc.watcher.Watched() == nil {
		t.Skip("file watching is unavailable here")
	}
	snap, err := svc.queryOpen(ctx, queryOpenParams{DirID: panel.DirID, Scope: "all", App: "commander"})
	if err != nil || snap.Total != 1 {
		t.Fatalf("panel session %+v, %v", snap, err)
	}

	if _, err := svc.appSetVisible(ctx, appSetVisibleParams{App: "viewer", Seq: seq()}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dirs[1], "new.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Hidden: no watch, so the session stays as it is.
	time.Sleep(700 * time.Millisecond)
	if page, err := svc.queries.Page(ctx, snap.QueryID, 0, 10); err != nil || page.Total != 1 {
		t.Fatalf("a hidden app's folder was re-listed: total %d, %v", page.Total, err)
	}

	if _, err := svc.appSetVisible(ctx, appSetVisibleParams{App: "commander", Seq: seq()}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		page, err := svc.queries.Page(ctx, snap.QueryID, 0, 10)
		if err == nil && page.Total == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the shown app's folder was not re-listed: total %d, %v", page.Total, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestSessionsCountAgainstTheCallingAppsBudget(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	dirs := mkdirs(t, "photos")
	dir := mustOpenDir(t, svc, dirOpenParams{Path: dirs[0], App: "viewer"})

	viewerFolder, err := svc.queryOpen(ctx, queryOpenParams{DirID: dir.DirID, App: "viewer"})
	if err != nil {
		t.Fatal(err)
	}
	for range query.Budgets[query.OwnerCommander] + 5 {
		if _, err := svc.queryOpen(ctx, queryOpenParams{DirID: dir.DirID, Scope: "all", App: "commander"}); err != nil {
			t.Fatal(err)
		}
	}
	if n := svc.queries.Count(query.OwnerCommander); n != query.Budgets[query.OwnerCommander] {
		t.Errorf("commander holds %d sessions, want %d", n, query.Budgets[query.OwnerCommander])
	}
	if _, err := svc.queries.Page(ctx, viewerFolder.QueryID, 0, 1); err != nil {
		t.Errorf("the commander's tabs closed the viewer's folder: %v", err)
	}
	// Main's own sessions (no app named) have a budget of their own.
	if _, err := svc.queryOpen(ctx, queryOpenParams{DirID: dir.DirID}); err != nil {
		t.Fatal(err)
	}
	if svc.queries.Count(query.OwnerMain) != 1 || svc.queries.Count(query.OwnerViewer) != 1 {
		t.Errorf("owners: main %d, viewer %d", svc.queries.Count(query.OwnerMain), svc.queries.Count(query.OwnerViewer))
	}
	var bad *rpc.Error
	if _, err := svc.queryOpen(ctx, queryOpenParams{DirID: dir.DirID, App: "shell"}); !errors.As(err, &bad) || bad.Code != rpc.CodeInvalidArgument {
		t.Fatalf("query.open with an unknown app must be refused: %v", err)
	}
}

// A folder the commander opens (a typed destination has no lane) used to
// share the viewer's scan lane and stop the viewer's listing.
func TestAnAppsOpenNeverCancelsTheOtherAppsScan(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	big := t.TempDir()
	for i := range 3000 {
		if err := os.WriteFile(filepath.Join(big, "f"+strconv.Itoa(i)+".jpg"), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	other := mkdirs(t, "target")[0]

	viewerScan, err := svc.dirOpen(ctx, dirOpenParams{Path: big, App: "viewer"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.dirOpen(ctx, dirOpenParams{Path: other, App: "commander"}); err != nil {
		t.Fatal(err)
	}
	svc.scans.Wait(viewerScan.ScanID)
	snap, err := svc.queryOpen(ctx, queryOpenParams{DirID: viewerScan.DirID, App: "viewer"})
	if err != nil {
		t.Fatal(err)
	}
	if snap.Total != 3000 {
		t.Fatalf("the viewer's listing was cut short at %d of 3000", snap.Total)
	}
}

// Requests are handled concurrently: a call overtaken by a later switch is
// dropped, so the watches end with the app that is really on screen.
func TestALateSetVisibleDoesNotUndoANewerOne(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	dirs := mkdirs(t, "photos", "left")
	mustOpenDir(t, svc, dirOpenParams{Path: dirs[0], App: "viewer"})
	mustOpenDir(t, svc, dirOpenParams{Path: dirs[1], App: "commander", Lane: "left"})
	if svc.watcher.Watched() == nil {
		t.Skip("file watching is unavailable here")
	}

	// Main switched to the commander (seq 1) and back (seq 2); 2 arrives first.
	if res, err := svc.appSetVisible(ctx, appSetVisibleParams{App: "viewer", Seq: 2}); err != nil || !res.OK {
		t.Fatalf("seq 2: %+v, %v", res, err)
	}
	if res, err := svc.appSetVisible(ctx, appSetVisibleParams{App: "commander", Seq: 1}); err != nil || res.OK {
		t.Fatalf("an overtaken call must be dropped: %+v, %v", res, err)
	}
	if got := watchedNames(svc); !slices.Contains(got, "photos") || slices.Contains(got, "left") {
		t.Fatalf("the viewer is on screen, watched: %v", got)
	}
	// Without a sequence number (0) nothing is applied either.
	if res, _ := svc.appSetVisible(ctx, appSetVisibleParams{App: "commander"}); res.OK {
		t.Fatal("a call without seq must not be applied")
	}
}
