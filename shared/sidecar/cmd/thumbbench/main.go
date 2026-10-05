// Command thumbbench measures the Stage 02 preview pipeline on real JPEGs:
// cold generation throughput and latency at several worker limits, CPU
// utilization, disk write rate, cache-hit latency and request coalescing.
//
//	go run ./cmd/thumbbench -fixtures <dir> -out result.json
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"runtime/metrics"
	"slices"
	"sync"
	"time"

	"fastview/sidecar/internal/fixture"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/preview"
	"fastview/sidecar/internal/scan"
)

type latency struct {
	N   int     `json:"n"`
	P50 float64 `json:"p50"`
	P95 float64 `json:"p95"`
	Max float64 `json:"max"`
}

type coldRun struct {
	Workers         int     `json:"workers"`
	Images          int     `json:"images"`
	WallMs          float64 `json:"wallMs"`
	ImagesPerSec    float64 `json:"imagesPerSec"`
	LatencyMs       latency `json:"latencyMs"` // ensure call -> ready event, per image
	CPUUtilization  float64 `json:"cpuUtilizationOfAllCores"`
	CPUCoresBusy    float64 `json:"cpuCoresBusy"`
	DiskWriteMBps   float64 `json:"diskWriteMBps"`
	BytesWritten    int64   `json:"bytesWritten"`
	AvgPreviewBytes int64   `json:"avgPreviewBytes"`
}

type result struct {
	Stage       string         `json:"stage"`
	Benchmark   string         `json:"benchmark"`
	Date        string         `json:"date"`
	Env         map[string]any `json:"env"`
	Fixture     map[string]any `json:"fixture"`
	Profile     string         `json:"profile"`
	Cold        []coldRun      `json:"cold"`
	HitBatchMs  latency        `json:"cacheHitEnsureMsPer100"`
	HitPerItem  float64        `json:"cacheHitMsPerItemP50"`
	Coalescing  map[string]int `json:"coalescing"`
	ThumbsPage  latency        `json:"pageThumbLookupMsPer100"`
	PixelBudget string         `json:"pixelBudget"`
}

var quiet = slog.New(slog.DiscardHandler)

func main() {
	fixtures := flag.String("fixtures", filepath.Join(os.TempDir(), "fastview-fixtures"), "fixture root")
	out := flag.String("out", "", "write JSON here (default stdout)")
	count := flag.Int("images", 120, "number of 12 MP images")
	flag.Parse()

	spec := fixture.ImageSpec{Count: *count, Width: 4000, Height: 3000}
	dir := filepath.Join(*fixtures, fmt.Sprintf("images-12mp-%d", *count))
	fmt.Println("fixture", dir, "(generated once; ~0.3 s per image)")
	must0(fixture.GenerateImages(dir, spec))

	res := result{
		Stage: "02", Benchmark: "previews", Date: time.Now().Format(time.RFC3339), Profile: string(preview.GridMd),
		Env:         map[string]any{"go": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH, "cpus": runtime.NumCPU()},
		Fixture:     map[string]any{"dir": dir, "spec": spec, "sourceMP": 12},
		PixelBudget: "250M pixels (default)",
	}
	for _, w := range []int{1, 2, 4, 8} {
		r := cold(dir, w)
		res.Cold = append(res.Cold, r)
		fmt.Printf("workers=%d  %6.1f img/s  latency p50 %6.0f ms p95 %6.0f ms  cpu %4.1f cores  disk %5.2f MB/s  avg %d B\n",
			w, r.ImagesPerSec, r.LatencyMs.P50, r.LatencyMs.P95, r.CPUCoresBusy, r.DiskWriteMBps, r.AvgPreviewBytes)
	}
	res.HitBatchMs, res.HitPerItem, res.ThumbsPage, res.Coalescing = warm(dir)
	fmt.Printf("cache hit: ensure(100) p50 %.2f ms p95 %.2f ms (%.3f ms/item); page thumb lookup(100) p95 %.2f ms\n",
		res.HitBatchMs.P50, res.HitBatchMs.P95, res.HitPerItem, res.ThumbsPage.P95)
	fmt.Printf("coalescing: %v\n", res.Coalescing)

	b, _ := json.MarshalIndent(res, "", "  ")
	if *out == "" {
		fmt.Println(string(b))
		return
	}
	must0(os.WriteFile(*out, append(b, '\n'), 0o644))
	fmt.Println("wrote", *out)
}

type env struct {
	store *index.Store
	disk  *preview.DiskCache
	root  index.DirInfo
	ids   []int64
	tmp   string
}

func setup(dir string) *env {
	tmp := must(os.MkdirTemp("", "fastview-thumbbench-"))
	store := must(index.Open(filepath.Join(tmp, "db", "index.db"), quiet))
	disk := must(preview.OpenDiskCache(tmp))
	root := must(store.EnsureDir(context.Background(), dir))
	gen := store.NextGeneration()
	scan.Run(context.Background(), store, quiet, scan.Options{}, scan.Hooks{}, 1, gen, root, false)
	root = must(store.Dir(context.Background(), root.ID))
	ids := must(store.QueryIDs(context.Background(), index.Descriptor{DirID: root.ID}, root.Key))
	return &env{store: store, disk: disk, root: root, ids: ids, tmp: tmp}
}

