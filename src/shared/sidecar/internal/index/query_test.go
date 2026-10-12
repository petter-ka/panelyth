package index

import (
	"fmt"
	"log/slog"
	"path/filepath"
	"slices"
	"testing"

	"panelyth/sidecar/internal/media"
)

func seedSearch(t *testing.T) (*Store, DirInfo) {
	t.Helper()
	s, _ := openTest(t)
	root, err := s.EnsureDir(ctx, filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	rows := []Row{
		fileRow(root, "Beach_Sunset.JPG", 300, 3),
		fileRow(root, "beach day.png", 100, 1),
		fileRow(root, "Mountain.jpg", 200, 2),
		fileRow(root, "100%_crop.jpg", 50, 4),
		fileRow(root, "a_b.jpg", 60, 5),
		fileRow(root, "axb.jpg", 70, 6),
		fileRow(root, "Ångström.webp", 80, 7),
		fileRow(root, "beach-clip.mp4", 900, 8),
		dirRow(root, "Beach trips"),
		dirRow(root, "Other"),
	}
	rows[0].BtimeNs, rows[1].BtimeNs, rows[2].BtimeNs = 30, 10, 20
	if _, err := s.Commit(ctx, s.NextGeneration(), rows,
		[]Finish{{DirID: root.ID, State: ListingComplete}}); err != nil {
		t.Fatal(err)
	}
	return s, root
}

func TestSearch(t *testing.T) {
	s, root := seedSearch(t)
	q := func(search string) []string {
		return names(t, s, Descriptor{DirID: root.ID, Search: search, Sort: []SortKey{{Field: SortName}}}, root.Key)
	}
	cases := []struct {
		search string
		want   []string
	}{
		{"beach", []string{"Beach trips", "beach day.png", "beach-clip.mp4", "Beach_Sunset.JPG"}},
		{"BEACH  sun", []string{"Beach_Sunset.JPG"}}, // every term, case-insensitive
		{"100%", []string{"100%_crop.jpg"}},          // % is literal
		{"a_b", []string{"a_b.jpg"}},                 // _ is literal, not "any char"
		{"ångström", []string{"Ångström.webp"}},      // Unicode case folding
		{"nothing-matches", []string{}},
		{"   ", nil}, // blank search = no search
	}
	for _, c := range cases {
		got := q(c.search)
		if c.want == nil {
			if len(got) != 10 {
				t.Errorf("%q: blank search filtered: %q", c.search, got)
			}
			continue
		}
		if !slices.Equal(got, c.want) {
			t.Errorf("%q: got %q want %q", c.search, got, c.want)
		}
	}
}

func TestExtAndKindFiltersWithSearch(t *testing.T) {
	s, root := seedSearch(t)
	got := names(t, s, Descriptor{DirID: root.ID, Exts: []string{"jpg"}, Search: "beach"}, root.Key)
	if want := []string{"Beach trips", "Beach_Sunset.JPG"}; !slices.Equal(got, want) {
		t.Fatalf("ext filter keeps folders unless kinds exclude them: %q", got)
	}
	got = names(t, s, Descriptor{DirID: root.ID, Exts: []string{"jpg"}, Kinds: []media.Kind{media.KindImage}, Search: "beach"}, root.Key)
	if want := []string{"Beach_Sunset.JPG"}; !slices.Equal(got, want) {
		t.Fatalf("kinds + exts: %q", got)
	}
}

func TestCreatedAndDimensionsSort(t *testing.T) {
	s, root := seedSearch(t)
	d := Descriptor{DirID: root.ID, Kinds: []media.Kind{media.KindImage}, Search: "beach", Sort: []SortKey{{Field: SortCreated, Desc: true}}}
	if got, want := names(t, s, d, root.Key), []string{"Beach_Sunset.JPG", "beach day.png"}; !slices.Equal(got, want) {
		t.Fatalf("created desc: %q", got)
	}

	ids, _ := s.QueryIDs(ctx, Descriptor{DirID: root.ID, Kinds: []media.Kind{media.KindImage}, Sort: []SortKey{{Field: SortName}}}, root.Key)
	items, _ := s.LoadItems(ctx, ids)
	byName := map[string]int64{}
	for _, it := range items {
		byName[it.Name] = it.ID
	}
	if err := s.SetDimensions(ctx, []Dimension{
		{ID: byName["Mountain.jpg"], Width: 4000, Height: 3000},
		{ID: byName["axb.jpg"], Width: 100, Height: 100},
		{ID: byName["a_b.jpg"], Width: 1920, Height: 1080},
	}); err != nil {
		t.Fatal(err)
	}
	for _, desc := range []bool{false, true} {
		got := names(t, s, Descriptor{DirID: root.ID, Kinds: []media.Kind{media.KindImage},
			Sort: []SortKey{{Field: SortDimensions, Desc: desc}}}, root.Key)
		known := []string{"axb.jpg", "a_b.jpg", "Mountain.jpg"}
		if desc {
			slices.Reverse(known)
		}
		if !slices.Equal(got[:3], known) {
			t.Fatalf("dimensions desc=%v: known sizes first, got %q", desc, got)
		}
		if len(got) != 7 {
			t.Fatalf("unknown dimensions must still be listed: %q", got)
		}
	}
}

func TestMultiKeySort(t *testing.T) {
	s, _ := openTest(t)
	root, _ := s.EnsureDir(ctx, filepath.Join(t.TempDir(), "r"))
	var rows []Row
	for i, n := range []string{"c.png", "b.jpg", "a.png", "d.jpg"} {
		rows = append(rows, fileRow(root, n, int64(100+i%2), 1))
	}
	if _, err := s.Commit(ctx, s.NextGeneration(), rows, []Finish{{DirID: root.ID, State: ListingComplete}}); err != nil {
		t.Fatal(err)
	}
	d := Descriptor{DirID: root.ID, Sort: []SortKey{{Field: SortType}, {Field: SortName, Desc: true}}}
	if got, want := names(t, s, d, root.Key), []string{"d.jpg", "b.jpg", "c.png", "a.png"}; !slices.Equal(got, want) {
		t.Fatalf("type asc, name desc: %q", got)
	}
}

func TestFacets(t *testing.T) {
	s, root := seedSearch(t)
	f, err := s.Facets(ctx, Descriptor{DirID: root.ID, Exts: []string{"png"}, Kinds: []media.Kind{media.KindVideo}}, root.Key)
	if err != nil {
		t.Fatal(err)
	}
	if f.Folders != 2 || f.Images != 7 || f.Videos != 1 {
		t.Fatalf("filters must not narrow facets: %+v", f)
	}
	if f.Exts[0] != (ExtCount{"jpg", 5}) {
		t.Fatalf("most common first: %+v", f.Exts)
	}
	f, _ = s.Facets(ctx, Descriptor{DirID: root.ID, Search: "beach"}, root.Key)
	if f.Folders != 1 || f.Images != 2 || f.Videos != 1 || len(f.Exts) != 3 {
		t.Fatalf("facets follow the search: %+v", f)
	}
}

func TestSummarizeAndPaths(t *testing.T) {
	s, root := seedSearch(t)
	ids, _ := s.QueryIDs(ctx, Descriptor{DirID: root.ID, Sort: []SortKey{{Field: SortName}}}, root.Key)
	sum, err := s.Summarize(ctx, append(slices.Clone(ids), 999999))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Count != 10 || sum.Dirs != 2 || sum.Images != 7 || sum.Videos != 1 || sum.Bytes != 1760 {
		t.Fatalf("summary %+v", sum)
	}
	paths, err := s.EntryPaths(ctx, []int64{ids[1], 999999, ids[0]})
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 2 || paths[0].Path != filepath.Join(root.Path, "Other") || paths[1].Path != filepath.Join(root.Path, "Beach trips") {
		t.Fatalf("paths in request order, missing skipped: %+v", paths)
	}
	file, _ := s.EntryPaths(ctx, []int64{ids[len(ids)-1]})
	if filepath.Dir(file[0].Path) != root.Path {
		t.Fatalf("file path %+v", file)
	}
	// Briefs (Stage 16): the same entries without their paths, in request order.
	briefs, err := s.Briefs(ctx, []int64{ids[len(ids)-1], 999999, ids[1], ids[0]})
	if err != nil {
		t.Fatal(err)
	}
	if len(briefs) != 3 || briefs[0].ID != ids[len(ids)-1] || briefs[0].Name != filepath.Base(file[0].Path) ||
		briefs[0].ParentID != root.ID || briefs[0].Kind == media.KindDir ||
		briefs[1].Name != "Other" || briefs[1].Kind != media.KindDir || briefs[2].Name != "Beach trips" {
		t.Fatalf("briefs in request order, missing skipped: %+v", briefs)
	}
	var total int64
	all, _ := s.Briefs(ctx, ids)
	for _, b := range all {
		total += b.Size
	}
	if len(all) != 10 || total != sum.Bytes {
		t.Fatalf("briefs of the folder: %d entries, %d bytes", len(all), total)
	}
	if none, err := s.Briefs(ctx, nil); err != nil || len(none) != 0 {
		t.Fatalf("no ids: %v %v", none, err)
	}
}

// TestUserSortAndFilter covers both join shapes of ADR-0021's user data:
// RIGHT JOIN for sorts (unannotated entries kept) and CROSS JOIN for filters.
func TestUserSortAndFilter(t *testing.T) {
	s, _ := openTest(t)
	root, err := s.EnsureDir(ctx, filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	rows := []Row{
		fileRow(root, "a.jpg", 1, 1),
		fileRow(root, "b.jpg", 1, 1),
		fileRow(root, "c.jpg", 1, 1),
		fileRow(root, "d.jpg", 1, 1),
		dirRow(root, "Sub"),
	}
	if _, err := s.Commit(ctx, s.NextGeneration(), rows, []Finish{{DirID: root.ID, State: ListingComplete}}); err != nil {
		t.Fatal(err)
	}
	user := []UserRow{
		{Key: rows[0].PathKey, Favorite: true, Rating: 2, FirstTag: "beach", Match: true},
		{Key: rows[1].PathKey, Rating: 5, FirstTag: "city"},
		{Key: rows[3].PathKey, Favorite: true},
		// An annotation with no entry in scope must not produce a row.
		{Key: "/nowhere/z.jpg", Favorite: true, Rating: 5, Match: true},
	}
	for _, tc := range []struct {
		name string
		d    Descriptor
		want []string
	}{
		{"sort-rating", Descriptor{Sort: []SortKey{{Field: SortRating, Desc: true}}}, []string{"Sub", "b.jpg", "a.jpg", "c.jpg", "d.jpg"}},
		{"sort-tags", Descriptor{Sort: []SortKey{{Field: SortTags}}}, []string{"Sub", "a.jpg", "b.jpg", "c.jpg", "d.jpg"}},
		{"sort-tags-desc", Descriptor{Sort: []SortKey{{Field: SortTags, Desc: true}}}, []string{"Sub", "b.jpg", "a.jpg", "c.jpg", "d.jpg"}},
		{"sort-favorite", Descriptor{Sort: []SortKey{{Field: SortFavorite, Desc: true}}}, []string{"Sub", "a.jpg", "d.jpg", "b.jpg", "c.jpg"}},
		{"filter-favorites", Descriptor{FavoriteOnly: true}, []string{"a.jpg", "d.jpg"}},
		{"filter-rating", Descriptor{MinRating: 3}, []string{"b.jpg"}},
		{"filter-tag", Descriptor{Tags: []string{"beach"}, Sort: []SortKey{{Field: SortRating}}}, []string{"a.jpg"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := tc.d
			d.DirID, d.User = root.ID, user
			if got := names(t, s, d, root.Key); !slices.Equal(got, tc.want) {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestEntryDetail(t *testing.T) {
	s, root := seedSearch(t)
	ids, _ := s.QueryIDs(ctx, Descriptor{DirID: root.ID, Search: "sunset"}, root.Key)
	d, err := s.Entry(ctx, ids[0])
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "Beach_Sunset.JPG" || d.Ext != "jpg" || d.Size != 300 || d.BtimeNs != 30 || d.Width != 0 || d.ParentID != root.ID {
		t.Fatalf("detail %+v", d)
	}
	r, _ := s.Entry(ctx, root.ID)
	if r.Kind != media.KindDir || !r.Listed || r.Path != root.Path {
		t.Fatalf("folder detail %+v", r)
	}
	if _, err := s.Entry(ctx, 424242); err != ErrNotFound {
		t.Fatalf("missing: %v", err)
	}
}

func BenchmarkSearch100k(b *testing.B) {
	s, err := Open(filepath.Join(b.TempDir(), "index.db"), slog.New(slog.DiscardHandler))
	if err != nil {
		b.Fatal(err)
	}
	defer s.Close()
	root, _ := s.EnsureDir(ctx, filepath.Join(b.TempDir(), "big"))
	rows := make([]Row, 0, 100_000)
	for i := range 100_000 {
		rows = append(rows, fileRow(root, fmt.Sprintf("IMG_%06d_%s.jpg", i, []string{"beach", "city", "forest", "family"}[i%4]), int64(i), int64(i)))
	}
	if _, err := s.Commit(ctx, s.NextGeneration(), rows, []Finish{{DirID: root.ID, State: ListingComplete}}); err != nil {
		b.Fatal(err)
	}
	for _, bc := range []struct{ name, search string }{{"common", "beach"}, {"rare", "img_04242"}, {"none", "zzz"}} {
		b.Run(bc.name, func(b *testing.B) {
			for b.Loop() {
				if _, err := s.QueryIDs(ctx, Descriptor{DirID: root.ID, Search: bc.search, Sort: []SortKey{{Field: SortName}}}, root.Key); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
	b.Run("facets", func(b *testing.B) {
		for b.Loop() {
			if _, err := s.Facets(ctx, Descriptor{DirID: root.ID}, root.Key); err != nil {
				b.Fatal(err)
			}
		}
	})
}

// BenchmarkUserSort100k measures ADR-0021's json_each join: 100k files, 10k
// of them annotated, sorted or filtered by user data.
func BenchmarkUserSort100k(b *testing.B) {
	s, err := Open(filepath.Join(b.TempDir(), "index.db"), slog.New(slog.DiscardHandler))
	if err != nil {
		b.Fatal(err)
	}
	defer s.Close()
	root, _ := s.EnsureDir(ctx, filepath.Join(b.TempDir(), "big"))
	rows := make([]Row, 0, 100_000)
	user := make([]UserRow, 0, 10_000)
	for i := range 100_000 {
		r := fileRow(root, fmt.Sprintf("IMG_%06d.jpg", i), int64(i), int64(i))
		rows = append(rows, r)
		if i%10 == 0 {
			user = append(user, UserRow{Key: r.PathKey, Favorite: i%20 == 0, Rating: i % 6,
				FirstTag: []string{"", "beach", "city"}[i%3], Match: i%3 == 1})
		}
	}
	if _, err := s.Commit(ctx, s.NextGeneration(), rows, []Finish{{DirID: root.ID, State: ListingComplete}}); err != nil {
		b.Fatal(err)
	}
	for _, bc := range []struct {
		name string
		d    Descriptor
	}{
		{"sort-rating", Descriptor{Sort: []SortKey{{Field: SortRating, Desc: true}}}},
		{"sort-tags", Descriptor{Sort: []SortKey{{Field: SortTags}}}},
		{"filter-favorites", Descriptor{FavoriteOnly: true, Sort: []SortKey{{Field: SortName}}}},
		{"filter-tag", Descriptor{Tags: []string{"beach"}, Sort: []SortKey{{Field: SortName}}}},
	} {
		b.Run(bc.name, func(b *testing.B) {
			d := bc.d
			d.DirID, d.User = root.ID, user
			for b.Loop() {
				if _, err := s.QueryIDs(ctx, d, root.Key); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
