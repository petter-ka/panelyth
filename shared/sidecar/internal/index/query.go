package index

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"fastview/sidecar/internal/media"
	"fastview/sidecar/internal/pathkey"
)

// SortField is a whitelisted ordering; field names never reach SQL directly.
type SortField string

const (
	SortName       SortField = "name"
	SortModified   SortField = "modified"
	SortSize       SortField = "size"
	SortType       SortField = "type"
	SortCreated    SortField = "created"
	SortDimensions SortField = "dimensions"
	// Stage 07 (ADR-0021).
	SortDuration SortField = "duration"
	SortFavorite SortField = "favorite"
	SortRating   SortField = "rating"
	SortTags     SortField = "tags"
	// Stage P02 (ADR-0026): the commander's Attr column.
	SortAttrs SortField = "attrs"
)

// sortSpec lists the SQL terms of one field. nullsLast terms are emitted
// ascending regardless of direction, so unknown values (dimensions not yet
// probed) always sort after known ones. user fields need the u (user data)
// join of QueryIDs.
type sortSpec struct {
	nullsLast string
	cols      []string
	user      bool
}

var sortSpecs = map[SortField]sortSpec{
	SortName:     {cols: []string{"name_nat", "name"}},
	SortModified: {cols: []string{"mtime_ns"}},
	SortSize:     {cols: []string{"size_bytes"}},
	SortType:     {cols: []string{"ext"}},
	SortCreated:  {cols: []string{"btime_ns"}},
	// Dimensions are recorded when a preview is generated (Stage 02);
	// rows without them sort last until metadata extraction (Stage 07).
	SortDimensions: {nullsLast: "(width IS NULL)", cols: []string{"(width * height)", "width"}},
	// Filled lazily by the metadata extractor (ADR-0021); unknown sorts last.
	SortDuration: {nullsLast: "(duration_ms IS NULL)", cols: []string{"duration_ms"}},
	SortFavorite: {cols: []string{"COALESCE(u.fav, 0)"}, user: true},
	SortRating:   {cols: []string{"COALESCE(u.rating, 0)"}, user: true},
	// First tag alphabetically; untagged last in both directions (M10).
	SortTags:  {nullsLast: "(COALESCE(u.tag, '') = '')", cols: []string{"COALESCE(u.tag, '')"}, user: true},
	SortAttrs: {cols: []string{"attrs"}},
}

// MetaSort reports whether ordering by f needs extracted metadata.
func MetaSort(f SortField) bool { return f == SortDimensions || f == SortDuration }

// ValidSortField reports whether f can be used in a Descriptor.
func ValidSortField(f SortField) bool {
	_, ok := sortSpecs[f]
	return ok
}

// SortKey is one ordering term.
type SortKey struct {
	Field SortField
	Desc  bool
}

// Search limits keep LIKE patterns cheap and bounded.
const (
	MaxSearchLen   = 256
	MaxSearchTerms = 8
	MaxExts        = 32
	MaxMaskLen     = 256
	MaxMaskTerms   = 16
)

// Scope selects which stored entries a query can see (ADR-0026).
type Scope string

const (
	// ScopeMedia is the viewer's scope and the default: folders, images and
	// videos that are neither hidden nor system, outside hidden folders.
	ScopeMedia Scope = "media"
	// ScopeAll is the commander's: every entry; hidden and system entries
	// only with ShowHidden.
	ScopeAll Scope = "all"
)

// hiddenBits are the attrs that hide an entry (fsx.AttrHidden|AttrSystem).
const hiddenBits = 1 | 2

// Descriptor selects and orders entries for a query session (ADR-0017).
type Descriptor struct {
	DirID     int64
	Recursive bool
	// Scope is ScopeMedia when empty.
	Scope Scope
	// ShowHidden includes hidden and system entries (ScopeAll only).
	ShowHidden bool
	// NameMask filters files (not folders) by wildcard patterns ("*" and
	// "?"), separated by ";" or spaces; patterns after "|" exclude. Case
	// folded. Empty means all files.
	NameMask string
	Sort     []SortKey
	// Kinds restricts entry kinds; empty means all. Recursive queries never
	// include directories.
	Kinds []media.Kind
	// Search matches file names: every whitespace-separated term must occur
	// (case-insensitive substring). Empty means no search.
	Search string
	// Exts restricts files to these lowercase extensions; folders are kept
	// unless Kinds excludes them.
	Exts []string
	// User-data filters (library.db, ADR-0021). Folders carry no user data,
	// so any of these leaves only files.
	FavoriteOnly bool
	MinRating    int
	Tags         []string
	// User holds the scope's annotations; set by the query manager when
	// NeedsUser is true.
	User []UserRow
}

