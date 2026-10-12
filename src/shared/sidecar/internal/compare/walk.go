package compare

import (
	"context"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/pathkey"
)

// Counters are a compare's running totals.
type Counters struct {
	// Dirs and Entries were read (both sides together).
	Dirs    int `json:"dirs"`
	Entries int `json:"entries"`
	// Compared files and Bytes were read for the content comparison.
	Compared int   `json:"compared"`
	Bytes    int64 `json:"bytes"`
	// Errors are folders and entries that could not be read; they are left
	// out on both sides. Links are never followed or compared.
	Errors int `json:"errors"`
	Links  int `json:"links"`
}

type counters struct {
	dirs, entries, compared, bytes, errors, links atomic.Int64
}

func (c *counters) snapshot() Counters {
	return Counters{Dirs: int(c.dirs.Load()), Entries: int(c.entries.Load()), Compared: int(c.compared.Load()),
		Bytes: c.bytes.Load(), Errors: int(c.errors.Load()), Links: int(c.links.Load())}
}

// ent is one entry of a folder on one side.
type ent struct {
	name, key   string
	size, mtime int64
	dir         bool
	// bad entries could not be read: they are left out on both sides rather
	// than taken for missing.
	bad bool
}

const readChunk = 512

// readDir lists one folder, sorted by key. Links and special files are
// counted and skipped, like unfinished copies of an interrupted job.
func readDir(ctx context.Context, dir string, cnt *counters) ([]ent, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []ent
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		ents, rerr := f.ReadDir(readChunk)
		for _, e := range ents {
			name := e.Name()
			if fsx.IsLink(e) {
				cnt.links.Add(1)
				continue
			}
			if strings.HasPrefix(name, ".") && strings.HasSuffix(name, fileops.PartialSuffix) {
				continue
			}
			it := ent{name: name, key: pathkey.ChildKey("", name, false), dir: e.IsDir()}
			info, err := fsx.EntryInfo(f, e)
			switch {
			case err != nil:
				it.bad = true
			case !it.dir && !info.Mode().IsRegular():
				cnt.links.Add(1)
				continue
			case !it.dir:
				it.size, it.mtime = info.Size(), info.ModTime().UnixNano()
			default:
				it.mtime = info.ModTime().UnixNano()
			}
			out = append(out, it)
		}
		cnt.entries.Add(int64(len(ents)))
		if errors.Is(rerr, io.EOF) || (rerr == nil && len(ents) == 0) {
			break
		}
		if rerr != nil {
			return nil, rerr
		}
	}
	cnt.dirs.Add(1)
	slices.SortFunc(out, func(a, b ent) int {
		if c := strings.Compare(a.key, b.key); c != 0 {
			return c
		}
		return strings.Compare(a.name, b.name)
	})
	return out, nil
}

// task is a folder to compare: on both sides, or on one (its entries are
// then all one-sided).
type task struct {
	rel  string // "/"-separated; "" = the roots
	l, r bool
}

type taskResult struct {
	rel  string
	rows []row
	subs []task
	err  error
}

// comparePair lists one folder on the sides that have it and merges the two
// listings by name. A folder that cannot be read on a side it exists on is
// left out entirely: its other side must not look one-sided.
func comparePair(ctx context.Context, spec *Spec, t task, cnt *counters) taskResult {
	res := taskResult{rel: t.rel}
	var le, re []ent
	sub := filepath.FromSlash(t.rel)
	if t.l {
		if le, res.err = readDir(ctx, filepath.Join(spec.Left, sub), cnt); res.err != nil {
			cnt.errors.Add(1)
			return res
		}
	}
	if t.r {
		if re, res.err = readDir(ctx, filepath.Join(spec.Right, sub), cnt); res.err != nil {
			cnt.errors.Add(1)
			return res
		}
	}
	one := func(e *ent, left bool) {
		if e.bad {
			cnt.errors.Add(1)
			return
		}
		w := row{name: e.name, state: StateRightOnly, flags: flagRight, rsize: e.size, rmtime: e.mtime}
		if left {
			w = row{name: e.name, state: StateLeftOnly, flags: flagLeft, lsize: e.size, lmtime: e.mtime}
		}
		if e.dir {
			w.flags |= flagDir
			res.subs = append(res.subs, task{rel: path.Join(t.rel, e.name), l: left, r: !left})
		}
		w.def = defaultAction(w.state, spec.Asymmetric)
		w.action = w.def
		res.rows = append(res.rows, w)
	}
	i, j := 0, 0
	for i < len(le) || j < len(re) {
		switch {
		case j >= len(re) || (i < len(le) && le[i].key < re[j].key):
			one(&le[i], true)
			i++
		case i >= len(le) || re[j].key < le[i].key:
			one(&re[j], false)
			j++
		default:
			a, b := &le[i], &re[j]
			i++
			j++
			switch {
			case a.bad || b.bad:
				cnt.errors.Add(1)
			case a.dir && b.dir:
				res.subs = append(res.subs, task{rel: path.Join(t.rel, a.name), l: true, r: true})
			default:
				w := row{name: a.name, flags: flagLeft | flagRight, lsize: a.size, lmtime: a.mtime, rsize: b.size, rmtime: b.mtime}
				if a.dir != b.dir {
					w.state = StateMismatch
				} else {
					w.state = spec.classify(a.size, a.mtime, b.size, b.mtime)
				}
				w.def = defaultAction(w.state, spec.Asymmetric)
				w.action = w.def
				res.rows = append(res.rows, w)
			}
		}
	}
	return res
}