func (e *env) close() {
	_ = e.store.Close()
	_ = os.RemoveAll(e.tmp)
}

func items(ids []int64) []preview.EnsureItem {
	out := make([]preview.EnsureItem, len(ids))
	for i, id := range ids {
		out[i] = preview.EnsureItem{ID: id, Priority: preview.PriorityVisible}
	}
	return out
}

func cold(dir string, workers int) coldRun {
	e := setup(dir)
	defer e.close()
	var mu sync.Mutex
	done := map[int64]time.Duration{}
	all := make(chan struct{})
	var start time.Time
	svc := preview.NewService(e.store, e.disk, quiet, preview.Options{Workers: workers}, func(it preview.Item) {
		mu.Lock()
		defer mu.Unlock()
		if it.Failed != "" {
			panic("preview failed: " + it.Failed)
		}
		done[it.ID] = time.Since(start)
		if len(done) == len(e.ids) {
			close(all)
		}
	})
	defer svc.Close()
	runtime.GC()
	cpu0 := cpuSeconds()
	start = time.Now()
	must(svc.Ensure(context.Background(), preview.EnsureRequest{Lane: "bench", Epoch: 1, Profile: preview.GridMd, Items: items(e.ids)}))
	<-all
	wall := time.Since(start)
	cpu := cpuSeconds() - cpu0
	written := must(e.store.PreviewBytes(context.Background()))
	var lat []float64
	for _, d := range done {
		lat = append(lat, ms(d))
	}
	secs := wall.Seconds()
	return coldRun{
		Workers: workers, Images: len(e.ids), WallMs: ms(wall), ImagesPerSec: round(float64(len(e.ids)) / secs),
		LatencyMs: stats(lat), CPUCoresBusy: round(cpu / secs), CPUUtilization: round(cpu / secs / float64(runtime.NumCPU())),
		DiskWriteMBps: round(float64(written) / (1 << 20) / secs), BytesWritten: written,
		AvgPreviewBytes: written / int64(len(e.ids)),
	}
}

func warm(dir string) (latency, float64, latency, map[string]int) {
	e := setup(dir)
	defer e.close()
	var mu sync.Mutex
	ready := 0
	svc := preview.NewService(e.store, e.disk, quiet, preview.Options{Workers: 8}, func(preview.Item) {
		mu.Lock()
		ready++
		mu.Unlock()
	})
	defer svc.Close()
	ctx := context.Background()
	batch := e.ids[:min(100, len(e.ids))]

	// Coalescing: the same 20 images requested 10 times before any finish.
	dup := e.ids[:20]
	for epoch := range 10 {
		must(svc.Ensure(ctx, preview.EnsureRequest{Lane: "bench", Epoch: 1, Profile: preview.GridMd, Items: items(dup)}))
		_ = epoch
	}
	wait := func(n int) {
		for {
			mu.Lock()
			r := ready
			mu.Unlock()
			if r >= n {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	wait(len(dup))
	st := svc.Stats()
	rows := must(e.store.PreviewBytes(ctx))
	coalescing := map[string]int{"requests": 10 * len(dup), "distinctImages": len(dup), "joined": int(st.Joined),
		"readyEvents": ready, "cacheBytes": int(rows)}

	must(svc.Ensure(ctx, preview.EnsureRequest{Lane: "bench", Epoch: 2, Profile: preview.GridMd, Items: items(batch)}))
	wait(len(dup) + len(batch) - len(dup))
	var hit []float64
	for range 50 {
		t := time.Now()
		r := must(svc.Ensure(ctx, preview.EnsureRequest{Lane: "bench", Epoch: 3, Profile: preview.GridMd, Items: items(batch)}))
		hit = append(hit, ms(time.Since(t)))
		if r.Queued != 0 {
			panic("warm ensure queued work")
		}
	}
	its := must(e.store.LoadItems(ctx, batch))
	var page []float64
	for range 50 {
		t := time.Now()
		th := must(svc.Thumbs(ctx, its, preview.GridMd))
		page = append(page, ms(time.Since(t)))
		if len(th) != len(batch) {
			panic("missing thumbs")
		}
	}
	h := stats(hit)
	return h, round(h.P50 / float64(len(batch))), stats(page), coalescing
}

func cpuSeconds() float64 {
	s := []metrics.Sample{{Name: "/cpu/classes/total:cpu-seconds"}, {Name: "/cpu/classes/idle:cpu-seconds"}}
	metrics.Read(s)
	return s[0].Value.Float64() - s[1].Value.Float64()
}

func stats(xs []float64) latency {
	slices.Sort(xs)
	q := func(p float64) float64 { return round(xs[min(len(xs)-1, int(p*float64(len(xs))))]) }
	return latency{N: len(xs), P50: q(0.5), P95: q(0.95), Max: round(xs[len(xs)-1])}
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
func round(v float64) float64    { return float64(int(v*100+0.5)) / 100 }
func must0(err error) {
	if err != nil {
		panic(err)
	}
}
func must[T any](v T, err error) T {
	must0(err)
	return v
}
