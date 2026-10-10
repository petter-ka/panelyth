package jobs

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestDirSize(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "a", "one.jpg"), 1000)
	write(t, filepath.Join(e.root, "a", "deep", "two.txt"), 234)
	write(t, filepath.Join(e.root, "b", "three.jpg"), 50)
	write(t, filepath.Join(e.root, "loose.jpg"), 7)
	// A link back to the root must not be followed (it would count forever).
	loop := filepath.Join(e.root, "a", "loop")
	if err := os.Symlink(e.root, loop); err != nil {
		// Windows without the symlink privilege: a junction needs none.
		if out, jerr := exec.Command("cmd", "/c", "mklink", "/J", loop, e.root).CombinedOutput(); jerr != nil {
			t.Fatalf("no link could be made: %v / %v %s", err, jerr, out)
		}
	}
	root := e.index(e.root)
	ids := e.ids(root, "a", "b", "loose.jpg")
	s := e.run(Spec{Kind: KindDirSize, IDs: ids})
	if s.State != StateCompleted || s.Done != 2 || s.Skipped != 1 || s.BytesDone != 1284 {
		t.Fatalf("snapshot %+v", s)
	}
	items, err := e.store.LoadItems(ctx, ids)
	if err != nil {
		t.Fatal(err)
	}
	if items[0].DirSize != 1234 || items[1].DirSize != 50 || items[2].DirSize != -1 {
		t.Fatalf("sizes %d %d %d", items[0].DirSize, items[1].DirSize, items[2].DirSize)
	}
	if !e.changed[root.ID] {
		t.Fatal("the parent session was not told")
	}
	// A rescan keeps calculated sizes.
	e.index(e.root)
	again, _ := e.store.LoadItems(ctx, ids[:1])
	if again[0].DirSize != 1234 {
		t.Fatalf("after rescan %d", again[0].DirSize)
	}
}

func TestDirSizeCancel(t *testing.T) {
	e := newEnv(t)
	for i := range 2000 {
		write(t, filepath.Join(e.root, "big", "sub"+string(rune('a'+i%20)), "f"+itoa(i)), 1)
	}
	root := e.index(e.root)
	s, err := e.m.Start(Spec{Kind: KindDirSize, IDs: e.ids(root, "big")})
	if err != nil {
		t.Fatal(err)
	}
	e.m.Cancel(s.JobID)
	start := time.Now()
	done := e.wait(s.JobID)
	if done.State != StateCancelled && done.State != StateCompleted {
		t.Fatalf("state %s", done.State)
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Fatalf("cancel took %s", time.Since(start))
	}
	if done.State == StateCancelled {
		items, _ := e.store.LoadItems(ctx, e.ids(root, "big"))
		if items[0].DirSize != -1 {
			t.Fatal("a cancelled job stored a partial size")
		}
	}

}

func TestSummaryIncludesFolderSizes(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "a", "one.jpg"), 1000)
	write(t, filepath.Join(e.root, "loose.jpg"), 7)
	root := e.index(e.root)
	ids := e.ids(root, "a", "loose.jpg")
	before, _ := e.store.Summarize(ctx, ids)
	e.run(Spec{Kind: KindDirSize, IDs: ids[:1]})
	after, _ := e.store.Summarize(ctx, ids)
	if before.Bytes != 7 || after.Bytes != 1007 || after.Dirs != 1 {
		t.Fatalf("before %+v after %+v", before, after)
	}
}
