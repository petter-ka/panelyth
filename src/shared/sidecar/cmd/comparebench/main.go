// Command comparebench measures Stage C08: comparing two 100k-entry trees by
// name, size and date (time, rows and memory per row, and by the number of
// folder readers), hashing throughput against the OS's own tool, and the
// text diff of two 10 MB files.
//
//	go run ./cmd/comparebench -fixtures <dir> -out result.json
//
// Fixtures are generated once per machine and reused (marker files).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"panelyth/sidecar/internal/checksum"
	"panelyth/sidecar/internal/compare"
	"panelyth/sidecar/internal/fixture"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/textdiff"
)

type compareRun struct {
	ElapsedMs float64 `json:"elapsedMs"`
	Rows      int     `json:"rows"`
	Dirs      int     `json:"dirs"`
	Entries   int     `json:"entries"`
	// BytesPerRow is the heap a finished compare holds, per row.
	BytesPerRow float64 `json:"bytesPerRow"`
	// SessionMs is the time to list the shown rows (the session's ids).
	SessionMs float64 `json:"sessionMs"`
}

type hashRun struct {
	OursMs   []float64 `json:"oursMs"`
	OSToolMs []float64 `json:"osToolMs"`
	OursMBs  float64   `json:"oursMBPerSec"`
	OSMBs    float64   `json:"osToolMBPerSec"`
	// Ratio is the best OS run over the best of ours (> 1: faster than the tool).
	Ratio float64 `json:"ratio"`
}

type diffRun struct {
	OpenMs  float64 `json:"openMs"`
	PageMs  float64 `json:"pageMs"`
	Rows    int     `json:"rows"`
	Changes int     `json:"changes"`
}

type result struct {
	Stage   string `json:"stage"`
	At      string `json:"at"`
	CPUs    int    `json:"numCpu"`
	Entries int    `json:"entriesPerTree"`
	// Compare: name, size and date with the default readers.
	Compare []compareRun `json:"compare"`
	// CompareByWalkers: the best of the runs per number of folder readers.
	CompareByWalkers map[string]float64 `json:"compareMsByWalkers"`
	// CompareContent also reads every pair of the same size (tiny files here: the cost is opening them).
	CompareContent []compareRun       `json:"compareContent"`
	HashBytes      int64              `json:"hashBytes"`
	OSHashTool     string             `json:"osHashTool"`
	Hash           map[string]hashRun `json:"hash"`
	TextBytes      int64              `json:"textBytes"`
	TextLines      int                `json:"textLines"`
	TextDiff       []diffRun          `json:"textDiff"`
}

