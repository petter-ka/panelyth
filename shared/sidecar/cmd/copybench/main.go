// Command copybench measures copy, move and delete jobs (Stage P03,
// ADR-0029) against the operating system's own copy on the same files:
// robocopy on Windows, cp elsewhere.
//
//	go run ./cmd/copybench -work <dir> [-dest <dir on another volume>] -out result.json
//
// Workloads: one large file (same volume and, with -dest, across volumes),
// 10,000 files of 10 KB, 1,000 files of 1 MB, and deleting 10,000 files to
// the trash and permanently. Everything it creates under -work and -dest is
// removed at the end; trashed bench files are purged from the recycle bin.
package main

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/metrics"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/scan"
)

type run struct {
	Workload   string  `json:"workload"`
	Engine     string  `json:"engine"` // "panelyth" or the OS tool
	Files      int     `json:"files"`
	Bytes      int64   `json:"bytes"`
	Ms         float64 `json:"ms"`
	MBPerSec   float64 `json:"mbPerSec"`
	PeakHeapMB float64 `json:"peakHeapMB,omitempty"`
	Failed     int     `json:"failed,omitempty"`
}

type result struct {
	Stage     string `json:"stage"`
	Benchmark string `json:"benchmark"`
	Date      string `json:"date"`
	GOOS      string `json:"goos"`
	CPU       int    `json:"cpus"`
	Work      string `json:"work"`
	Dest      string `json:"dest,omitempty"`
	LargeMB   int    `json:"largeMB"`
	InFlight  int    `json:"inFlight"`
	NoBufMB   int    `json:"noBufferingFromMB"`
	SmallKB   int64  `json:"smallFileKB"`
	Runs      []run  `json:"runs"`
}

type bench struct {
	store *index.Store
	m     *jobs.Manager
	log   *slog.Logger

	mu    sync.Mutex
	final map[int64]chan jobs.Snapshot
}

func main() {
	work := flag.String("work", filepath.Join(os.TempDir(), "panelyth-copybench"), "work folder (source volume)")
	dest := flag.String("dest", "", "a folder on another volume (cross-volume copy), optional")
	out := flag.String("out", "", "result file (JSON); stdout when empty")
	largeMB := flag.Int("large-mb", 4096, "size of the large file")
	only := flag.String("only", "", "comma-free workload filter: large, small, medium, delete")
	reps := flag.Int("reps", 3, "repetitions per measurement (the median is kept)")
	inFlight := flag.Int("inflight", 0, "small files in flight on SSD lanes (0 = the engine's default)")
	noBufMB := flag.Int("nobuffering-mb", -1, "Windows: unbuffered copies from this size in MiB (-1 = default)")
	smallKB := flag.Int("small-kb", 0, "files under this size are copied in flight (0 = the engine's default)")
	settleS := flag.Int("settle-s", 10, "seconds to let the disk settle between copies")
	flag.Parse()
	settleFor = time.Duration(*settleS) * time.Second
	if *smallKB > 0 {
		fileops.SmallFile = int64(*smallKB) << 10
	}
	if *inFlight > 0 {
		jobs.SmallFilesInFlight = *inFlight
	}
	setNoBuffering(*noBufMB)

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	res := result{Stage: cmp.Or(os.Getenv("BENCH_STAGE"), "P03"), Benchmark: "copy", Date: time.Now().Format(time.RFC3339),
		GOOS: runtime.GOOS, CPU: runtime.NumCPU(), Work: *work, Dest: *dest, LargeMB: *largeMB}
	if err := os.MkdirAll(*work, 0o755); err != nil {
		fatal(err)
	}
	defer os.RemoveAll(*work)
	if *dest != "" {
		if err := os.MkdirAll(*dest, 0o755); err != nil {
			fatal(err)
		}
		defer os.RemoveAll(*dest)
	}
	b := newBench(filepath.Join(*work, "db"), log)
	defer b.close()

	want := func(w string) bool { return *only == "" || *only == w }
	res.InFlight, res.NoBufMB, res.SmallKB = jobs.SmallFilesInFlight, noBufferingMB(), fileops.SmallFile>>10
	if want("small") {
		res.Runs = append(res.Runs, b.copies(*work, "small-10k-10KB", 10_000, 10<<10, *reps)...)
	}
	if want("medium") {
		res.Runs = append(res.Runs, b.copies(*work, "medium-1k-1MB", 1_000, 1<<20, *reps)...)
	}
	if want("large") {
		res.Runs = append(res.Runs, b.large(*work, *dest, int64(*largeMB)<<20, *reps)...)
	}
	if want("delete") {
		res.Runs = append(res.Runs, b.deletes(*work)...)
	}

	data, _ := json.MarshalIndent(res, "", "  ")
	if *out == "" {
		fmt.Println(string(data))
		return
	}
	if err := os.WriteFile(*out, append(data, '\n'), 0o644); err != nil {
		fatal(err)
	}
	fmt.Println("wrote", *out)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "copybench:", err)
	os.Exit(1)
}