// UserRow is one annotated path key passed into QueryIDs.
type UserRow struct {
	Key      string
	Favorite bool
	Rating   int
	FirstTag string
	Match    bool
}

// NeedsUser reports whether the descriptor sorts or filters by user data.
func (d Descriptor) NeedsUser() bool {
	if d.FavoriteOnly || d.MinRating > 0 || len(d.Tags) > 0 {
		return true
	}
	for _, k := range d.Sort {
		if sortSpecs[k.Field].user {
			return true
		}
	}
	return false
}

// userJSON encodes d.User as [[key, fav, rating, tag, match], ...].
func userJSON(rows []UserRow) (string, error) {
	out := make([][5]any, len(rows))
	for i, r := range rows {
		out[i] = [5]any{r.Key, boolInt(r.Favorite), r.Rating, r.FirstTag, boolInt(r.Match)}
	}
	b, err := json.Marshal(out)
	return string(b), err
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// Item is the compact row sent to the renderer.
type Item struct {
	ID      int64
	PathKey string // not sent to the renderer; used for preview keys
	Kind    media.Kind
	Name    string
	Ext     string
	Size    int64
	MtimeNs int64
	Attrs   int
}

// FoldName is the search form of a name: NFC, lowercased. The same fold is
// applied to search terms.
func FoldName(name string) string {
	return strings.ToLower(norm.NFC.String(name))
}

// SearchTerms splits and folds a search string (at most MaxSearchTerms).
func SearchTerms(search string) []string {
	f := strings.FieldsFunc(FoldName(search), unicode.IsSpace)
	return f[:min(len(f), MaxSearchTerms)]
}

func likeEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// ValidScope reports whether s can be used in a Descriptor ("" = media).
func ValidScope(s Scope) bool { return s == "" || s == ScopeMedia || s == ScopeAll }

// Mask is a parsed NameMask: lowercase GLOB patterns.
type Mask struct {
	Include, Exclude []string
}

// ParseMask splits a name mask. Only "*" and "?" are wildcards; "[" is
// matched literally.
func ParseMask(mask string) Mask {
	inc, exc, _ := strings.Cut(mask, "|")
	split := func(s string) []string {
		var out []string
		for _, f := range strings.FieldsFunc(FoldName(s), func(r rune) bool { return r == ';' || unicode.IsSpace(r) }) {
			if f == "*.*" {
				f = "*"
			}
			out = append(out, strings.ReplaceAll(f, "[", "[[]"))
			if len(out) == MaxMaskTerms {
				break
			}
		}
		return out
	}
	m := Mask{Include: split(inc), Exclude: split(exc)}
	if slices.Contains(m.Include, "*") {
		m.Include = nil // "*" matches everything: no include filter
	}
	return m
}

// hiddenRange is a hidden folder's subtree inside a recursive media scope.
type hiddenRange struct{ lo, hi string }

// scope builds the WHERE clause for d. withFilters=false leaves out the kind
// and extension filters (facets count what the filters would choose from).
// hidden lists hidden folders' subtrees to leave out (recursive media scope).
func scope(d Descriptor, dirKey string, withFilters bool, hidden []hiddenRange) (string, []any) {
	var where []string
	var args []any
	if d.Recursive {
		lo, hi := pathkey.SubtreeRange(dirKey)
		where = append(where, "path_key >= ? AND path_key < ?", "kind <> 0")
		args = append(args, lo, hi)
	} else {
		where = append(where, "parent_id = ?")
		args = append(args, d.DirID)
	}
	switch {
	case d.Scope == ScopeAll && d.ShowHidden:
	case d.Scope == ScopeAll:
		where = append(where, fmt.Sprintf("(attrs & %d) = 0", hiddenBits))
	default:
		where = append(where, fmt.Sprintf("kind IN (0, 1, 2) AND (attrs & %d) = 0", hiddenBits))
		for _, h := range hidden {
			where = append(where, "NOT (path_key >= ? AND path_key < ?)")
			args = append(args, h.lo, h.hi)
		}
	}
	if d.NameMask != "" {
		m := ParseMask(d.NameMask)
		if len(m.Include) > 0 {
			or := make([]string, len(m.Include))
			for i, p := range m.Include {
				or[i] = "name_fold GLOB ?"
				args = append(args, p)
			}
			where = append(where, "(kind = 0 OR "+strings.Join(or, " OR ")+")")
		}
		for _, p := range m.Exclude {
			where = append(where, "(kind = 0 OR name_fold NOT GLOB ?)")
			args = append(args, p)
		}
	}
	for _, t := range SearchTerms(d.Search) {
		where = append(where, `name_fold LIKE ? ESCAPE '\'`)
		args = append(args, "%"+likeEscape(t)+"%")
	}
	if withFilters && len(d.Kinds) > 0 {
		ph := make([]string, len(d.Kinds))
		for i, k := range d.Kinds {
			ph[i] = "?"
			args = append(args, int(k))
		}
		where = append(where, "kind IN ("+strings.Join(ph, ",")+")")
	}
	if withFilters && d.FavoriteOnly {
		where = append(where, "u.fav = 1")
	}
	if withFilters && d.MinRating > 0 {
		where = append(where, "u.rating >= ?")
		args = append(args, d.MinRating)
	}
	if withFilters && len(d.Tags) > 0 {
		where = append(where, "u.m = 1")
	}
	if withFilters && len(d.Exts) > 0 {
		ph := make([]string, len(d.Exts))
		for i, e := range d.Exts {
			ph[i] = "?"
			args = append(args, e)
		}
		where = append(where, "(kind = 0 OR ext IN ("+strings.Join(ph, ",")+"))")
	}
	return strings.Join(where, " AND "), args
}

// QueryIDs materializes the ordered id list for d. dirKey is the directory's
// path key (needed for recursive subtree ranges).
func (s *Store) QueryIDs(ctx context.Context, d Descriptor, dirKey string) ([]int64, error) {
	hidden, err := s.hiddenRanges(ctx, d, dirKey)
	if err != nil {
		return nil, err
	}
	where, args := scope(d, dirKey, true, hidden)

	order := []string{"(kind <> 0)"} // directories first, always
	used := map[string]bool{}
	add := func(term string, desc bool) {
		if used[term] {
			return
		}
		used[term] = true
		dir := " ASC"
		if desc {
			dir = " DESC"
		}
		order = append(order, term+dir)
	}
	for _, k := range d.Sort {
		spec, ok := sortSpecs[k.Field]
		if !ok {
			return nil, fmt.Errorf("unknown sort field %q", k.Field)
		}
		if spec.nullsLast != "" {
			add(spec.nullsLast, false)
		}
		for _, c := range spec.cols {
			add(c, k.Desc)
		}
	}
	// Deterministic tail: natural name, then id.
	add("name_nat", false)
	add("name", false)
	add("id", false)

	q := "SELECT id FROM entries WHERE " + where + " ORDER BY " + strings.Join(order, ", ")
	if d.NeedsUser() {
		// The scope's annotations arrive as one JSON parameter instead of an
		// ATTACHed library.db (ADR-0021). json_each reports a tiny row
		// estimate, so "entries LEFT JOIN u" never gets an automatic index and
		// rescans u for every entry (100k x 10k: ~75 s). The equivalent RIGHT
		// JOIN walks u once, probing entries' unique path_key index, then
		// emits the unannotated entries through the scope's own index. User
		// filters need an annotation, so SQLite reduces that join to an inner
		// join and would reorder it the slow way again; CROSS JOIN pins u as
		// the outer loop.
		join := "u RIGHT JOIN entries"
		if d.FavoriteOnly || d.MinRating > 0 || len(d.Tags) > 0 {
			join = "u CROSS JOIN entries"
		}
		js, err := userJSON(d.User)
		if err != nil {
			return nil, err
		}
		args = append([]any{js}, args...)
		q = `WITH u(k, fav, rating, tag, m) AS MATERIALIZED
			(SELECT value->>0, value->>1, value->>2, value->>3, value->>4 FROM json_each(?))
			SELECT id FROM ` + join + ` ON entries.path_key = u.k WHERE ` + where + " ORDER BY " + strings.Join(order, ", ")
	}
	rows, err := s.r.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]int64, 0, 1024)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// MaxHiddenRanges bounds the subtrees a recursive media query leaves out.
