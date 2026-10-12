package library

import (
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestMigrationFromVersion1KeepsUserData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library.db")
	// A Stage 05 database: only migration 1 applied.
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
		migrations[0],
		`INSERT INTO schema_migrations VALUES (1, 0)`,
		`INSERT INTO bookmarks (path, label, position, created_at) VALUES ('/p', 'p', 1, 0)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	_ = db.Close()
	l, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if v, _ := l.SchemaVersion(); v != len(migrations) {
		t.Fatalf("schema %d", v)
	}
	if b, _ := l.Bookmarks(ctx); len(b) != 1 {
		t.Error("bookmark lost by migration")
	}
	if err := l.SetFavorite(ctx, []string{"/p/a.jpg"}, true, nil); err != nil {
		t.Fatal(err)
	}
}

func count(t *testing.T, l *Library, q string) int {
	t.Helper()
	var n int
	if err := l.db.QueryRow(q).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestFavoriteRatingTagsAndPruning(t *testing.T) {
	l, _ := open(t)
	keys := []string{"/a/1.jpg", "/a/2.jpg", "/a/3.jpg"}
	var progress int
	if err := l.SetFavorite(ctx, keys[:2], true, func(n int) { progress += n }); err != nil {
		t.Fatal(err)
	}
	if progress != 2 {
		t.Errorf("progress %d", progress)
	}
	if err := l.SetRating(ctx, keys[1:], 4, nil); err != nil {
		t.Fatal(err)
	}
	if err := l.SetRating(ctx, keys, 6, nil); !errors.Is(err, ErrInvalid) {
		t.Errorf("rating 6: %v", err)
	}
	if err := l.SetTag(ctx, keys, " Holiday ", true, nil); err != nil {
		t.Fatal(err)
	}
	if err := l.SetTag(ctx, keys[2:], "beach", true, nil); err != nil {
		t.Fatal(err)
	}
	if err := l.SetTag(ctx, keys[:1], "HOLIDAY", true, nil); err != nil { // same tag, other case
		t.Fatal(err)
	}
	ann, err := l.Annotations(ctx, append(keys, "/a/none.jpg"), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(ann) != 3 || !ann["/a/1.jpg"].Favorite || ann["/a/1.jpg"].Rating != 0 || ann["/a/2.jpg"].Rating != 4 {
		t.Errorf("annotations %+v", ann)
	}
	if got := fmt.Sprint(ann["/a/3.jpg"].Tags); got != "[beach Holiday]" {
		t.Errorf("tags of 3: %s", got)
	}
	tags, _ := l.Tags(ctx)
	if len(tags) != 2 || tags[1].Name != "Holiday" || tags[1].Count != 3 {
		t.Errorf("tags %+v", tags)
	}

	// Clearing everything on an item deletes its row.
	if err := l.SetFavorite(ctx, keys[:1], false, nil); err != nil {
		t.Fatal(err)
	}
	if err := l.SetTag(ctx, keys[:1], "holiday", false, nil); err != nil {
		t.Fatal(err)
	}
	if n := count(t, l, `SELECT COUNT(*) FROM items`); n != 2 {
		t.Errorf("items after clearing one: %d", n)
	}
	// Removing a tag nobody has is a no-op, not an error.
	if err := l.SetTag(ctx, keys, "never-created", false, nil); err != nil {
		t.Error(err)
	}
	if _, err := CleanTag("  "); !errors.Is(err, ErrInvalid) {
		t.Error("blank tag accepted")
	}
	if err := l.DeleteTag(ctx, tags[0].ID); err != nil { // beach: 3.jpg keeps rating + Holiday
		t.Fatal(err)
	}
	if err := l.DeleteTag(ctx, tags[0].ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second delete: %v", err)
	}
}

func TestScopeFiltersAndSortKey(t *testing.T) {
	l, _ := open(t)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(l.SetTag(ctx, []string{"/d/a.jpg", "/d/b.jpg"}, "zebra", true, nil))
	must(l.SetTag(ctx, []string{"/d/b.jpg"}, "apple", true, nil))
	must(l.SetFavorite(ctx, []string{"/d/c.jpg", "/other/x.jpg"}, true, nil))
	rows, err := l.Scope(ctx, "/d/", "/d0", nil)
	must(err)
	got := map[string]ScopeRow{}
	for _, r := range rows {
		got[r.Key] = r
	}
	if len(got) != 3 || got["/d/b.jpg"].FirstTag != "apple" || got["/d/c.jpg"].FirstTag != "" || !got["/d/c.jpg"].Match {
		t.Errorf("scope %+v", rows)
	}
	rows, err = l.Scope(ctx, "/d/", "/d0", []string{"Zebra", "apple"})
	must(err)
	matched := 0
	for _, r := range rows {
		if r.Match {
			matched++
			if r.Key != "/d/b.jpg" {
				t.Errorf("unexpected match %s", r.Key)
			}
		}
	}
	if matched != 1 {
		t.Errorf("matched %d", matched)
	}
	rows, err = l.Scope(ctx, "/d/", "/d0", []string{"unknown"})
	must(err)
	for _, r := range rows {
		if r.Match {
			t.Errorf("unknown tag matched %s", r.Key)
		}
	}
}

func TestRekeyAndForget(t *testing.T) {
	l, _ := open(t)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(l.SetRating(ctx, []string{"/a/x.jpg", "/a/sub/y.jpg", "/a/sub/deep/z.jpg", "/b/x.jpg", "/a/subway.jpg"}, 3, nil))
	must(l.SetFavorite(ctx, []string{"/b/x.jpg"}, true, nil))
	// File move onto an annotated file replaces its metadata.
	must(l.Rekey(ctx, "/a/x.jpg", "/b/x.jpg"))
	ann, _ := l.Annotations(ctx, []string{"/a/x.jpg", "/b/x.jpg"}, false)
	if _, ok := ann["/a/x.jpg"]; ok || ann["/b/x.jpg"].Favorite || ann["/b/x.jpg"].Rating != 3 {
		t.Errorf("file rekey %+v", ann)
	}
	// Folder rename rewrites the subtree only (not "/a/subway.jpg").
	must(l.Rekey(ctx, "/a/sub/", "/c/renamed/"))
	ann, _ = l.Annotations(ctx, []string{"/c/renamed/y.jpg", "/c/renamed/deep/z.jpg", "/a/subway.jpg", "/a/sub/y.jpg"}, false)
	if len(ann) != 3 || ann["/c/renamed/deep/z.jpg"].Rating != 3 {
		t.Errorf("folder rekey %+v", ann)
	}
	must(l.Forget(ctx, []string{"/c/renamed/", "/a/subway.jpg"}))
	if n := count(t, l, `SELECT COUNT(*) FROM items`); n != 1 {
		t.Errorf("items after forget: %d", n)
	}
}

func BenchmarkFavorite100k(b *testing.B) {
	l, err := Open(filepath.Join(b.TempDir(), "library.db"))
	if err != nil {
		b.Fatal(err)
	}
	defer l.Close()
	keys := make([]string, 100_000)
	for i := range keys {
		keys[i] = fmt.Sprintf("/photos/flat/IMG_%06d.jpg", i)
	}
	b.ResetTimer()
	for i := range b.N {
		if err := l.SetFavorite(ctx, keys, i%2 == 0, nil); err != nil {
			b.Fatal(err)
		}
	}
}

// A batch of renames is applied in its order, in one transaction: a chain
// (b → c, then a → b) keeps each file's metadata with the file.
func TestRekeyMany(t *testing.T) {
	l, _ := open(t)
	if err := l.SetRating(ctx, []string{"/d/a.jpg"}, 1, nil); err != nil {
		t.Fatal(err)
	}
	if err := l.SetRating(ctx, []string{"/d/b.jpg"}, 2, nil); err != nil {
		t.Fatal(err)
	}
	pairs := [][2]string{{"/d/b.jpg", "/d/c.jpg"}, {"/d/a.jpg", "/d/b.jpg"}, {"/d/same.jpg", "/d/same.jpg"}, {"/d/none.jpg", "/d/other.jpg"}}
	if err := l.RekeyMany(ctx, pairs); err != nil {
		t.Fatal(err)
	}
	ann, _ := l.Annotations(ctx, []string{"/d/a.jpg", "/d/b.jpg", "/d/c.jpg"}, false)
	if len(ann) != 2 || ann["/d/b.jpg"].Rating != 1 || ann["/d/c.jpg"].Rating != 2 {
		t.Fatalf("after the batch: %+v", ann)
	}
	if err := l.RekeyMany(ctx, nil); err != nil {
		t.Fatal(err)
	}
}