func newBench(dbDir string, log *slog.Logger) *bench {
	store, err := index.Open(filepath.Join(dbDir, "index.db"), log)
	if err != nil {
		fatal(err)
	}
	b := &bench{store: store, log: log, final: map[int64]chan jobs.Snapshot{}}
	b.m = jobs.NewManager(jobs.Deps{Store: store, Log: log, Emit: b.emit})
	return b
}

func (b *bench) close() {
	b.m.Close()
	_ = b.store.Close()
}

func (b *bench) emit(s jobs.Snapshot) {
	switch s.State {
	case jobs.StateCompleted, jobs.StateCancelled, jobs.StateFailed:
	default:
		return
	}
	b.mu.Lock()
	ch := b.final[s.JobID]
	b.mu.Unlock()
	if ch != nil {
		select {
		case ch <- s:
		default:
		}
	}
}

// indexDir lists dir like opening it in a panel and returns its entry ids.
func (b *bench) indexDir(dir string) []int64 {
	info, err := b.store.EnsureDir(context.Background(), dir)
	if err != nil {
		fatal(err)
	}
	st := scan.Run(context.Background(), b.store, b.log, scan.Options{}, scan.Hooks{}, 0, b.store.NextGeneration(), info, false)
	if st.State != scan.StateCompleted {
		fatal(fmt.Errorf("scan %s: %s", dir, st.State))
	}
	ids, err := b.store.QueryIDs(context.Background(), index.Descriptor{DirID: info.ID, Scope: index.ScopeAll, ShowHidden: true}, info.Key)
	if err != nil {
		fatal(err)
	}
	return ids
}

// job runs a job to its end, sampling the Go heap meanwhile.
func (b *bench) job(spec jobs.Spec) (jobs.Snapshot, time.Duration, float64) {
	var peak atomic.Uint64
	stop := make(chan struct{})
	go func() {
		// runtime/metrics reads without stopping the world (ReadMemStats
		// would stall the OS copy's callbacks every tick).
		sample := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}, {Name: "/memory/classes/heap/unused:bytes"}}
		t := time.NewTicker(50 * time.Millisecond)
		defer t.Stop()
		for {
			metrics.Read(sample)
			if used := sample[0].Value.Uint64() + sample[1].Value.Uint64(); used > peak.Load() {
				peak.Store(used)
			}
			select {
			case <-stop:
				return
			case <-t.C:
			}
		}
	}()
	runtime.GC()
	start := time.Now()
	s, err := b.m.Start(spec)
	if err != nil {
		fatal(err)
	}
	ch := make(chan jobs.Snapshot, 1)
	b.mu.Lock()
	b.final[s.JobID] = ch
	b.mu.Unlock()
	// The job may have finished before the channel was registered.
	var final jobs.Snapshot
	for done := false; !done; {
		select {
		case final = <-ch:
			done = true
		case <-time.After(50 * time.Millisecond):
			for _, l := range b.m.List() {
				if l.JobID == s.JobID && (l.State == jobs.StateCompleted || l.State == jobs.StateFailed || l.State == jobs.StateCancelled) {
					final, done = l, true
				}
			}
		}
	}
	elapsed := time.Since(start)
	close(stop)
	return final, elapsed, float64(peak.Load()) / (1 << 20)
}

func writeFiles(dir string, n int, size int) int64 {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fatal(err)
	}
	buf := make([]byte, size)
	_, _ = rand.Read(buf)
	for i := range n {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%05d.bin", i)), buf, 0o644); err != nil {
			fatal(err)
		}
	}
	return int64(n) * int64(size)
}

func writeLarge(path string, size int64) {
	f, err := os.Create(path)
	if err != nil {
		fatal(err)
	}
	buf := make([]byte, 8<<20)
	_, _ = rand.Read(buf)
	for written := int64(0); written < size; {
		n := min(int64(len(buf)), size-written)
		if _, err := f.Write(buf[:n]); err != nil {
			fatal(err)
		}
		written += n
	}
	if err := f.Close(); err != nil {
		fatal(err)
	}
}

