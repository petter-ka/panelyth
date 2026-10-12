package library

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// Stage P06: library.db is the user's data and is never discarded
// (ADR-0016), so a library written by any earlier schema must open in this
// build with its rows intact. Every migration has a seed: rows a user of
// that schema could have. A new migration needs one before the tests pass.
var seeds = [][]string{
	// 1: settings, bookmarks, recent folders.
	{
		`INSERT INTO settings (key, value_json, updated_at) VALUES ('workspace', '{"tileSize":"large"}', 1)`,
		`INSERT INTO bookmarks (path, label, position, created_at) VALUES ('/photos', 'Photos', 1, 1)`,
		`INSERT INTO recent (path_key, path, last_opened_at) VALUES ('/photos', '/photos', 1)`,
	},
	// 2: favorites, ratings, tags.
	{
		`INSERT INTO items (path_key, favorite, rating, updated_at) VALUES ('/photos/a.jpg', 1, 4, 1)`,
		`INSERT INTO tags (name, name_fold, created_at) VALUES ('Trip', 'trip', 1)`,
		`INSERT INTO item_tags (item_id, tag_id) VALUES (1, 1)`,
	},
	// 3: color labels and collections.
	{
		`UPDATE items SET label = 3 WHERE id = 1`,
		`INSERT INTO collections (name, name_fold, position, created_at) VALUES ('Best', 'best', 1, 1)`,
		`INSERT INTO collection_items (collection_id, path_key, position, added_at) VALUES (1, '/photos/a.jpg', 1, 1)`,
	},
	// 4: bookmark groups.
	{`UPDATE bookmarks SET group_name = 'Work' WHERE path = '/photos'`},
	// 5: saved recipes.
	{`INSERT INTO recipes (name, name_fold, json, created_at, updated_at) VALUES ('Web', 'web', '{}', 1, 1)`},
	// 6: saved connections.
	{`INSERT INTO connections (name, name_fold, host, port, tls, created_at, updated_at) VALUES ('NAS', 'nas', 'nas.local', 21, 'none', 1, 1)`},
}

// What each seed must still read as after the upgrade: a query and its one value.
var kept = [][][2]string{
	{
		{`SELECT value_json FROM settings WHERE key = 'workspace'`, `{"tileSize":"large"}`},
		{`SELECT label FROM bookmarks WHERE path = '/photos'`, "Photos"},
		{`SELECT path FROM recent WHERE path_key = '/photos'`, "/photos"},
	},
	{
		{`SELECT favorite || ':' || rating FROM items WHERE path_key = '/photos/a.jpg'`, "1:4"},
		{`SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = 1`, "Trip"},
	},
	{
		{`SELECT label FROM items WHERE id = 1`, "3"},
		{`SELECT c.name FROM collection_items ci JOIN collections c ON c.id = ci.collection_id WHERE ci.path_key = '/photos/a.jpg'`, "Best"},
	},
	{{`SELECT group_name FROM bookmarks WHERE path = '/photos'`, "Work"}},
	{{`SELECT name FROM recipes WHERE name_fold = 'web'`, "Web"}},
	{{`SELECT host || ':' || port FROM connections WHERE name_fold = 'nas'`, "nas.local:21"}},
}