// The scanner never descends into hidden folders, so only folders opened
// directly (in the commander) have indexed contents; beyond the bound the
// query fails rather than silently including hidden files.
const MaxHiddenRanges = 256

// hiddenRanges finds hidden or system folders with indexed children inside a
// recursive media scope.
func (s *Store) hiddenRanges(ctx context.Context, d Descriptor, dirKey string) ([]hiddenRange, error) {
	if !d.Recursive || (d.Scope != "" && d.Scope != ScopeMedia) {
		return nil, nil
	}
	lo, hi := pathkey.SubtreeRange(dirKey)
	rows, err := s.r.QueryContext(ctx, fmt.Sprintf(`SELECT h.path_key FROM entries h
		WHERE h.path_key >= ? AND h.path_key < ? AND h.kind = 0 AND (h.attrs & %d) <> 0
		AND EXISTS (SELECT 1 FROM entries c WHERE c.parent_id = h.id) LIMIT %d`, hiddenBits, MaxHiddenRanges+1), lo, hi)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []hiddenRange
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		l, h := pathkey.SubtreeRange(key)
		out = append(out, hiddenRange{l, h})
	}
	if len(out) > MaxHiddenRanges {
		return nil, fmt.Errorf("more than %d hidden folders with indexed contents in this subtree", MaxHiddenRanges)
	}
	return out, rows.Err()
}

