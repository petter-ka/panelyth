package find

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"golang.org/x/text/encoding/charmap"

	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/scan"
)

func write(t *testing.T, path string, body []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
}

func newStore(t *testing.T) *index.Store {
	t.Helper()
	st, err := index.Open(filepath.Join(t.TempDir(), "index.db"), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// search runs spec to completion and returns the results' paths relative
// to root, sorted, with "/" separators.
func search(t *testing.T, root string, spec Spec) []string {
	t.Helper()
	if spec.Roots == nil {
		spec.Roots = []string{root}
	}
	c, err := Compile(spec)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	Run(context.Background(), c, Options{}, func(b []index.Found) bool {
		for _, f := range b {
			rel, err := filepath.Rel(root, filepath.Join(f.Dir, f.Name))
			if err != nil {
				t.Fatal(err)
			}
			out = append(out, filepath.ToSlash(rel))
		}
		return true
	}, nil)
	slices.Sort(out)
	return out
}

func noBounds(s Spec) Spec {
	s.MinSize, s.MaxSize = -1, -1
	if s.Depth == 0 {
		s.Depth = -1
	}
	return s
}

func TestMasksExclusionsAndDepth(t *testing.T) {
	root := t.TempDir()
	for _, p := range []string{"a.txt", "b.TXT", "c.md", "sub/d.txt", "sub/bak-1.txt", "sub/deeper/e.txt", "skip/f.txt", "Skip2/g.txt"} {
		write(t, filepath.Join(root, p), []byte("x"))
	}
	got := search(t, root, noBounds(Spec{Mask: "*.txt | bak* skip\\ skip2/"}))
	want := []string{"a.txt", "b.TXT", "sub/d.txt", "sub/deeper/e.txt"}
	if !slices.Equal(got, want) {
		t.Errorf("mask: got %v, want %v", got, want)
	}
	// Folders match by name too when no text or size bound is given.
	if got := search(t, root, noBounds(Spec{Mask: "s*"})); !slices.Equal(got, []string{"Skip2", "skip", "sub"}) {
		t.Errorf("folders: %v", got)
	}
	s := noBounds(Spec{Mask: "s*"})
	s.MinSize = 0
	if got := search(t, root, s); len(got) != 0 {
		t.Errorf("a size bound leaves folders out: %v", got)
	}
	s = noBounds(Spec{Mask: "*.txt"})
	s.Depth = 0
	if got := search(t, root, s); !slices.Equal(got, []string{"a.txt", "b.TXT"}) {
		t.Errorf("depth 0: %v", got)
	}
	s.Depth = 1
	if got := search(t, root, s); len(got) != 6 || slices.Contains(got, "sub/deeper/e.txt") {
		t.Errorf("depth 1: %v", got)
	}
	// Overlapping roots search each folder once.
	s = noBounds(Spec{Roots: []string{root, filepath.Join(root, "sub"), root}, Mask: "d.txt"})
	if got := search(t, root, s); !slices.Equal(got, []string{"sub/d.txt"}) {
		t.Errorf("roots: %v", got)
	}
}

func TestSizeDateAndAttributes(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "small.bin"), make([]byte, 10))
	write(t, filepath.Join(root, "big.bin"), make([]byte, 5000))
	old := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(root, "small.bin"), old, old); err != nil {
		t.Fatal(err)
	}
	s := noBounds(Spec{})
	s.MinSize = 100
	if got := search(t, root, s); !slices.Equal(got, []string{"big.bin"}) {
		t.Errorf("min size: %v", got)
	}
	s = noBounds(Spec{})
	s.MaxSize = 100
	if got := search(t, root, s); !slices.Equal(got, []string{"small.bin"}) {
		t.Errorf("max size: %v", got)
	}
	s = noBounds(Spec{ModifiedBefore: time.Date(2021, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()})
	if got := search(t, root, s); !slices.Equal(got, []string{"small.bin"}) {
		t.Errorf("before: %v", got)
	}
	s = noBounds(Spec{ModifiedAfter: time.Date(2021, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()})
	if got := search(t, root, s); !slices.Equal(got, []string{"big.bin"}) {
		t.Errorf("after: %v", got)
	}
	if err := os.Chmod(filepath.Join(root, "big.bin"), 0o444); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(root, "big.bin"), 0o644) })
	s = noBounds(Spec{AttrsSet: 4}) // read-only
	if got := search(t, root, s); !slices.Equal(got, []string{"big.bin"}) {
		t.Errorf("read-only: %v", got)
	}
	s = noBounds(Spec{AttrsClear: 4})
	if got := search(t, root, s); !slices.Equal(got, []string{"small.bin"}) {
		t.Errorf("not read-only: %v", got)
	}
	for _, bad := range []Spec{{}, {Roots: []string{"relative"}}, {Roots: []string{root}, AttrsSet: 4, AttrsClear: 4},
		{Roots: []string{root}, MinSize: 10, MaxSize: 5}, {Roots: []string{root}, Text: "x", Encodings: []string{"ebcdic"}}} {
		if _, err := Compile(bad); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

func TestLinksAreNeverFollowed(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "dir/file.txt"), []byte("x"))
	loop := filepath.Join(root, "dir", "loop")
	if err := os.Symlink(root, loop); err != nil {
		// Windows without the symlink privilege: a junction needs none.
		if out, jerr := exec.Command("cmd", "/c", "mklink", "/J", loop, root).CombinedOutput(); jerr != nil {
			t.Skipf("neither symlinks nor junctions: %v; %v %s", err, jerr, out)
		}
	}
	done := make(chan []string, 1)
	go func() { done <- search(t, root, noBounds(Spec{})) }()
	select {
	case got := <-done:
		if !slices.Equal(got, []string{"dir", "dir/file.txt", "dir/loop"}) {
			t.Errorf("got %v", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the walk followed a link cycle")
	}
}

func utf16Bytes(s string, le, bom bool) []byte {
	var b []byte
	units := utf16.Encode([]rune(s))
	if bom {
		units = append([]uint16{0xfeff}, units...)
	}
	for _, u := range units {
		if le {
			b = append(b, byte(u), byte(u>>8))
		} else {
			b = append(b, byte(u>>8), byte(u))
		}
	}
	return b
}

func encode(t *testing.T, cm *charmap.Charmap, s string) []byte {
	t.Helper()
	b, err := cm.NewEncoder().Bytes([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestContentEncodings(t *testing.T) {
	root := t.TempDir()
	const de = "Viele Grüße aus der Straße"
	const ru = "Он сказал: привет, мир"
	write(t, filepath.Join(root, "utf8.txt"), []byte(de))
	write(t, filepath.Join(root, "utf16le.txt"), utf16Bytes(de, true, true))
	write(t, filepath.Join(root, "utf16le-nobom.txt"), utf16Bytes("x"+de, true, false))
	write(t, filepath.Join(root, "utf16be.txt"), utf16Bytes(de, false, true))
	write(t, filepath.Join(root, "cp1252.txt"), encode(t, charmap.Windows1252, de))
	write(t, filepath.Join(root, "cp1251.txt"), encode(t, charmap.Windows1251, ru))
	write(t, filepath.Join(root, "koi8.txt"), encode(t, charmap.KOI8R, ru))
	write(t, filepath.Join(root, "ru-utf8.txt"), []byte(ru))
	write(t, filepath.Join(root, "other.txt"), []byte("nothing here"))

	got := search(t, root, noBounds(Spec{Text: "GRÜSSE", Encodings: Encodings}))
	if len(got) != 0 {
		t.Errorf("ß is not folded to SS: %v", got)
	}
	got = search(t, root, noBounds(Spec{Text: "GRÜßE", Encodings: Encodings}))
	want := []string{"cp1252.txt", "utf16be.txt", "utf16le-nobom.txt", "utf16le.txt", "utf8.txt"}
	if !slices.Equal(got, want) {
		t.Errorf("Western, any case: got %v, want %v", got, want)
	}
	if got := search(t, root, noBounds(Spec{Text: "GRÜßE", Encodings: Encodings, CaseSensitive: true})); len(got) != 0 {
		t.Errorf("case-sensitive: %v", got)
	}
	got = search(t, root, noBounds(Spec{Text: "Grüße", Encodings: []string{EncodingUTF8}, CaseSensitive: true}))
	if !slices.Equal(got, []string{"utf8.txt"}) {
		t.Errorf("UTF-8 only: %v", got)
	}
	got = search(t, root, noBounds(Spec{Text: "ПРИВЕТ", Encodings: []string{EncodingUTF8, "windows-1251", "koi8-r"}}))
	if !slices.Equal(got, []string{"cp1251.txt", "koi8.txt", "ru-utf8.txt"}) {
		t.Errorf("Cyrillic: %v", got)
	}
	// The default encodings cannot hold Cyrillic in a single byte; UTF-8
	// and UTF-16 still search.
	got = search(t, root, noBounds(Spec{Text: "привет"}))
	if !slices.Equal(got, []string{"ru-utf8.txt"}) {
		t.Errorf("defaults: %v", got)
	}
}

func TestWholeWordsAndBinary(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "concat.txt"), []byte("concatenate them"))
	write(t, filepath.Join(root, "under.txt"), []byte("cat_food"))
	write(t, filepath.Join(root, "word.txt"), []byte("the cat sat"))
	write(t, filepath.Join(root, "end.txt"), []byte("a cat"))
	write(t, filepath.Join(root, "start.txt"), []byte("Cat."))
	write(t, filepath.Join(root, "umlaut.txt"), []byte("äcat"))
	write(t, filepath.Join(root, "wide.txt"), utf16Bytes("the cat", true, true))
	got := search(t, root, noBounds(Spec{Text: "cat", WholeWords: true}))
	want := []string{"end.txt", "start.txt", "wide.txt", "word.txt"}
	if !slices.Equal(got, want) {
		t.Errorf("whole words: got %v, want %v", got, want)
	}

	bin := append([]byte{0x7f, 'E', 'L', 'F', 0, 0, 1, 0, 0, 0, 2, 0, 0, 0}, []byte("needle")...)
	write(t, filepath.Join(root, "prog.bin"), bin)
	write(t, filepath.Join(root, "text.log"), []byte("a needle in text"))
	if got := search(t, root, noBounds(Spec{Text: "needle", SkipBinary: true})); !slices.Equal(got, []string{"text.log"}) {
		t.Errorf("skip binary: %v", got)
	}
	if got := search(t, root, noBounds(Spec{Text: "needle"})); !slices.Equal(got, []string{"prog.bin", "text.log"}) {
		t.Errorf("binary included: %v", got)
	}
	if !looksBinary(bin) || looksBinary(utf16Bytes("plain text here", true, false)) || looksBinary([]byte("text")) {
		t.Error("binary detection")
	}
}

// Matches straddling chunk boundaries are found with small buffers too, and
// UTF-16 matches only start at even offsets.
func TestChunkBoundaries(t *testing.T) {
	dir := t.TempDir()
	m, err := newMatcher("needle", []string{EncodingUTF8, EncodingUTF16LE}, false, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, at := range []int{0, 1, 59, 60, 61, 63, 64, 65, 127, 200} {
		body := bytes.Repeat([]byte("."), 300)
		copy(body[at:], "NeEdLe")
		path := filepath.Join(dir, "f.txt")
		write(t, path, body)
		for _, size := range []int{m.maxLen + 2*ctxBytes + 1, 64, 100} {
			var read int64
			ok, err := m.searchFile(context.Background(), path, make([]byte, size), false, &read)
			if err != nil || !ok {
				t.Errorf("at %d, buffer %d: %v %v", at, size, ok, err)
			}
		}
	}
	// "needle" in UTF-16LE preceded by one byte: at an odd offset only.
	odd := append([]byte{'x'}, utf16Bytes("needle", true, false)...)
	write(t, filepath.Join(dir, "odd.txt"), odd)
	m16, _ := newMatcher("needle", []string{EncodingUTF16LE}, true, false)
	var read int64
	if ok, _ := m16.searchFile(context.Background(), filepath.Join(dir, "odd.txt"), make([]byte, 64), false, &read); ok {
		t.Error("matched UTF-16 at an odd offset")
	}
}

func TestCancelStopsQuickly(t *testing.T) {
	root := t.TempDir()
	// Large files whose content takes a while to read.
	for i := range 4 {
		f, err := os.Create(filepath.Join(root, "big"+string(rune('a'+i))+".dat"))
		if err != nil {
			t.Fatal(err)
		}
		if err := f.Truncate(256 << 20); err != nil {
			t.Fatal(err)
		}
		_ = f.Close()
	}
	st := newStore(t)
	var final Progress
	done := make(chan struct{})
	m := NewManager(Deps{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Progress: func(p Progress) {
		if p.State != StateRunning {
			final = p
			close(done)
		}
	}})
	defer m.Close()
	c, err := Compile(noBounds(Spec{Roots: []string{root}, Text: "never there"}))
	if err != nil {
		t.Fatal(err)
	}
	id, _, err := m.Start(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	start := time.Now()
	if !m.Cancel(id) {
		t.Fatal("not running")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("no final state")
	}
	if d := time.Since(start); d > 200*time.Millisecond {
		t.Errorf("cancel took %v", d)
	}
	if final.State != StateCancelled {
		t.Errorf("state %q", final.State)
	}
}

type fakeSessions struct{ refreshed chan int64 }

func TestManagerWritesSortsAndRevalidates(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	write(t, filepath.Join(root, "b.txt"), []byte("12345"))
	write(t, filepath.Join(root, "sub/a.txt"), []byte("1"))
	write(t, filepath.Join(root, "sub/deep/c.txt"), []byte("123"))
	write(t, filepath.Join(root, "sub/.hidden.txt"), []byte("1"))
	st := newStore(t)
	if _, err := st.EnsureDir(ctx, root); err != nil {
		t.Fatal(err)
	}
	fs := fakeSessions{refreshed: make(chan int64, 64)}
	m := NewManager(Deps{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Refresh: func(id int64) { fs.refreshed <- id }})
	defer m.Close()
	c, err := Compile(noBounds(Spec{Roots: []string{root}, Mask: "*.txt", Hidden: true}))
	if err != nil {
		t.Fatal(err)
	}
	id, src, err := m.Start(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	m.Attach(id, 7)
	m.Wait(id)
	if src.Len() != 4 {
		t.Fatalf("results: %d", src.Len())
	}
	select {
	case got := <-fs.refreshed:
		if got != 7 {
			t.Errorf("refreshed %d", got)
		}
	default:
		t.Error("no refresh")
	}

	names := func(d index.Descriptor) []string {
		ids, err := src.IDs(ctx, d)
		if err != nil {
			t.Fatal(err)
		}
		items, err := st.LoadItems(ctx, ids)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, it := range items {
			out = append(out, it.Name)
		}
		return out
	}
	byName := index.Descriptor{Scope: index.ScopeAll, ShowHidden: true, Sort: []index.SortKey{{Field: index.SortName}}}
	if got := names(byName); !slices.Equal(got, []string{".hidden.txt", "a.txt", "b.txt", "c.txt"}) {
		t.Errorf("by name: %v", got)
	}
	bySize := index.Descriptor{Scope: index.ScopeAll, Sort: []index.SortKey{{Field: index.SortSize, Desc: true}}}
	if got := names(bySize); !slices.Equal(got, []string{"b.txt", "c.txt", "a.txt"}) {
		t.Errorf("by size, hidden left out: %v", got)
	}
	masked := index.Descriptor{Scope: index.ScopeAll, Sort: []index.SortKey{{Field: index.SortName}}, NameMask: "a*;c*"}
	if got := names(masked); !slices.Equal(got, []string{"a.txt", "c.txt"}) {
		t.Errorf("quick filter: %v", got)
	}

	// Results are index entries under their real folders.
	ids, _ := src.IDs(ctx, byName)
	paths, err := st.EntryPaths(ctx, ids)
	if err != nil || len(paths) != 4 {
		t.Fatalf("paths: %v %v", paths, err)
	}
	if paths[3].Path != filepath.Join(root, "sub", "deep", "c.txt") || paths[3].Kind != media.KindFile {
		t.Errorf("path: %+v", paths[3])
	}

	// A deleted result drops out after the index change reaches the source.
	parents, err := st.ParentDirs(ctx, ids[1:2])
	if err != nil {
		t.Fatal(err)
	}
	if err := st.ApplyChanges(ctx, index.Changes{Removed: ids[1:2]}); err != nil {
		t.Fatal(err)
	}
	for pid, key := range parents {
		m.Changed([]scan.Change{{DirID: pid, DirKey: key}})
	}
	if got := names(byName); !slices.Equal(got, []string{".hidden.txt", "b.txt", "c.txt"}) {
		t.Errorf("after delete: %v", got)
	}
	m.Dropped(7)
	if _, err := m.Source(id); err == nil {
		t.Error("a finished search without sessions is kept")
	}
}

func TestResultLimit(t *testing.T) {
	root := t.TempDir()
	for i := range 30 {
		write(t, filepath.Join(root, strings.Repeat("x", i+1)+".txt"), nil)
	}
	st := newStore(t)
	var final Progress
	m := NewManager(Deps{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), MaxResults: 10,
		Progress: func(p Progress) {
			if p.State != StateRunning {
				final = p
			}
		}})
	defer m.Close()
	c, _ := Compile(noBounds(Spec{Roots: []string{root}}))
	id, src, _ := m.Start(c, nil)
	m.Wait(id)
	if src.Len() != 10 || !final.Truncated || final.State != StateCompleted || final.Matches != 10 || final.FirstMatchMs < 0 {
		t.Errorf("limit: %d %+v", src.Len(), final)
	}
}
