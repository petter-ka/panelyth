package remote

import (
	"cmp"
	"context"
	"slices"
	"strings"

	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/natsort"
)

// Source serves one listed folder of a connection to a query session
// (query.Source and query.ItemSource; ADR-0017): sorted and filtered in Go
// like a local folder, rows built from the listing. It never talks to the
// server: a session over it costs no network.
type Source struct {
	c   *Conn
	dir int32
}

// Source returns the session source of a folder that OpenDir has listed.
func (c *Conn) Source(dirID int64) (*Source, error) {
	cid, i, ok := SplitID(dirID)
	c.mu.Lock()
	defer c.mu.Unlock()
	if !ok || cid != c.ID || c.dirs[int32(i)] == nil {
		return nil, ErrUnknown
	}
	return &Source{c: c, dir: int32(i)}, nil
}

// Conn is the connection the source belongs to.
func (s *Source) Conn() *Conn { return s.c }

// hidden: names that start with a dot, as on the systems FTP servers run on.
func hidden(name string) bool { return strings.HasPrefix(name, ".") }

// IDs implements query.Source: folders first, then the sort keys, then the
// natural name.
func (s *Source) IDs(_ context.Context, d index.Descriptor) ([]int64, error) {
	type row struct {
		i     int32
		dir   bool
		nat   string
		name  string
		size  int64
		mtime int64
	}
	var mask index.Mask
	if d.NameMask != "" {
		mask = index.ParseMask(d.NameMask)
	}
	s.c.mu.Lock()
	state := s.c.dirs[s.dir]
	if state == nil {
		s.c.mu.Unlock()
		return nil, nil
	}
	rows := make([]row, 0, len(state.kids))
	for _, k := range state.kids {
		e := &s.c.entries[k]
		dir := e.kind == KindDir
		if !d.ShowHidden && hidden(e.name) {
			continue
		}
		if d.NameMask != "" && !dir && !index.MatchMask(mask, index.FoldName(e.name)) {
			continue
		}
		rows = append(rows, row{i: k, dir: dir, name: e.name, size: e.size, mtime: e.mtime})
	}
	s.c.mu.Unlock()
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
				c = cmp.Compare(a.mtime, b.mtime)
			case index.SortSize:
				c = cmp.Compare(a.size, b.size)
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
		ids[k] = EntryID(s.c.ID, int(r.i))
	}
	return ids, nil
}

// Names implements query.Source.
func (s *Source) Names(context.Context) (map[int64]index.NameRow, error) {
	s.c.mu.Lock()
	defer s.c.mu.Unlock()
	state := s.c.dirs[s.dir]
	if state == nil {
		return map[int64]index.NameRow{}, nil
	}
	out := make(map[int64]index.NameRow, len(state.kids))
	for _, k := range state.kids {
		e := &s.c.entries[k]
		out[EntryID(s.c.ID, int(k))] = index.NameRow{Name: index.FoldName(e.name), IsDir: e.kind == KindDir}
	}
	return out, nil
}

// Missing implements query.Source; a listing changes only when it is read again.
func (s *Source) Missing() {}

// SingleFolder tells the query layer that rows need no folder path.
func (s *Source) SingleFolder() bool { return true }

// Items implements query.ItemSource: page rows from the listing.
func (s *Source) Items(_ context.Context, ids []int64) ([]index.Item, error) {
	out := make([]index.Item, 0, len(ids))
	s.c.mu.Lock()
	defer s.c.mu.Unlock()
	for _, id := range ids {
		cid, i, ok := SplitID(id)
		if !ok || cid != s.c.ID || i >= len(s.c.entries) {
			continue
		}
		out = append(out, item(id, &s.c.entries[i]))
	}
	return out, nil
}

// item builds the row of one entry. Pictures and videos show their kind's
// icon; they have no thumbnail (nothing is downloaded to list a folder).
func item(id int64, e *entry) index.Item {
	it := index.Item{ID: id, Name: e.name, Size: e.size, MtimeNs: e.mtime, DirSize: -1}
	switch e.kind {
	case KindDir:
		it.Kind, it.Size = media.KindDir, 0
	case KindLink:
		it.Kind, it.Ext = media.KindLink, media.Ext(e.name)
	default:
		it.Kind, it.Ext = media.KindFile, media.Ext(e.name)
		if k, _, ok := media.Classify(e.name); ok {
			it.Kind = k
		}
	}
	return it
}
