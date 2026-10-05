package library

import (
	"context"
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
	a, _ := l.AddBookmark(ctx, "/photos/2024", "")
	b, _ := l.AddBookmark(ctx, "/photos/trips", "Trips")
	again, _ := l.AddBookmark(ctx, "/photos/2024", "other label")
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
		if _, err := l.AddBookmark(ctx, fmt.Sprintf("/b/%d", i), ""); err != nil {
			if !errors.Is(err, ErrTooManyItems) || i < MaxBookmarks-1 {
				t.Fatalf("bookmark %d: %v", i, err)
			}
		}
	}
	if _, err := l.AddBookmark(ctx, "/one/too/many", ""); !errors.Is(err, ErrTooManyItems) {
		t.Fatalf("limit not enforced: %v", err)
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
