package find

import (
	"cmp"
	"context"
	"slices"
	"strings"
	"sync"

	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/media"
	"fastview/sidecar/internal/natsort"
	"fastview/sidecar/internal/scan"
)

// result is one found entry as the source sorts it.
type result struct {
	id      int64
	parent  int64
	kind    media.Kind
	name    string
	nat     string
	fold    string
	ext     string
	size    int64
	mtimeNs int64
	btimeNs int64
	attrs   int
}

// Source holds a search's results in found order and serves query sessions
// (query.Source). Results are index entries, so every command works on them;
// after index changes under their folders the source reloads them.
type Source struct {
	store *index.Store

	// reload serializes snapshots, so a reload sees the list it replaces
	// as a prefix of the current one (add only appends).
	reload  sync.Mutex
	mu      sync.Mutex
	list    []result
	pos     map[int64]bool
	parents map[int64]bool
	stale   bool
}

func newSource(store *index.Store) *Source {
	return &Source{store: store, pos: map[int64]bool{}, parents: map[int64]bool{}}
}

// Len is the number of results.
func (s *Source) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.list)
}

// add appends newly written results (ids in the same order as found); an id
// already present (overlapping roots) is skipped. It returns how many were new.
func (s *Source) add(found []index.Found, ids []int64, parents []int64) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for i, f := range found {
		if s.pos[ids[i]] {
			continue
		}
		s.pos[ids[i]] = true
		s.parents[parents[i]] = true
		s.list = append(s.list, result{id: ids[i], parent: parents[i], kind: f.Kind, name: f.Name,
			nat: natsort.Key(f.Name), fold: index.FoldName(f.Name), ext: f.Ext, size: f.Size,
			mtimeNs: f.MtimeNs, btimeNs: f.BtimeNs, attrs: f.Attrs})
		n++
	}
	return n
}

// Missing implements query.Source.
func (s *Source) Missing() {
	s.mu.Lock()
	s.stale = true
	s.mu.Unlock()
}

// changed marks the source stale when an index change touches a folder
// holding results, or a result folder itself.
func (s *Source) changed(changes []scan.Change) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range changes {
		if s.parents[c.DirID] || s.pos[c.DirID] {
			s.stale = true
			return true
		}
	}
	return false
}

// snapshot returns the current list, reloading it from the index first when
// stale: deleted entries drop out, renamed and changed ones get their new
// names and sizes.
func (s *Source) snapshot(ctx context.Context) ([]result, error) {
	s.reload.Lock()
	defer s.reload.Unlock()
	s.mu.Lock()
	list, stale := s.list, s.stale
	s.stale = false
	s.mu.Unlock()
	if !stale {
		return list, nil
	}
	ids := make([]int64, len(list))
	for i, r := range list {
		ids[i] = r.id
	}
	items, err := s.store.LoadItems(ctx, ids)
	if err != nil {
		s.Missing()
		return nil, err
	}
	byID := make(map[int64]index.Item, len(items))
	for _, it := range items {
		byID[it.ID] = it
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Results added while reloading are kept as they are.
	fresh := make([]result, 0, len(s.list))
	for i, r := range s.list {
		if i < len(list) {
			it, ok := byID[r.id]
			if !ok {
				delete(s.pos, r.id)
				continue
			}
			if it.Name != r.name {
				r.name, r.nat, r.fold = it.Name, natsort.Key(it.Name), index.FoldName(it.Name)
			}
			r.kind, r.ext, r.size, r.mtimeNs, r.attrs = it.Kind, it.Ext, it.Size, it.MtimeNs, it.Attrs
		}
		fresh = append(fresh, r)
	}
	s.list = fresh
	return fresh, nil
}

// IDs implements query.Source: found order without sort keys, otherwise
// folders first, the keys, then the natural name and id (ADR-0017).
func (s *Source) IDs(ctx context.Context, d index.Descriptor) ([]int64, error) {
	list, err := s.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	var mask index.Mask
	if d.NameMask != "" {
		mask = index.ParseMask(d.NameMask)
	}
	keep := make([]int, 0, len(list))
	for i := range list {
		r := &list[i]
		if !d.ShowHidden && r.attrs&(1|2) != 0 && d.Scope == index.ScopeAll {
			continue
		}
		if d.NameMask != "" && r.kind != media.KindDir && !index.MatchMask(mask, r.fold) {
			continue
		}
		keep = append(keep, i)
	}
	if len(d.Sort) > 0 {
		slices.SortStableFunc(keep, func(a, b int) int { return compare(&list[a], &list[b], d.Sort) })
	}
	ids := make([]int64, len(keep))
	for i, k := range keep {
		ids[i] = list[k].id
	}
	return ids, nil
}

func compare(a, b *result, keys []index.SortKey) int {
	if ad, bd := a.kind == media.KindDir, b.kind == media.KindDir; ad != bd {
		if ad {
			return -1
		}
		return 1
	}
	for _, k := range keys {
		var c int
		switch k.Field {
		case index.SortModified:
			c = cmp.Compare(a.mtimeNs, b.mtimeNs)
		case index.SortSize:
			c = cmp.Compare(a.size, b.size)
		case index.SortType:
			c = strings.Compare(a.ext, b.ext)
		case index.SortCreated:
			c = cmp.Compare(a.btimeNs, b.btimeNs)
		case index.SortAttrs:
			c = cmp.Compare(a.attrs, b.attrs)
		default: // name, and fields a search result has no value for
			c = cmp.Or(strings.Compare(a.nat, b.nat), strings.Compare(a.name, b.name))
		}
		if k.Desc {
			c = -c
		}
		if c != 0 {
			return c
		}
	}
	return cmp.Or(strings.Compare(a.nat, b.nat), strings.Compare(a.name, b.name), cmp.Compare(a.id, b.id))
}

// Names implements query.Source.
func (s *Source) Names(ctx context.Context) (map[int64]index.NameRow, error) {
	list, err := s.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]index.NameRow, len(list))
	for _, r := range list {
		out[r.id] = index.NameRow{Name: r.fold, IsDir: r.kind == media.KindDir}
	}
	return out, nil
}
