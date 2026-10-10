package archive

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
)

// entry is one listed entry, kept compact: an open archive costs about 100
// bytes per entry (ADR-0030, docs/commander/PERFORMANCE.md).
type entry struct {
	path    string // clean inner path
	size    int64  // files: uncompressed size; folders: the size of their files
	mtimeNs int64
	parent  int32 // index of the parent folder; -1 for the root
	kind    Kind
}

// Listing is an archive's entries, read once per open archive. It is never
// changed after Read returns, so it is shared without locks.
type Listing struct {
	Path   string
	Format Format
	// Size and MtimeNs identify the archive file that was read.
	Size    int64
	MtimeNs int64
	entries []entry
	// children of the root (key -1) and of each folder, in stored order.
	children map[int32][]int32
	// Rejected counts entries with unsafe names (never listed or extracted).
	Rejected int
	// Bytes is the expanded size of all files; Packed the archive's size.
	Bytes  int64
	Packed int64
}

// Len is the number of listed entries (synthesized folders included).
func (l *Listing) Len() int { return len(l.entries) }

// Read lists an archive. tool runs 7-Zip for the formats it handles.
func Read(ctx context.Context, path string, format Format, tool *Tool) (*Listing, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	l := &Listing{Path: path, Format: format, Size: fi.Size(), MtimeNs: fi.ModTime().UnixNano(),
		Packed: fi.Size(), children: map[int32][]int32{}}
	b := builder{l: l, dirs: map[string]int32{}}
	add := func(h *Header, _ io.Reader) error {
		if h.Unsafe != "" {
			l.Rejected++
			return nil
		}
		if h.Kind == KindSpecial {
			return nil
		}
		return b.add(h)
	}
	if format == Format7z {
		if !tool.Available() {
			return nil, ErrNoTool
		}
		err = tool.list(ctx, path, add)
	} else {
		var r reader
		if r, err = openReader(path, format, nil); err != nil {
			return nil, err
		}
		err = r.walk(ctx, nil, add)
		_ = r.close()
	}
	if err != nil {
		return nil, err
	}
	b.sizes()
	return l, nil
}

type builder struct {
	l    *Listing
	dirs map[string]int32 // folder path → index
	// files maps file paths to their index, for archives storing a name twice
	// (the later one wins, as when extracting in order).
	files map[string]int32
}

// dir returns the index of a folder, creating it (and its parents) when the
// archive lists files without their folders.
func (b *builder) dir(p string) (int32, error) {
	if p == "" {
		return -1, nil
	}
	if i, ok := b.dirs[p]; ok {
		return i, nil
	}
	parent, err := b.dir(parentOf(p))
	if err != nil {
		return 0, err
	}
	return b.push(entry{path: p, parent: parent, kind: KindDir})
}

func (b *builder) push(e entry) (int32, error) {
	l := b.l
	if len(l.entries) >= MaxEntries {
		return 0, fmt.Errorf("%w: more than %d entries", ErrTooLarge, MaxEntries)
	}
	i := int32(len(l.entries))
	l.entries = append(l.entries, e)
	l.children[e.parent] = append(l.children[e.parent], i)
	if e.kind == KindDir {
		b.dirs[e.path] = i
	}
	return i, nil
}

func (b *builder) add(h *Header) error {
	if h.Kind == KindDir {
		i, err := b.dir(h.Path)
		if err == nil && h.MtimeNs != 0 {
			b.l.entries[i].mtimeNs = h.MtimeNs
		}
		return err
	}
	if _, isDir := b.dirs[h.Path]; isDir {
		return nil // a file named like a folder: the folder wins
	}
	if b.files == nil {
		b.files = map[string]int32{}
	}
	if i, ok := b.files[h.Path]; ok {
		e := &b.l.entries[i]
		e.size, e.mtimeNs, e.kind = h.Size, h.MtimeNs, h.Kind
		return nil
	}
	parent, err := b.dir(parentOf(h.Path))
	if err != nil {
		return err
	}
	i, err := b.push(entry{path: h.Path, size: h.Size, mtimeNs: h.MtimeNs, parent: parent, kind: h.Kind})
	if err == nil {
		b.files[h.Path] = i
	}
	return err
}

// sizes adds each file's size to its folders, and totals the archive.
func (b *builder) sizes() {
	es := b.l.entries
	for i := range es {
		if es[i].kind != KindFile {
			continue
		}
		b.l.Bytes += es[i].size
		for p := es[i].parent; p >= 0; p = es[p].parent {
			es[p].size += es[i].size
		}
	}
	b.files = nil
}

// Entry is an exported view of one listed entry.
type Entry struct {
	Index   int
	Path    string
	Name    string
	Kind    Kind
	Size    int64
	MtimeNs int64
}

// Entry returns entry i.
func (l *Listing) Entry(i int) Entry {
	e := &l.entries[i]
	return Entry{Index: i, Path: e.path, Name: baseName(e.path), Kind: e.kind, Size: e.size, MtimeNs: e.mtimeNs}
}

// Children returns the entries of a folder (-1 = the root), stored order.
func (l *Listing) Children(dir int) []int32 { return l.children[int32(dir)] }

// Parent is the folder holding entry i (-1 for the root).
func (l *Listing) Parent(i int) int { return int(l.entries[i].parent) }

// Find returns the index of a clean inner path, or -1.
func (l *Listing) Find(p string) int {
	dir := int32(-1)
	if p == "" {
		return -1
	}
	parts := strings.Split(p, "/")
	for k, name := range parts {
		found := int32(-1)
		for _, c := range l.children[dir] {
			if baseName(l.entries[c].path) == name {
				found = c
				break
			}
		}
		if found < 0 {
			return -1
		}
		if k == len(parts)-1 {
			return int(found)
		}
		dir = found
	}
	return -1
}

// Changed reports whether the archive file differs from the one listed.
func (l *Listing) Changed() bool {
	fi, err := os.Stat(l.Path)
	return err != nil || fi.Size() != l.Size || fi.ModTime().UnixNano() != l.MtimeNs
}
