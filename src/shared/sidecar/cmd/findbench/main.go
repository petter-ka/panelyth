// Command findbench measures find files (Stage C06): find by name over
// tree-500k (first result, entries per second), content search against a
// plain sequential read of the same files, cancel latency and memory.
//
//	go run ./cmd/findbench -fixtures <dir> -out result.json
//
// Fixtures are generated once per machine and reused (marker files).
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"runtime/metrics"
	"sync"
	"sync/atomic"
	"time"

	"panelyth/sidecar/internal/find"
	"panelyth/sidecar/internal/fixture"
	"panelyth/sidecar/internal/index"
)

type nameRun struct {
	Mask          string  `json:"mask"`
	Matches       int     `json:"matches"`
	Entries       int     `json:"entries"`
	Dirs          int     `json:"dirs"`
	FirstResultMs int64   `json:"firstResultMs"`
	ElapsedMs     float64 `json:"elapsedMs"`
	EntriesPerSec float64 `json:"entriesPerSec"`
}

type contentRun struct {
	Text          string  `json:"text"`
	Encodings     int     `json:"patterns"`
	CaseSensitive bool    `json:"caseSensitive"`
	Files         int     `json:"files"`
	Bytes         int64   `json:"bytes"`
	ElapsedMs     float64 `json:"elapsedMs"`
	MBPerSec      float64 `json:"mbPerSec"`
	ShareOfSeq    float64 `json:"shareOfSequentialRead"`
	HeapPeakMB    float64 `json:"heapPeakMB"`
}

type result struct {
	Stage       string       `json:"stage"`
	At          string       `json:"at"`
	CPUs        int          `json:"numCpu"`
	Tree        string       `json:"tree"`
	TreeEntries int          `json:"treeEntries"`
	ByName      []nameRun    `json:"byName"`
	SeqReadMBs  []float64    `json:"sequentialReadMBPerSec"`
	Content     []contentRun `json:"content"`
	CancelMs    []float64    `json:"cancelMs"`
}

func main() {
	fixtures := flag.String("fixtures", filepath.Join(os.TempDir(), "panelyth-fixtures"), "fixture root")
	out := flag.String("out", "", "write the JSON result here (default stdout)")
	runs := flag.Int("runs", 3, "runs per measurement")
	only := flag.String("only", "", "run one part: name, content or cancel")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))

	tree := filepath.Join(*fixtures, "tree-500k")
	// 2,801 folders x 180 files = 504,180 files (every 10th a .txt).
	exp, err := fixture.Generate(tree, fixture.Spec{Files: 180, Depth: 4, Fanout: 7, NonMediaEvery: 10})
	check(err)
	content := filepath.Join(*fixtures, "content-1g")
	check(genContent(content, 256, 4<<20))

	res := result{Stage: "C06", At: time.Now().Format(time.RFC3339), CPUs: runtime.NumCPU(), Tree: tree,
		TreeEntries: exp.Dirs + exp.Media + exp.NonMedia + exp.Hidden}

	want := func(part string) bool { return *only == "" || *only == part }
	for _, mask := range []string{"IMG_177.*", "*.gif", "nothing-matches-*"} {
		for range *runs * boolInt(want("name")) {
			res.ByName = append(res.ByName, byName(log, tree, mask))
		}
	}
	seq := 0.0
	for range *runs * boolInt(want("content")) {
		mbs := seqRead(content)
		res.SeqReadMBs = append(res.SeqReadMBs, mbs)
		seq = max(seq, mbs)
	}
	for _, c := range []struct {
		text  string
		encs  []string
		cases bool
	}{
		{"zebra-quokka", nil, false},
		{"zebra-quokka", []string{find.EncodingUTF8}, true},
	} {
		for range *runs * boolInt(want("content")) {
			r := byContent(log, content, c.text, c.encs, c.cases)
			r.ShareOfSeq = r.MBPerSec / seq
			res.Content = append(res.Content, r)
		}
	}
	for range *runs * boolInt(want("cancel")) {
		res.CancelMs = append(res.CancelMs, cancelLatency(log, tree))
	}

	b, err := json.MarshalIndent(res, "", "  ")
	check(err)
	if *out == "" {
		fmt.Println(string(b))
		return
	}
	check(os.WriteFile(*out, append(b, '\n'), 0o644))
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func newStore(log *slog.Logger) (*index.Store, func()) {
	dir, err := os.MkdirTemp("", "findbench-*")
	check(err)
	st, err := index.Open(filepath.Join(dir, "index.db"), log)
	check(err)
	return st, func() { _ = st.Close(); _ = os.RemoveAll(dir) }
}

// start runs one search through the manager, as find.start does.
func start(log *slog.Logger, root string, spec find.Spec, onProgress func(find.Progress)) (*find.Manager, int64, func()) {
	st, done := newStore(log)
	_, err := st.EnsureDir(context.Background(), root)
	check(err)
	m := find.NewManager(find.Deps{Store: st, Log: log, Progress: onProgress})
	spec.Roots = []string{root}
	c, err := find.Compile(spec)
	check(err)
	id, _, err := m.Start(c, nil)
	check(err)
	return m, id, func() { m.Close(); done() }
}

