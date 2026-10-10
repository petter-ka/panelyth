// Command archivebench measures archives (Stage C07): listing a 100k-entry
// zip (time and memory per entry), extracting a 1 GiB tar.gz and packing 10k
// files, each against the OS's own tar where it exists (bsdtar on Windows
// and macOS, GNU tar on Linux).
//
//	go run ./cmd/archivebench -fixtures <dir> -out result.json
//
// Fixtures are generated once per machine and reused (marker files).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"panelyth/sidecar/internal/archive"
	"panelyth/sidecar/internal/fixture"
)

type listRun struct {
	ElapsedMs     float64 `json:"elapsedMs"`
	BytesPerEntry float64 `json:"bytesPerEntry"`
}

type compared struct {
	Ours   []float64 `json:"oursMs"`
	OSTool []float64 `json:"osToolMs"`
	// MBPerSec of the best run (bytes of content).
	OursMBs   float64 `json:"oursMBPerSec"`
	OSToolMBs float64 `json:"osToolMBPerSec"`
	// Ratio is the best OS run over the best of ours (> 1: faster than the tool).
	Ratio float64 `json:"ratio"`
}

type result struct {
	Stage      string              `json:"stage"`
	At         string              `json:"at"`
	CPUs       int                 `json:"numCpu"`
	OSTool     string              `json:"osTool"`
	ZipEntries int                 `json:"zipEntries"`
	List100k   []listRun           `json:"list100kZip"`
	ListTgzMs  []float64           `json:"listTgzMs"`
	TgzBytes   int64               `json:"tgzContentBytes"`
	Extract    compared            `json:"extractTgz"`
	PackFiles  int                 `json:"packFiles"`
	Pack       map[string]compared `json:"pack"`
}

func main() {
	fixtures := flag.String("fixtures", filepath.Join(os.TempDir(), "panelyth-fixtures"), "fixture root")
	out := flag.String("out", "", "write the JSON result here (default stdout)")
	runs := flag.Int("runs", 3, "runs per measurement")
	tgzBytes := flag.Int64("tgz-bytes", 1<<30, "content of big.tar.gz")
	flag.Parse()

	root := filepath.Join(*fixtures, "archives-c07")
	spec := fixture.ArchiveSpec{ZipEntries: 100_000, TgzBytes: *tgzBytes, PackFiles: 10_000}
	fmt.Fprintln(os.Stderr, "fixtures:", root)
	check(fixture.GenerateArchives(root, spec))
	tool := osTar()
	res := result{Stage: "C07", At: time.Now().Format(time.RFC3339), CPUs: runtime.NumCPU(), OSTool: tool,
		ZipEntries: spec.ZipEntries, TgzBytes: spec.TgzBytes, PackFiles: spec.PackFiles, Pack: map[string]compared{}}
	ctx := context.Background()

	zipPath := filepath.Join(root, "many.zip")
	for range *runs {
		var before, after runtime.MemStats
		runtime.GC()
		runtime.ReadMemStats(&before)
		start := time.Now()
		l, err := archive.Read(ctx, zipPath, archive.FormatZip, nil)
		ms := msSince(start)
		check(err)
		runtime.GC()
		runtime.ReadMemStats(&after)
		per := float64(int64(after.HeapAlloc)-int64(before.HeapAlloc)) / float64(l.Len())
		runtime.KeepAlive(l)
		res.List100k = append(res.List100k, listRun{ElapsedMs: ms, BytesPerEntry: per})
		fmt.Fprintf(os.Stderr, "list 100k zip: %.0f ms, %.0f B/entry\n", ms, per)
	}

	tgz := filepath.Join(root, "big.tar.gz")
	for range *runs {
		start := time.Now()
		_, err := archive.Read(ctx, tgz, archive.FormatTgz, nil)
		check(err)
		res.ListTgzMs = append(res.ListTgzMs, msSince(start))
	}
	fmt.Fprintf(os.Stderr, "list tgz: %v ms\n", res.ListTgzMs)

	scratch := filepath.Join(*fixtures, "archives-c07-out")
	res.Extract = compare(*runs, spec.TgzBytes, scratch,
		func(dir string) error {
			return archive.Extract(ctx, tgz, archive.FormatTgz, nil, nil, &archive.ExtractOptions{Dest: dir})
		},
		toolRun(tool, func(dir string) []string { return []string{"-xzf", tgz, "-C", dir} }, ""))
	fmt.Fprintf(os.Stderr, "extract tgz: ours %v, tool %v (ratio %.2f)\n", res.Extract.Ours, res.Extract.OSTool, res.Extract.Ratio)

	pack := filepath.Join(root, "pack")
	packBytes := treeBytes(pack)
	for _, c := range []struct {
		format archive.Format
		name   string
		args   func(target string) []string
	}{
		{archive.FormatZip, "pack.zip", func(t string) []string { return []string{"-a", "-cf", t, "pack"} }},
		{archive.FormatTgz, "pack.tar.gz", func(t string) []string { return []string{"-czf", t, "pack"} }},
	} {
		r := compare(*runs, packBytes, scratch,
			func(dir string) error {
				return archive.Pack(ctx, nil, &archive.PackOptions{Format: c.format, Level: 6, Target: filepath.Join(dir, c.name),
					Items: []archive.PackItem{{Path: pack, Name: "pack"}}})
			},
			toolRun(tool, func(dir string) []string { return c.args(filepath.Join(dir, c.name)) }, root))
		if c.format == archive.FormatZip && runtime.GOOS == "linux" {
			r.OSTool, r.OSToolMBs, r.Ratio = nil, 0, 0 // GNU tar writes no zip
		}
		res.Pack[string(c.format)] = r
		fmt.Fprintf(os.Stderr, "pack %s: ours %v, tool %v (ratio %.2f)\n", c.format, r.Ours, r.OSTool, r.Ratio)
	}
	_ = os.RemoveAll(scratch)

	b, _ := json.MarshalIndent(res, "", "  ")
	if *out == "" {
		fmt.Println(string(b))
		return
	}
	check(os.MkdirAll(filepath.Dir(*out), 0o755))
	check(os.WriteFile(*out, append(b, '\n'), 0o644))
	fmt.Fprintln(os.Stderr, "wrote", *out)
}