func main() {
	fixtures := flag.String("fixtures", filepath.Join(os.TempDir(), "panelyth-fixtures"), "fixture root")
	out := flag.String("out", "", "write the JSON result here (default stdout)")
	runs := flag.Int("runs", 5, "runs per measurement")
	entries := flag.Int("entries", 100_000, "files per tree")
	hashBytes := flag.Int64("hash-bytes", 1<<30, "size of the hashed file")
	textBytes := flag.Int64("text-bytes", 10<<20, "size of each text file")
	flag.Parse()

	root := filepath.Join(*fixtures, "sync-c08")
	spec := fixture.SyncSpec{Entries: *entries, TextBytes: *textBytes, HashBytes: *hashBytes}
	fmt.Fprintln(os.Stderr, "fixtures:", root)
	check(fixture.GenerateSync(root, spec))
	res := result{Stage: "C08", At: time.Now().Format(time.RFC3339), CPUs: runtime.NumCPU(), Entries: *entries,
		CompareByWalkers: map[string]float64{}, HashBytes: *hashBytes, Hash: map[string]hashRun{}, TextBytes: *textBytes}
	ctx := context.Background()
	a, b := filepath.Join(root, "tree-a"), filepath.Join(root, "tree-b")

	// Compare: the walk, the arrangement and the first listing of the rows.
	one := func(walkers int, content bool) compareRun {
		var before, after runtime.MemStats
		runtime.GC()
		runtime.ReadMemStats(&before)
		var last compare.Progress
		m := compare.NewManager(compare.Deps{Walkers: walkers, Progress: func(p compare.Progress) { last = p }})
		start := time.Now()
		r, err := m.Start(compare.Spec{Left: a, Right: b, Content: content, Options: compare.Options{Tolerance: 2 * time.Second}}, nil)
		check(err)
		m.Wait(r.ID())
		ms := msSince(start)
		if last.State != compare.StateCompleted {
			check(fmt.Errorf("compare ended %s", last.State))
		}
		runtime.GC()
		runtime.ReadMemStats(&after)
		s := time.Now()
		ids, _ := r.IDs(ctx, index.Descriptor{})
		sessionMs := msSince(s)
		run := compareRun{ElapsedMs: ms, Rows: r.Len(), Dirs: last.Dirs, Entries: last.Entries, SessionMs: sessionMs,
			BytesPerRow: float64(int64(after.HeapAlloc)-int64(before.HeapAlloc)) / float64(max(r.Len(), 1))}
		runtime.KeepAlive(ids)
		runtime.KeepAlive(r)
		m.Shutdown()
		return run
	}
	for range *runs {
		run := one(0, false)
		res.Compare = append(res.Compare, run)
		fmt.Fprintf(os.Stderr, "compare: %.0f ms, %d rows, %.0f B/row, session %.1f ms\n", run.ElapsedMs, run.Rows, run.BytesPerRow, run.SessionMs)
	}
	for _, w := range []int{1, 2, 4, 8, 16} {
		best := 0.0
		for i := range 3 {
			if ms := one(w, false).ElapsedMs; i == 0 || ms < best {
				best = ms
			}
		}
		res.CompareByWalkers[fmt.Sprint(w)] = best
		fmt.Fprintf(os.Stderr, "compare with %d readers: %.0f ms\n", w, best)
	}
	for range min(*runs, 3) {
		run := one(0, true)
		res.CompareContent = append(res.CompareContent, run)
		fmt.Fprintf(os.Stderr, "compare with contents: %.0f ms\n", run.ElapsedMs)
	}

	// Hashing: one large file, warm cache, against the OS's tool.
	hashFile := filepath.Join(root, "hash.bin")
	tool, toolArgs := osHashTool()
	res.OSHashTool = tool
	_, _ = checksum.File(ctx, hashFile, checksum.CRC32, nil) // warm the cache
	for _, algo := range []checksum.Algo{checksum.SHA256, checksum.SHA1, checksum.MD5, checksum.CRC32} {
		var h hashRun
		for range *runs {
			start := time.Now()
			_, err := checksum.File(ctx, hashFile, algo, nil)
			check(err)
			h.OursMs = append(h.OursMs, msSince(start))
			if args := toolArgs(algo, hashFile); args != nil {
				start = time.Now()
				if outp, err := exec.Command(tool, args...).CombinedOutput(); err != nil {
					check(fmt.Errorf("%s: %v: %s", tool, err, outp))
				}
				h.OSToolMs = append(h.OSToolMs, msSince(start))
			}
		}
		mbs := func(ms float64) float64 { return float64(*hashBytes) / (1 << 20) / (ms / 1000) }
		h.OursMBs = mbs(best(h.OursMs))
		if len(h.OSToolMs) > 0 {
			h.OSMBs = mbs(best(h.OSToolMs))
			h.Ratio = best(h.OSToolMs) / best(h.OursMs)
		}
		res.Hash[string(algo)] = h
		fmt.Fprintf(os.Stderr, "%s: ours %.0f MB/s, tool %.0f MB/s (ratio %.2f)\n", algo, h.OursMBs, h.OSMBs, h.Ratio)
	}

	// Text diff: compare, then one page of rows from the middle.
	ta, tb := filepath.Join(root, "text-a.txt"), filepath.Join(root, "text-b.txt")
	for range *runs {
		start := time.Now()
		d, err := textdiff.Open(ctx, ta, tb)
		check(err)
		open := msSince(start)
		in := d.Info()
		// Pages spread over the view; the clock is too coarse for one.
		const pages = 200
		start = time.Now()
		for k := range pages {
			_, err = d.Page(in.Rows/pages*k, 200)
			check(err)
		}
		page := msSince(start) / pages
		res.TextLines = in.Left.Lines
		res.TextDiff = append(res.TextDiff, diffRun{OpenMs: open, PageMs: page, Rows: in.Rows, Changes: in.Changes})
		fmt.Fprintf(os.Stderr, "text diff: %.0f ms, %d rows, %d changes; a page of 200 rows %.3f ms\n", open, in.Rows, in.Changes, page)
	}

	bts, _ := json.MarshalIndent(res, "", "  ")
	if *out == "" {
		fmt.Println(string(bts))
		return
	}
	check(os.MkdirAll(filepath.Dir(*out), 0o755))
	check(os.WriteFile(*out, append(bts, '\n'), 0o644))
	fmt.Fprintln(os.Stderr, "wrote", *out)
}

// osHashTool is the system's own checksum tool and its arguments per
// algorithm (nil where it has none): certutil on Windows, shasum and md5 on
// macOS, the coreutils elsewhere.
func osHashTool() (string, func(checksum.Algo, string) []string) {
	switch runtime.GOOS {
	case "windows":
		tool := filepath.Join(os.Getenv("SystemRoot"), "System32", "certutil.exe")
		return tool, func(a checksum.Algo, file string) []string {
			if a == checksum.CRC32 {
				return nil
			}
			return []string{"-hashfile", file, strings.ToUpper(string(a))}
		}
	case "darwin":
		return "/usr/bin/shasum", func(a checksum.Algo, file string) []string {
			switch a {
			case checksum.SHA256:
				return []string{"-a", "256", file}
			case checksum.SHA1:
				return []string{"-a", "1", file}
			}
			return nil
		}
	}
	return "/usr/bin/env", func(a checksum.Algo, file string) []string {
		switch a {
		case checksum.SHA256:
			return []string{"sha256sum", file}
		case checksum.SHA1:
			return []string{"sha1sum", file}
		case checksum.MD5:
			return []string{"md5sum", file}
		}
		return nil
	}
}

func best(ms []float64) float64 {
	b := ms[0]
	for _, v := range ms {
		b = min(b, v)
	}
	return b
}

func msSince(t time.Time) float64 { return float64(time.Since(t).Microseconds()) / 1000 }

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
