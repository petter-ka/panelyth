package jobs

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/pathkey"
)

// Engine v2: lanes, start-now, pause, conflicts, speed (Stage P03, ADR-0029).

// waitFor polls the job until cond holds.
func (e *env) waitFor(id int64, what string, cond func(Snapshot) bool) Snapshot {
	e.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if s := e.wait0(id); s.JobID == id && cond(s) {
			return s
		}
		time.Sleep(2 * time.Millisecond)
	}
	e.t.Fatalf("job %d: %s: %+v", id, what, e.wait0(id))
	return Snapshot{}
}

// asker starts a copy that conflicts and so waits in "asking": a job that
// holds its lane until answered.
func (e *env) asker(name string) (int64, string) {
	e.t.Helper()
	src := filepath.Join(e.root, "src-"+name)
	dst := filepath.Join(e.root, "dst-"+name)
	write(e.t, filepath.Join(src, "a.jpg"), 10)
	write(e.t, filepath.Join(dst, "a.jpg"), 5)
	dir := e.index(src)
	s, err := e.m.Start(Spec{Kind: KindCopy, IDs: e.ids(dir, "a.jpg"), Destination: dst, Conflict: ConflictAsk})
	if err != nil {
		e.t.Fatal(err)
	}
	return s.JobID, dst
}

func TestLanesStartNowAndTheRunningCap(t *testing.T) {
	e := newEnv(t)
	lanes := map[string]string{} // destination -> lane
	e.m.deps.Lane = func(s Spec, _ *index.Store) string { return lanes[s.Destination] }
	lane := func(name, l string) { lanes[filepath.Join(e.root, "dst-"+name)] = l }
	for _, n := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		lane(n, "lane-"+n)
	}
	lane("b", "lane-a") // b shares a's lane

	a, _ := e.asker("a")
	b, _ := e.asker("b")
	asking := func(s Snapshot) bool { return s.State == StateAsking }
	e.waitFor(a, "a asks", asking)
	time.Sleep(30 * time.Millisecond)
	if s := e.wait0(b); s.State != StateQueued {
		t.Fatalf("b runs while a holds the lane: %s", s.State)
	}
	// Other lanes run in parallel, up to MaxRunning jobs.
	c, _ := e.asker("c")
	d, _ := e.asker("d")
	f, _ := e.asker("f")
	for _, id := range []int64{c, d, f} {
		e.waitFor(id, "runs in its own lane", asking)
	}
	g, _ := e.asker("g")
	time.Sleep(30 * time.Millisecond)
	if s := e.wait0(g); s.State != StateQueued {
		t.Fatalf("a fifth job runs: %s", s.State)
	}
	// Start now: b runs although its lane and the slots are taken.
	if !e.m.StartNow(b) {
		t.Fatal("start now refused")
	}
	e.waitFor(b, "b started now", asking)
	if e.m.StartNow(b) {
		t.Error("start now of a running job")
	}
	// Answering a frees a slot: g starts.
	if err := e.m.Resolve(a, ConflictSkip, false); err != nil {
		t.Fatal(err)
	}
	if s := e.wait(a); s.State != StateCompleted || s.Skipped != 1 {
		t.Fatalf("a: %+v", s)
	}
	e.waitFor(g, "g starts when a slot frees", asking)
	for _, id := range []int64{b, c, d, f, g} {
		if !e.m.Cancel(id) {
			t.Errorf("cancel %d", id)
		}
		if s := e.wait(id); s.State != StateCancelled {
			t.Errorf("%d: %s", id, s.State)
		}
	}
}

func TestQueueCap(t *testing.T) {
	e := newEnv(t)
	e.m.deps.Lane = func(Spec, *index.Store) string { return "one" }
	first, _ := e.asker("first") // holds the only lane
	e.waitFor(first, "asks", func(s Snapshot) bool { return s.State == StateAsking })
	for i := range MaxQueued {
		if _, err := e.m.Start(Spec{Kind: KindFavorite, Favorite: true}); err != nil {
			t.Fatalf("job %d: %v", i, err)
		}
	}
	if _, err := e.m.Start(Spec{Kind: KindFavorite, Favorite: true}); !errors.Is(err, ErrBusy) {
		t.Fatalf("job %d accepted: %v", MaxQueued+1, err)
	}
	e.m.Cancel(first)
}