// compare runs ours and the tool alternately, each into a fresh folder.
func compare(runs int, bytes int64, scratch string, ours func(dir string) error, tool func(dir string) error) compared {
	var c compared
	best := func(ms []float64) float64 {
		b := ms[0]
		for _, v := range ms {
			b = min(b, v)
		}
		return b
	}
	for i := range runs {
		for _, side := range []string{"ours", "tool"} {
			if side == "tool" && tool == nil {
				continue
			}
			dir := filepath.Join(scratch, fmt.Sprintf("%s-%d", side, i))
			_ = os.RemoveAll(dir)
			check(os.MkdirAll(dir, 0o755))
			start := time.Now()
			if side == "ours" {
				check(ours(dir))
				c.Ours = append(c.Ours, msSince(start))
			} else {
				check(tool(dir))
				c.OSTool = append(c.OSTool, msSince(start))
			}
			_ = os.RemoveAll(dir)
		}
	}
	mbs := func(ms float64) float64 { return float64(bytes) / (1 << 20) / (ms / 1000) }
	c.OursMBs = mbs(best(c.Ours))
	if len(c.OSTool) > 0 {
		c.OSToolMBs = mbs(best(c.OSTool))
		c.Ratio = best(c.OSTool) / best(c.Ours)
	}
	return c
}

// osTar is the system's tar: System32's bsdtar on Windows (not a Git or
// MSYS one earlier on PATH), else the first on PATH.
func osTar() string {
	if runtime.GOOS == "windows" {
		p := filepath.Join(os.Getenv("SystemRoot"), "System32", "tar.exe")
		if _, err := os.Stat(p); err == nil {
			return p
		}
		return ""
	}
	p, _ := exec.LookPath("tar")
	return p
}

func toolRun(tool string, args func(dir string) []string, cwd string) func(dir string) error {
	if tool == "" {
		return nil
	}
	return func(dir string) error {
		cmd := exec.Command(tool, args(dir)...)
		cmd.Dir = cwd
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("%s: %v: %s", tool, err, out)
		}
		return nil
	}
}

func treeBytes(root string) int64 {
	var n int64
	_ = filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if fi, err := d.Info(); err == nil {
				n += fi.Size()
			}
		}
		return nil
	})
	return n
}

func msSince(t time.Time) float64 { return float64(time.Since(t).Microseconds()) / 1000 }

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
