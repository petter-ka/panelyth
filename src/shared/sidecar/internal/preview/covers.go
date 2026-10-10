package preview

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/imaging"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/natsort"
	"panelyth/sidecar/internal/pathkey"
)

// Folder covers (Stage 08.6, ADR-0024): a folder tile shows up to MaxCovers
// of its media files. The folder is read shallowly and only until enough
// media is found; nothing is indexed and no other file in it gets a preview.
// Cover previews use the normal keys, so opening the folder later reuses them.
const (
	MaxCovers = 4
	// coverScanLimit bounds the directory entries examined per folder, so a
	// folder of 100k non-media files costs one bounded read, not a full listing.
	coverScanLimit = 2048
	coverReadChunk = 256
	// coverDiscoverWorkers bounds concurrent folder reads per request.
	coverDiscoverWorkers = 4
	// coverMemoMax bounds remembered discoveries (dropped wholesale when full).
	coverMemoMax = 2048
	// coverWaitMax bounds pending cover waiters; stale ones (dropped tasks)
	// are forgotten wholesale and re-registered by the next request.
	coverWaitMax = 4096
)

// CoverItem is one finished cover slot sent to the renderer. Mirrors
// src/shared/contracts FolderCoverItem.
type CoverItem struct {
	DirID   int64   `json:"dirId"`
	Slot    int     `json:"slot"`
	Profile Profile `json:"profile"`
	URL     string  `json:"url,omitempty"`
	Width   int     `json:"width,omitempty"`
	Height  int     `json:"height,omitempty"`
	Failed  string  `json:"failed,omitempty"`
}

// CoverSlot is one cover in a CoversRequest answer: a URL, a failure, or
// pending (the result arrives later as a CoverItem).
type CoverSlot struct {
	URL     string `json:"url,omitempty"`
	Width   int    `json:"width,omitempty"`
	Height  int    `json:"height,omitempty"`
	Failed  string `json:"failed,omitempty"`
	Pending bool   `json:"pending,omitempty"`
}

// FolderCover lists a folder's covers; no slots means no media was found
// (or the folder could not be read) and the folder symbol is shown.
type FolderCover struct {
	DirID int64       `json:"dirId"`
	Slots []CoverSlot `json:"slots"`
}

// CoversRequest asks for covers of folder entries.
type CoversRequest struct {
	Lane    string
	Epoch   uint64
	Profile Profile
	Items   []EnsureItem
}

type coverRef struct {
	dir  int64
	slot int
}

type coverMemo struct {
	mtimeNs int64
	sources []index.Source
}

// coverState is the service's folder-cover bookkeeping.
type coverState struct {
	mu   sync.Mutex
	memo map[string]coverMemo // dir path key -> discovered sources
	wait map[Key][]coverRef
	emit func(CoverItem)
}

// SetCoverEmitter receives finished cover slots. Call before the first Covers.
func (s *Service) SetCoverEmitter(emit func(CoverItem)) {
	s.covers.mu.Lock()
	s.covers.emit = emit
	s.covers.mu.Unlock()
}

// Covers answers known covers at once (cache hits, remembered failures,
// folders without media) and schedules the rest on the shared worker pool.
func (s *Service) Covers(ctx context.Context, req CoversRequest) ([]FolderCover, error) {
	edge, ok := req.Profile.MaxEdge()
	if !ok {
		return nil, ErrUnknownProfile
	}
	ids := make([]int64, len(req.Items))
	prio := make(map[int64]Priority, len(req.Items))
	for i, it := range req.Items {
		ids[i] = it.ID
		prio[it.ID] = it.Priority
	}
	paths, err := s.store.EntryPaths(ctx, ids)
	if err != nil {
		return nil, err
	}
	dirs := slices.DeleteFunc(paths, func(p index.EntryPath) bool { return p.Kind != media.KindDir })
	found := make([][]index.Source, len(dirs))
	sem := make(chan struct{}, coverDiscoverWorkers)
	var wg sync.WaitGroup
	for i, d := range dirs {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer func() { <-sem; wg.Done() }()
			found[i] = s.coverSources(ctx, d.Path)
		}()
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	var keys [][]byte
	for _, srcs := range found {
		for _, src := range srcs {
			k := MakeKey(src.PathKey, src.Size, src.MtimeNs, req.Profile)
			keys = append(keys, k[:])
		}
	}
	hits, err := s.store.LookupPreviews(ctx, keys)
	if err != nil {
		return nil, err
	}
	failures, err := s.store.LookupFailures(ctx, keys)
	if err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	out := make([]FolderCover, len(dirs))
	var todo []Request
	var refs []coverRef
	for i, d := range dirs {
		fc := FolderCover{DirID: d.ID, Slots: make([]CoverSlot, len(found[i]))}
		for slot, src := range found[i] {
			k := MakeKey(src.PathKey, src.Size, src.MtimeNs, req.Profile)
			if p, ok := hits[string(k[:])]; ok {
				fc.Slots[slot] = CoverSlot{URL: URL(k, imaging.Format(p.Format)), Width: p.Width, Height: p.Height}
				s.touch(k)
				continue
			}
			if f, ok := failures[string(k[:])]; ok && (f.RetryAfter == 0 || f.RetryAfter > now) {
				fc.Slots[slot] = CoverSlot{Failed: f.Code}
				continue
			}
			fc.Slots[slot] = CoverSlot{Pending: true}
			// EntryID 0: a cover has no index row; results go to cover waiters.
			todo = append(todo, Request{Key: k, Priority: prio[d.ID],
				Payload: &job{src: src, profile: req.Profile, edge: edge}})
			refs = append(refs, coverRef{dir: d.ID, slot: slot})
		}
		out[i] = fc
	}
	s.addCoverWaiters(todo, refs)
	s.sched.Submit(req.Lane, req.Epoch, todo)
	return out, nil
}