func byName(log *slog.Logger, tree, mask string) nameRun {
	var final find.Progress
	t := time.Now()
	m, id, done := start(log, tree, find.Spec{Mask: mask, Depth: -1, MinSize: -1, MaxSize: -1}, func(p find.Progress) {
		if p.State != find.StateRunning {
			final = p
		}
	})
	m.Wait(id)
	el := time.Since(t)
	done()
	return nameRun{Mask: mask, Matches: final.Matches, Entries: final.Entries, Dirs: final.Dirs,
		FirstResultMs: final.FirstMatchMs, ElapsedMs: ms(el), EntriesPerSec: float64(final.Entries) / el.Seconds()}
}

func byContent(log *slog.Logger, root, text string, encs []string, caseSensitive bool) contentRun {
	var final find.Progress
	stopSampling := sampleHeap()
	t := time.Now()
	m, id, done := start(log, root, find.Spec{Mask: "*.log", Depth: -1, MinSize: -1, MaxSize: -1, Text: text,
		Encodings: encs, CaseSensitive: caseSensitive, SkipBinary: true}, func(p find.Progress) {
		if p.State != find.StateRunning {
			final = p
		}
	})
	m.Wait(id)
	el := time.Since(t)
	peak := stopSampling()
	done()
	n := len(encs)
	if n == 0 {
		n = len(find.DefaultEncodings)
	}
	return contentRun{Text: text, Encodings: n, CaseSensitive: caseSensitive, Files: final.Searched, Bytes: final.Bytes,
		ElapsedMs: ms(el), MBPerSec: float64(final.Bytes) / (1 << 20) / el.Seconds(), HeapPeakMB: peak}
}

// cancelLatency starts a content search over the 500k small files of the
// tree (seconds of work), cancels it after 150 ms and measures the time to
// the final state.
func cancelLatency(log *slog.Logger, root string) float64 {
	stopped := make(chan time.Time, 1)
	m, id, done := start(log, root, find.Spec{Mask: "*", Depth: -1, MinSize: -1, MaxSize: -1, Text: "never-there-xyz"},
		func(p find.Progress) {
			if p.State != find.StateRunning {
				if p.State != find.StateCancelled {
					check(fmt.Errorf("cancel benchmark: the search ended %s before the cancel", p.State))
				}
				stopped <- time.Now()
			}
		})
	defer done()
	time.Sleep(150 * time.Millisecond)
	t := time.Now()
	if !m.Cancel(id) {
		check(fmt.Errorf("cancel benchmark: the search was not running"))
	}
	// Windows' clock ticks are coarse: 0 means within one tick.
	return ms((<-stopped).Sub(t))
}

// seqRead reads every file once, one after the other, with a 1 MiB buffer:
// the speed a single sequential reader gets from this disk and cache.
func seqRead(root string) float64 {
	entries, err := os.ReadDir(root)
	check(err)
	buf := make([]byte, 1<<20)
	var total int64
	t := time.Now()
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".log" {
			continue
		}
		f, err := os.Open(filepath.Join(root, e.Name()))
		check(err)
		for {
			n, err := f.Read(buf)
			total += int64(n)
			if err == io.EOF {
				break
			}
			check(err)
		}
		_ = f.Close()
	}
	return float64(total) / (1 << 20) / time.Since(t).Seconds()
}

func sampleHeap() func() float64 {
	var peak atomic.Uint64
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Go(func() {
		s := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
		for {
			metrics.Read(s)
			if v := s[0].Value.Uint64(); v > peak.Load() {
				peak.Store(v)
			}
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Millisecond):
			}
		}
	})
	return func() float64 {
		close(stop)
		wg.Wait()
		return float64(peak.Load()) / (1 << 20)
	}
}

// genContent writes count text files of size bytes (numbered log lines).
func genContent(root string, count int, size int64) error {
	marker := filepath.Join(root, ".panelyth-fixture")
	want := fmt.Sprintf("content %d x %d", count, size)
	if b, err := os.ReadFile(marker); err == nil && string(b) == want {
		return nil
	}
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	for i := range count {
		f, err := os.Create(filepath.Join(root, fmt.Sprintf("part-%04d.log", i)))
		if err != nil {
			return err
		}
		w := bufio.NewWriterSize(f, 1<<20)
		var n int64
		for line := 0; n < size; line++ {
			k, _ := fmt.Fprintf(w, "%08d 2026-10-07T12:00:00Z INFO request served path=/api/items/%d status=200 bytes=%d\n", line, line%977, line*31%65536)
			n += int64(k)
		}
		if err := w.Flush(); err != nil {
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
	}
	return os.WriteFile(marker, []byte(want), 0o644)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
