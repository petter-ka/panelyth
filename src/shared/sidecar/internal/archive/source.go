package archive

import (
	"cmp"
	"context"
	"slices"
	"strings"

	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/natsort"
)

// Entry ids of open archives come from their own range (ADR-0030), far
// above index ids, so selection descriptors are unambiguous: an id is
// IDBase + archive<<slotBits + entry index + 1. All stay below 2^53.
const (
	IDBase   int64 = 1 << 50
	slotBits       = 21 // MaxEntries < 2^21
	slotMask       = 1<<slotBits - 1
	maxSlot        = 1<<(52-slotBits) - 1
)

// idLimit ends the range of archive entry ids; the rows of directory
// compares come above it (Stage C08).
const idLimit = IDBase + (maxSlot+1)<<slotBits

// IsID reports whether id names an archive entry.
func IsID(id int64) bool { return id >= IDBase && id < idLimit }

// SplitID returns the archive id and the entry index of an archive entry id.
func SplitID(id int64) (archiveID int64, entry int, ok bool) {
	if !IsID(id) {
		return 0, 0, false
	}
	v := id - IDBase
	idx := int(v&slotMask) - 1
	return v >> slotBits, idx, idx >= 0
}

// EntryID is the id of entry i of an open archive.
func EntryID(archiveID int64, i int) int64 {
	return IDBase + archiveID<<slotBits + int64(i) + 1
}

// Source serves one folder of an open archive to a query session
// (query.Source; ADR-0017 as amended in Stage C06): sorted and filtered in
// Go like a folder, rows built from the listing.
type Source struct {
	a   *Open
	dir int // -1 = the archive's root
}

// IDs implements query.Source: folders first, then the sort keys, then the
// natural name.
func (s *Source) IDs(_ context.Context, d index.Descriptor) ([]int64, error) {
	l := s.a.Listing
	kids := l.Children(s.dir)
	var mask index.Mask
	if d.NameMask != "" {
		mask = index.ParseMask(d.NameMask)
	}
	type row struct {
		i    int32
		dir  bool
		nat  string
		name string
		e    *entry
	}
	rows := make([]row, 0, len(kids))
	for _, i := range kids {
		e := &l.entries[i]
		name := baseName(e.path)
		dir := e.kind == KindDir
		if d.NameMask != "" && !dir && !index.MatchMask(mask, index.FoldName(name)) {
			continue
		}
		rows = append(rows, row{i: i, dir: dir, name: name, e: e})
	}
	// Natural keys only for this folder, only for this sort.
	for k := range rows {
		rows[k].nat = natsort.Key(rows[k].name)
	}
	byName := func(a, b *row) int {
		return cmp.Or(strings.Compare(a.nat, b.nat), strings.Compare(a.name, b.name), cmp.Compare(a.i, b.i))
	}
	slices.SortStableFunc(rows, func(a, b row) int {
		if a.dir != b.dir {
			if a.dir {
				return -1
			}
			return 1
		}
		for _, k := range d.SortFor(a.dir) {
			var c int
			switch k.Field {
			case index.SortModified:
				c = cmp.Compare(a.e.mtimeNs, b.e.mtimeNs)
			case index.SortSize:
				c = cmp.Compare(a.e.size, b.e.size)
			case index.SortType:
				c = strings.Compare(media.Ext(a.name), media.Ext(b.name))
			default:
				c = byName(&a, &b)
			}
			if k.Desc {
				c = -c
			}
			if c != 0 {
				return c
			}
		}
		return byName(&a, &b)
	})
	ids := make([]int64, len(rows))
	for k, r := range rows {
		ids[k] = EntryID(s.a.ID, int(r.i))
	}
	return ids, nil
}

// Names implements query.Source.
func (s *Source) Names(context.Context) (map[int64]index.NameRow, error) {
	l := s.a.Listing
	kids := l.Children(s.dir)
	out := make(map[int64]index.NameRow, len(kids))
	for _, i := range kids {
		e := &l.entries[i]
		out[EntryID(s.a.ID, int(i))] = index.NameRow{Name: index.FoldName(baseName(e.path)), IsDir: e.kind == KindDir}
	}
	return out, nil
}

// Missing implements query.Source; a listing never loses entries.
func (s *Source) Missing() {}

// SingleFolder tells the query layer that rows need no folder path.
func (s *Source) SingleFolder() bool { return true }

// Items implements query.ItemSource: page rows from the listing.
func (s *Source) Items(_ context.Context, ids []int64) ([]index.Item, error) {
	out := make([]index.Item, 0, len(ids))
	for _, id := range ids {
		if it, ok := s.a.Item(id); ok {
			out = append(out, it)
		}
	}
	return out, nil
}

// Item builds the row of one entry id of this archive.
func (a *Open) Item(id int64) (index.Item, bool) {
	aid, i, ok := SplitID(id)
	if !ok || aid != a.ID || i >= a.Listing.Len() {
		return index.Item{}, false
	}
	e := &a.Listing.entries[i]
	name := baseName(e.path)
	it := index.Item{ID: id, Name: name, Size: e.size, MtimeNs: e.mtimeNs, DirSize: -1}
	switch e.kind {
	case KindDir:
		it.Kind, it.Size, it.DirSize = media.KindDir, 0, e.size
	case KindSymlink, KindHardlink:
		it.Kind, it.Ext = media.KindLink, media.Ext(name)
	default:
		it.Kind, it.Ext = media.KindFile, media.Ext(name)
		if k, _, ok := media.Classify(name); ok {
			it.Kind = k
		}
	}
	return it, true
}
