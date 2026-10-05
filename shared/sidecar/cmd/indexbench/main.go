// Command indexbench measures the Stage 01 index pipeline on real files:
// scan throughput, write-batch latency, time to first committed rows, query
// materialization, page latency at deep offsets and memory growth.
//
//	go run ./cmd/indexbench -fixtures <dir> -out result.json
//
// Fixtures are generated once (see internal/fixture) and reused.
package main

import (
	"cmp"
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
	"time"

	"fastview/sidecar/internal/fixture"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/query"
	"fastview/sidecar/internal/scan"
)

type scanResult struct {
	Name          string  `json:"name"`
	Recursive     bool    `json:"recursive"`
	IndexState    string  `json:"indexState"` // "cold" (empty index) or "warm" (rescan)
	Entries       int     `json:"entries"`
	Dirs          int     `json:"dirs"`
	ElapsedMs     float64 `json:"elapsedMs"`
	EntriesPerSec float64 `json:"entriesPerSec"`
	FirstCommitMs float64 `json:"firstCommitMs"`
	Batches       int     `json:"batches"`
	BatchMsMax    float64 `json:"batchMsMax"`
	BatchMsAvg    float64 `json:"batchMsAvg"`
	WriteShare    float64 `json:"writeShareOfElapsed"`
}

type latency struct {
	N   int     `json:"n"`
	P50 float64 `json:"p50"`
	P95 float64 `json:"p95"`
	Max float64 `json:"max"`
}

type queryResult struct {
	Name          string             `json:"name"`
	Total         int                `json:"total"`
	OpenMs        latency            `json:"openMs"`
	PageMsByDepth map[string]latency `json:"pageMsByOffset"`
}

type result struct {
	Stage     string         `json:"stage"`
	Benchmark string         `json:"benchmark"`
	Date      string         `json:"date"`
	Env       map[string]any `json:"env"`
	Fixtures  map[string]any `json:"fixtures"`
	Scans     []scanResult   `json:"scans"`
	Queries   []queryResult  `json:"queries"`
	Memory    map[string]any `json:"memory"`
	// IndexDB is index.db's size after all scans (Stage P02: growth from
	// storing every entry).
	IndexDB map[string]any `json:"indexDb"`
}

