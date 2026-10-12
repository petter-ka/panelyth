// Command renamebench measures Stage C09: the multi-rename preview of 10,000
// files (the first one, which resolves the entries and reads the folder,
// and the ones a key press causes), applying and undoing it as jobs, and
// the sizes of a panel of 1,000 folders with batched index writes.
//
//	go run ./cmd/renamebench -fixtures <dir> -out result.json
//
// Fixtures are generated once per machine and reused (a marker file).
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
	"sync"
	"time"

	"panelyth/sidecar/internal/fixture"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/pathkey"
	"panelyth/sidecar/internal/rename"
	"panelyth/sidecar/internal/scan"
)

type previewRun struct {
	// FirstMs: resolving the entries from the index, reading the folder's
	// names and naming the batch (what opening the dialog costs).
	FirstMs float64 `json:"firstMs"`
	// PlainMs and HeavyMs: naming the batch again with a counter mask, and
	// with dates, a regular expression and a case conversion (a key press).
	PlainMs float64 `json:"plainMs"`
	HeavyMs float64 `json:"heavyMs"`
}

type jobRun struct {
	ElapsedMs float64 `json:"elapsedMs"`
	Done      int     `json:"done"`
	Failed    int     `json:"failed"`
	// Notified is how often open listings were told to refresh.
	Notified int `json:"notified"`
}

type sizeRun struct {
	jobRun
	Bytes int64 `json:"bytes"`
}

type result struct {
	Stage   string       `json:"stage"`
	At      string       `json:"at"`
	CPUs    int          `json:"numCpu"`
	Files   int          `json:"files"`
	Preview []previewRun `json:"preview"`
	// Apply renames every file ([Y]-[M]-[D] name counter); Undo takes it back.
	Apply []jobRun `json:"apply"`
	Undo  []jobRun `json:"undo"`
	// Sizes of every folder of a panel: one job.
	Folders     int       `json:"folders"`
	FolderFiles int       `json:"filesPerFolder"`
	Sizes       []sizeRun `json:"sizes"`
	// What batching the index writes is worth for that many folders: one
	// transaction per folder (before Stage C09) against one for all.
	SizeWritesPerFolderMs float64 `json:"sizeWritesPerFolderMs"`
	SizeWritesBatchedMs   float64 `json:"sizeWritesBatchedMs"`
}

