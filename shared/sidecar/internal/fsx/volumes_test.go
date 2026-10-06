package fsx

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestWithSpaceTimesOutPerVolume(t *testing.T) {
	release := make(chan struct{})
	var slowCalls atomic.Int32
	old := spaceFunc
	spaceFunc = func(root string) (int64, int64, bool) {
		switch root {
		case `\dead\share`:
			slowCalls.Add(1)
			<-release
			return 0, 0, false
		case "E:":
			return 0, 0, false // a card reader without media
		}
		return 100, 1000, true
	}
	t.Cleanup(func() {
		close(release)
		spaceFunc = old
	})

	vs := []Volume{
		{Path: "C:", Kind: "fixed"},
		{Path: "E:", Kind: "removable"},
		{Path: `\dead\share`, Kind: "network"},
		{Path: "X:", Kind: "other"},
	}
	start := time.Now()
	got := withSpace(vs)
	if d := time.Since(start); d > NetworkSpaceTimeout+500*time.Millisecond {
		t.Fatalf("withSpace took %v; the dead share must time out", d)
	}
	if got[0].FreeBytes != 100 || got[0].TotalBytes != 1000 || got[0].NotReady {
		t.Errorf("fixed: %+v", got[0])
	}
	if !got[1].NotReady || got[1].TotalBytes != 0 {
		t.Errorf("removable without media: %+v", got[1])
	}
	if !got[2].NotReady {
		t.Errorf("dead network share: %+v", got[2])
	}
	if got[3].NotReady || got[3].TotalBytes != 0 {
		t.Errorf("other: %+v", got[3])
	}

	// A second listing joins the read still blocked on the dead share.
	withSpace([]Volume{{Path: `\dead\share`, Kind: "network"}})
	if n := slowCalls.Load(); n != 1 {
		t.Errorf("blocked share read %d times; want 1 (joined)", n)
	}
}

func TestVolumesListsSomething(t *testing.T) {
	vs, err := Volumes()
	if err != nil {
		t.Fatal(err)
	}
	if len(vs) == 0 {
		t.Fatal("no volumes")
	}
	fixed := false
	for _, v := range vs {
		if v.Kind == "fixed" && v.TotalBytes > 0 {
			fixed = true
		}
	}
	if !fixed {
		t.Errorf("no fixed volume with a size: %+v", vs)
	}
	if _, err := VolumeSignature(); err != nil {
		t.Fatal(err)
	}
}
