package fonts

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"golang.org/x/image/font/gofont/gomedium"
	"golang.org/x/image/font/gofont/gosmallcaps"
	"golang.org/x/image/font/gofont/gosmallcapsitalic"
	"golang.org/x/image/font/sfnt"
)

func familyOf(t *testing.T, f *sfnt.Font) string {
	t.Helper()
	var buf sfnt.Buffer
	name, err := f.Name(&buf, sfnt.NameIDFamily)
	if err != nil {
		t.Fatal(err)
	}
	return name
}

func TestBuiltInFamilies(t *testing.T) {
	l := New()
	if got := l.Families(context.Background()); !slices.Equal(got, []string{Default, Mono}) {
		t.Fatalf("families %v", got)
	}
	regular, err := l.Font(Default, false, false)
	if err != nil {
		t.Fatal(err)
	}
	// The same font object every time: it is parsed once.
	if again, _ := l.Font("go", false, false); again != regular {
		t.Error("the default family is parsed twice, or names are case sensitive")
	}
	bold, _ := l.Font(Default, true, false)
	italic, _ := l.Font(Default, false, true)
	both, _ := l.Font(Default, true, true)
	if bold == regular || italic == regular || both == bold || both == italic {
		t.Error("the four styles of the default family are not four fonts")
	}
	// Mono has no italic: the closest style is used.
	mono, _ := l.Font(Mono, false, false)
	monoItalic, _ := l.Font(Mono, false, true)
	monoBoldItalic, _ := l.Font(Mono, true, true)
	monoBold, _ := l.Font(Mono, true, false)
	if monoItalic != mono || monoBoldItalic != monoBold || mono == monoBold {
		t.Error("mono styles")
	}
	// An empty or unknown family is the default, never an error.
	for _, name := range []string{"", "No Such Family", "../../etc/passwd"} {
		if f, err := l.Font(name, false, false); err != nil || f != regular {
			t.Errorf("font %q: %v", name, err)
		}
	}
	if !l.Known("GO MONO") || l.Known("Arial Unicode Nowhere") {
		t.Error("Known")
	}
}

func TestScanReadsNamesAndSkipsWhatIsNotAFont(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "more")
	deep := filepath.Join(dir, "a", "b", "c", "d", "e")
	for _, d := range []string{sub, deep} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path string, data []byte) {
		t.Helper()
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(dir, "smallcaps.ttf"), gosmallcaps.TTF)
	write(filepath.Join(dir, "smallcaps-italic.TTF"), gosmallcapsitalic.TTF)
	write(filepath.Join(sub, "medium.otf"), gomedium.TTF)
	write(filepath.Join(dir, "broken.ttf"), []byte("this is not a font, whatever its name says"))
	write(filepath.Join(dir, "empty.ttf"), nil)
	write(filepath.Join(dir, "truncated.ttf"), gomedium.TTF[:200])
	write(filepath.Join(dir, "notes.txt"), gomedium.TTF)
	// Too deep to be looked at.
	write(filepath.Join(deep, "hidden.ttf"), gosmallcaps.TTF)
	// A link is not followed (it could point anywhere); skipped where links cannot be made.
	linked := os.Symlink(filepath.Join(sub, "medium.otf"), filepath.Join(dir, "link.ttf")) == nil

	l := New(dir, filepath.Join(dir, "does-not-exist"))
	got := l.Families(context.Background())
	want := []string{Default, Mono, "Go Medium", "Go Smallcaps"}
	if !slices.Equal(got, want) {
		t.Fatalf("families %v, want %v (link made: %v)", got, want, linked)
	}
	caps, err := l.Font("go smallcaps", false, false)
	if err != nil || familyOf(t, caps) != "Go Smallcaps" {
		t.Fatalf("smallcaps: %v", err)
	}
	capsItalic, _ := l.Font("Go Smallcaps", false, true)
	if capsItalic == caps {
		t.Error("the italic file was not found as the family's italic")
	}
	// Loaded fonts are kept: the same object the second time.
	if again, _ := l.Font("Go Smallcaps", false, false); again != caps {
		t.Error("a system font is read again on every use")
	}
	// A font whose file went away falls back to the default.
	if err := os.Remove(filepath.Join(sub, "medium.otf")); err != nil {
		t.Fatal(err)
	}
	def, _ := l.Font(Default, false, false)
	if f, err := l.Font("Go Medium", false, false); err != nil || f != def {
		t.Errorf("a font whose file is gone: %v", err)
	}
}

func TestScanStopsWithItsContext(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "medium.ttf"), gomedium.TTF, 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	l := New(dir)
	if got := l.Families(ctx); !slices.Equal(got, []string{Default, Mono}) {
		t.Fatalf("a cancelled scan listed %v", got)
	}
	// Text can still be drawn.
	if _, err := l.Font("Go Medium", false, false); err != nil && !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func TestSystemLibraryLists(t *testing.T) {
	if testing.Short() {
		t.Skip("scans the machine's fonts")
	}
	names := System().Families(context.Background())
	if len(names) < 2 || names[0] != Default || names[1] != Mono {
		t.Fatalf("system families start with %v", names[:min(len(names), 3)])
	}
	seen := map[string]bool{}
	for _, n := range names {
		if n == "" || len(n) > maxName || seen[n] {
			t.Fatalf("family name %q (empty, too long or twice)", n)
		}
		seen[n] = true
	}
	t.Logf("%d font families on this machine", len(names))
}