func TestPauseResumeAndCancelMidFile(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "big.mp4"), 96<<20)
	dest := filepath.Join(e.root, "dest")
	_ = os.Mkdir(dest, 0o755)
	root := e.index(e.root)
	for _, cancelPaused := range []bool{false, true} {
		s, err := e.m.Start(Spec{Kind: KindCopy, IDs: e.ids(root, "big.mp4"), Destination: dest, Conflict: ConflictKeepBoth})
		if err != nil {
			t.Fatal(err)
		}
		e.waitFor(s.JobID, "copying", func(s Snapshot) bool { return s.BytesDone > 0 || !s.State.Active() })
		t0 := time.Now()
		if !e.m.Pause(s.JobID) {
			t.Fatal("pause refused")
		}
		paused := e.waitFor(s.JobID, "paused", func(s Snapshot) bool { return s.State == StatePaused })
		time.Sleep(200 * time.Millisecond)
		at := e.wait0(s.JobID).BytesDone
		time.Sleep(200 * time.Millisecond)
		if now := e.wait0(s.JobID); now.BytesDone != at || now.State != StatePaused {
			t.Fatalf("copying while paused: %d → %d (%s)", at, now.BytesDone, now.State)
		}
		if at >= 96<<20 {
			t.Skipf("the copy finished before the pause took effect (%v)", time.Since(t0))
		}
		if paused.BytesPerSec != 0 || paused.EtaMs != 0 {
			t.Errorf("speed while paused: %+v", paused)
		}
		partial := fileops.PartialName(dest, "big.mp4")
		if cancelPaused {
			if partial2 := fileops.PartialName(dest, "big (2).mp4"); exist(partial2) {
				partial = partial2
			}
		}
		if !exist(partial) {
			t.Errorf("no partial file while paused")
		}
		if cancelPaused {
			e.m.Cancel(s.JobID)
			if f := e.wait(s.JobID); f.State != StateCancelled {
				t.Fatalf("%+v", f)
			}
			if exist(partial) {
				t.Error("cancelling a paused copy kept the partial file")
			}
			continue
		}
		if !e.m.Resume(s.JobID) {
			t.Fatal("resume refused")
		}
		if f := e.wait(s.JobID); f.State != StateCompleted || f.BytesDone != 96<<20 {
			t.Fatalf("after resume: %+v", f)
		}
		if fi, err := os.Stat(filepath.Join(dest, "big.mp4")); err != nil || fi.Size() != 96<<20 {
			t.Fatalf("copy: %v", err)
		}
	}
}

func TestConflictPoliciesV2(t *testing.T) {
	old := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	newer := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		policy string
		// srcNewer / sameSize shape the conflict.
		srcNewer, sameSize bool
		// want: names in the destination with their sizes.
		want    map[string]int64
		skipped int
	}{
		{ConflictReplace, false, false, map[string]int64{"a.jpg": 10}, 0},
		{ConflictSkip, true, false, map[string]int64{"a.jpg": 5}, 1},
		{ConflictKeepBoth, true, false, map[string]int64{"a.jpg": 5, "a (2).jpg": 10}, 0},
		{ConflictRenameNew, true, false, map[string]int64{"a.jpg": 5, "a (2).jpg": 10}, 0},
		{ConflictRenameExisting, true, false, map[string]int64{"a.jpg": 10, "a (2).jpg": 5}, 0},
		{ConflictReplaceOlder, true, false, map[string]int64{"a.jpg": 10}, 0},
		{ConflictReplaceOlder, false, false, map[string]int64{"a.jpg": 5}, 1},
		{ConflictReplaceIfDifferentSize, true, false, map[string]int64{"a.jpg": 10}, 0},
		{ConflictReplaceIfDifferentSize, true, true, map[string]int64{"a.jpg": 10}, 1},
	} {
		t.Run(fmt.Sprintf("%s-newer=%v-same=%v", tc.policy, tc.srcNewer, tc.sameSize), func(t *testing.T) {
			e := newEnv(t)
			src, dst := filepath.Join(e.root, "src"), filepath.Join(e.root, "dst")
			write(t, filepath.Join(src, "a.jpg"), 10)
			existing := 5
			if tc.sameSize {
				existing = 10
			}
			write(t, filepath.Join(dst, "a.jpg"), existing)
			srcT, dstT := old, newer
			if tc.srcNewer {
				srcT, dstT = newer, old
			}
			_ = os.Chtimes(filepath.Join(src, "a.jpg"), srcT, srcT)
			_ = os.Chtimes(filepath.Join(dst, "a.jpg"), dstT, dstT)
			dstDir := e.index(dst)
			srcDir := e.index(src)
			s := e.run(Spec{Kind: KindCopy, IDs: e.ids(srcDir, "a.jpg"), Destination: dst, Conflict: tc.policy})
			if s.State != StateCompleted || s.Skipped != tc.skipped || s.Failed != 0 {
				t.Fatalf("%+v %v", s, e.errors(s.JobID))
			}
			ents, _ := os.ReadDir(dst)
			got := map[string]int64{}
			for _, en := range ents {
				fi, _ := en.Info()
				got[en.Name()] = fi.Size()
			}
			if fmt.Sprint(got) != fmt.Sprint(tc.want) {
				t.Errorf("destination %v, want %v", got, tc.want)
			}
			// The index agrees with the disk (renamed existing keeps its row).
			names := e.names(dstDir)
			slices.Sort(names)
			var want []string
			for n := range tc.want {
				want = append(want, n)
			}
			slices.Sort(want)
			if fmt.Sprint(names) != fmt.Sprint(want) {
				t.Errorf("index %v, want %v", names, want)
			}
		})
	}
}