// warmUp makes one copy with each engine and throws the times away: the
// source was just written and is still being flushed, which would land in
// whichever copy runs first.
func (b *bench) warmUp(src, parent string, ids []int64, file string) {
	time.Sleep(3 * settleFor)
	dst := filepath.Join(parent, "warm-fv")
	if err := os.MkdirAll(dst, 0o755); err != nil {
		fatal(err)
	}
	b.job(jobs.Spec{Kind: jobs.KindCopy, IDs: ids, Destination: dst, Conflict: jobs.ConflictKeepBoth})
	_ = os.RemoveAll(dst)
	osCopy(src, filepath.Join(parent, "warm-os"), file, 1)
	_ = os.RemoveAll(filepath.Join(parent, "warm-os"))
}

// settleFor lets the disk finish writing back before the next copy, so one
// copy's cache flush never lands in the next one's time.
var settleFor = 10 * time.Second

func settle() { time.Sleep(settleFor) }

// alternate runs the two copies of a repetition, swapping their order every
// other repetition (a full or warm disk cache favors whichever runs second).
func alternate(r int, a, b func()) {
	if r%2 == 1 {
		a, b = b, a
	}
	settle()
	a()
	settle()
	b()
}

func median(xs []time.Duration) time.Duration {
	s := slices.Clone(xs)
	slices.Sort(s)
	return s[len(s)/2]
}

func mbps(bytes int64, d time.Duration) float64 {
	return float64(bytes) / (1 << 20) / d.Seconds()
}

// osCopy copies the files of src (non-recursive) or one file into dst with
// the OS's tool, single-threaded like a plain Explorer or Finder copy.
func osCopy(src, dst, file string, threads int) (string, time.Duration) {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		fatal(err)
	}
	var cmd *exec.Cmd
	name := "cp"
	if runtime.GOOS == "windows" {
		args := []string{src, dst}
		if file != "" {
			args = append(args, file)
		}
		args = append(args, "/NJH", "/NJS", "/NFL", "/NDL", "/NP", "/R:0", "/W:0")
		name = "robocopy"
		if threads > 1 {
			args = append(args, fmt.Sprintf("/MT:%d", threads))
			name = fmt.Sprintf("robocopy /MT:%d", threads)
		}
		cmd = exec.Command("robocopy", args...)
	} else if file != "" {
		cmd = exec.Command("cp", "-p", filepath.Join(src, file), dst)
	} else {
		cmd = exec.Command("sh", "-c", `cp -p "$0"/* "$1"/`, src, dst)
	}
	start := time.Now()
	err := cmd.Run()
	elapsed := time.Since(start)
	if ee, ok := err.(*exec.ExitError); ok && runtime.GOOS == "windows" && ee.ExitCode() < 8 {
		err = nil // robocopy: 0–7 are success codes
	}
	if err != nil {
		fatal(fmt.Errorf("%s: %w", name, err))
	}
	return name, elapsed
}

// copies measures a job that copies n files of size bytes (selected
// individually, like Ctrl+A in a panel) and the OS tool on the same files.
func (b *bench) copies(work, name string, n, size, reps int) []run {
	src := filepath.Join(work, name, "src")
	total := writeFiles(src, n, size)
	ids := b.indexDir(src)
	b.warmUp(src, filepath.Join(work, name), ids, "")
	var fv, osT, osMT []time.Duration
	var heap float64
	failed := 0
	for r := range reps {
		panelyth := func() {
			dst := filepath.Join(work, name, fmt.Sprintf("fv%d", r))
			if err := os.MkdirAll(dst, 0o755); err != nil {
				fatal(err)
			}
			s, d, h := b.job(jobs.Spec{Kind: jobs.KindCopy, IDs: ids, Destination: dst, Conflict: jobs.ConflictKeepBoth})
			fv = append(fv, d)
			heap = max(heap, h)
			failed += s.Failed
			_ = os.RemoveAll(dst)
		}
		tool := func() {
			_, d := osCopy(src, filepath.Join(work, name, fmt.Sprintf("os%d", r)), "", 1)
			osT = append(osT, d)
			_ = os.RemoveAll(filepath.Join(work, name, fmt.Sprintf("os%d", r)))
			if runtime.GOOS == "windows" {
				settle()
				_, d = osCopy(src, filepath.Join(work, name, fmt.Sprintf("mt%d", r)), "", 8)
				osMT = append(osMT, d)
				_ = os.RemoveAll(filepath.Join(work, name, fmt.Sprintf("mt%d", r)))
			}
		}
		alternate(r, panelyth, tool)
	}
	_ = os.RemoveAll(filepath.Join(work, name))
	out := []run{
		{Workload: name, Engine: "panelyth", Files: n, Bytes: total, Ms: ms(median(fv)), MBPerSec: mbps(total, median(fv)), PeakHeapMB: heap, Failed: failed},
		{Workload: name, Engine: osName(1), Files: n, Bytes: total, Ms: ms(median(osT)), MBPerSec: mbps(total, median(osT))},
	}
	if len(osMT) > 0 {
		out = append(out, run{Workload: name, Engine: osName(8), Files: n, Bytes: total, Ms: ms(median(osMT)), MBPerSec: mbps(total, median(osMT))})
	}
	return out
}

