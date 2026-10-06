package index

import (
	"context"
	"strings"
)

// NameRow is one entry's folded name and whether it is a folder.
type NameRow struct {
	Name  string
	IsDir bool
}

// Names returns the folded names of the entries in d's scope, keyed by id
// (Stage C02: quick search and marking by mask match them in memory). User
// filters are left out, so the result is a superset of the session; callers
// look up the session's ids only.
func (s *Store) Names(ctx context.Context, d Descriptor, dirKey string) (map[int64]NameRow, error) {
	d.FavoriteOnly, d.MinRating, d.Tags = false, 0, nil
	hidden, err := s.hiddenRanges(ctx, d, dirKey)
	if err != nil {
		return nil, err
	}
	where, args := scope(d, dirKey, true, hidden)
	rows, err := s.r.QueryContext(ctx, `SELECT id, kind, name_fold FROM entries WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]NameRow{}
	for rows.Next() {
		var id int64
		var kind int
		var name string
		if err := rows.Scan(&id, &kind, &name); err != nil {
			return nil, err
		}
		out[id] = NameRow{Name: name, IsDir: kind == 0}
	}
	return out, rows.Err()
}

// Glob reports whether name matches pattern, where "*" matches any run and
// "?" one character; everything else, "[" included, is literal. Both are
// expected folded (FoldName).
func Glob(pattern, name string) bool {
	p, n := []rune(pattern), []rune(name)
	pi, ni, star, mark := 0, 0, -1, 0
	for ni < len(n) {
		switch {
		case pi < len(p) && (p[pi] == '?' || p[pi] == n[ni]):
			pi++
			ni++
		case pi < len(p) && p[pi] == '*':
			star, mark = pi, ni
			pi++
		case star >= 0:
			pi = star + 1
			mark++
			ni = mark
		default:
			return false
		}
	}
	for pi < len(p) && p[pi] == '*' {
		pi++
	}
	return pi == len(p)
}

// MatchMask applies a parsed name mask to a folded name ("[" literal).
func MatchMask(m Mask, name string) bool {
	lit := func(p string) string { return strings.ReplaceAll(p, "[[]", "[") }
	if len(m.Include) > 0 {
		ok := false
		for _, p := range m.Include {
			if Glob(lit(p), name) {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	for _, p := range m.Exclude {
		if Glob(lit(p), name) {
			return false
		}
	}
	return true
}

// SetDirSize stores a folder's calculated size (bytes of every file below it).
func (s *Store) SetDirSize(ctx context.Context, id, bytes int64) error {
	_, err := s.w.ExecContext(ctx, `UPDATE entries SET dir_size_bytes = ? WHERE id = ? AND kind = 0`, bytes, id)
	return err
}
