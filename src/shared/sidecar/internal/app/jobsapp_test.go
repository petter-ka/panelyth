package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/library"
)

// Each app lists the jobs it started (ADR-0031 amended): main names the app
// on every start, Go keeps it on the job, and a conflict question carries it
// so main asks only that app's views.

func TestJobsAreListedInTheAppThatStartedThem(t *testing.T) {
	ctx := context.Background()
	var mu sync.Mutex
	var conflicts []jobConflictEvent
	emit := func(ch string, payload any) error {
		if ch != evJobConflict {
			return nil
		}
		b, _ := json.Marshal(payload)
		var ev jobConflictEvent
		_ = json.Unmarshal(b, &ev)
		mu.Lock()
		conflicts = append(conflicts, ev)
		mu.Unlock()
		return nil
	}
	svc, err := newIndexService(t.TempDir(), 1<<20, slog.New(slog.DiscardHandler), emit, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	lib, err := library.Open(filepath.Join(t.TempDir(), "library.db"))
	if err != nil {
		t.Fatal(err)
	}
	svc.lib = lib
	close(svc.libReady)
	t.Cleanup(func() {
		svc.close()
		_ = lib.Close()
	})

	src := filepath.Join(t.TempDir(), "src")
	dst := filepath.Join(t.TempDir(), "dst")
	for _, dir := range []string{src, dst} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range []string{"a.jpg", "b.png", "c.txt"} {
		if err := os.WriteFile(filepath.Join(src, n), []byte(n), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	srcDir, _ := svc.store.EnsureDir(ctx, src)
	ids := listIDs(t, svc, srcDir)

	start := func(app string, conflict string) jobs.Snapshot {
		t.Helper()
		snap, err := svc.jobs.Start(jobs.Spec{Kind: jobs.KindCopy, App: app, IDs: ids[:1], Destination: dst,
			Conflict: conflict})
		if err != nil {
			t.Fatal(err)
		}
		if snap.App != app {
			t.Fatalf("snapshot app %q, want %q", snap.App, app)
		}
		return waitJob(t, svc, snap.JobID)
	}
	viewer := start("viewer", jobs.ConflictKeepBoth)
	commander := start("commander", jobs.ConflictKeepBoth)
	none := start("", jobs.ConflictKeepBoth)

	listed := func(app string) map[int64]string {
		out := map[int64]string{}
		for _, s := range svc.jobsList(app).Jobs {
			out[s.JobID] = s.App
		}
		return out
	}
	want := func(app string, ids ...int64) {
		t.Helper()
		got := listed(app)
		if len(got) != len(ids) {
			t.Errorf("%q lists %v, want %v", app, got, ids)
		}
		for _, id := range ids {
			if _, ok := got[id]; !ok {
				t.Errorf("%q does not list job %d: %v", app, id, got)
			}
		}
	}
	want("viewer", viewer.JobID, none.JobID)
	want("commander", commander.JobID, none.JobID)
	want("", viewer.JobID, commander.JobID, none.JobID)

	// A name that is taken: the question names the commander's job as the commander's.
	snap, err := svc.jobs.Start(jobs.Spec{Kind: jobs.KindCopy, App: "commander", IDs: ids[:1], Destination: dst,
		Conflict: jobs.ConflictAsk})
	if err != nil {
		t.Fatal(err)
	}
	var asked *jobConflictEvent
	for deadline := time.Now().Add(10 * time.Second); asked == nil && time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		mu.Lock()
		for i := range conflicts {
			if conflicts[i].JobID == snap.JobID {
				asked = &conflicts[i]
			}
		}
		mu.Unlock()
	}
	if asked == nil {
		t.Fatal("no conflict question")
	}
	if asked.App != "commander" {
		t.Errorf("the question's app %q", asked.App)
	}
	svc.jobs.Cancel(snap.JobID)
	waitJob(t, svc, snap.JobID)
}
