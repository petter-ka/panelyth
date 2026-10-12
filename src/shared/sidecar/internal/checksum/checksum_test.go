package checksum

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

var ctx = context.Background()

// Known vectors (FIPS 180, RFC 1321 and the CRC-32 check value).
func TestKnownVectors(t *testing.T) {
	dir := t.TempDir()
	write := func(name, data string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	abc, empty, check := write("abc", "abc"), write("empty", ""), write("check", "123456789")
	cases := []struct {
		path string
		algo Algo
		want string
	}{
		{abc, SHA256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
		{abc, SHA1, "a9993e364706816aba3e25717850c26c9cd0d89d"},
		{abc, MD5, "900150983cd24fb0d6963f7d28e17f72"},
		{abc, CRC32, "352441C2"},
		{empty, SHA256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
		{empty, SHA1, "da39a3ee5e6b4b0d3255bfef95601890afd80709"},
		{empty, MD5, "d41d8cd98f00b204e9800998ecf8427e"},
		{empty, CRC32, "00000000"},
		{check, CRC32, "CBF43926"},
	}
	for _, c := range cases {
		got, err := File(ctx, c.path, c.algo, nil)
		if err != nil || got != c.want {
			t.Errorf("%s of %s = %q, %v; want %q", c.algo, filepath.Base(c.path), got, err, c.want)
		}
	}
}

func TestFileHooksAndErrors(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "big")
	if err := os.WriteFile(p, make([]byte, 3*BufferSize+17), 0o644); err != nil {
		t.Fatal(err)
	}
	var seen int64
	gates := 0
	sum, err := File(ctx, p, SHA256, &Options{
		Progress: func(n int64) { seen += n },
		Gate:     func(ctx context.Context) error { gates++; return ctx.Err() },
	})
	if err != nil || len(sum) != 64 || seen != 3*BufferSize+17 || gates < 4 {
		t.Errorf("sum %q err %v seen %d gates %d", sum, err, seen, gates)
	}
	if _, err := File(ctx, filepath.Join(dir, "missing"), MD5, nil); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("missing: %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := File(cancelled, p, SHA1, nil); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled: %v", err)
	}
}

func TestNamesAndExtensions(t *testing.T) {
	for name, want := range map[string]Algo{"a.sha256": SHA256, "A.SHA1": SHA1, "x.y.md5": MD5, "disc.SFV": CRC32} {
		if got, ok := ByName(name); !ok || got != want {
			t.Errorf("ByName(%q) = %q, %v", name, got, ok)
		}
		if !strings.EqualFold(want.Ext(), filepath.Ext(name)) {
			t.Errorf("Ext of %s = %q", want, want.Ext())
		}
	}
	for _, name := range []string{"a.txt", "sha256", "a.sha512", ""} {
		if _, ok := ByName(name); ok {
			t.Errorf("ByName(%q) accepted", name)
		}
	}
	if Algo("sha512").Valid() || !CRC32.Valid() {
		t.Error("Valid")
	}
}

func TestLinesRoundTrip(t *testing.T) {
	sums := map[Algo]string{
		SHA256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		SHA1:   "a9993e364706816aba3e25717850c26c9cd0d89d",
		MD5:    "900150983cd24fb0d6963f7d28e17f72",
		CRC32:  "352441C2",
	}
	names := []string{"a.txt", "with space.txt", "sub/deep/árvíztűrő.bin", "  lead.txt"}
	for algo, sum := range sums {
		text := Header(algo)
		for _, n := range names {
			text += Line(algo, sum, n)
		}
		got, err := Parse(strings.NewReader(text), algo)
		if err != nil {
			t.Fatalf("%s: %v\n%s", algo, err, text)
		}
		var paths []string
		for _, e := range got {
			paths = append(paths, e.Path)
			if e.Sum != strings.ToLower(sum) {
				t.Errorf("%s: sum %q", algo, e.Sum)
			}
		}
		if !slices.Equal(paths, names) {
			t.Errorf("%s: paths %q", algo, paths)
		}
	}
}

func TestParseForms(t *testing.T) {
	md5 := "900150983cd24fb0d6963f7d28e17f72"
	text := "\xef\xbb\xbf# made elsewhere\r\n" +
		md5 + "  text mode.txt\r\n" +
		"\r\n" +
		strings.ToUpper(md5) + " *sub\\win.bin\r\n" +
		"MD5 (bsd form.txt) = " + md5 + "\r\n" +
		"\\" + md5 + " *odd\\\\name\\nwith a line break\r\n" +
		"; a comment\n"
	got, err := Parse(strings.NewReader(text), MD5)
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, e := range got {
		paths = append(paths, e.Path)
		if e.Sum != md5 {
			t.Errorf("sum %q", e.Sum)
		}
	}
	// Backslashes become forward slashes: lists from Windows tools use them
	// as separators.
	want := []string{"text mode.txt", "sub/win.bin", "bsd form.txt", "odd/name\nwith a line break"}
	if !slices.Equal(paths, want) {
		t.Errorf("paths %q, want %q", paths, want)
	}

	sfv, err := Parse(strings.NewReader("; header\nmovie part 1.avi 352441c2\nb.bin  00000000\n"), CRC32)
	if err != nil || len(sfv) != 2 || sfv[0].Path != "movie part 1.avi" || sfv[0].Sum != "352441c2" || sfv[1].Path != "b.bin" {
		t.Errorf("sfv %+v, %v", sfv, err)
	}
}

func TestParseRejectsDamage(t *testing.T) {
	md5 := "900150983cd24fb0d6963f7d28e17f72"
	for name, text := range map[string]string{
		"a short sum":         md5[:30] + "  a.txt\n",
		"not hex":             strings.Repeat("z", 32) + "  a.txt\n",
		"no name":             md5 + "  \n",
		"no separator":        md5 + "a.txt\n",
		"prose":               "this is a readme, not a list\n",
		"one bad line of 2":   md5 + "  a.txt\ngarbage\n",
		"a line far too long": md5 + "  " + strings.Repeat("x", maxLineBytes+1) + "\n",
	} {
		if _, err := Parse(strings.NewReader(text), MD5); !errors.Is(err, ErrFormat) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A sha256 sum in an .md5 file is the wrong length.
	if _, err := Parse(strings.NewReader(strings.Repeat("a", 64)+"  a.txt\n"), MD5); !errors.Is(err, ErrFormat) {
		t.Errorf("wrong algorithm: %v", err)
	}
	if _, err := Parse(strings.NewReader("a.bin\n"), CRC32); !errors.Is(err, ErrFormat) {
		t.Errorf("sfv without a sum: %v", err)
	}
	if got, err := Parse(strings.NewReader(""), SHA1); err != nil || len(got) != 0 {
		t.Errorf("an empty file: %v, %v", got, err)
	}
}

func TestResolveStaysInside(t *testing.T) {
	dir := t.TempDir()
	for _, rel := range []string{"a.txt", "sub/b.txt", "sub/./c.txt"} {
		got, ok := Resolve(dir, rel)
		if !ok || !strings.HasPrefix(got, dir) {
			t.Errorf("Resolve(%q) = %q, %v", rel, got, ok)
		}
	}
	bad := []string{"", "../a.txt", "sub/../../a.txt", "/etc/passwd", ".."}
	if runtime.GOOS == "windows" {
		bad = append(bad, `C:/Windows/notepad.exe`, `C:a.txt`, `//server/share/a.txt`, "nul")
	}
	for _, rel := range bad {
		if got, ok := Resolve(dir, rel); ok {
			t.Errorf("Resolve(%q) = %q, accepted", rel, got)
		}
	}
}