func main() {
	fixtures := flag.String("fixtures", filepath.Join(os.TempDir(), "fastview-fixtures"), "fixture root")
	out := flag.String("out", "", "write JSON result here (default stdout)")
	flag.Parse()
	log := slog.New(slog.DiscardHandler)
	ctx := context.Background()

	flat := filepath.Join(*fixtures, "flat-100k")
	tree := filepath.Join(*fixtures, "tree-50k")
	flatSpec := fixture.Spec{Files: 100_000, NonMediaEvery: 10}
	treeSpec := fixture.Spec{Files: 200, Depth: 3, Fanout: 6, NonMediaEvery: 10}
	flatExp := must(fixture.Generate(flat, flatSpec))
	treeExp := must(fixture.Generate(tree, treeSpec))
	// Stage P02: half media, half documents, every 5th file hidden.
	mixed := filepath.Join(*fixtures, "mixed-100k")
	mixedSpec := fixture.Spec{Files: 100_000, NonMediaEvery: 2, HiddenEvery: 5}
	mixedExp := must(fixture.Generate(mixed, mixedSpec))

	dbDir := must(os.MkdirTemp("", "fastview-indexbench-"))
	defer os.RemoveAll(dbDir)
	store := must(index.Open(filepath.Join(dbDir, "index.db"), log))
	defer store.Close()

	runtime.GC()
	memBefore := runtimeBytes()
	peak := memBefore
	stopSampling := sampleMemory(&peak)

	res := result{
		Stage: cmp.Or(os.Getenv("BENCH_STAGE"), "01"), Benchmark: "index", Date: time.Now().Format(time.RFC3339),
		Env: map[string]any{"go": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH, "cpus": runtime.NumCPU()},
		Fixtures: map[string]any{
			"flat-100k":  map[string]any{"spec": flatSpec, "expected": flatExp},
			"tree-50k":   map[string]any{"spec": treeSpec, "expected": treeExp},
			"mixed-100k": map[string]any{"spec": mixedSpec, "expected": mixedExp},
		},
	}

	flatInfo := must(store.EnsureDir(ctx, flat))
	treeInfo := must(store.EnsureDir(ctx, tree))
	mixedInfo := must(store.EnsureDir(ctx, mixed))
	res.Scans = append(res.Scans,
		runScan(ctx, store, log, "flat-100k", flatInfo, false, "cold"),
		runScan(ctx, store, log, "flat-100k", flatInfo, false, "warm"),
		runScan(ctx, store, log, "tree-50k", treeInfo, true, "cold"),
		runScan(ctx, store, log, "tree-50k", treeInfo, true, "warm"),
		runScan(ctx, store, log, "mixed-100k", mixedInfo, false, "cold"),
		runScan(ctx, store, log, "mixed-100k", mixedInfo, false, "warm"),
	)
	checkTotal(ctx, store, flatInfo, false, flatExp.Media)
	checkTotal(ctx, store, treeInfo, true, treeExp.Media)
	checkTotal(ctx, store, mixedInfo, false, mixedExp.Media)

	qm := query.NewManager(store, log, query.Options{}, nil)
	res.Queries = append(res.Queries,
		runQuery(ctx, qm, "flat-100k name asc", index.Descriptor{DirID: flatInfo.ID, Sort: []index.SortKey{{Field: index.SortName}}}),
		runQuery(ctx, qm, "flat-100k modified desc", index.Descriptor{DirID: flatInfo.ID, Sort: []index.SortKey{{Field: index.SortModified, Desc: true}}}),
		runQuery(ctx, qm, "flat-100k type asc", index.Descriptor{DirID: flatInfo.ID, Sort: []index.SortKey{{Field: index.SortType}}}),
		runQuery(ctx, qm, "flat-100k created desc", index.Descriptor{DirID: flatInfo.ID, Sort: []index.SortKey{{Field: index.SortCreated, Desc: true}}}),
		runQuery(ctx, qm, "flat-100k dimensions desc", index.Descriptor{DirID: flatInfo.ID, Sort: []index.SortKey{{Field: index.SortDimensions, Desc: true}}}),
		runQuery(ctx, qm, "flat-100k search \"img_4\"", index.Descriptor{DirID: flatInfo.ID, Search: "img_4", Sort: []index.SortKey{{Field: index.SortName}}}),
		runQuery(ctx, qm, "tree-50k recursive name asc", index.Descriptor{DirID: treeInfo.ID, Recursive: true, Sort: []index.SortKey{{Field: index.SortName}}}),
		// Stage P02 (ADR-0026): the media scope on a mixed folder, and the
		// commander's all scope.
		runQuery(ctx, qm, "mixed-100k media name asc", index.Descriptor{DirID: mixedInfo.ID, Sort: []index.SortKey{{Field: index.SortName}}}),
		runQuery(ctx, qm, "mixed-100k all name asc", index.Descriptor{DirID: mixedInfo.ID, Scope: index.ScopeAll, Sort: []index.SortKey{{Field: index.SortName}}}),
		runQuery(ctx, qm, "mixed-100k all+hidden name asc", index.Descriptor{DirID: mixedInfo.ID, Scope: index.ScopeAll, ShowHidden: true, Sort: []index.SortKey{{Field: index.SortName}}}),
		runQuery(ctx, qm, "mixed-100k all ext asc", index.Descriptor{DirID: mixedInfo.ID, Scope: index.ScopeAll, Sort: []index.SortKey{{Field: index.SortType}}}),
		runQuery(ctx, qm, "mixed-100k all attrs desc", index.Descriptor{DirID: mixedInfo.ID, Scope: index.ScopeAll, ShowHidden: true, Sort: []index.SortKey{{Field: index.SortAttrs, Desc: true}}}),
		runQuery(ctx, qm, "mixed-100k all mask *.txt", index.Descriptor{DirID: mixedInfo.ID, Scope: index.ScopeAll, NameMask: "*.txt", Sort: []index.SortKey{{Field: index.SortName}}}),
		runQuery(ctx, qm, "mixed-100k all mask *|*.txt;*.jpg", index.Descriptor{DirID: mixedInfo.ID, Scope: index.ScopeAll, NameMask: "*|*.txt;*.jpg", Sort: []index.SortKey{{Field: index.SortName}}}),
		runQuery(ctx, qm, "flat-100k all name asc", index.Descriptor{DirID: flatInfo.ID, Scope: index.ScopeAll, Sort: []index.SortKey{{Field: index.SortName}}}),
	)
	qm.Shutdown()

	stopSampling()
	runtime.GC()
	after := runtimeBytes()
	res.Memory = map[string]any{
		"runtimeBytesBefore": memBefore, "runtimeBytesPeak": peak, "runtimeBytesAfterGC": after,
		"growthAfterGCBytes": int64(after) - int64(memBefore),
		"note":               "Go runtime memory (/memory/classes/total:bytes) of this process; excludes SQLite page cache outside the Go heap only if allocated natively (modernc allocates in Go)",
	}

	_ = store.Close()
	var dbBytes int64
	for _, suffix := range []string{"", "-wal"} {
		if fi, err := os.Stat(filepath.Join(dbDir, "index.db"+suffix)); err == nil {
			dbBytes += fi.Size()
		}
	}
	res.IndexDB = map[string]any{"bytes": dbBytes, "entries": flatExp.Media + flatExp.NonMedia + flatExp.Hidden +
		treeExp.Media + treeExp.NonMedia + treeExp.Dirs + mixedExp.Media + mixedExp.NonMedia + mixedExp.Hidden}

	b, _ := json.MarshalIndent(res, "", "  ")
	if *out == "" {
		fmt.Println(string(b))
		return
	}
	if err := os.WriteFile(*out, append(b, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, s := range res.Scans {
		fmt.Printf("%-10s %-4s recursive=%-5v %7d entries %8.0f ms  %8.0f entries/s  first commit %6.1f ms  batches %4d (max %.1f ms)\n",
			s.Name, s.IndexState, s.Recursive, s.Entries, s.ElapsedMs, s.EntriesPerSec, s.FirstCommitMs, s.Batches, s.BatchMsMax)
	}
	for _, q := range res.Queries {
		fmt.Printf("%-30s total %6d  open p50 %6.1f ms  page@0 p95 %.2f ms  page@deep p95 %.2f ms\n",
			q.Name, q.Total, q.OpenMs.P50, q.PageMsByDepth["0"].P95, q.PageMsByDepth["last"].P95)
	}
	fmt.Printf("memory: before %.1f MB, peak %.1f MB, after GC %.1f MB\n",
		mb(memBefore), mb(peak), mb(after))
	fmt.Printf("index.db: %.1f MB\n", mb(uint64(dbBytes)))
	fmt.Println("wrote", *out)
}

func runScan(ctx context.Context, store *index.Store, log *slog.Logger, name string, root index.DirInfo, recursive bool, state string) scanResult {
	gen := store.NextGeneration()
	id := must(store.ScanStarted(ctx, root.ID, recursive, gen))
	t := time.Now()
	st := scan.Run(ctx, store, log, scan.Options{}, scan.Hooks{}, id, gen, root, recursive)
	elapsed := float64(time.Since(t).Microseconds()) / 1000
	if st.State != scan.StateCompleted {
		panic("scan " + st.State)
	}
	return scanResult{
		Name: name, Recursive: recursive, IndexState: state, Entries: st.Entries, Dirs: st.DirsListed,
		ElapsedMs: elapsed, EntriesPerSec: float64(st.Entries) / (elapsed / 1000),
		FirstCommitMs: st.FirstCommitMs, Batches: st.Batches, BatchMsMax: st.MaxBatchMs,
		BatchMsAvg: st.TotalWriteMs / float64(max(st.Batches, 1)), WriteShare: st.TotalWriteMs / elapsed,
	}
}

func runQuery(ctx context.Context, qm *query.Manager, name string, d index.Descriptor) queryResult {
	var opens []float64
	var snap query.Snapshot
	for range 7 {
		t := time.Now()
		snap = must(qm.Open(ctx, d))
		opens = append(opens, ms(time.Since(t)))
		qm.Close(snap.QueryID)
	}
	snap = must(qm.Open(ctx, d))
	offsets := map[string]int{"0": 0, "middle": snap.Total / 2, "last": max(snap.Total-256, 0)}
	pages := map[string]latency{}
	for label, off := range offsets {
		var xs []float64
		for range 50 {
			t := time.Now()
			p := must(qm.Page(ctx, snap.QueryID, off, 256))
			xs = append(xs, ms(time.Since(t)))
			if len(p.Items) == 0 && snap.Total > 0 {
				panic("empty page")
			}
		}
		pages[label] = stats(xs)
	}
	return queryResult{Name: name, Total: snap.Total, OpenMs: stats(opens), PageMsByDepth: pages}
}

func checkTotal(ctx context.Context, store *index.Store, d index.DirInfo, recursive bool, want int) {
	ids := must(store.QueryIDs(ctx, index.Descriptor{DirID: d.ID, Recursive: recursive, Kinds: nil}, d.Key))
	media := 0
	items := must(store.LoadItems(ctx, ids))
	for _, it := range items {
		if it.Kind != 0 {
			media++
		}
	}
	if media != want {
		panic(fmt.Sprintf("indexed %d media, fixture has %d", media, want))
	}
}

func sampleMemory(peak *uint64) func() {
	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		t := time.NewTicker(20 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				*peak = max(*peak, runtimeBytes())
			}
		}
	}()
	return func() { close(done); <-stopped }
}

func runtimeBytes() uint64 {
	s := []metrics.Sample{{Name: "/memory/classes/total:bytes"}}
	metrics.Read(s)
	return s[0].Value.Uint64()
}

func stats(xs []float64) latency {
	slices.Sort(xs)
	q := func(p float64) float64 { return round(xs[min(len(xs)-1, int(p*float64(len(xs))))]) }
	return latency{N: len(xs), P50: q(0.5), P95: q(0.95), Max: round(xs[len(xs)-1])}
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
func mb(b uint64) float64        { return float64(b) / (1 << 20) }
func round(v float64) float64    { return float64(int(v*100+0.5)) / 100 }
func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