// ExtCount is one extension facet.
type ExtCount struct {
	Ext   string `json:"ext"`
	Count int    `json:"count"`
}

// Facets counts what the kind and extension filters can choose from, within
// the descriptor's folder scope and search.
type Facets struct {
	Folders int `json:"folders"`
	Images  int `json:"images"`
	Videos  int `json:"videos"`
	// Files counts other files and links (ScopeAll only).
	Files int        `json:"files,omitempty"`
	Exts  []ExtCount `json:"exts"`
}

// MaxFacetExts bounds the extension list.
const MaxFacetExts = 50

// Facets computes filter counts for d (its Kinds and Exts are ignored).
func (s *Store) Facets(ctx context.Context, d Descriptor, dirKey string) (Facets, error) {
	hidden, err := s.hiddenRanges(ctx, d, dirKey)
	if err != nil {
		return Facets{}, err
	}
	where, args := scope(d, dirKey, false, hidden)
	rows, err := s.r.QueryContext(ctx, "SELECT kind, ext, COUNT(*) FROM entries WHERE "+where+" GROUP BY kind, ext", args...)
	if err != nil {
		return Facets{}, err
	}
	defer rows.Close()
	f := Facets{Exts: []ExtCount{}}
	for rows.Next() {
		var kind, n int
		var ext string
		if err := rows.Scan(&kind, &ext, &n); err != nil {
			return Facets{}, err
		}
		switch media.Kind(kind) {
		case media.KindDir:
			f.Folders += n
			continue
		case media.KindImage:
			f.Images += n
		case media.KindVideo:
			f.Videos += n
		default:
			f.Files += n
		}
		f.Exts = append(f.Exts, ExtCount{Ext: ext, Count: n})
	}
	slices.SortFunc(f.Exts, func(a, b ExtCount) int {
		if c := cmp.Compare(b.Count, a.Count); c != 0 {
			return c
		}
		return strings.Compare(a.Ext, b.Ext)
	})
	f.Exts = f.Exts[:min(len(f.Exts), MaxFacetExts)]
	return f, rows.Err()
}

// LoadItems returns rows for ids in the same order. Ids that no longer exist
// are skipped (the session is about to be invalidated anyway).
func (s *Store) LoadItems(ctx context.Context, ids []int64) ([]Item, error) {
	// SQLite caps bound variables per statement; pages are ≤ 1000 ids, but
	// the API must not fail for callers passing more.
	const chunk = 1000
	if len(ids) > chunk {
		out := make([]Item, 0, len(ids))
		for lo := 0; lo < len(ids); lo += chunk {
			part, err := s.LoadItems(ctx, ids[lo:min(lo+chunk, len(ids))])
			if err != nil {
				return nil, err
			}
			out = append(out, part...)
		}
		return out, nil
	}
	if len(ids) == 0 {
		return []Item{}, nil
	}
	ph := strings.Repeat("?,", len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := s.r.QueryContext(ctx,
		`SELECT id, kind, name, ext, size_bytes, mtime_ns, path_key, attrs FROM entries WHERE id IN (`+ph[:len(ph)-1]+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := make(map[int64]Item, len(ids))
	for rows.Next() {
		var it Item
		var kind int
		if err := rows.Scan(&it.ID, &kind, &it.Name, &it.Ext, &it.Size, &it.MtimeNs, &it.PathKey, &it.Attrs); err != nil {
			return nil, err
		}
		it.Kind = media.Kind(kind)
		byID[it.ID] = it
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]Item, 0, len(ids))
	for _, id := range ids {
		if it, ok := byID[id]; ok {
			out = append(out, it)
		}
	}
	return out, nil
}
