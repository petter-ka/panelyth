package query

import (
	"context"
	"strings"
	"sync"

	"fastview/sidecar/internal/index"
)

// Name lookups over a session (Stage C02): quick search (Locate), marking by
// mask (Match) and carrying a selection over between the apps (Positions).
// Each session builds, on first use per version, its folded names, folder
// flags and an id → position map, so a keystroke is an in-memory scan and
// never a query over the folder.

type lookup struct {
	version int64
	names   []string
	dirs    []bool
	pos     map[int64]int
}

type lookups struct {
	mu sync.Mutex
	by map[int64]*lookup // session id → its lookup for one version
}

// lookupFor returns the session's lookup for its current version. Names are
// loaded only when withNames is set (quick search, masks); positions alone
// (a carried selection) come from the id list without a query.
func (m *Manager) lookupFor(ctx context.Context, id int64, withNames bool) (*lookup, error) {
	m.mu.Lock()
	s := m.sessions[id]
	if s == nil {
		m.mu.Unlock()
		return nil, ErrUnknownSession
	}
	ids, version, desc, key, src := s.ids, s.version, s.desc, s.dirKey, s.src
	m.mu.Unlock()

	m.lk.mu.Lock()
	cached := m.lk.by[id]
	m.lk.mu.Unlock()
	if cached != nil && cached.version == version && (!withNames || cached.names != nil) {
		return cached, nil
	}

	l := &lookup{version: version, pos: make(map[int64]int, len(ids))}
	for i, entry := range ids {
		l.pos[entry] = i
	}
	if withNames {
		var rows map[int64]index.NameRow
		var err error
		if src != nil {
			rows, err = src.Names(ctx)
		} else {
			rows, err = m.store.Names(ctx, desc, key)
		}
		if err != nil {
			return nil, err
		}
		l.names, l.dirs = make([]string, len(ids)), make([]bool, len(ids))
		for i, entry := range ids {
			r := rows[entry]
			l.names[i], l.dirs[i] = r.Name, r.IsDir
		}
	}
	m.lk.mu.Lock()
	if m.lk.by == nil {
		m.lk.by = map[int64]*lookup{}
	}
	// Only live sessions keep a lookup; a refreshed one is replaced.
	for sid := range m.lk.by {
		if !m.alive(sid) {
			delete(m.lk.by, sid)
		}
	}
	m.lk.by[id] = l
	m.lk.mu.Unlock()
	return l, nil
}

func (m *Manager) alive(id int64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id] != nil
}

// Locate returns the next index at or after from (before, when backward)
// whose name matches pattern, wrapping around; -1 when nothing matches.
// Prefix matches win over substring matches. "*" and "?" are wildcards.
func (m *Manager) Locate(ctx context.Context, id int64, pattern string, from int, backward bool) (int, int64, error) {
	l, err := m.lookupFor(ctx, id, true)
	if err != nil {
		return -1, 0, err
	}
	p := index.FoldName(pattern)
	if p == "" || len(l.names) == 0 {
		return -1, l.version, nil
	}
	var prefix, substring func(string) bool
	if strings.ContainsAny(p, "*?") {
		prefix = func(n string) bool { return index.Glob(p+"*", n) }
		substring = func(n string) bool { return index.Glob("*"+p+"*", n) }
	} else {
		prefix = func(n string) bool { return strings.HasPrefix(n, p) }
		substring = func(n string) bool { return strings.Contains(n, p) }
	}
	for _, match := range []func(string) bool{prefix, substring} {
		if at := scanNames(l.names, from, backward, match); at >= 0 {
			return at, l.version, nil
		}
	}
	return -1, l.version, nil
}

func scanNames(names []string, from int, backward bool, match func(string) bool) int {
	n := len(names)
	from = ((from % n) + n) % n
	for k := range n {
		i := from + k
		if backward {
			i = from - k
		}
		i = ((i % n) + n) % n
		if match(names[i]) {
			return i
		}
	}
	return -1
}

// Match returns the sorted indexes of the files (folders too, unless
// filesOnly) whose names match a name mask (the nameMask syntax).
func (m *Manager) Match(ctx context.Context, id int64, mask string, filesOnly bool) ([]int, int64, error) {
	l, err := m.lookupFor(ctx, id, true)
	if err != nil {
		return nil, 0, err
	}
	parsed := index.ParseMask(mask)
	var out []int
	for i, name := range l.names {
		if filesOnly && l.dirs[i] {
			continue
		}
		if index.MatchMask(parsed, name) {
			out = append(out, i)
		}
	}
	return out, l.version, nil
}

// Positions maps entry ids to their indexes in the session's current version;
// ids not in the session are left out.
func (m *Manager) Positions(ctx context.Context, id int64, entries []int64) ([]int, int64, error) {
	l, err := m.lookupFor(ctx, id, false)
	if err != nil {
		return nil, 0, err
	}
	out := make([]int, 0, len(entries))
	for _, e := range entries {
		if i, ok := l.pos[e]; ok {
			out = append(out, i)
		}
	}
	return out, l.version, nil
}
