package index

import (
	"path/filepath"
	"slices"
	"testing"

	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/pathkey"
)

// Stage P02 (ADR-0026): every entry is stored; queries choose the scope.

func entryRow(parent DirInfo, name string, kind media.Kind, attrs int) Row {
	if kind == media.KindDir {
		r := dirRow(parent, name)
		r.Attrs = attrs
		return r
	}
	return Row{ParentID: parent.ID, Kind: kind, Name: name, Ext: media.Ext(name), Size: 10, Attrs: attrs,
		PathKey: pathkey.ChildKey(parent.Key, name, false)}
}

func seedAll(t *testing.T) (*Store, DirInfo) {
	t.Helper()
	s, _ := openTest(t)
	root, err := s.EnsureDir(ctx, filepath.Join(t.TempDir(), "mixed"))
	if err != nil {
		t.Fatal(err)
	}
	rows := []Row{
		entryRow(root, "photo.jpg", media.KindImage, 0),
		entryRow(root, "clip.mp4", media.KindVideo, 4),    // read-only media stays visible
		entryRow(root, "notes.txt", media.KindFile, 8),    // archive
		entryRow(root, "setup.exe", media.KindFile, 16),   // executable
		entryRow(root, "Backup.TMP", media.KindFile, 0),   // mask exclusion, case folded
		entryRow(root, "shortcut", media.KindLink, 32),    // link
		entryRow(root, ".secret.jpg", media.KindImage, 1), // hidden media
		entryRow(root, "pagefile.sys", media.KindFile, 2), // system
		entryRow(root, "Albums", media.KindDir, 0),        // folder
		entryRow(root, ".git", media.KindDir, 1),          // hidden folder
		entryRow(root, "[draft].jpg", media.KindImage, 0), // "[" is literal in masks
	}
	if _, err := s.Commit(ctx, s.NextGeneration(), rows, []Finish{{DirID: root.ID, State: ListingComplete}}); err != nil {
		t.Fatal(err)
	}
	return s, root
}

func TestScopeMediaIsTheViewersView(t *testing.T) {
	s, root := seedAll(t)
	byName := []SortKey{{Field: SortName}}
	got := names(t, s, Descriptor{DirID: root.ID, Sort: byName}, root.Key)
	want := []string{"Albums", "[draft].jpg", "clip.mp4", "photo.jpg"}
	if !slices.Equal(got, want) {
		t.Fatalf("default (media) scope: %q, want %q", got, want)
	}
	if got2 := names(t, s, Descriptor{DirID: root.ID, Scope: ScopeMedia, Sort: byName}, root.Key); !slices.Equal(got2, want) {
		t.Fatalf("explicit media scope differs: %q", got2)
	}
	f, err := s.Facets(ctx, Descriptor{DirID: root.ID}, root.Key)
	if err != nil {
		t.Fatal(err)
	}
	if f.Folders != 1 || f.Images != 2 || f.Videos != 1 || f.Files != 0 {
		t.Fatalf("media facets %+v", f)
	}
}

func TestScopeAllAndShowHidden(t *testing.T) {
	s, root := seedAll(t)
	byName := []SortKey{{Field: SortName}}
	got := names(t, s, Descriptor{DirID: root.ID, Scope: ScopeAll, Sort: byName}, root.Key)
	want := []string{"Albums", "[draft].jpg", "Backup.TMP", "clip.mp4", "notes.txt", "photo.jpg", "setup.exe", "shortcut"}
	if !slices.Equal(got, want) {
		t.Fatalf("all scope: %q, want %q", got, want)
	}
	got = names(t, s, Descriptor{DirID: root.ID, Scope: ScopeAll, ShowHidden: true, Sort: byName}, root.Key)
	if len(got) != 11 || got[0] != ".git" || got[1] != "Albums" {
		t.Fatalf("show hidden: folders first, all 11 entries: %q", got)
	}
	f, err := s.Facets(ctx, Descriptor{DirID: root.ID, Scope: ScopeAll}, root.Key)
	if err != nil {
		t.Fatal(err)
	}
	if f.Folders != 1 || f.Images != 2 || f.Videos != 1 || f.Files != 4 {
		t.Fatalf("all facets %+v", f)
	}
}

