package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"log/slog"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"panelyth/sidecar/internal/editor"
	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/imaging"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/library"
)

// TestBenchBatch is the Stage 16 benchmark (opt-in: it writes a few hundred
// megabytes and runs for minutes). It measures a batch edit of 12 MP JPEGs
// through the real services (the job queue, the editor's save, the decode
// budget previews share): throughput for 1, 2 and 4 workers, the peak heap,
// the goroutines, the latency of a cancel, the plan of a large selection and
// what a running batch costs the thumbnail generation.
//
//	PANELYTH_BENCH_BATCH=1 [PANELYTH_BENCH_N=200] [PANELYTH_BENCH_PLAN_N=100000] [PANELYTH_BENCH_OUT=file.json] \
//	  go test ./internal/app -run TestBenchBatch -v -timeout 60m
func TestBenchBatch(t *testing.T) {
	if os.Getenv("PANELYTH_BENCH_BATCH") != "1" {
		t.Skip("writes a few hundred MB and runs for minutes; set PANELYTH_BENCH_BATCH=1")
	}
	envInt := func(name string, def int) int {
		if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
			return v
		}
		return def
	}
	n, planN := envInt("PANELYTH_BENCH_N", 200), envInt("PANELYTH_BENCH_PLAN_N", 100_000)
	ctx := context.Background()
	// PANELYTH_BENCH_ONLY=plan,cancel… runs some of the measurements (runs, cancel, journal, thumbs, plan).
	only := os.Getenv("PANELYTH_BENCH_ONLY")
	want := func(part string) bool { return only == "" || strings.Contains(only, part) }

	// The service, with its events counted (previews report through them).
	var ready atomic.Int64
	emit := func(channel string, payload any) error {
		if channel == evPreviewReady {
			b, _ := json.Marshal(payload)
			ready.Add(int64(bytes.Count(b, []byte(`"id":`))))
		}
		return nil
	}
	svc, err := newIndexService(t.TempDir(), 8<<30, slog.New(slog.DiscardHandler), emit, nil, nil)
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
		_ = lib.Close()
		svc.close()
	})

	// One 12 MP photograph-like picture (a gradient with grain), and n names
	// for it: hard links, so the set costs the disk one file.
	base := filepath.Join(t.TempDir(), "base.jpg")
	{
		rng := rand.New(rand.NewSource(16))
		img := image.NewRGBA(image.Rect(0, 0, 4000, 3000))
		for y := range 3000 {
			for x := range 4000 {
				g := rng.Intn(24)
				img.SetRGBA(x, y, color.RGBA{uint8(x*200/4000 + g), uint8(y*200/3000 + g), uint8((x+y)%180 + g), 255})
			}
		}
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(base, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	baseInfo, _ := os.Stat(base)
	set := func(name string, count int) string {
		dir := filepath.Join(filepath.Dir(base), name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for i := range count {
			dst := filepath.Join(dir, fmt.Sprintf("IMG_%05d.jpg", i))
			if os.Link(base, dst) == nil {
				continue
			}
			src, err := os.Open(base)
			if err != nil {
				t.Fatal(err)
			}
			out, err := os.Create(dst)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.Copy(out, src)
			_ = src.Close()
			_ = out.Close()
		}
		return dir
	}
	open := func(dir string) (jobSourceWire, []int64) {
		res, err := svc.dirOpen(ctx, dirOpenParams{Path: dir})
		if err != nil {
			t.Fatal(err)
		}
		svc.scans.Wait(res.ScanID)
		snap, err := svc.queryOpen(ctx, queryOpenParams{DirID: res.DirID, Sort: []sortKeyWire{{Field: "name", Direction: "asc"}}})
		if err != nil {
			t.Fatal(err)
		}
		ids, _, err := svc.queries.IDs(snap.QueryID, snap.Version)
		if err != nil {
			t.Fatal(err)
		}
		return jobSourceWire{Selection: selectionWire{QueryID: snap.QueryID, Version: snap.Version,
			Ranges: [][2]int{{0, len(ids)}}, Include: []int64{}, Exclude: []int64{}}}, ids
	}

	recipe := editor.Recipe{Version: editor.RecipeVersion,
		Ops: editList(t, `[{"op":"resize","p":{"mode":"fit","w":1600,"h":1600,"noEnlarge":true}},`+
			`{"op":"sharpen","p":{"amount":60,"radius":0.8}},`+
			`{"op":"watermark","p":{"kind":"text","text":"© {year} {name}","size":4,"color":"#ffffff","opacity":70,"shadow":true,"anchor":"se","margin":3}}]`),
		Output: editor.Output{Format: "jpeg", Quality: 85, Metadata: imaging.MetaKeep, Destination: editor.DestFolder, Conflict: editor.ConflictKeepBoth}}

	type run struct {
		Workers        int     `json:"workers"`
		Pictures       int     `json:"pictures"`
		Seconds        float64 `json:"seconds"`
		PicturesPerSec float64 `json:"picturesPerSec"`
		MPPerSec       float64 `json:"megapixelsPerSec"`
		PeakHeapMB     float64 `json:"peakHeapInUseMB"`
		PeakSysMB      float64 `json:"peakSysMB"`
		Goroutines     int     `json:"maxGoroutines"`
		BaseGoroutines int     `json:"goroutinesBefore"`
	}
	type result struct {
		Stage      string  `json:"stage"`
		At         string  `json:"at"`
		CPUs       int     `json:"cpus"`
		Go         string  `json:"go"`
		Megapixels float64 `json:"megapixelsPerPicture"`
		SourceMB   float64 `json:"sourceMBPerPicture"`
		Recipe     string  `json:"recipe"`
		Runs       []run   `json:"runs"`
		Scaling    float64 `json:"scaling1to4"`
		Default    int     `json:"defaultWorkers"`
		Cancel     struct {
			DoneBefore int     `json:"doneBeforeCancel"`
			LatencyMs  float64 `json:"latencyMs"`
			Partials   int     `json:"partialsLeft"`
		} `json:"cancel"`
		Plan struct {
			Pictures  int     `json:"pictures"`
			MedianMs  float64 `json:"medianMs"`
			MaxMs     float64 `json:"maxMs"`
			LargeN    int     `json:"largePictures"`
			LargeMs   float64 `json:"largeMedianMs"`
			LargeMax  float64 `json:"largeMaxMs"`
			LargeScan float64 `json:"largeScanSeconds"`
		} `json:"plan"`
		Journal struct {
			Entries int     `json:"entries"`
			Ms      float64 `json:"ms"`
		} `json:"journal"`
		Thumbs struct {
			Pictures    int     `json:"pictures"`
			AloneSec    float64 `json:"aloneSeconds"`
			WithSec     float64 `json:"withBatchSeconds"`
			DropPercent float64 `json:"throughputDropPercent"`
		} `json:"thumbnails"`
	}
	res := result{Stage: os.Getenv("BENCH_STAGE"), At: time.Now().Format(time.RFC3339), CPUs: runtime.NumCPU(), Go: runtime.Version(),
		Megapixels: 12, SourceMB: float64(baseInfo.Size()) / (1 << 20), Default: jobs.BatchWorkers(),
		Recipe: "fit 1600 px + sharpen + text watermark -> JPEG 85, into a folder"}

	pics := set("pics", n)
	source, _ := open(pics)

	wait := func(id int64) jobs.Snapshot {
		for {
			for _, s := range svc.jobs.List() {
				if s.JobID == id && !s.State.Active() {
					return s
				}
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	start := func(workers int, folder string) jobs.Snapshot {
		ids, err := svc.resolveSelection(source.Selection)
		if err != nil {
			t.Fatal(err)
		}
		snap, err := svc.startJob(jobs.Spec{Kind: jobs.KindEdit, IDs: ids, Destination: folder, Batch: &jobs.BatchSpec{
			Recipe: recipe, Folder: folder, Workers: workers, Reserve: svc.preview.ReserveDecode, Resources: svc.editor.ResourcesFor}})
		if err != nil {
			t.Fatal(err)
		}
		return snap
	}
	// watch samples the heap and the goroutines until stop is closed.
	watch := func(stop <-chan struct{}) (heap, sys *float64, goroutines *int, done *sync.WaitGroup) {
		heap, sys, goroutines, done = new(float64), new(float64), new(int), &sync.WaitGroup{}
		done.Add(1)
		go func() {
			defer done.Done()
			var ms runtime.MemStats
			for {
				runtime.ReadMemStats(&ms)
				*heap = max(*heap, float64(ms.HeapInuse)/(1<<20))
				*sys = max(*sys, float64(ms.Sys)/(1<<20))
				*goroutines = max(*goroutines, runtime.NumGoroutine())
				select {
				case <-stop:
					return
				case <-time.After(50 * time.Millisecond):
				}
			}
		}()
		return
	}

	// The plan of the selection: one call, no pixels.
	planTimes := func(src jobSourceWire) (median, worst float64, count int) {
		var times []float64
		for range 7 {
			t0 := time.Now()
			plan, err := svc.editPlan(ctx, editBatchParams{Source: src, Recipe: recipe, Folder: t.TempDir()})
			if err != nil {
				t.Fatal(err)
			}
			times = append(times, float64(time.Since(t0).Microseconds())/1000)
			count = plan.Count
		}
		slices.Sort(times)
		return times[len(times)/2], times[len(times)-1], count
	}
	res.Plan.MedianMs, res.Plan.MaxMs, res.Plan.Pictures = planTimes(source)

	for _, workers := range []int{1, 2, 4} {
		if !want("runs") {
			break
		}
		folder := filepath.Join(t.TempDir(), "out")
		if err := os.Mkdir(folder, 0o755); err != nil {
			t.Fatal(err)
		}
		runtime.GC()
		base := runtime.NumGoroutine()
		stop := make(chan struct{})
		heap, sys, goroutines, done := watch(stop)
		t0 := time.Now()
		s := wait(start(workers, folder).JobID)
		secs := time.Since(t0).Seconds()
		close(stop)
		done.Wait()
		if s.State != jobs.StateCompleted || s.Done != n || s.Failed != 0 {
			errs, _, _ := svc.jobs.Errors(s.JobID, 0, 20)
			t.Fatalf("%d workers: %+v %+v", workers, s, errs)
		}
		r := run{Workers: workers, Pictures: n, Seconds: secs, PicturesPerSec: float64(n) / secs, MPPerSec: 12 * float64(n) / secs,
			PeakHeapMB: *heap, PeakSysMB: *sys, Goroutines: *goroutines, BaseGoroutines: base}
		res.Runs = append(res.Runs, r)
		t.Logf("%d workers: %.2f pictures/s (%.0f MP/s), peak heap %.0f MB, goroutines %d (before %d)",
			workers, r.PicturesPerSec, r.MPPerSec, r.PeakHeapMB, r.Goroutines, base)
		_ = os.RemoveAll(folder)
	}
	if len(res.Runs) == 3 {
		res.Scaling = res.Runs[2].PicturesPerSec / res.Runs[0].PicturesPerSec
	}

	// Cancel: how long the pictures in progress take to stop, and what they leave.
	if want("cancel") {
		folder := filepath.Join(t.TempDir(), "cancelled")
		if err := os.Mkdir(folder, 0o755); err != nil {
			t.Fatal(err)
		}
		snap := start(4, folder)
		for {
			done := 0
			for _, s := range svc.jobs.List() {
				if s.JobID == snap.JobID {
					done = s.Done
				}
			}
			if done >= 8 {
				res.Cancel.DoneBefore = done
				break
			}
			time.Sleep(2 * time.Millisecond)
		}
		t0 := time.Now()
		svc.jobs.Cancel(snap.JobID)
		s := wait(snap.JobID)
		res.Cancel.LatencyMs = float64(time.Since(t0).Microseconds()) / 1000
		if s.State != jobs.StateCancelled {
			t.Fatalf("cancel: %+v", s)
		}
		entries, _ := os.ReadDir(folder)
		for _, e := range entries {
			if strings.Contains(e.Name(), fileops.PartialSuffix) {
				res.Cancel.Partials++
			}
		}
		t.Logf("cancel: %.0f ms after %d pictures, %d partial files, %d finished files", res.Cancel.LatencyMs, res.Cancel.DoneBefore, res.Cancel.Partials, len(entries))
	}

	// The journal of a 10,000-picture job is a slice in memory.
	if want("journal") {
		t0 := time.Now()
		var created []jobs.Created
		for i := range jobs.MaxCreated {
			created = append(created, jobs.Created{Path: filepath.Join(pics, fmt.Sprintf("IMG_%05d-edited.jpg", i)), Size: 1, MtimeNs: 1})
		}
		res.Journal.Entries, res.Journal.Ms = len(created), float64(time.Since(t0).Microseconds())/1000
	}

	// Thumbnails alone, and while a batch runs (each on pictures it has not seen).
	if want("thumbs") {
		const m = 120
		thumbs := func(name string) float64 {
			_, ids := open(set(name, m))
			items := make([]previewEnsureItem, len(ids))
			for i, id := range ids {
				items[i] = previewEnsureItem{ID: id, Priority: 0}
			}
			ready.Store(0)
			t0 := time.Now()
			got, err := svc.previewEnsure(ctx, previewEnsureParams{Lane: "bench", Epoch: 1, Profile: "grid-md", Items: items, Force: []int64{}})
			if err != nil {
				t.Fatal(err)
			}
			for int(ready.Load())+len(got.Items) < len(ids) {
				if time.Since(t0) > 10*time.Minute {
					t.Fatalf("thumbnails: %d of %d", ready.Load(), len(ids))
				}
				time.Sleep(5 * time.Millisecond)
			}
			return time.Since(t0).Seconds()
		}
		res.Thumbs.Pictures = m
		res.Thumbs.AloneSec = thumbs("thumbs-alone")
		folder := filepath.Join(t.TempDir(), "busy")
		if err := os.Mkdir(folder, 0o755); err != nil {
			t.Fatal(err)
		}
		snap := start(0, folder)
		time.Sleep(500 * time.Millisecond) // the batch is under way
		res.Thumbs.WithSec = thumbs("thumbs-busy")
		busy := false
		for _, s := range svc.jobs.List() {
			busy = busy || s.JobID == snap.JobID && s.State.Active()
		}
		if !busy {
			t.Log("the batch ended before the thumbnails: the interference figure is too low; raise PANELYTH_BENCH_N")
		}
		svc.jobs.Cancel(snap.JobID)
		wait(snap.JobID)
		res.Thumbs.DropPercent = 100 * (1 - res.Thumbs.AloneSec/res.Thumbs.WithSec)
		t.Logf("thumbnails of %d pictures: %.2f s alone, %.2f s beside a batch (throughput -%.0f %%)", m, res.Thumbs.AloneSec, res.Thumbs.WithSec, res.Thumbs.DropPercent)
	}

	// The plan of a large selection: names only, so empty files stand in.
	if want("plan") {
		large := filepath.Join(t.TempDir(), "large")
		if err := os.MkdirAll(large, 0o755); err != nil {
			t.Fatal(err)
		}
		for i := range planN {
			if err := os.WriteFile(filepath.Join(large, fmt.Sprintf("P%06d.jpg", i)), nil, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		t0 := time.Now()
		src, ids := open(large)
		res.Plan.LargeScan = time.Since(t0).Seconds()
		res.Plan.LargeMs, res.Plan.LargeMax, res.Plan.LargeN = planTimes(src)
		if res.Plan.LargeN != len(ids) {
			t.Fatalf("plan counted %d of %d", res.Plan.LargeN, len(ids))
		}
		t.Logf("plan of %d pictures: median %.0f ms, worst %.0f ms", res.Plan.LargeN, res.Plan.LargeMs, res.Plan.LargeMax)
	}

	b, _ := json.MarshalIndent(res, "", "  ")
	b = append(b, '\n')
	if out := os.Getenv("PANELYTH_BENCH_OUT"); out != "" {
		if err := os.WriteFile(out, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("%s", b)
}
