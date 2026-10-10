package jobs

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"testing"
	"time"

	"panelyth/sidecar/internal/fileops"
)

// TestBenchLargeCopyVsOS is the controlled large-file comparison of Stage
// P03 (opt-in: it writes several GB). A copy job, a direct fileops.CopyFile
// and the OS's copy (robocopy / cp) take turns on the same file, with the
// disk settling in between, because on a busy or nearly full drive the
// write-back of one copy otherwise lands in the next one's time.
//
//	PANELYTH_BENCH_LARGE=1 [PANELYTH_BENCH_DEST=D:\somewhere] [PANELYTH_BENCH_MB=4096] go test ./internal/jobs -run BenchLargeCopyVsOS -v -timeout 30m
func TestBenchLargeCopyVsOS(t *testing.T) {
	if os.Getenv("PANELYTH_BENCH_LARGE") != "1" {
		t.Skip("writes several GB; set PANELYTH_BENCH_LARGE=1")
	}
	mb := 4096
	if v, err := strconv.Atoi(os.Getenv("PANELYTH_BENCH_MB")); err == nil && v > 0 {
		mb = v
	}
	e := newEnv(t)
	src := filepath.Join(e.root, "src")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(src, "big.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 8<<20)
	_, _ = rand.Read(buf)
	for range mb / 8 {
		if _, err := f.Write(buf); err != nil {
			t.Fatal(err)
		}
	}
	_ = f.Close()
	ids := e.ids(e.index(src), "big.mp4")
	dest := os.Getenv("PANELYTH_BENCH_DEST")
	if dest == "" {
		dest = e.root
	} else {
		dest = filepath.Join(dest, "panelyth-bench-large")
		t.Cleanup(func() { _ = os.RemoveAll(dest) })
	}
	settle := func() { time.Sleep(10 * time.Second) }
	time.Sleep(30 * time.Second) // the source is still being written back

	var jobT, directT, osT []time.Duration
	for i := range 3 {
		settle()
		dst := filepath.Join(dest, fmt.Sprintf("job%d", i))
		_ = os.MkdirAll(dst, 0o755)
		t0 := time.Now()
		st, err := e.m.Start(Spec{Kind: KindCopy, IDs: ids, Destination: dst, Conflict: ConflictKeepBoth})
		if err != nil {
			t.Fatal(err)
		}
		for s := e.wait0(st.JobID); s.State.Active(); s = e.wait0(st.JobID) {
			time.Sleep(5 * time.Millisecond)
		}
		jobT = append(jobT, time.Since(t0))
		_ = os.RemoveAll(dst)

		settle()
		dst = filepath.Join(dest, fmt.Sprintf("os%d", i))
		t0 = time.Now()
		var cmd *exec.Cmd
		if runtime.GOOS == "windows" {
			cmd = exec.Command("robocopy", src, dst, "big.mp4", "/NJH", "/NJS", "/NFL", "/NDL", "/NP")
		} else {
			_ = os.MkdirAll(dst, 0o755)
			cmd = exec.Command("cp", "-p", filepath.Join(src, "big.mp4"), dst)
		}
		_ = cmd.Run() // robocopy exits 1 on success
		osT = append(osT, time.Since(t0))
		_ = os.RemoveAll(dst)

		settle()
		dst = filepath.Join(dest, fmt.Sprintf("direct%d", i))
		_ = os.MkdirAll(dst, 0o755)
		t0 = time.Now()
		if err := fileops.CopyFile(context.Background(), filepath.Join(src, "big.mp4"), filepath.Join(dst, "big.mp4"), false, nil); err != nil {
			t.Fatal(err)
		}
		directT = append(directT, time.Since(t0))
		_ = os.RemoveAll(dst)
	}
	med := func(xs []time.Duration) time.Duration {
		s := slices.Clone(xs)
		slices.Sort(s)
		return s[len(s)/2]
	}
	rate := func(d time.Duration) float64 { return float64(mb) / d.Seconds() }
	t.Logf("%d MB to %s: job %v (median %v, %.0f MB/s), direct %v (median %v), OS %v (median %v, %.0f MB/s); job/OS throughput %.0f%%",
		mb, dest, jobT, med(jobT), rate(med(jobT)), directT, med(directT), osT, med(osT), rate(med(osT)),
		100*med(osT).Seconds()/med(jobT).Seconds())
}