func osName(threads int) string {
	if runtime.GOOS != "windows" {
		return "cp"
	}
	if threads > 1 {
		return fmt.Sprintf("robocopy /MT:%d", threads)
	}
	return "robocopy"
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

// large copies one big file within the work volume and, with dest, to
// another volume. Copies are removed between repetitions (disk space).
func (b *bench) large(work, dest string, size int64, reps int) []run {
	src := filepath.Join(work, "large", "src")
	if err := os.MkdirAll(src, 0o755); err != nil {
		fatal(err)
	}
	writeLarge(filepath.Join(src, "big.bin"), size)
	ids := b.indexDir(src)
	b.warmUp(src, filepath.Join(work, "large"), ids, "big.bin")
	var out []run
	targets := []struct{ name, dir string }{{"large-same-volume", filepath.Join(work, "large")}}
	if dest != "" {
		targets = append(targets, struct{ name, dir string }{"large-cross-volume", dest})
	}
	for _, t := range targets {
		var fv, osT []time.Duration
		var heap float64
		failed := 0
		for r := range reps {
			panelyth := func() {
				dst := filepath.Join(t.dir, fmt.Sprintf("fv%d", r))
				if err := os.MkdirAll(dst, 0o755); err != nil {
					fatal(err)
				}
				s, d, h := b.job(jobs.Spec{Kind: jobs.KindCopy, IDs: ids, Destination: dst, Conflict: jobs.ConflictKeepBoth})
				fv, heap, failed = append(fv, d), max(heap, h), failed+s.Failed
				_ = os.RemoveAll(dst)
			}
			tool := func() {
				osDst := filepath.Join(t.dir, fmt.Sprintf("os%d", r))
				_, d := osCopy(src, osDst, "big.bin", 1)
				osT = append(osT, d)
				_ = os.RemoveAll(osDst)
			}
			alternate(r, panelyth, tool)
		}
		out = append(out,
			run{Workload: t.name, Engine: "panelyth", Files: 1, Bytes: size, Ms: ms(median(fv)), MBPerSec: mbps(size, median(fv)), PeakHeapMB: heap, Failed: failed},
			run{Workload: t.name, Engine: osName(1), Files: 1, Bytes: size, Ms: ms(median(osT)), MBPerSec: mbps(size, median(osT))},
		)
	}
	_ = os.RemoveAll(filepath.Join(work, "large"))
	return out
}

// deletes removes 10,000 files permanently and to the trash (per item, as
// the jobs do). The trashed bench files are purged from the recycle bin.
func (b *bench) deletes(work string) []run {
	var out []run
	for _, kind := range []jobs.Kind{jobs.KindDelete, jobs.KindTrash} {
		dir := filepath.Join(work, "delete-"+string(kind))
		total := writeFiles(dir, 10_000, 1<<10)
		ids := b.indexDir(dir)
		s, d, h := b.job(jobs.Spec{Kind: kind, IDs: ids})
		out = append(out, run{Workload: "delete-10k-" + string(kind), Engine: "panelyth", Files: 10_000, Bytes: total,
			Ms: ms(d), MBPerSec: mbps(total, d), PeakHeapMB: h, Failed: s.Failed})
		if kind == jobs.KindTrash {
			n, err := purgeTrash(dir)
			if err != nil {
				fmt.Fprintln(os.Stderr, "copybench: purge the recycle bin by hand:", err)
			} else {
				fmt.Fprintf(os.Stderr, "copybench: purged %d bench files from the recycle bin\n", n)
			}
		}
		_ = os.RemoveAll(dir)
	}
	return out
}