func TestAskWithApplyToAllAndOtherJobsRunning(t *testing.T) {
	e := newEnv(t)
	var asked []Conflict
	e.m.deps.Ask = func(_ int64, c Conflict) { asked = append(asked, c) }
	src, dst := filepath.Join(e.root, "src"), filepath.Join(e.root, "dst")
	for _, n := range []string{"a.jpg", "b.jpg", "c.jpg", "d.jpg"} {
		write(t, filepath.Join(src, n), 10)
		write(t, filepath.Join(dst, n), 3)
	}
	dstDir := e.index(dst)
	srcDir := e.index(src)
	s, err := e.m.Start(Spec{Kind: KindCopy, IDs: e.ids(srcDir, "a.jpg", "b.jpg", "c.jpg", "d.jpg"), Destination: dst, Conflict: ConflictAsk})
	if err != nil {
		t.Fatal(err)
	}
	first := e.waitFor(s.JobID, "asks", func(s Snapshot) bool { return s.State == StateAsking })
	if first.Conflict == nil || first.Conflict.Name != "a.jpg" || first.Conflict.Source.Size != 10 || first.Conflict.Target.Size != 3 {
		t.Fatalf("conflict %+v", first.Conflict)
	}
	if first.Conflict.Target.ID != e.ids(dstDir, "a.jpg")[0] || first.Conflict.Source.ID == 0 {
		t.Errorf("conflict ids %+v", first.Conflict)
	}
	// Another job (another lane) runs to its end meanwhile.
	write(t, filepath.Join(e.root, "other", "x.jpg"), 1)
	other := e.index(filepath.Join(e.root, "other"))
	if o := e.run(Spec{Kind: KindFavorite, IDs: e.ids(other, "x.jpg"), Favorite: true}); o.State != StateCompleted {
		t.Fatalf("other job: %+v", o)
	}
	if err := e.m.Resolve(s.JobID, "ask", false); !errors.Is(err, ErrInvalid) {
		t.Errorf("answer ask: %v", err)
	}
	if err := e.m.Resolve(s.JobID, ConflictSkip, false); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.JobID, "asks about b", func(s Snapshot) bool { return s.State == StateAsking && s.Conflict.Name == "b.jpg" })
	if err := e.m.Resolve(s.JobID, ConflictReplace, true); err != nil {
		t.Fatal(err)
	}
	f := e.wait(s.JobID)
	if f.State != StateCompleted || f.Done != 3 || f.Skipped != 1 || len(asked) != 2 {
		t.Fatalf("%+v asked=%d", f, len(asked))
	}
	for n, size := range map[string]int64{"a.jpg": 3, "b.jpg": 10, "c.jpg": 10, "d.jpg": 10} {
		if fi, _ := os.Stat(filepath.Join(dst, n)); fi.Size() != size {
			t.Errorf("%s: %d", n, fi.Size())
		}
	}
	if err := e.m.Resolve(s.JobID, ConflictSkip, false); !errors.Is(err, ErrUnknownJob) {
		t.Errorf("answer a finished job: %v", err)
	}
}

func TestFolderMergeAsksPerFile(t *testing.T) {
	e := newEnv(t)
	e.m.deps.Ask = func(id int64, c Conflict) {
		go func() {
			d := ConflictSkip
			if strings.HasSuffix(c.Name, "replace.txt") {
				d = ConflictReplace
			}
			if c.Name == "album" {
				d = ConflictReplace // merge the folders
			}
			if err := e.m.Resolve(id, d, false); err != nil {
				t.Error(err)
			}
		}()
	}
	write(t, filepath.Join(e.root, "album", "replace.txt"), 10)
	write(t, filepath.Join(e.root, "album", "skip.txt"), 10)
	write(t, filepath.Join(e.root, "album", "new.txt"), 10)
	dst := filepath.Join(e.root, "dst")
	write(t, filepath.Join(dst, "album", "replace.txt"), 1)
	write(t, filepath.Join(dst, "album", "skip.txt"), 1)
	root := e.index(e.root)
	s := e.run(Spec{Kind: KindMove, IDs: e.ids(root, "album"), Destination: dst, Conflict: ConflictAsk})
	if s.State != StateCompleted || s.Done != 1 {
		t.Fatalf("%+v %v", s, e.errors(s.JobID))
	}
	sizes := map[string]int64{"replace.txt": 10, "skip.txt": 1, "new.txt": 10}
	for n, want := range sizes {
		if fi, err := os.Stat(filepath.Join(dst, "album", n)); err != nil || fi.Size() != want {
			t.Errorf("%s: %v", n, err)
		}
	}
	// The skipped file stays in the source folder.
	if !exist(filepath.Join(e.root, "album", "skip.txt")) || exist(filepath.Join(e.root, "album", "new.txt")) {
		t.Error("move merge: sources")
	}
}