// walk compares the two trees with a bounded number of folder readers and
// fills res. It returns the roots' read error, if any.
func walk(ctx context.Context, spec *Spec, res *Result, cnt *counters, workers int, tick <-chan time.Time, progress func()) error {
	jobs := make(chan task)
	results := make(chan taskResult, workers)
	var wg sync.WaitGroup
	for range workers {
		wg.Go(func() {
			for t := range jobs {
				results <- comparePair(ctx, spec, t, cnt)
			}
		})
	}
	frontier := []task{{l: true, r: true}}
	pending := 0
	var rootErr error
loop:
	for len(frontier) > 0 || pending > 0 {
		var send chan task
		var next task
		if len(frontier) > 0 {
			send, next = jobs, frontier[len(frontier)-1] // depth-first keeps the frontier small
		}
		select {
		case send <- next:
			frontier = frontier[:len(frontier)-1]
			pending++
		case r := <-results:
			pending--
			if r.err != nil {
				if r.rel == "" {
					rootErr = r.err
					break loop
				}
				continue
			}
			if !res.add(r.rel, r.rows) {
				break loop
			}
			frontier = append(frontier, r.subs...)
		case <-tick:
			progress()
		case <-ctx.Done():
			break loop
		}
	}
	// Drain so readers blocked on their results can finish.
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		for range results {
		}
	}()
	close(jobs)
	wg.Wait()
	close(results)
	<-drained
	return rootErr
}

// compareContent reads the files that have the same size on both sides and
// settles their state by their bytes (a few at a time).
func compareContent(ctx context.Context, spec *Spec, res *Result, cnt *counters, readers int) {
	res.mu.RLock()
	var todo []int32
	for _, i := range res.order {
		w := &res.rows[i]
		if w.flags == flagLeft|flagRight && w.state != StateMismatch && w.lsize == w.rsize {
			todo = append(todo, i)
		}
	}
	res.mu.RUnlock()

	next := make(chan int32)
	var wg sync.WaitGroup
	for range readers {
		wg.Go(func() {
			o := &StreamOptions{Progress: func(n int64) { cnt.bytes.Add(n) }}
			for i := range next {
				res.mu.RLock()
				w := res.rows[i]
				rel := filepath.Join(filepath.FromSlash(res.dirs[w.dir]), w.name)
				res.mu.RUnlock()
				equal := true
				if w.lsize > 0 {
					var err error
					equal, _, err = EqualFiles(ctx, filepath.Join(spec.Left, rel), filepath.Join(spec.Right, rel), o)
					if err != nil {
						if ctx.Err() == nil {
							cnt.errors.Add(1)
						}
						continue // the size-and-date state stays
					}
				}
				cnt.compared.Add(1)
				state := StateEqual
				if !equal {
					switch c := spec.cmpTime(w.lmtime, w.rmtime); {
					case c > 0:
						state = StateLeftNewer
					case c < 0:
						state = StateRightNewer
					default:
						state = StateDifferent
					}
				}
				res.mu.Lock()
				p := &res.rows[i]
				p.state = state
				p.def = defaultAction(state, spec.Asymmetric)
				p.action = p.def
				res.mu.Unlock()
			}
		})
	}
feed:
	for _, i := range todo {
		select {
		case next <- i:
		case <-ctx.Done():
			break feed
		}
	}
	close(next)
	wg.Wait()
}
