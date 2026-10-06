package fsx

import (
	"sync"
	"time"
)

// Space reads are bounded per volume (Stage C03): a disconnected network
// share or a slow optical drive answers "not ready" after the timeout
// instead of stalling the drive menu. A read that is still running is never
// started again for the same path, so a dead mount costs one blocked
// goroutine, not one per call.
const (
	LocalSpaceTimeout   = 500 * time.Millisecond
	NetworkSpaceTimeout = 1500 * time.Millisecond
)

// spaceFunc reads a volume's free and total bytes; tests replace it.
var spaceFunc = diskSpace

type spaceResult struct {
	free, total int64
	ok          bool
}

// spaceRead is one read in flight; done closes once r is set.
type spaceRead struct {
	done chan struct{}
	r    spaceResult
}

var (
	spaceMu      sync.Mutex
	spaceRunning = map[string]*spaceRead{}
)

// readSpace starts (or joins) the read for one path and waits up to timeout.
func readSpace(path string, timeout time.Duration) (spaceResult, bool) {
	spaceMu.Lock()
	read, running := spaceRunning[path]
	if !running {
		read = &spaceRead{done: make(chan struct{})}
		spaceRunning[path] = read
		go func() {
			free, total, ok := spaceFunc(path)
			read.r = spaceResult{free, total, ok}
			spaceMu.Lock()
			delete(spaceRunning, path)
			spaceMu.Unlock()
			close(read.done)
		}()
	}
	spaceMu.Unlock()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-read.done:
		return read.r, true
	case <-timer.C:
		return spaceResult{}, false
	}
}

// Volumes lists the mounted volumes with free and total space, reading the
// volumes in parallel (one read per volume, at most 26 on Windows) with a
// timeout each.
func Volumes() ([]Volume, error) {
	vs, err := listVolumes()
	if err != nil {
		return nil, err
	}
	return withSpace(append(vs, simulated...)), nil
}

// simulated holds benchmark-only volumes (SimulateSlowVolume).
var simulated []Volume

// SimulateSlowVolume adds a network volume whose space read blocks for
// delay, like a disconnected share. Benchmarks only (the sidecar enables it
// in dev mode); call before serving.
func SimulateSlowVolume(path string, delay time.Duration) {
	simulated = append(simulated, Volume{Path: path, Label: "slow share", Kind: "network"})
	read := spaceFunc
	spaceFunc = func(root string) (int64, int64, bool) {
		if root == path {
			time.Sleep(delay)
			return 0, 0, false
		}
		return read(root)
	}
}

func withSpace(vs []Volume) []Volume {
	var wg sync.WaitGroup
	for i := range vs {
		v := &vs[i]
		if v.Kind == "other" {
			continue
		}
		timeout := LocalSpaceTimeout
		if v.Kind == "network" {
			timeout = NetworkSpaceTimeout
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, done := readSpace(v.Path, timeout)
			switch {
			case done && r.ok:
				v.FreeBytes, v.TotalBytes = r.free, r.total
			case v.Kind != "fixed":
				// No media, a disconnected share, or no answer in time.
				v.NotReady = true
			}
		}()
	}
	wg.Wait()
	return vs
}

// VolumeSignature is a cheap fingerprint of the mounted volumes (paths,
// kinds and labels, no space), for the volume monitor's polling.
func VolumeSignature() (string, error) {
	vs, err := listVolumes()
	if err != nil {
		return "", err
	}
	n := 0
	for _, v := range vs {
		n += len(v.Path) + len(v.Kind) + len(v.Label) + 3
	}
	b := make([]byte, 0, n)
	for _, v := range vs {
		b = append(b, v.Path...)
		b = append(b, 0)
		b = append(b, v.Kind...)
		b = append(b, 0)
		b = append(b, v.Label...)
		b = append(b, '\n')
	}
	return string(b), nil
}
