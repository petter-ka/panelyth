package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

var ctx = context.Background()

func open(t *testing.T) (*Library, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cfg", "library.db")
	l, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l, path
}

func TestMigrationsApplyOnceAndSurviveReopen(t *testing.T) {
	l, path := open(t)
	if v, _ := l.SchemaVersion(); v != len(migrations) {
		t.Fatalf("schema %d", v)
	}
	if err := l.SetSetting(ctx, "workspace", json.RawMessage(`{"tileSize":"large"}`)); err != nil {
		t.Fatal(err)
	}
	_ = l.Close()
	l2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer l2.Close()
	s, _ := l2.Settings(ctx)
	if string(s["workspace"]) != `{"tileSize":"large"}` {
		t.Fatalf("user data lost across reopen: %v", s)
	}
}

func TestSettingsValidation(t *testing.T) {
	l, _ := open(t)
	for _, c := range []struct {
		key string
		val string
	}{{"", `1`}, {"k", `{broken`}, {string(make([]byte, 200)), `1`}, {"k", `"` + string(make([]byte, MaxSettingBytes)) + `"`}} {
		if err := l.SetSetting(ctx, c.key, json.RawMessage(c.val)); !errors.Is(err, ErrInvalid) {
			t.Errorf("accepted key=%q len=%d", c.key[:min(len(c.key), 10)], len(c.val))
		}
	}
	_ = l.SetSetting(ctx, "a", json.RawMessage(`1`))
	_ = l.SetSetting(ctx, "a", json.RawMessage(`2`))
	if s, _ := l.Settings(ctx); string(s["a"]) != "2" {
		t.Fatalf("overwrite: %v", s)
	}
}

func TestBookmarks(t *testing.T) {
	l, _ := open(t)
	a, _ := l.AddBookmark(ctx, "/photos/2024", "", "")
	b, _ := l.AddBookmark(ctx, "/photos/trips", "Trips", "")
	again, _ := l.AddBookmark(ctx, "/photos/2024", "other label", "")
	if again.ID != a.ID {
		t.Fatal("adding the same path twice must be idempotent")
	}
	list, _ := l.Bookmarks(ctx)
	if len(list) != 2 || list[0].Label != "2024" || list[1].Label != "Trips" {
		t.Fatalf("order/labels: %+v", list)
	}
	if err := l.RemoveBookmark(ctx, b.ID); err != nil {
		t.Fatal(err)
	}
	if err := l.RemoveBookmark(ctx, b.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second remove: %v", err)
	}
	for i := range MaxBookmarks {
		if _, err := l.AddBookmark(ctx, fmt.Sprintf("/b/%d", i), "", ""); err != nil {
			if !errors.Is(err, ErrTooManyItems) || i < MaxBookmarks-1 {
				t.Fatalf("bookmark %d: %v", i, err)
			}
		}
	}
	if _, err := l.AddBookmark(ctx, "/one/too/many", "", ""); !errors.Is(err, ErrTooManyItems) {
		t.Fatalf("limit not enforced: %v", err)
	}
}

func TestBookmarkGroupsEditAndOrder(t *testing.T) {
	l, _ := open(t)
	a, _ := l.AddBookmark(ctx, "/a", "", "Work")
	b, _ := l.AddBookmark(ctx, "/b", "B", "")
	c, _ := l.AddBookmark(ctx, "/c", "C", "Work")
	if a.Group != "Work" || b.Group != "" {
		t.Fatalf("groups on add: %+v %+v", a, b)
	}
	if _, err := l.AddBookmark(ctx, "/d", "", string(make([]byte, MaxGroupLen+1))); !errors.Is(err, ErrInvalid) {
		t.Fatalf("long group accepted: %v", err)
	}

	got, err := l.UpdateBookmark(ctx, Bookmark{ID: b.ID, Path: "/b2", Label: "", Group: "Home"})
	if err != nil || got.Label != "b2" || got.Group != "Home" {
		t.Fatalf("update: %+v %v", got, err)
	}
	if _, err := l.UpdateBookmark(ctx, Bookmark{ID: b.ID, Path: "/a", Label: "x"}); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate path: %v", err)
	}
	if _, err := l.UpdateBookmark(ctx, Bookmark{ID: 999, Path: "/z", Label: "z"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown id: %v", err)
	}

	// c first, then the rest in their old order; unknown ids are ignored.
	if err := l.ReorderBookmarks(ctx, []int64{c.ID, 12345, c.ID}); err != nil {
		t.Fatal(err)
	}
	list, _ := l.Bookmarks(ctx)
	ids := []int64{list[0].ID, list[1].ID, list[2].ID}
	if ids[0] != c.ID || ids[1] != a.ID || ids[2] != b.ID || list[2].Path != "/b2" {
		t.Fatalf("order: %+v", list)
	}
}

// A library.db from before Stage C03 keeps its bookmarks, now in no group.
func TestBookmarkGroupMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library.db")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for v, m := range migrations[:3] {
		if _, err := db.Exec(m); err != nil {
			t.Fatal(err)
		}
		_, _ = db.Exec(`INSERT INTO schema_migrations VALUES (?, 0)`, v+1)
	}
	if _, err := db.Exec(`INSERT INTO bookmarks (path, label, position, created_at) VALUES ('/old', 'Old', 1, 0)`); err != nil {
		t.Fatal(err)
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
	list, _ := l.Bookmarks(ctx)
	if len(list) != 1 || list[0].Path != "/old" || list[0].Label != "Old" || list[0].Group != "" {
		t.Fatalf("migrated bookmarks: %+v", list)
	}
}

func TestRecentKeepsNewestBounded(t *testing.T) {
	l, _ := open(t)
	for i := range MaxRecent + 20 {
		if err := l.TouchRecent(ctx, fmt.Sprintf("/k/%d", i), fmt.Sprintf("/K/%d", i)); err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Millisecond)
	}
	_ = l.TouchRecent(ctx, "/k/30", "/K/30") // re-opened: moves to the top
	r, _ := l.Recent(ctx, 0)
	if len(r) != MaxRecent {
		t.Fatalf("recent not bounded: %d", len(r))
	}
	if r[0].Path != "/K/30" {
		t.Fatalf("newest first: %+v", r[0])
	}
	if top3, _ := l.Recent(ctx, 3); len(top3) != 3 {
		t.Fatalf("limit: %d", len(top3))
	}
}