func TestVerifyAndLinksOptions(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "a.jpg"), 3<<20)
	dest := filepath.Join(e.root, "dest")
	_ = os.Mkdir(dest, 0o755)
	root := e.index(e.root)
	if s := e.run(Spec{Kind: KindCopy, IDs: e.ids(root, "a.jpg"), Destination: dest, Conflict: ConflictKeepBoth, Verify: true}); s.Done != 1 {
		t.Fatalf("%+v", s)
	}
	// A link at the top level: skipped and reported for the viewer, copied
	// as a link for the commander.
	link := filepath.Join(e.root, "links", "l.jpg")
	_ = os.MkdirAll(filepath.Dir(link), 0o755)
	if err := os.Symlink(filepath.Join(e.root, "a.jpg"), link); err != nil {
		t.Skip("symlinks need Developer Mode or admin on Windows:", err)
	}
	linksDir := e.index(filepath.Join(e.root, "links"))
	all, _ := e.store.QueryIDs(ctx, index.Descriptor{DirID: linksDir.ID, Scope: index.ScopeAll}, linksDir.Key)
	s := e.run(Spec{Kind: KindCopy, IDs: all, Destination: dest, Conflict: ConflictKeepBoth})
	if s.Failed != 1 || e.errors(s.JobID)[0].Code != fileops.CodeSkippedLink {
		t.Errorf("viewer: %+v", s)
	}
	s = e.run(Spec{Kind: KindCopy, IDs: all, Destination: dest, Conflict: ConflictKeepBoth, CopyLinks: true})
	if fi, err := os.Lstat(filepath.Join(dest, "l.jpg")); s.Done != 1 || err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Errorf("commander: %+v %v", s, err)
	}
}

func TestSmallFilesInFlightKeepTheIndexRight(t *testing.T) {
	e := newEnv(t)
	SmallFilesInFlight = 4
	names := make([]string, 120)
	for i := range names {
		names[i] = fmt.Sprintf("IMG_%03d.jpg", i)
		write(t, filepath.Join(e.root, "src", names[i]), 2000+i)
	}
	dest := filepath.Join(e.root, "dest")
	_ = os.Mkdir(dest, 0o755)
	destDir := e.index(dest)
	src := e.index(filepath.Join(e.root, "src"))
	s := e.run(Spec{Kind: KindCopy, IDs: e.ids(src, names...), Destination: dest, Conflict: ConflictKeepBoth})
	var bytes int64
	for i := range names {
		bytes += int64(2000 + i)
	}
	if s.Done != 120 || s.Failed != 0 || s.BytesDone != bytes {
		t.Fatalf("%+v (want %d bytes)", s, bytes)
	}
	if got := e.names(destDir); len(got) != 120 {
		t.Errorf("index has %d rows", len(got))
	}
	keys := map[string]bool{}
	for _, n := range e.names(destDir) {
		keys[pathkey.ChildKey(destDir.Key, n, false)] = true
	}
	if len(keys) != 120 {
		t.Error("duplicate rows")
	}
}

func TestSpeedAndETA(t *testing.T) {
	j := &job{snap: Snapshot{State: StateRunning, BytesTotal: 100 << 20}}
	t0 := time.Now()
	j.addSample(t0)
	j.snap.BytesDone = 10 << 20
	j.addSample(t0.Add(time.Second))
	if j.snap.BytesPerSec != 10<<20 || j.snap.EtaMs != 9000 {
		t.Fatalf("speed %d B/s, eta %d ms", j.snap.BytesPerSec, j.snap.EtaMs)
	}
	// Only the last speedWindow counts.
	j.snap.BytesDone = 90 << 20
	j.addSample(t0.Add(5 * time.Second))
	j.snap.BytesDone = 92 << 20
	j.addSample(t0.Add(6 * time.Second))
	if j.snap.BytesPerSec != 2<<20 || j.snap.EtaMs != 4000 {
		t.Errorf("windowed speed %d B/s, eta %d ms", j.snap.BytesPerSec, j.snap.EtaMs)
	}
	j.snap.State = StatePaused
	j.addSample(t0.Add(7 * time.Second))
	if j.snap.BytesPerSec != 0 || j.snap.EtaMs != 0 {
		t.Error("speed while paused")
	}
}