func (s *Service) addCoverWaiters(todo []Request, refs []coverRef) {
	if len(todo) == 0 {
		return
	}
	c := &s.covers
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.wait) > coverWaitMax {
		c.wait = nil
	}
	if c.wait == nil {
		c.wait = map[Key][]coverRef{}
	}
	for i, r := range todo {
		if !slices.Contains(c.wait[r.Key], refs[i]) {
			c.wait[r.Key] = append(c.wait[r.Key], refs[i])
		}
	}
}

// publishCovers sends a finished preview to the folders waiting for it.
func (s *Service) publishCovers(key Key, item Item) {
	c := &s.covers
	c.mu.Lock()
	refs, emit := c.wait[key], c.emit
	delete(c.wait, key)
	c.mu.Unlock()
	if emit == nil {
		return
	}
	for _, r := range refs {
		emit(CoverItem{DirID: r.dir, Slot: r.slot, Profile: item.Profile, URL: item.URL,
			Width: item.Width, Height: item.Height, Failed: item.Failed})
	}
}

// coverSources returns the first MaxCovers media files of dir, remembered
// until the folder's modification time changes. Errors mean "no covers".
func (s *Service) coverSources(ctx context.Context, dir string) []index.Source {
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		return nil
	}
	dirKey := pathkey.DirKey(dir)
	mtime := fi.ModTime().UnixNano()
	c := &s.covers
	c.mu.Lock()
	m, ok := c.memo[dirKey]
	c.mu.Unlock()
	if ok && m.mtimeNs == mtime {
		return m.sources
	}
	srcs, err := findCoverSources(ctx, dir, dirKey, s.video.Available())
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			s.log.Debug("folder covers", "err", err)
		}
		return nil
	}
	c.mu.Lock()
	if len(c.memo) >= coverMemoMax || c.memo == nil {
		c.memo = map[string]coverMemo{}
	}
	c.memo[dirKey] = coverMemo{mtimeNs: mtime, sources: srcs}
	c.mu.Unlock()
	return srcs
}

// findCoverSources reads dir in chunks and stops at MaxCovers media files or
// coverScanLimit entries. Hidden entries and links are skipped, as in scans
// (ADR-0015); videos only count when posters can be made.
func findCoverSources(ctx context.Context, dir, dirKey string, videos bool) ([]index.Source, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []index.Source
	seen := 0
	for len(out) < MaxCovers && seen < coverScanLimit {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		ents, readErr := f.ReadDir(coverReadChunk)
		for _, e := range ents {
			seen++
			if e.IsDir() || e.Type()&fs.ModeSymlink != 0 || fsx.IsHidden(e) {
				continue
			}
			kind, ext, ok := media.Classify(e.Name())
			if !ok || (kind == media.KindVideo && !videos) {
				continue
			}
			info, err := e.Info()
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			out = append(out, index.Source{Kind: kind, Ext: ext, Size: info.Size(),
				MtimeNs: info.ModTime().UnixNano(), PathKey: pathkey.ChildKey(dirKey, e.Name(), false),
				Path: filepath.Join(dir, e.Name())})
			if len(out) == MaxCovers {
				break
			}
		}
		if errors.Is(readErr, io.EOF) || len(ents) == 0 {
			break
		}
		if readErr != nil {
			return nil, readErr
		}
	}
	// Stable order regardless of directory order.
	slices.SortFunc(out, func(a, b index.Source) int {
		ka, kb := natsort.Key(a.PathKey), natsort.Key(b.PathKey)
		switch {
		case ka < kb:
			return -1
		case ka > kb:
			return 1
		}
		return 0
	})
	return out, nil
}
