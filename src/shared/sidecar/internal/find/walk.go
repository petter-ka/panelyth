package find

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/media"
)

// Options tunes a walk; zero values get defaults.
type Options struct {
	// Walkers list folders concurrently; Readers search file contents.
	Walkers, Readers int
	// ReadChunk is the number of entries read per ReadDir call.
	ReadChunk int
	// FlushInterval bounds how long a found entry waits before Sink sees it;
	// FlushItems caps one batch.
	FlushInterval time.Duration
	FlushItems    int
	// ProgressInterval throttles Progress.
	ProgressInterval time.Duration
}

func (o *Options) defaults() {
	if o.Walkers <= 0 {
		o.Walkers = 4
	}
	if o.Readers <= 0 {
		o.Readers = 4
	}
	if o.ReadChunk <= 0 {
		o.ReadChunk = 512
	}
	if o.FlushInterval <= 0 {
		o.FlushInterval = 40 * time.Millisecond
	}
	if o.FlushItems <= 0 {
		o.FlushItems = 500
	}
	if o.ProgressInterval <= 0 {
		o.ProgressInterval = 100 * time.Millisecond
	}
}

// Counters are a walk's running totals.
type Counters struct {
	Dirs     int    `json:"dirs"`
	Entries  int    `json:"entries"`
	Searched int    `json:"searched"`
	Bytes    int64  `json:"bytes"`
	Errors   int    `json:"errors"`
	Current  string `json:"current"`
}

type counters struct {
	dirs, entries, searched, bytes, errors atomic.Int64
	current                                atomic.Pointer[string]
}

func (c *counters) snapshot() Counters {
	out := Counters{Dirs: int(c.dirs.Load()), Entries: int(c.entries.Load()), Searched: int(c.searched.Load()),
		Bytes: c.bytes.Load(), Errors: int(c.errors.Load())}
	if p := c.current.Load(); p != nil {
		out.Current = *p
	}
	return out
}

type dirJob struct {
	path  string
	depth int
}

// Run walks c's roots and passes matches to sink in batches. sink returns
// false to stop the walk (the result limit). progress gets throttled
// counters while running. Run returns the final counters once every worker
// has stopped; ctx cancels it.
func Run(ctx context.Context, c *Compiled, opts Options, sink func([]index.Found) bool, progress func(Counters)) Counters {
	opts.defaults()
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	var cnt counters

	jobs := make(chan dirJob)
	subdirs := make(chan []dirJob, opts.Walkers)
	hits := make(chan []index.Found, 16)
	cands := make(chan index.Found, 256)

	var walkWG, readWG sync.WaitGroup
	for range opts.Walkers {
		walkWG.Go(func() {
			for j := range jobs {
				subs := listDir(ctx, c, j, opts.ReadChunk, &cnt, hits, cands)
				subdirs <- subs
			}
		})
	}
	if c.content != nil {
		for range opts.Readers {
			readWG.Go(func() { readContent(ctx, c, cands, hits, &cnt) })
		}
	}

	collected := make(chan struct{})
	go func() {
		defer close(collected)
		collect(opts, hits, sink, stop)
	}()

	frontier := make([]dirJob, 0, len(c.roots))
	for i := len(c.roots) - 1; i >= 0; i-- {
		frontier = append(frontier, dirJob{path: c.roots[i]})
	}
	pending := 0
	tick := time.NewTicker(opts.ProgressInterval)
	defer tick.Stop()
loop:
	for len(frontier) > 0 || pending > 0 {
		var send chan dirJob
		var next dirJob
		if len(frontier) > 0 {
			send, next = jobs, frontier[len(frontier)-1] // depth-first keeps the frontier small
		}
		select {
		case send <- next:
			frontier = frontier[:len(frontier)-1]
			pending++
		case subs := <-subdirs:
			pending--
			for i := len(subs) - 1; i >= 0; i-- {
				frontier = append(frontier, subs[i])
			}
		case <-tick.C:
			if progress != nil {
				progress(cnt.snapshot())
			}
		case <-ctx.Done():
			break loop
		}
	}

	// Drain subfolder reports so walkers blocked on them can finish.
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		for range subdirs {
		}
	}()
	close(jobs)
	walkWG.Wait()
	close(subdirs)
	<-drained
	close(cands)
	readWG.Wait()
	close(hits)
	<-collected
	return cnt.snapshot()
}

