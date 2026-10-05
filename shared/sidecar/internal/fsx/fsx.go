// Package fsx holds the small filesystem helpers the sidebar and properties
// need: platform file times, volumes, lazy subfolder listing and breadcrumbs.
// Nothing here walks recursively.
package fsx

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"fastview/sidecar/internal/natsort"
)

// Crumb is one breadcrumb segment, root first.
type Crumb struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// Crumbs splits a cleaned absolute path into its ancestors, root first. The
// renderer never parses OS paths; it gets these.
func Crumbs(clean string) []Crumb {
	var out []Crumb
	for p := clean; ; {
		parent := filepath.Dir(p)
		if parent == p {
			out = append(out, Crumb{Name: rootName(p), Path: p})
			break
		}
		out = append(out, Crumb{Name: filepath.Base(p), Path: p})
		p = parent
	}
	slices.Reverse(out)
	return out
}

// rootName is "C:" for "C:\", "\\server\share" for a UNC root and "/" on Unix.
func rootName(root string) string {
	if v := filepath.VolumeName(root); v != "" {
		return v
	}
	return root
}

// DirChild is one immediate subfolder.
type DirChild struct {
	Name string `json:"name"`
	Path string `json:"path"`
	// HasChildren is false only when the probe proved the folder has no
	// visible subfolders; unprobed or partially probed folders report true.
	HasChildren bool `json:"hasChildren"`
}

// ListOptions bound ListDirs; zero values get defaults.
type ListOptions struct {
	MaxEntries int // children returned (default 20000)
	// ProbeBudget is how many children get a has-subfolders probe
	// (default 512); the rest report HasChildren = true.
	ProbeBudget int
	// ProbeReads bounds the entries one probe reads (default 256).
	ProbeReads     int
	ProbeWorkers   int // default 8
	readDirChunk   int
	probeReadChunk int
}

func (o *ListOptions) defaults() {
	if o.MaxEntries <= 0 {
		o.MaxEntries = 20000
	}
	if o.ProbeBudget <= 0 {
		o.ProbeBudget = 512
	}
	if o.ProbeReads <= 0 {
		o.ProbeReads = 256
	}
	if o.ProbeWorkers <= 0 {
		o.ProbeWorkers = 8
	}
	o.readDirChunk = 512
	o.probeReadChunk = 64
}

// ListDirs returns the visible immediate subfolders of dir in natural order.
// Hidden folders and symlinks are skipped (same rules as the scanner).
// truncated reports that MaxEntries cut the listing.
func ListDirs(ctx context.Context, dir string, opts ListOptions) (children []DirChild, truncated bool, err error) {
	opts.defaults()
	f, err := os.Open(dir)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	for {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		ents, rerr := f.ReadDir(opts.readDirChunk)
		for _, e := range ents {
			if !e.IsDir() || e.Type()&fs.ModeSymlink != 0 || IsHidden(e) {
				continue
			}
			if len(children) == opts.MaxEntries {
				truncated = true
				break
			}
			children = append(children, DirChild{Name: e.Name(), Path: filepath.Join(dir, e.Name()), HasChildren: true})
		}
		if truncated || errors.Is(rerr, io.EOF) || (rerr == nil && len(ents) == 0) {
			break
		}
		if rerr != nil {
			return nil, false, rerr
		}
	}
	keys := make(map[string]string, len(children))
	for _, c := range children {
		keys[c.Name] = natsort.Key(c.Name)
	}
	slices.SortFunc(children, func(a, b DirChild) int {
		if c := strings.Compare(keys[a.Name], keys[b.Name]); c != 0 {
			return c
		}
		return strings.Compare(a.Name, b.Name)
	})
	probeAll(ctx, children[:min(len(children), opts.ProbeBudget)], opts)
	return children, truncated, ctx.Err()
}

// probeAll runs bounded-concurrency probes over children in place.
func probeAll(ctx context.Context, children []DirChild, opts ListOptions) {
	next := make(chan int)
	var wg sync.WaitGroup
	for range min(opts.ProbeWorkers, len(children)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				children[i].HasChildren = hasSubdir(children[i].Path, opts)
			}
		}()
	}
	for i := range children {
		if ctx.Err() != nil {
			break
		}
		next <- i
	}
	close(next)
	wg.Wait()
}

// hasSubdir reads at most ProbeReads entries; an unreadable folder or an
// exhausted budget answers true so the expander stays available.
func hasSubdir(dir string, opts ListOptions) bool {
	f, err := os.Open(dir)
	if err != nil {
		return errors.Is(err, fs.ErrPermission) // show it; expanding explains the error
	}
	defer f.Close()
	for read := 0; read < opts.ProbeReads; {
		ents, err := f.ReadDir(opts.probeReadChunk)
		for _, e := range ents {
			if e.IsDir() && e.Type()&fs.ModeSymlink == 0 && !IsHidden(e) {
				return true
			}
		}
		read += len(ents)
		if err != nil || len(ents) == 0 {
			return false
		}
	}
	return true
}

// Volume is a mounted drive or filesystem root shown in the sidebar.
type Volume struct {
	Path  string `json:"path"`
	Label string `json:"label"`
	// Kind is fixed, removable, network, optical or other.
	Kind string `json:"kind"`
	// FreeBytes (available to this user) and TotalBytes are read for fixed
	// and removable volumes only; 0 (omitted) means unknown. Network shares
	// are skipped: a disconnected one can stall for seconds.
	FreeBytes  int64 `json:"freeBytes,omitempty"`
	TotalBytes int64 `json:"totalBytes,omitempty"`
}

// withSpace fills FreeBytes and TotalBytes of local volumes.
func withSpace(vs []Volume) []Volume {
	for i := range vs {
		if vs[i].Kind != "fixed" && vs[i].Kind != "removable" {
			continue
		}
		if free, total, ok := diskSpace(vs[i].Path); ok {
			vs[i].FreeBytes, vs[i].TotalBytes = free, total
		}
	}
	return vs
}

// Times holds the platform file times the index does not store; zero means
// unavailable on this platform.
type Times struct {
	BirthNs  int64
	AccessNs int64
}