func TestNameMask(t *testing.T) {
	s, root := seedAll(t)
	q := func(mask string) []string {
		return names(t, s, Descriptor{DirID: root.ID, Scope: ScopeAll, NameMask: mask, Sort: []SortKey{{Field: SortName}}}, root.Key)
	}
	cases := []struct {
		mask string
		want []string
	}{
		{"*.jpg", []string{"Albums", "[draft].jpg", "photo.jpg"}}, // folders always pass
		{"*.JPG;*.mp4", []string{"Albums", "[draft].jpg", "clip.mp4", "photo.jpg"}},
		{"*.*|*.tmp *.exe", []string{"Albums", "[draft].jpg", "clip.mp4", "notes.txt", "photo.jpg", "shortcut"}}, // "*.*" = every file
		{"|*.tmp", []string{"Albums", "[draft].jpg", "clip.mp4", "notes.txt", "photo.jpg", "setup.exe", "shortcut"}},
		{"[draft]*", []string{"Albums", "[draft].jpg"}},
		{"?????.jpg", []string{"Albums", "photo.jpg"}},
	}
	for _, c := range cases {
		if got := q(c.mask); !slices.Equal(got, c.want) {
			t.Errorf("mask %q: got %q want %q", c.mask, got, c.want)
		}
	}
}

func TestSortByAttrsKeepsFoldersFirst(t *testing.T) {
	s, root := seedAll(t)
	got := names(t, s, Descriptor{DirID: root.ID, Scope: ScopeAll, Sort: []SortKey{{Field: SortAttrs, Desc: true}}}, root.Key)
	want := []string{"Albums", "shortcut", "setup.exe", "notes.txt", "clip.mp4", "[draft].jpg", "Backup.TMP", "photo.jpg"}
	if !slices.Equal(got, want) {
		t.Fatalf("attrs desc: %q, want %q", got, want)
	}
}

func TestRecursiveMediaScopeLeavesOutHiddenFolders(t *testing.T) {
	s, root := seedAll(t)
	// The commander opened ".git" and "Albums"; only Albums' media may show
	// up in the viewer's recursive view.
	var git, albums DirInfo
	for _, name := range []string{".git", "Albums"} {
		d, err := s.EnsureDir(ctx, filepath.Join(root.Path, name))
		if err != nil {
			t.Fatal(err)
		}
		if name == ".git" {
			git = d
		} else {
			albums = d
		}
	}
	gen := s.NextGeneration()
	if _, err := s.Commit(ctx, gen, []Row{entryRow(git, "inside-hidden.jpg", media.KindImage, 0)},
		[]Finish{{DirID: git.ID, State: ListingComplete}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Commit(ctx, gen, []Row{entryRow(albums, "inside-album.jpg", media.KindImage, 0)},
		[]Finish{{DirID: albums.ID, State: ListingComplete}}); err != nil {
		t.Fatal(err)
	}
	byName := []SortKey{{Field: SortName}}
	got := names(t, s, Descriptor{DirID: root.ID, Recursive: true, Sort: byName}, root.Key)
	if slices.Contains(got, "inside-hidden.jpg") || !slices.Contains(got, "inside-album.jpg") {
		t.Fatalf("recursive media: %q", got)
	}
	// Opening the hidden folder itself still shows its media (viewer path bar).
	if got := names(t, s, Descriptor{DirID: git.ID, Sort: byName}, git.Key); !slices.Equal(got, []string{"inside-hidden.jpg"}) {
		t.Fatalf("inside a hidden folder: %q", got)
	}
	// The all scope with hidden entries shown includes it recursively.
	got = names(t, s, Descriptor{DirID: root.ID, Recursive: true, Scope: ScopeAll, ShowHidden: true, Sort: byName}, root.Key)
	if !slices.Contains(got, "inside-hidden.jpg") {
		t.Fatalf("recursive all+hidden: %q", got)
	}
}

func TestLoadItemsReturnsAttrs(t *testing.T) {
	s, root := seedAll(t)
	ids, err := s.QueryIDs(ctx, Descriptor{DirID: root.ID, Scope: ScopeAll, NameMask: "setup.exe;shortcut"}, root.Key)
	if err != nil {
		t.Fatal(err)
	}
	items, err := s.LoadItems(ctx, ids)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for _, it := range items {
		got[it.Name] = it.Attrs
	}
	if got["setup.exe"] != 16 || got["shortcut"] != 32 {
		t.Fatalf("attrs %v", got)
	}
}

func TestSourcesAreMediaOnly(t *testing.T) {
	s, root := seedAll(t)
	ids, err := s.QueryIDs(ctx, Descriptor{DirID: root.ID, Scope: ScopeAll, ShowHidden: true}, root.Key)
	if err != nil {
		t.Fatal(err)
	}
	srcs, err := s.Sources(ctx, ids)
	if err != nil {
		t.Fatal(err)
	}
	for _, src := range srcs {
		if !src.Kind.IsMedia() {
			t.Fatalf("non-media source %+v", src)
		}
	}
	if len(srcs) != 4 { // photo, clip, .secret, [draft]
		t.Fatalf("sources %d, want 4", len(srcs))
	}
}
