package index

import (
	"context"
	"database/sql"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"

	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/pathkey"
)

func openTest(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "db", "index.db")
	s, err := Open(path, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, path
}

var ctx = context.Background()

func fileRow(parent DirInfo, name string, size, mtime int64) Row {
	kind, ext, _ := media.Classify(name)
	return Row{ParentID: parent.ID, Kind: kind, Name: name, Ext: ext, Size: size, MtimeNs: mtime,
		PathKey: pathkey.ChildKey(parent.Key, name, false)}
}

func dirRow(parent DirInfo, name string) Row {
	return Row{ParentID: parent.ID, Kind: media.KindDir, Name: name,
		Path: filepath.Join(parent.Path, name), PathKey: pathkey.ChildKey(parent.Key, name, true)}
}

func names(t *testing.T, s *Store, d Descriptor, key string) []string {
	t.Helper()
	ids, err := s.QueryIDs(ctx, d, key)
	if err != nil {
		t.Fatal(err)
	}
	items, err := s.LoadItems(ctx, ids)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.Name
	}
	return out
}

func TestListingReconcileAndOrdering(t *testing.T) {
	s, _ := openTest(t)
	root, err := s.EnsureDir(ctx, filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	gen := s.NextGeneration()
	dirs, err := s.Commit(ctx, gen, []Row{
		fileRow(root, "IMG_10.jpg", 300, 3),
		fileRow(root, "IMG_2.jpg", 100, 1),
		dirRow(root, "Zeta"),
		fileRow(root, "clip.mp4", 200, 2),
		dirRow(root, "alpha"),
	}, []Finish{{DirID: root.ID, State: ListingComplete, ChildDirs: 2, ChildMedia: 3}})
	if err != nil {
		t.Fatal(err)
	}
	if len(dirs) != 2 || dirs[0].ID == 0 {
		t.Fatalf("dir refs %+v", dirs)
	}

	d := Descriptor{DirID: root.ID, Sort: []SortKey{{Field: SortName}}}
	if got, want := names(t, s, d, root.Key), []string{"alpha", "Zeta", "clip.mp4", "IMG_2.jpg", "IMG_10.jpg"}; !slices.Equal(got, want) {
		t.Fatalf("name asc: %q", got)
	}
	d.Sort = []SortKey{{Field: SortSize, Desc: true}}
	if got, want := names(t, s, d, root.Key), []string{"alpha", "Zeta", "IMG_10.jpg", "clip.mp4", "IMG_2.jpg"}; !slices.Equal(got, want) {
		t.Fatalf("size desc (dirs first): %q", got)
	}
	d.Kinds = []media.Kind{media.KindVideo}
	if got := names(t, s, d, root.Key); !slices.Equal(got, []string{"clip.mp4"}) {
		t.Fatalf("kind filter: %q", got)
	}

	// Second listing: IMG_2 removed, IMG_10 modified, new file added.
	gen2 := s.NextGeneration()
	if gen2 <= gen {
		t.Fatal("generations must increase")
	}
	if _, err := s.Commit(ctx, gen2, []Row{
		fileRow(root, "IMG_10.jpg", 999, 9),
		fileRow(root, "clip.mp4", 200, 2),
		fileRow(root, "new.png", 1, 1),
		dirRow(root, "Zeta"),
		dirRow(root, "alpha"),
	}, []Finish{{DirID: root.ID, State: ListingComplete}}); err != nil {
		t.Fatal(err)
	}
	all := names(t, s, Descriptor{DirID: root.ID}, root.Key)
	if slices.Contains(all, "IMG_2.jpg") || !slices.Contains(all, "new.png") {
		t.Fatalf("reconcile failed: %q", all)
	}
	info, err := s.Dir(ctx, root.ID)
	if err != nil || info.ListingState != ListingComplete || info.LastListedAt == 0 {
		t.Fatalf("dir state %+v %v", info, err)
	}
}

func TestIncompleteListingDeletesNothing(t *testing.T) {
	s, _ := openTest(t)
	root, _ := s.EnsureDir(ctx, filepath.Join(t.TempDir(), "r"))
	_, _ = s.Commit(ctx, s.NextGeneration(), []Row{fileRow(root, "a.jpg", 1, 1), fileRow(root, "b.jpg", 1, 1)},
		[]Finish{{DirID: root.ID, State: ListingComplete}})
	// A cancelled rescan saw only a.jpg and never completed.
	if _, err := s.Commit(ctx, s.NextGeneration(), []Row{fileRow(root, "a.jpg", 1, 1)}, nil); err != nil {
		t.Fatal(err)
	}
	if got := names(t, s, Descriptor{DirID: root.ID}, root.Key); !slices.Equal(got, []string{"a.jpg", "b.jpg"}) {
		t.Fatalf("cancelled listing deleted rows: %q", got)
	}
	// A failed listing records the error and keeps rows.
	if _, err := s.Commit(ctx, s.NextGeneration(), nil, []Finish{{DirID: root.ID, State: ListingError, ErrCode: "PERMISSION_DENIED"}}); err != nil {
		t.Fatal(err)
	}
	if got := names(t, s, Descriptor{DirID: root.ID}, root.Key); len(got) != 2 {
		t.Fatalf("failed listing deleted rows: %q", got)
	}
}

func TestRecursiveSubtreeAndCascade(t *testing.T) {
	s, _ := openTest(t)
	root, _ := s.EnsureDir(ctx, filepath.Join(t.TempDir(), "r"))
	gen := s.NextGeneration()
	dirs, _ := s.Commit(ctx, gen, []Row{fileRow(root, "top.jpg", 1, 1), dirRow(root, "sub")},
		[]Finish{{DirID: root.ID, State: ListingComplete}})
	sub := DirInfo{ID: dirs[0].ID, Path: dirs[0].Path, Key: dirs[0].Key}
	_, _ = s.Commit(ctx, gen, []Row{fileRow(sub, "deep.png", 1, 1)}, []Finish{{DirID: sub.ID, State: ListingComplete}})

	// A sibling whose name shares the prefix must stay outside the subtree.
	sibling, _ := s.EnsureDir(ctx, root.Path+"x")
	_, _ = s.Commit(ctx, gen, []Row{fileRow(sibling, "other.jpg", 1, 1)}, []Finish{{DirID: sibling.ID, State: ListingComplete}})

	got := names(t, s, Descriptor{DirID: root.ID, Recursive: true, Sort: []SortKey{{Field: SortName}}}, root.Key)
	if !slices.Equal(got, []string{"deep.png", "top.jpg"}) {
		t.Fatalf("recursive: %q", got)
	}
	// Removing "sub" from the root listing cascades to its children.
	_, _ = s.Commit(ctx, s.NextGeneration(), []Row{fileRow(root, "top.jpg", 1, 1)}, []Finish{{DirID: root.ID, State: ListingComplete}})
	if got := names(t, s, Descriptor{DirID: root.ID, Recursive: true}, root.Key); !slices.Equal(got, []string{"top.jpg"}) {
		t.Fatalf("cascade: %q", got)
	}
}

func TestEnsureDirRelinksToParent(t *testing.T) {
	s, _ := openTest(t)
	base := t.TempDir()
	child, _ := s.EnsureDir(ctx, filepath.Join(base, "p", "c"))
	parent, _ := s.EnsureDir(ctx, filepath.Join(base, "p"))
	dirs, err := s.Commit(ctx, s.NextGeneration(), []Row{dirRow(parent, "c")}, []Finish{{DirID: parent.ID, State: ListingComplete}})
	if err != nil {
		t.Fatal(err)
	}
	if dirs[0].ID != child.ID {
		t.Fatalf("child re-created (%d) instead of relinked (%d)", dirs[0].ID, child.ID)
	}
	again, _ := s.EnsureDir(ctx, filepath.Join(base, "p", "c"))
	if again.ID != child.ID {
		t.Fatal("EnsureDir must be idempotent")
	}
}

func TestCorruptIndexIsRecreated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.db")
	if err := os.WriteFile(path, []byte("definitely not sqlite"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("corrupt index should be recreated: %v", err)
	}
	defer s.Close()
	if _, err := s.EnsureDir(ctx, filepath.Join(t.TempDir(), "x")); err != nil {
		t.Fatal(err)
	}
}

// An index.db from Stage 06 (schema v3) lacks the v4 metadata columns; it
// is recreated (version check, and prepare failure as a backstop), so
// indexing keeps working after an upgrade.
func TestOlderSchemaIsRecreated(t *testing.T) {
	s, path := openTest(t)
	_ = s.Close()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`ALTER TABLE entries DROP COLUMN duration_ms`,
		`ALTER TABLE entries DROP COLUMN meta_state`,
		`UPDATE meta SET value = '3' WHERE key = 'schema_version'`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	_ = db.Close()
	s, err = Open(path, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	root, _ := s.EnsureDir(ctx, filepath.Join(t.TempDir(), "r"))
	if _, err := s.Commit(ctx, s.NextGeneration(), []Row{fileRow(root, "a.jpg", 1, 1)}, nil); err != nil {
		t.Fatalf("commit after upgrade: %v", err)
	}
}

// A downgrade (Stage P06): an index.db a newer build wrote is as
// disposable as an older one. It is recreated, never read with the wrong
// schema, and indexing works at once.
func TestNewerSchemaIsRecreated(t *testing.T) {
	s, path := openTest(t)
	root, _ := s.EnsureDir(ctx, filepath.Join(t.TempDir(), "r"))
	if _, err := s.Commit(ctx, s.NextGeneration(), []Row{fileRow(root, "old.jpg", 1, 1)}, nil); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, strconv.Itoa(schemaVersion+1)); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	s, err = Open(path, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("an index from a newer build should be recreated: %v", err)
	}
	defer s.Close()
	var entries int
	if err := s.r.QueryRow(`SELECT COUNT(*) FROM entries`).Scan(&entries); err != nil {
		t.Fatal(err)
	}
	if entries != 0 {
		t.Fatalf("%d rows of the newer schema were kept", entries)
	}
	root, _ = s.EnsureDir(ctx, filepath.Join(t.TempDir(), "r2"))
	if _, err := s.Commit(ctx, s.NextGeneration(), []Row{fileRow(root, "a.jpg", 1, 1)}, nil); err != nil {
		t.Fatalf("commit after the downgrade: %v", err)
	}
}

func TestGenerationsSurviveReopen(t *testing.T) {
	s, path := openTest(t)
	root, _ := s.EnsureDir(ctx, filepath.Join(t.TempDir(), "r"))
	g := s.NextGeneration()
	_, _ = s.Commit(ctx, g, nil, []Finish{{DirID: root.ID, State: ListingComplete}})
	_ = s.Close()
	s2, err := Open(path, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if next := s2.NextGeneration(); next <= g {
		t.Fatalf("generation reused after reopen: %d <= %d", next, g)
	}
}