// libraryAt writes a library.db as a build with `schema` migrations left it.
func libraryAt(t *testing.T, schema int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "library.db")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec := func(q string) {
		t.Helper()
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("schema %d: %s: %v", schema, q, err)
		}
	}
	exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`)
	for v := 1; v <= schema; v++ {
		exec(migrations[v-1])
		exec(fmt.Sprintf(`INSERT INTO schema_migrations (version, applied_at) VALUES (%d, 1)`, v))
		for _, q := range seeds[v-1] {
			exec(q)
		}
	}
	return path
}

func TestEveryMigrationHasASeed(t *testing.T) {
	if len(seeds) != len(migrations) || len(kept) != len(migrations) {
		t.Fatalf("%d migrations, %d seeds, %d checks: add rows a user of the new schema could have (Stage P06)",
			len(migrations), len(seeds), len(kept))
	}
}

func TestLibraryFromEverySchemaOpensWithItsData(t *testing.T) {
	for from := 1; from <= len(migrations); from++ {
		t.Run(fmt.Sprintf("schema %d", from), func(t *testing.T) {
			path := libraryAt(t, from)
			l, err := Open(path)
			if err != nil {
				t.Fatalf("a library of schema %d does not open: %v", from, err)
			}
			defer l.Close()
			if v, _ := l.SchemaVersion(); v != len(migrations) {
				t.Fatalf("schema %d after the upgrade, want %d", v, len(migrations))
			}
			for v := 1; v <= from; v++ {
				for _, check := range kept[v-1] {
					var got string
					if err := l.db.QueryRow(check[0]).Scan(&got); err != nil {
						t.Fatalf("data of schema %d lost: %s: %v", v, check[0], err)
					}
					if got != check[1] {
						t.Errorf("data of schema %d changed: %s = %q, want %q", v, check[0], got, check[1])
					}
				}
			}
			// The upgraded library takes writes through the API.
			if err := l.SetSetting(ctx, "shared.updates", json.RawMessage(`{"v":1,"auto":false}`)); err != nil {
				t.Fatal(err)
			}
			if _, err := l.AddBookmark(ctx, "/videos", "Videos", ""); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// A downgrade: an older build finds a library a newer one wrote. It is
// refused, not rewritten; the sidecar then runs without the library and the
// newer build finds everything as it left it.
func TestNewerLibraryIsRefusedAndLeftAlone(t *testing.T) {
	path := libraryAt(t, len(migrations))
	raw, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, 1)`, len(migrations)+1); err != nil {
		t.Fatal(err)
	}
	_ = raw.Close()

	if l, err := Open(path); err == nil {
		_ = l.Close()
		t.Fatal("a library from a newer build was opened")
	} else if !strings.Contains(err.Error(), "newer Panelyth") {
		t.Fatalf("unhelpful error: %v", err)
	}

	raw, err = sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	var version int
	var setting string
	if err := raw.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err := raw.QueryRow(`SELECT value_json FROM settings WHERE key = 'workspace'`).Scan(&setting); err != nil {
		t.Fatal(err)
	}
	if version != len(migrations)+1 || setting != `{"tileSize":"large"}` {
		t.Fatalf("the refused library was changed: schema %d, setting %s", version, setting)
	}
}

// released pins the text of every migration that shipped in a release: an
// installed library ran exactly that text, so a released entry is never
// edited; a change is a new migration. Add a migration's hash here in the
// release that first ships it (docs/RELEASING.md).
var released = []string{
	// 1–6: frozen in Stage P06 for the first release.
	"609e63b2d6b9311ea9eb3cba6328dd2f32beac4dc5422f000bf2f90e0f642bbe",
	"7d354cd1fcb2a9d4529cd012de38e1f0bceb171791312633ecaff3b021c6e6eb",
	"fe585a3a1d1785009c80a930e6c2f45bfa175e459941376f05e5ecfe0680623e",
	"f5d9fcb5d639711b44911d297adb892a0e9d10b1cff7d033a0089924ed235138",
	"7c62884549f6cc0441ff00909823c7915b30238697ded7f598527b89eca82147",
	"12295c20093d32e50f2893323b250a45c26239c3d7e6308fa010bdd5ade4bf6f",
}

func TestReleasedMigrationsAreNeverEdited(t *testing.T) {
	if len(released) > len(migrations) {
		t.Fatalf("%d released migrations, %d in the code: a released migration was removed", len(released), len(migrations))
	}
	for i, want := range released {
		sum := sha256.Sum256([]byte(migrations[i]))
		if got := hex.EncodeToString(sum[:]); got != want {
			t.Errorf("migration %d was edited after its release (sha256 %s, released as %s): add a new migration instead",
				i+1, got, want)
		}
	}
}
