package archive

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/flate"
	"compress/gzip"
	"context"
	"errors"
	"hash/crc32"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"fastview/sidecar/internal/fileops"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/media"
)

type file struct {
	name string
	data string
	dir  bool
	link string // symlink target (tar, zip) or hard link path (tar, hard)
	hard bool
	// nonUTF8 stores the name without the UTF-8 flag (zip).
	nonUTF8 bool
}

var mtime = time.Date(2024, 5, 6, 7, 8, 10, 0, time.UTC)

func writeZip(t testing.TB, path string, files []file) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	z := zip.NewWriter(f)
	for _, e := range files {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate, Modified: mtime, NonUTF8: e.nonUTF8}
		switch {
		case e.dir:
			h.Name, h.Method = strings.TrimSuffix(e.name, "/")+"/", zip.Store
			h.SetMode(fs.ModeDir | 0o755)
		case e.link != "":
			h.SetMode(fs.ModeSymlink | 0o777)
		default:
			h.SetMode(0o644)
		}
		w, err := z.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if e.link != "" {
			_, err = io.WriteString(w, e.link)
		} else {
			_, err = io.WriteString(w, e.data)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func writeTar(t testing.TB, path string, files []file, gz bool) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	var w io.Writer = f
	var zw *gzip.Writer
	if gz {
		zw = gzip.NewWriter(f)
		w = zw
	}
	tw := tar.NewWriter(w)
	for _, e := range files {
		h := &tar.Header{Name: e.name, ModTime: mtime, Mode: 0o644, Typeflag: tar.TypeReg, Size: int64(len(e.data))}
		switch {
		case e.dir:
			h.Typeflag, h.Size, h.Mode = tar.TypeDir, 0, 0o755
		case e.hard:
			h.Typeflag, h.Size, h.Linkname = tar.TypeLink, 0, e.link
		case e.link != "":
			h.Typeflag, h.Size, h.Linkname = tar.TypeSymlink, 0, e.link
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			if _, err := io.WriteString(tw, e.data); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if zw != nil {
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

var sample = []file{
	{name: "docs", dir: true},
	{name: "docs/readme.txt", data: "hello\n"},
	{name: "docs/sub/deep.txt", data: "deep\n"}, // its folder is not stored
	{name: "photo.jpg", data: strings.Repeat("x", 1000)},
	{name: "Ünïcode ✓.txt", data: "utf8\n"},
}

func paths(l *Listing) []string {
	var out []string
	for i := range l.Len() {
		e := l.Entry(i)
		p := e.Path
		if e.Kind == KindDir {
			p += "/"
		}
		out = append(out, p)
	}
	slices.Sort(out)
	return out
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestDetect(t *testing.T) {
	cases := map[string]Format{
		"a.zip": FormatZip, "A.ZIP": FormatZip, "a.tar": FormatTar, "a.tar.gz": FormatTgz, "a.tgz": FormatTgz,
		"a.tar.bz2": FormatTbz2, "a.tbz2": FormatTbz2, "notes.gz": FormatGz, "a.7z": Format7z, "a.rar": Format7z,
	}
	for name, want := range cases {
		if got, ok := Detect(name); !ok || got != want {
			t.Errorf("Detect(%q) = %q, %v; want %q", name, got, ok, want)
		}
	}
	if _, ok := Detect("photo.jpg"); ok {
		t.Error("a jpg is not an archive")
	}
	for in, want := range map[string]string{"photos.tar.gz": "photos", "a.zip": "a", "x.tgz": "x", "noext": "noext"} {
		if got := StripExt(in); got != want {
			t.Errorf("StripExt(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCleanPath(t *testing.T) {
	ok := map[string]string{
		"a/b.txt": "a/b.txt", `dir\file.txt`: "dir/file.txt", "./x/./y": "x/y", "folder/": "folder", "a//b": "a/b",
	}
	for in, want := range ok {
		if got, bad := CleanPath(in); bad != "" || got != want {
			t.Errorf("CleanPath(%q) = %q, %q; want %q", in, got, bad, want)
		}
	}
	for _, in := range []string{"../evil", "a/../../b", "/etc/passwd", `\\server\share\x`, `C:\Windows\x`, "c:x", "", ".", "a/..", "x\x00y"} {
		if got, bad := CleanPath(in); bad == "" {
			t.Errorf("CleanPath(%q) = %q, want a rejection", in, got)
		}
	}
	for _, c := range []struct {
		at, target string
		inside     bool
	}{
		{"l", "a.txt", true}, {"d/l", "../a.txt", true}, {"d/l", "../../a.txt", false}, {"l", "../x", false},
		{"l", "/etc/passwd", false}, {"l", `C:\x`, false}, {"d/e/l", "../../f/g", true}, {"l", "a/../../x", false},
	} {
		if got := LinkInside(c.at, c.target); got != c.inside {
			t.Errorf("LinkInside(%q, %q) = %v, want %v", c.at, c.target, got, c.inside)
		}
	}
}

func TestListEveryFormat(t *testing.T) {
	dir := t.TempDir()
	zipPath, tarPath, tgzPath := filepath.Join(dir, "a.zip"), filepath.Join(dir, "a.tar"), filepath.Join(dir, "a.tgz")
	writeZip(t, zipPath, sample)
	writeTar(t, tarPath, sample, false)
	writeTar(t, tgzPath, sample, true)
	want := []string{"docs/", "docs/readme.txt", "docs/sub/", "docs/sub/deep.txt", "photo.jpg", "Ünïcode ✓.txt"}
	slices.Sort(want)
	for _, c := range []struct {
		path   string
		format Format
	}{{zipPath, FormatZip}, {tarPath, FormatTar}, {tgzPath, FormatTgz}} {
		l, err := Read(context.Background(), c.path, c.format, nil)
		if err != nil {
			t.Fatalf("%s: %v", c.format, err)
		}
		if got := paths(l); !slices.Equal(got, want) {
			t.Errorf("%s: entries %v, want %v", c.format, got, want)
		}
		docs := l.Find("docs")
		if docs < 0 || l.Entry(docs).Size != int64(len("hello\n")+len("deep\n")) {
			t.Errorf("%s: docs folder size = %d", c.format, l.Entry(docs).Size)
		}
		if i := l.Find("photo.jpg"); i < 0 || l.Entry(i).MtimeNs != mtime.UnixNano() || l.Entry(i).Size != 1000 {
			t.Errorf("%s: photo.jpg entry %+v", c.format, l.Entry(i))
		}
		if l.Bytes != 1000+6+5+5 {
			t.Errorf("%s: bytes = %d", c.format, l.Bytes)
		}
	}

	l, err := Read(context.Background(), filepath.Join("testdata", "small.tar.bz2"), FormatTbz2, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := paths(l); !slices.Equal(got, []string{"docs/", "docs/readme.txt", "docs/über.txt", "top.bin"}) {
		t.Errorf("tbz2 entries %v", got)
	}

	gzPath := filepath.Join(dir, "notes.txt.gz")
	f, _ := os.Create(gzPath)
	zw := gzip.NewWriter(f)
	_, _ = io.WriteString(zw, "single file\n")
	_ = zw.Close()
	_ = f.Close()
	l, err = Read(context.Background(), gzPath, FormatGz, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := paths(l); !slices.Equal(got, []string{"notes.txt"}) || l.Entry(0).Size != 12 {
		t.Errorf("gz entries %v size %d", got, l.Entry(0).Size)
	}
	out := t.TempDir()
	if err := Extract(context.Background(), gzPath, FormatGz, nil, nil, &ExtractOptions{Dest: out}); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(out, "notes.txt")); got != "single file\n" {
		t.Errorf("gz extracted %q", got)
	}
}

func TestZip64AndLegacyNames(t *testing.T) {
	dir := t.TempDir()
	// More than 65,535 entries: the writer adds ZIP64 records.
	files := make([]file, 0, 70_001)
	for i := range 70_000 {
		files = append(files, file{name: "f/" + strings.Repeat("0", 5-len(itoa(i))) + itoa(i) + ".txt", data: ""})
	}
	files = append(files, file{name: "\x81ber.txt", data: "cp437", nonUTF8: true}) // "über" in code page 437
	p := filepath.Join(dir, "big.zip")
	writeZip(t, p, files)
	l, err := Read(context.Background(), p, FormatZip, nil)
	if err != nil {
		t.Fatal(err)
	}
	if l.Len() != 70_002 { // + the folder "f"
		t.Fatalf("entries = %d", l.Len())
	}
	if l.Find("über.txt") < 0 {
		t.Errorf("legacy name was not decoded: %v", paths(l)[len(paths(l))-3:])
	}
	if len(l.Children(l.Find("f"))) != 70_000 {
		t.Errorf("children of f = %d", len(l.Children(l.Find("f"))))
	}
}

func itoa(i int) string { return strconv.Itoa(i) }

func TestExtractSelectionAndConflicts(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.zip")
	writeZip(t, p, sample)
	out := t.TempDir()
	if err := os.WriteFile(filepath.Join(out, "readme.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	var extracted, skipped []string
	o := &ExtractOptions{
		Dest: out, Base: "docs",
		Include:   (&Selection{Paths: []string{"docs/readme.txt", "docs/sub"}}).Include(),
		Extracted: func(rel string, h *Header) { extracted = append(extracted, rel) },
		Skipped:   func(rel string, h *Header) { skipped = append(skipped, rel) },
		Conflict: func(rel string, h *Header, fi fs.FileInfo) (Decision, error) {
			if rel != "readme.txt" || fi.Size() != 3 || h.Size != 6 {
				t.Errorf("conflict %q %d %d", rel, h.Size, fi.Size())
			}
			return DecideKeepBoth, nil
		},
	}
	if err := Extract(context.Background(), p, FormatZip, nil, nil, o); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(out, "readme (2).txt")); got != "hello\n" {
		t.Errorf("kept both: %q", got)
	}
	if got := read(t, filepath.Join(out, "readme.txt")); got != "old" {
		t.Errorf("the existing file changed: %q", got)
	}
	if got := read(t, filepath.Join(out, "sub", "deep.txt")); got != "deep\n" {
		t.Errorf("deep: %q", got)
	}
	if _, err := os.Stat(filepath.Join(out, "photo.jpg")); err == nil {
		t.Error("an unselected entry was extracted")
	}
	fi, _ := os.Stat(filepath.Join(out, "sub", "deep.txt"))
	if !fi.ModTime().Equal(mtime) {
		t.Errorf("mtime %v, want %v", fi.ModTime(), mtime)
	}
	if !slices.Contains(extracted, "readme (2).txt") || !slices.Contains(extracted, "sub/deep.txt") || len(skipped) != 0 {
		t.Errorf("extracted %v skipped %v", extracted, skipped)
	}

	// Replace and skip.
	o.Base, o.Include = "", (&Selection{Paths: []string{"photo.jpg"}}).Include()
	if err := os.WriteFile(filepath.Join(out, "photo.jpg"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	o.Conflict = func(string, *Header, fs.FileInfo) (Decision, error) { return DecideSkip, nil }
	_ = Extract(context.Background(), p, FormatZip, nil, nil, o)
	if read(t, filepath.Join(out, "photo.jpg")) != "mine" || !slices.Contains(skipped, "photo.jpg") {
		t.Error("skip replaced the file")
	}
	o.Conflict = func(string, *Header, fs.FileInfo) (Decision, error) { return DecideReplace, nil }
	_ = Extract(context.Background(), p, FormatZip, nil, nil, o)
	if len(read(t, filepath.Join(out, "photo.jpg"))) != 1000 {
		t.Error("replace kept the old file")
	}
	o.Conflict = func(string, *Header, fs.FileInfo) (Decision, error) { return DecideRenameExisting, nil }
	_ = Extract(context.Background(), p, FormatZip, nil, nil, o)
	if len(read(t, filepath.Join(out, "photo (2).jpg"))) != 1000 || len(read(t, filepath.Join(out, "photo.jpg"))) != 1000 {
		t.Error("rename existing")
	}
	assertNoPartials(t, out)
}

func assertNoPartials(t *testing.T, dir string) {
	t.Helper()
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && strings.HasSuffix(d.Name(), fileops.PartialSuffix) {
			t.Errorf("partial left behind: %s", p)
		}
		return nil
	})
}

// outsideOf lists what exists in parent besides dest (nothing may appear).
func outsideOf(t *testing.T, parent, dest string) []string {
	t.Helper()
	var out []string
	entries, _ := os.ReadDir(parent)
	for _, e := range entries {
		if filepath.Join(parent, e.Name()) != dest {
			out = append(out, e.Name())
		}
	}
	return out
}

func TestZipSlipAndAbsolutePaths(t *testing.T) {
	evil := []file{
		{name: "../evil.txt", data: "x"},
		{name: "a/../../evil2.txt", data: "x"},
		{name: "/abs.txt", data: "x"},
		{name: `C:\Windows\evil.txt`, data: "x"},
		{name: `..\backslash.txt`, data: "x"},
		{name: "good.txt", data: "fine"},
	}
	for _, kind := range []string{"zip", "tar"} {
		t.Run(kind, func(t *testing.T) {
			parent := t.TempDir()
			dest := filepath.Join(parent, "dest")
			_ = os.Mkdir(dest, 0o755)
			src := filepath.Join(t.TempDir(), "evil."+kind)
			format := FormatZip
			if kind == "zip" {
				writeZip(t, src, evil)
			} else {
				writeTar(t, src, evil, false)
				format = FormatTar
			}
			l, err := Read(context.Background(), src, format, nil)
			if err != nil {
				t.Fatal(err)
			}
			if l.Rejected != 5 || l.Len() != 1 {
				t.Errorf("rejected %d, listed %v", l.Rejected, paths(l))
			}
			var failed []string
			err = Extract(context.Background(), src, format, nil, nil, &ExtractOptions{Dest: dest,
				Failed: func(rel string, err error) {
					if fileops.Code(err) != CodeUnsafePath {
						t.Errorf("%s: code %s", rel, fileops.Code(err))
					}
					failed = append(failed, rel)
				}})
			if err != nil {
				t.Fatal(err)
			}
			if len(failed) != 5 {
				t.Errorf("failed %v", failed)
			}
			if got := outsideOf(t, parent, dest); len(got) != 0 {
				t.Fatalf("written outside the target: %v", got)
			}
			if read(t, filepath.Join(dest, "good.txt")) != "fine" {
				t.Error("the safe entry was not extracted")
			}
			if _, err := os.Stat(`C:\Windows\evil.txt`); err == nil && runtime.GOOS == "windows" {
				t.Fatal("wrote to an absolute path")
			}
		})
	}
}

func TestTarLinks(t *testing.T) {
	files := []file{
		{name: "real.txt", data: "real"},
		{name: "d", dir: true},
		{name: "d/inside", link: "../real.txt"},
		{name: "d/outside", link: "../../escape.txt"},
		{name: "abs", link: "/etc/passwd"},
		{name: "hard", link: "real.txt", hard: true},
		{name: "hardout", link: "../x", hard: true},
	}
	src := filepath.Join(t.TempDir(), "links.tar")
	writeTar(t, src, files, false)

	parent := t.TempDir()
	dest := filepath.Join(parent, "dest")
	_ = os.Mkdir(dest, 0o755)
	codes := map[string]string{}
	err := Extract(context.Background(), src, FormatTar, nil, nil, &ExtractOptions{Dest: dest, Links: true,
		Failed: func(rel string, err error) { codes[rel] = fileops.Code(err) }})
	if err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"d/outside", "abs", "hardout"} {
		if codes[rel] != CodeUnsafePath {
			t.Errorf("%s: code %q, want UNSAFE_PATH", rel, codes[rel])
		}
	}
	if got := outsideOf(t, parent, dest); len(got) != 0 {
		t.Fatalf("written outside: %v", got)
	}
	if fi, err := os.Lstat(filepath.Join(dest, "d", "inside")); err == nil {
		if fi.Mode()&fs.ModeSymlink == 0 {
			t.Error("inside is not a link")
		}
	} else if codes["d/inside"] != fileops.CodeSkippedLink {
		t.Errorf("inside: %v / %s", err, codes["d/inside"]) // no symlink privilege on Windows
	}
	if read(t, filepath.Join(dest, "hard")) != "real" {
		t.Error("hard link")
	}

	// Links off: skipped, nothing created.
	dest2 := t.TempDir()
	var skipped []string
	_ = Extract(context.Background(), src, FormatTar, nil, nil, &ExtractOptions{Dest: dest2,
		Skipped: func(rel string, _ *Header) { skipped = append(skipped, rel) }})
	if len(skipped) != 5 {
		t.Errorf("skipped %v", skipped)
	}
	if _, err := os.Lstat(filepath.Join(dest2, "d", "inside")); err == nil {
		t.Error("a link was created with links off")
	}
}

// zipBomb writes a zip whose entry declares 10 bytes but inflates to 1 MiB.
func zipBomb(t *testing.T, path string) {
	t.Helper()
	data := bytes.Repeat([]byte{'A'}, 1<<20)
	var comp bytes.Buffer
	fw, _ := flate.NewWriter(&comp, flate.BestCompression)
	_, _ = fw.Write(data)
	_ = fw.Close()
	f, _ := os.Create(path)
	z := zip.NewWriter(f)
	h := &zip.FileHeader{Name: "bomb.txt", Method: zip.Deflate, Modified: mtime,
		CRC32: crc32.ChecksumIEEE(data), CompressedSize64: uint64(comp.Len()), UncompressedSize64: 10}
	w, err := z.CreateRaw(h)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write(comp.Bytes())
	_ = z.Close()
	_ = f.Close()
}

func TestBombStopsAtDeclaredSize(t *testing.T) {
	src := filepath.Join(t.TempDir(), "bomb.zip")
	zipBomb(t, src)
	dest := t.TempDir()
	var codes []string
	err := Extract(context.Background(), src, FormatZip, nil, nil, &ExtractOptions{Dest: dest,
		Failed: func(_ string, err error) { codes = append(codes, fileops.Code(err)) }})
	if err == nil && len(codes) == 0 {
		t.Fatal("the bomb was extracted")
	}
	if fi, err := os.Stat(filepath.Join(dest, "bomb.txt")); err == nil {
		t.Errorf("bomb.txt exists (%d bytes)", fi.Size())
	}
	assertNoPartials(t, dest)
	if !slices.Contains(codes, CodeTooLarge) && !slices.Contains(codes, CodeCorrupt) {
		t.Errorf("codes %v", codes)
	}
	if w := Warnings(1<<40, 1<<20, 1<<41); !slices.Contains(w, "ratio") {
		t.Errorf("warnings %v", w)
	}
	if w := Warnings(10<<30, 9<<30, 1<<30); !slices.Equal(w, []string{"space"}) {
		t.Errorf("warnings %v", w)
	}
	if w := Warnings(100, 50, -1); len(w) != 0 {
		t.Errorf("warnings %v", w)
	}
}

func TestIntegrity(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.zip")
	writeZip(t, p, sample)
	if n, err := Test(context.Background(), p, FormatZip, nil, nil); err != nil || n != 4 {
		t.Fatalf("test ok archive: %d, %v", n, err)
	}
	if n, err := Test(context.Background(), filepath.Join("testdata", "small.tar.bz2"), FormatTbz2, nil, nil); err != nil || n != 3 {
		t.Fatalf("test tbz2: %d, %v", n, err)
	}
	// Flip a byte inside readme.txt's stored data: the CRC fails.
	zr, _ := zip.OpenReader(p)
	var off int64
	for _, f := range zr.File {
		if f.Name == "docs/readme.txt" {
			off, _ = f.DataOffset()
		}
	}
	_ = zr.Close()
	b, _ := os.ReadFile(p)
	b[off+1] ^= 0x01
	bad := filepath.Join(dir, "bad.zip")
	_ = os.WriteFile(bad, b, 0o644)
	if _, err := Test(context.Background(), bad, FormatZip, nil, nil); !errors.Is(err, ErrCorrupt) {
		t.Errorf("damaged zip: %v", err)
	}
	tgz := filepath.Join(dir, "a.tgz")
	writeTar(t, tgz, sample, true)
	b, _ = os.ReadFile(tgz)
	_ = os.WriteFile(tgz, b[:len(b)-12], 0o644) // truncated
	if _, err := Test(context.Background(), tgz, FormatTgz, nil, nil); !errors.Is(err, ErrCorrupt) {
		t.Errorf("truncated tgz: %v", err)
	}
	if _, err := Read(context.Background(), filepath.Join(dir, "a.tgz"), FormatZip, nil); !errors.Is(err, ErrCorrupt) {
		t.Errorf("not a zip: %v", err)
	}
}

func TestPackRoundTrip(t *testing.T) {
	src := t.TempDir()
	mk := func(rel, data string) {
		p := filepath.Join(src, filepath.FromSlash(rel))
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mk("folder/a.txt", "aaa")
	mk("folder/sub/b.txt", strings.Repeat("b", 5000))
	mk("single ✓.txt", "s")
	_ = os.Symlink("a.txt", filepath.Join(src, "folder", "link")) // may fail on Windows: then not packed
	items := []PackItem{{Path: filepath.Join(src, "folder"), Name: "folder"}, {Path: filepath.Join(src, "single ✓.txt"), Name: "single ✓.txt"}}
	for _, c := range []struct {
		format Format
		name   string
		level  int
	}{{FormatZip, "out.zip", 6}, {FormatZip, "stored.zip", 0}, {FormatTgz, "out.tar.gz", 9}} {
		dest := t.TempDir()
		target := filepath.Join(dest, c.name)
		var progress int64
		err := Pack(context.Background(), nil, &PackOptions{Format: c.format, Level: c.level, Items: items, Target: target,
			Progress: func(n int64) { progress += n },
			Failed:   func(_ int, rel string, err error) { t.Errorf("%s: %v", rel, err) }})
		if err != nil {
			t.Fatal(err)
		}
		if progress != 3+5000+1 {
			t.Errorf("%s: progress %d", c.name, progress)
		}
		assertNoPartials(t, dest)
		l, err := Read(context.Background(), target, c.format, nil)
		if err != nil {
			t.Fatal(err)
		}
		got := paths(l)
		for _, want := range []string{"folder/", "folder/a.txt", "folder/sub/", "folder/sub/b.txt", "single ✓.txt"} {
			if !slices.Contains(got, want) {
				t.Errorf("%s: %s missing from %v", c.name, want, got)
			}
		}
		if _, err := Test(context.Background(), target, c.format, nil, nil); err != nil {
			t.Errorf("%s: test %v", c.name, err)
		}
		out := t.TempDir()
		if err := Extract(context.Background(), target, c.format, nil, nil, &ExtractOptions{Dest: out}); err != nil {
			t.Fatal(err)
		}
		if read(t, filepath.Join(out, "folder", "sub", "b.txt")) != strings.Repeat("b", 5000) {
			t.Errorf("%s: round trip", c.name)
		}
		// An existing target is not replaced without Replace.
		err = Pack(context.Background(), nil, &PackOptions{Format: c.format, Items: items, Target: target})
		if fileops.Code(err) != fileops.CodeExists {
			t.Errorf("%s: second pack: %v", c.name, err)
		}
	}
	if err := Pack(context.Background(), &Tool{}, &PackOptions{Format: Format7z, Items: items, Target: filepath.Join(src, "x.7z")}); !errors.Is(err, ErrNoTool) {
		t.Errorf("7z without the tool: %v", err)
	}
}

func TestCancel(t *testing.T) {
	src := filepath.Join(t.TempDir(), "a.tgz")
	writeTar(t, src, sample, true)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Read(ctx, src, FormatTgz, nil); !errors.Is(err, context.Canceled) {
		t.Errorf("read: %v", err)
	}
	dest := t.TempDir()
	if err := Extract(ctx, src, FormatTgz, nil, nil, &ExtractOptions{Dest: dest}); !errors.Is(err, context.Canceled) {
		t.Errorf("extract: %v", err)
	}
}

func TestManagerSourceAndViews(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.zip")
	writeZip(t, p, append(slices.Clone(sample), file{name: "b.txt", data: "bb"}, file{name: "a10.txt", data: "a"}, file{name: "a9.txt", data: "a"}))
	tmp := filepath.Join(t.TempDir(), "tmp", "archive")
	m := NewManager(nil, tmp, nil)
	a, err := m.OpenFile(context.Background(), 7, p, true)
	if err != nil {
		t.Fatal(err)
	}
	again, _ := m.OpenFile(context.Background(), 7, p, true)
	if again != a {
		t.Error("the same unchanged archive was listed twice")
	}
	src, err := m.Source(a.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	root, _ := src.IDs(context.Background(), index.Descriptor{Sort: []index.SortKey{{Field: index.SortName}}})
	items, _ := src.Items(context.Background(), root)
	var names []string
	for _, it := range items {
		names = append(names, it.Name)
	}
	if want := []string{"docs", "a9.txt", "a10.txt", "b.txt", "photo.jpg", "Ünïcode ✓.txt"}; !slices.Equal(names, want) {
		t.Errorf("root = %v, want %v", names, want)
	}
	if items[0].Kind != media.KindDir || items[0].DirSize != 11 || items[4].Kind != media.KindImage || items[4].Ext != "jpg" {
		t.Errorf("rows %+v", items[:5])
	}
	ids, _ := src.IDs(context.Background(), index.Descriptor{Sort: []index.SortKey{{Field: index.SortSize, Desc: true}}, NameMask: "*.txt"})
	items, _ = src.Items(context.Background(), ids)
	if len(items) != 5 || items[0].Name != "docs" || items[1].Name != "Ünïcode ✓.txt" || items[2].Name != "b.txt" {
		t.Errorf("masked by size: %+v", items)
	}
	names2, _ := src.Names(context.Background())
	if len(names2) != 6 || names2[root[0]].Name != "docs" || !names2[root[0]].IsDir {
		t.Errorf("names %v", names2)
	}
	ids = root // docs, a9, a10, b, photo, Ünïcode
	if _, err := m.Source(a.ID, ids[1]); err == nil {
		t.Error("a file is not a folder source")
	}
	sub, err := m.Source(a.ID, ids[0])
	if err != nil {
		t.Fatal(err)
	}
	subIDs, _ := sub.IDs(context.Background(), index.Descriptor{})
	if len(subIDs) != 2 {
		t.Errorf("docs has %d entries", len(subIDs))
	}

	// Select and view.
	sel, err := m.Select([]int64{ids[0], ids[3]})
	if err != nil || sel.Files != 3 || sel.Base != "" {
		t.Fatalf("select %+v %v", sel, err)
	}
	if _, err := m.Select([]int64{ids[1], subIDs[0]}); err == nil {
		t.Error("entries of two folders were selected together")
	}
	path, e, err := m.View(context.Background(), ids[3])
	if err != nil || read(t, path) != "bb" || e.Name != "b.txt" {
		t.Fatalf("view %q %+v %v", path, e, err)
	}
	if !strings.HasPrefix(path, tmp) {
		t.Errorf("view outside tmp: %s", path)
	}
	if _, _, err := m.View(context.Background(), ids[0]); err == nil {
		t.Error("a folder was viewed")
	}

	// Sessions and handles keep it open; then it closes and its files go.
	m.Attach(100, src)
	m.Close(a.ID)
	m.Close(a.ID)
	if _, err := m.Get(a.ID); err != nil {
		t.Fatal("closed while a session uses it")
	}
	m.Dropped(100)
	if _, err := m.Get(a.ID); !errors.Is(err, ErrUnknown) {
		t.Error("still open without sessions and handles")
	}
	if _, err := os.Stat(path); err == nil {
		t.Error("the view file was not removed")
	}
	if _, err := m.OpenFile(context.Background(), 1, filepath.Join(dir, "x.7z"), true); !errors.Is(err, ErrNoTool) {
		t.Errorf("7z without the tool: %v", err)
	}
	m.Shutdown()
}

func TestEntryIDs(t *testing.T) {
	for _, c := range []struct {
		archive int64
		i       int
	}{{1, 0}, {1, MaxEntries - 1}, {maxSlot, 5}} {
		id := EntryID(c.archive, c.i)
		if id >= 1<<53 || !IsID(id) {
			t.Fatalf("id %d out of range", id)
		}
		a, i, ok := SplitID(id)
		if !ok || a != c.archive || i != c.i {
			t.Errorf("SplitID(%d) = %d, %d", id, a, i)
		}
	}
	if IsID(123456) {
		t.Error("an index id")
	}
}

func TestMemoryPerEntry(t *testing.T) {
	if testing.Short() {
		t.Skip("lists 100k entries")
	}
	p := filepath.Join(t.TempDir(), "100k.zip")
	files := make([]file, 100_000)
	for i := range files {
		files[i] = file{name: "folder" + itoa(i%100) + "/IMG_" + itoa(100000+i) + ".jpg"}
	}
	writeZip(t, p, files)
	perEntry, elapsed := measureListing(t, p)
	t.Logf("100k-entry zip: %.0f bytes per entry, listed in %v", perEntry, elapsed)
	if perEntry > 100 {
		t.Errorf("%.0f bytes per entry, budget 100", perEntry)
	}
}

func measureListing(t testing.TB, p string) (float64, time.Duration) {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	start := time.Now()
	l, err := Read(context.Background(), p, FormatZip, nil)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	n := l.Len()
	runtime.KeepAlive(l)
	return float64(int64(after.HeapAlloc)-int64(before.HeapAlloc)) / float64(n), elapsed
}