func main() {
	fixtures := flag.String("fixtures", filepath.Join(os.TempDir(), "panelyth-fixtures"), "fixture root")
	out := flag.String("out", "", "write the JSON result here (default stdout)")
	runs := flag.Int("runs", 5, "runs per measurement")
	files := flag.Int("files", 10_000, "files to rename")
	folders := flag.Int("folders", 1_000, "folders to size")
	folderFiles := flag.Int("folder-files", 20, "files per folder")
	flag.Parse()

	root := filepath.Join(*fixtures, "rename-c09")
	spec := fixture.RenameSpec{Files: *files, Folders: *folders, FolderFiles: *folderFiles}
	fmt.Fprintln(os.Stderr, "fixtures:", root)
	check(fixture.GenerateRename(root, spec))
	res := result{Stage: "C09", At: time.Now().Format(time.RFC3339), CPUs: runtime.NumCPU(), Files: *files,
		Folders: *folders, FolderFiles: *folderFiles}
	ctx := context.Background()
	log := slog.New(slog.DiscardHandler)

	work, err := os.MkdirTemp("", "panelyth-renamebench")
	check(err)
	defer os.RemoveAll(work)
	store, err := index.Open(filepath.Join(work, "index.db"), log)
	check(err)
	defer store.Close()
	list := func(dir string) (index.DirInfo, []int64) {
		info, err := store.EnsureDir(ctx, dir)
		check(err)
		if st := scan.Run(ctx, store, log, scan.Options{}, scan.Hooks{}, 0, store.NextGeneration(), info, false); st.State != scan.StateCompleted {
			check(fmt.Errorf("scan of %s ended %s", dir, st.State))
		}
		ids, err := store.QueryIDs(ctx, index.Descriptor{DirID: info.ID, Scope: index.ScopeAll, ShowHidden: true,
			Sort: []index.SortKey{{Field: index.SortName}}}, info.Key)
		check(err)
		return info, ids
	}

	var mu sync.Mutex
	notified := 0
	finished := map[int64]chan jobs.Snapshot{}
	m := jobs.NewManager(jobs.Deps{Store: store, Log: log,
		Changed: func([]scan.Change) {
			mu.Lock()
			notified++
			mu.Unlock()
		},
		Emit: func(s jobs.Snapshot) {
			if s.State.Active() {
				return
			}
			mu.Lock()
			ch := finished[s.JobID]
			mu.Unlock()
			if ch != nil {
				ch <- s
			}
		},
	})
	defer m.Close()
	runJob := func(spec jobs.Spec) jobRun {
		mu.Lock()
		notified = 0
		mu.Unlock()
		start := time.Now()
		snap, err := m.Start(spec)
		check(err)
		ch := make(chan jobs.Snapshot, 1)
		mu.Lock()
		finished[snap.JobID] = ch
		mu.Unlock()
		// It may have ended before the channel was there.
		var done jobs.Snapshot
		for done.JobID == 0 {
			select {
			case done = <-ch:
			case <-time.After(5 * time.Millisecond):
				for _, s := range m.List() {
					if s.JobID == snap.JobID && !s.State.Active() {
						done = s
					}
				}
			}
		}
		ms := msSince(start)
		if done.State != jobs.StateCompleted {
			check(fmt.Errorf("%s job ended %s: %s", spec.Kind, done.State, done.Error))
		}
		mu.Lock()
		defer mu.Unlock()
		return jobRun{ElapsedMs: ms, Done: done.Done, Failed: done.Failed, Notified: notified}
	}

	// Preview: what the dialog's first call and every later one cost in Go.
	filesDir := filepath.Join(root, "files")
	_, ids := list(filesDir)
	plain := compile(rename.Spec{NameMask: "Trip [C:5]", ExtMask: "[E]", Start: 1, Step: 1, Digits: 1})
	heavyPlan := rename.Spec{NameMask: "[Y]-[M]-[D] [N5-] [C:5]", ExtMask: "[E]", Search: `^(\d{4})-0*(\d+)`, Replace: "$1.$2",
		Regex: true, Case: rename.CaseWords, Start: 1, Step: 1, Digits: 1}
	heavy := compile(heavyPlan)
	for range *runs {
		start := time.Now()
		entries := make([]rename.Entry, 0, len(ids))
		for lo := 0; lo < len(ids); lo += 1000 {
			targets, err := store.Targets(ctx, ids[lo:min(lo+1000, len(ids))])
			check(err)
			for _, t := range targets {
				entries = append(entries, rename.Entry{Dir: pathkey.DirKey(filepath.Dir(t.Path)),
					Item: rename.Item{Name: t.Name, IsDir: t.Kind == media.KindDir, ModNs: t.MtimeNs}})
			}
		}
		f, err := os.Open(filesDir)
		check(err)
		names, err := f.Readdirnames(-1)
		check(err)
		_ = f.Close()
		taken := make(map[string]struct{}, len(names))
		dirKey := pathkey.DirKey(filesDir)
		for _, n := range names {
			taken[rename.Key(dirKey, n)] = struct{}{}
		}
		exists := func(_ int, name string) bool {
			_, ok := taken[rename.Key(dirKey, name)]
			return ok
		}
		if r := rename.Resolve(plain, entries, exists); r.Renamed != len(ids) {
			check(fmt.Errorf("preview: %d of %d would be renamed", r.Renamed, len(ids)))
		}
		run := previewRun{FirstMs: msSince(start)}
		run.PlainMs = best(5, func() { rename.Resolve(plain, entries, exists) })
		run.HeavyMs = best(5, func() {
			if r := rename.Resolve(heavy, entries, exists); r.Renamed != len(ids) {
				check(fmt.Errorf("heavy preview: %d of %d would be renamed (%d conflicts, %d invalid)", r.Renamed, len(ids), r.Conflicts, r.Invalid))
			}
		})
		res.Preview = append(res.Preview, run)
		fmt.Fprintf(os.Stderr, "preview: first %.1f ms, a key press %.1f ms (plain) / %.1f ms (dates, expression, case)\n",
			run.FirstMs, run.PlainMs, run.HeavyMs)
	}

	// Apply and undo. The files have other names in between: the fixture is
	// not reusable until the undo is through.
	marker, err := os.ReadFile(fixture.RenameMarker(root))
	check(err)
	check(os.Remove(fixture.RenameMarker(root)))
	for range *runs {
		apply := runJob(jobs.Spec{Kind: jobs.KindMultiRename, IDs: ids, Rename: &heavyPlan})
		undo := runJob(jobs.Spec{Kind: jobs.KindUndoRename})
		if apply.Done != len(ids) || undo.Done != len(ids) {
			check(fmt.Errorf("renamed %d and took back %d of %d", apply.Done, undo.Done, len(ids)))
		}
		res.Apply, res.Undo = append(res.Apply, apply), append(res.Undo, undo)
		fmt.Fprintf(os.Stderr, "apply: %.0f ms (%.0f files/s, %d refreshes); undo: %.0f ms\n",
			apply.ElapsedMs, float64(apply.Done)/apply.ElapsedMs*1000, apply.Notified, undo.ElapsedMs)
	}
	check(os.WriteFile(fixture.RenameMarker(root), marker, 0o644))

	// Folder sizes for a panel of folders.
	_, dirIDs := list(filepath.Join(root, "folders"))
	for range *runs {
		run := runJob(jobs.Spec{Kind: jobs.KindDirSize, IDs: dirIDs})
		items, err := store.LoadItems(ctx, dirIDs)
		check(err)
		var bytes int64
		for _, it := range items {
			bytes += it.DirSize
		}
		res.Sizes = append(res.Sizes, sizeRun{jobRun: run, Bytes: bytes})
		fmt.Fprintf(os.Stderr, "sizes of %d folders: %.0f ms, %d refreshes, %d bytes\n", run.Done, run.ElapsedMs, run.Notified, bytes)
	}
	sizes := make([]index.DirSize, len(dirIDs))
	for i, id := range dirIDs {
		sizes[i] = index.DirSize{ID: id, Bytes: int64(*folderFiles) * 1024}
	}
	res.SizeWritesPerFolderMs = best(3, func() {
		for _, s := range sizes {
			check(store.SetDirSizes(ctx, []index.DirSize{s}))
		}
	})
	res.SizeWritesBatchedMs = best(3, func() { check(store.SetDirSizes(ctx, sizes)) })
	fmt.Fprintf(os.Stderr, "index writes for %d folders: %.1f ms one by one, %.1f ms in one transaction\n",
		len(sizes), res.SizeWritesPerFolderMs, res.SizeWritesBatchedMs)

	b, _ := json.MarshalIndent(res, "", "  ")
	if *out == "" {
		fmt.Println(string(b))
		return
	}
	check(os.MkdirAll(filepath.Dir(*out), 0o755))
	check(os.WriteFile(*out, append(b, '\n'), 0o644))
	fmt.Fprintln(os.Stderr, "wrote", *out)
}

func compile(s rename.Spec) *rename.Plan {
	p, err := rename.Compile(s)
	check(err)
	return p
}

// best is the fastest of n runs of fn, in milliseconds.
func best(n int, fn func()) float64 {
	out := 0.0
	for i := range n {
		start := time.Now()
		fn()
		if ms := msSince(start); i == 0 || ms < out {
			out = ms
		}
	}
	return out
}

func msSince(t time.Time) float64 { return float64(time.Since(t).Microseconds()) / 1000 }

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "renamebench:", err)
		os.Exit(1)
	}
}