// collect batches hits for sink; after sink refuses, the rest is dropped.
func collect(opts Options, hits <-chan []index.Found, sink func([]index.Found) bool, stop func()) {
	var batch []index.Found
	open := true
	flush := func() {
		if len(batch) == 0 {
			return
		}
		if open && !sink(batch) {
			open = false
			stop()
		}
		batch = nil
	}
	t := time.NewTicker(opts.FlushInterval)
	defer t.Stop()
	for {
		select {
		case h, ok := <-hits:
			if !ok {
				flush()
				return
			}
			if !open {
				continue
			}
			batch = append(batch, h...)
			if len(batch) >= opts.FlushItems {
				flush()
			}
		case <-t.C:
			flush()
		}
	}
}

// listDir reads one folder: matches go to hits (or to cands for a content
// check), subfolders to be entered are returned.
func listDir(ctx context.Context, c *Compiled, j dirJob, chunk int, cnt *counters,
	hits chan<- []index.Found, cands chan<- index.Found) []dirJob {
	path := j.path
	cnt.current.Store(&path)
	f, err := os.Open(j.path)
	if err != nil {
		cnt.errors.Add(1)
		return nil
	}
	defer f.Close()
	cnt.dirs.Add(1)
	enter := c.Depth < 0 || j.depth < c.Depth
	var subs []dirJob
	var fold []rune
	for {
		if ctx.Err() != nil {
			return nil
		}
		ents, rerr := f.ReadDir(chunk)
		var found []index.Found
		for _, e := range ents {
			name := e.Name()
			info, err := fsx.EntryInfo(f, e)
			if err != nil {
				continue // vanished between read and stat
			}
			attrs := fsx.AttrsOf(name, info)
			if !c.Hidden && attrs&(fsx.AttrHidden|fsx.AttrSystem) != 0 {
				continue
			}
			link := fsx.IsLink(e)
			isDir := e.IsDir() && !link
			fold = foldRunes(name, fold)
			if isDir && c.skipDir(fold) {
				continue
			}
			if isDir && enter {
				subs = append(subs, dirJob{path: fsx.JoinName(j.path, name), depth: j.depth + 1})
			}
			if isDir && !c.folders {
				continue
			}
			if !c.matchName(fold) {
				continue
			}
			size := int64(0)
			if !isDir {
				size = info.Size()
			}
			mtime := info.ModTime().UnixNano()
			if !c.matchMeta(isDir, size, mtime, attrs) {
				continue
			}
			hit := index.Found{Dir: j.path, Name: name, Size: size, MtimeNs: mtime,
				BtimeNs: fsx.FileTimes(info).BirthNs, Attrs: attrs, Kind: media.KindDir}
			switch {
			case link:
				hit.Kind, hit.Ext = media.KindLink, media.Ext(name)
			case !isDir:
				var ok bool
				if hit.Kind, hit.Ext, ok = media.Classify(name); !ok {
					hit.Kind = media.KindFile
				}
			}
			if c.content == nil {
				found = append(found, hit)
				continue
			}
			if link || !info.Mode().IsRegular() {
				continue // content is read from regular files only
			}
			select {
			case cands <- hit:
			case <-ctx.Done():
				return nil
			}
		}
		cnt.entries.Add(int64(len(ents)))
		if len(found) > 0 {
			select {
			case hits <- found:
			case <-ctx.Done():
				return nil
			}
		}
		if errors.Is(rerr, io.EOF) || (rerr == nil && len(ents) == 0) {
			break
		}
		if rerr != nil {
			cnt.errors.Add(1)
			break
		}
	}
	return subs
}

// readContent checks candidates' contents with one bounded buffer.
func readContent(ctx context.Context, c *Compiled, cands <-chan index.Found, hits chan<- []index.Found, cnt *counters) {
	buf := make([]byte, ChunkSize+c.content.maxLen+2*ctxBytes)
	for h := range cands {
		if ctx.Err() != nil {
			continue // drain
		}
		var read int64
		ok, err := c.content.searchFile(ctx, fsx.JoinName(h.Dir, h.Name), buf, c.SkipBinary, &read)
		cnt.bytes.Add(read)
		cnt.searched.Add(1)
		if err != nil && !errors.Is(err, errBinary) && ctx.Err() == nil {
			cnt.errors.Add(1)
		}
		if ok {
			select {
			case hits <- []index.Found{h}:
			case <-ctx.Done():
			}
		}
	}
}
