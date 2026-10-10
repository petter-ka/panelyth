package archive

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The test binary doubles as a fake 7-Zip when FV_FAKE_7Z is set. Its
// "archives" are text files: one entry per line, "path|content", or
// "path/" for a folder; a first line "ENCRYPTED" or "BAD" fails.
func TestMain(m *testing.M) {
	if os.Getenv("FV_FAKE_7Z") == "1" {
		os.Exit(fake7z(os.Args[1:]))
	}
	os.Exit(m.Run())
}

func fake7z(args []string) int {
	cmd := args[0]
	var archive, out, list string
	for _, a := range args[1:] {
		switch {
		case strings.HasPrefix(a, "-o"):
			out = a[2:]
		case strings.HasPrefix(a, "@"):
			list = a[1:]
		case strings.HasPrefix(a, "-"):
		case archive == "":
			archive = a
		}
	}
	if cmd == "a" {
		names, _ := os.ReadFile(list)
		var b strings.Builder
		for _, n := range strings.Fields(string(names)) {
			fmt.Fprintf(&b, "%s|packed\n", n)
		}
		if err := os.WriteFile(archive, []byte(b.String()), 0o644); err != nil {
			return 2
		}
		return 0
	}
	data, err := os.ReadFile(archive)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ERROR: Can not open the file as archive")
		return 2
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	switch lines[0] {
	case "ENCRYPTED":
		fmt.Fprintln(os.Stderr, "ERROR: Wrong password : x")
		return 2
	case "BAD":
		if cmd == "t" {
			fmt.Fprintln(os.Stderr, "ERROR: Data Error : x")
			return 2
		}
		lines = lines[1:]
	}
	switch cmd {
	case "l":
		fmt.Printf("Path = %s\nType = 7z\nPhysical Size = %d\n\n", archive, len(data))
		for _, l := range lines {
			p, content, _ := strings.Cut(l, "|")
			if strings.HasSuffix(p, "/") {
				fmt.Printf("Path = %s\nFolder = +\nSize = 0\nModified = 2024-05-06 07:08:10\nAttributes = D\n\n", strings.TrimSuffix(strings.ReplaceAll(p, "/", `\`), `\`))
				continue
			}
			fmt.Printf("Path = %s\nFolder = -\nSize = %d\nPacked Size = 3\nModified = 2024-05-06 07:08:10.1234567\nAttributes = A\nEncrypted = -\n\n", strings.ReplaceAll(p, "/", `\`), len(content))
		}
	case "t":
	case "x":
		var want []string
		if list != "" {
			b, _ := os.ReadFile(list)
			want = strings.Fields(string(b))
		}
		for _, l := range lines {
			p, content, _ := strings.Cut(l, "|")
			if len(want) > 0 && !slices.ContainsFunc(want, func(w string) bool {
				w = strings.TrimSuffix(w, "/*")
				return strings.TrimSuffix(p, "/") == w || strings.HasPrefix(p, w+"/")
			}) {
				continue
			}
			target := filepath.Join(out, filepath.FromSlash(p))
			if strings.HasSuffix(p, "/") {
				_ = os.MkdirAll(target, 0o755)
				continue
			}
			_ = os.MkdirAll(filepath.Dir(target), 0o755)
			_ = os.WriteFile(target, []byte(content), 0o644)
		}
	default:
		return 7
	}
	return 0
}

func fakeTool(t *testing.T) *Tool {
	t.Helper()
	t.Setenv("FV_FAKE_7Z", "1")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return &Tool{Path: exe}
}

func writeFake(t *testing.T, name string, lines ...string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSevenZipWithoutTheTool(t *testing.T) {
	t.Setenv("PANELYTH_7Z", "off")
	tool := LocateTool(os.Getenv)
	if tool.Available() {
		t.Fatal("PANELYTH_7Z=off still found a tool")
	}
	p := writeFake(t, "a.7z", "x.txt|x")
	if _, err := Read(context.Background(), p, Format7z, tool); !errors.Is(err, ErrNoTool) {
		t.Errorf("read: %v", err)
	}
	if _, err := Test(context.Background(), p, Format7z, tool, nil); !errors.Is(err, ErrNoTool) {
		t.Errorf("test: %v", err)
	}
	if err := Extract(context.Background(), p, Format7z, tool, nil, &ExtractOptions{Dest: t.TempDir()}); !errors.Is(err, ErrNoTool) {
		t.Errorf("extract: %v", err)
	}
	if CanCreate(Format7z, tool) || !CanCreate(FormatZip, tool) {
		t.Error("CanCreate")
	}
}

func TestSevenZipAdapter(t *testing.T) {
	tool := fakeTool(t)
	p := writeFake(t, "a.rar", "docs/", "docs/readme.txt|hello", "docs/sub/deep.txt|deep", "top.txt|top!")
	l, err := Read(context.Background(), p, Format7z, tool)
	if err != nil {
		t.Fatal(err)
	}
	if got := paths(l); !slices.Equal(got, []string{"docs/", "docs/readme.txt", "docs/sub/", "docs/sub/deep.txt", "top.txt"}) {
		t.Fatalf("entries %v", got)
	}
	if e := l.Entry(l.Find("top.txt")); e.Size != 4 || e.MtimeNs == 0 {
		t.Errorf("top.txt %+v", e)
	}

	// The whole archive, through the staging folder.
	dest := t.TempDir()
	if err := Extract(context.Background(), p, Format7z, tool, nil, &ExtractOptions{Dest: dest}); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dest, "docs", "sub", "deep.txt")) != "deep" || read(t, filepath.Join(dest, "top.txt")) != "top!" {
		t.Error("extracted contents")
	}
	entries, _ := os.ReadDir(dest)
	if len(entries) != 2 {
		t.Errorf("the staging folder was left behind: %v", entries)
	}

	// A selection below a folder.
	sel := &Selection{Paths: []string{"docs/sub"}}
	dest = t.TempDir()
	err = Extract(context.Background(), p, Format7z, tool, nil, &ExtractOptions{Dest: dest, Base: "docs",
		Include: sel.Include(), Selected: sel.Paths})
	if err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dest, "sub", "deep.txt")) != "deep" {
		t.Error("selected folder")
	}
	if _, err := os.Stat(filepath.Join(dest, "readme.txt")); err == nil {
		t.Error("an unselected entry was extracted")
	}

	if n, err := Test(context.Background(), p, Format7z, tool, nil); err != nil || n != 3 {
		t.Errorf("test: %d, %v", n, err)
	}
	bad := writeFake(t, "bad.7z", "BAD", "x.txt|x")
	if _, err := Test(context.Background(), bad, Format7z, tool, nil); !errors.Is(err, ErrCorrupt) {
		t.Errorf("test damaged: %v", err)
	}
	enc := writeFake(t, "enc.7z", "ENCRYPTED")
	if _, err := Read(context.Background(), enc, Format7z, tool); !errors.Is(err, ErrEncrypted) {
		t.Errorf("encrypted: %v", err)
	}

	// Create a 7z.
	src := t.TempDir()
	_ = os.WriteFile(filepath.Join(src, "one.txt"), []byte("1"), 0o644)
	target := filepath.Join(t.TempDir(), "out.7z")
	err = Pack(context.Background(), tool, &PackOptions{Format: Format7z, Level: 5, Target: target,
		Items: []PackItem{{Path: filepath.Join(src, "one.txt"), Name: "one.txt"}}})
	if err != nil {
		t.Fatal(err)
	}
	if got := read(t, target); got != "one.txt|packed\n" {
		t.Errorf("packed %q", got)
	}
	assertNoPartials(t, filepath.Dir(target))
}

func TestRealSevenZip(t *testing.T) {
	tool := LocateTool(os.Getenv)
	if !tool.Available() {
		t.Skip("7-Zip is not installed")
	}
	src := t.TempDir()
	_ = os.MkdirAll(filepath.Join(src, "d"), 0o755)
	_ = os.WriteFile(filepath.Join(src, "d", "a.txt"), []byte("real 7z"), 0o644)
	target := filepath.Join(t.TempDir(), "real.7z")
	if err := Pack(context.Background(), tool, &PackOptions{Format: Format7z, Level: 5, Target: target,
		Items: []PackItem{{Path: filepath.Join(src, "d"), Name: "d"}}}); err != nil {
		t.Fatal(err)
	}
	l, err := Read(context.Background(), target, Format7z, tool)
	if err != nil {
		t.Fatal(err)
	}
	if got := paths(l); !slices.Equal(got, []string{"d/", "d/a.txt"}) {
		t.Errorf("entries %v", got)
	}
	dest := t.TempDir()
	if err := Extract(context.Background(), target, Format7z, tool, nil, &ExtractOptions{Dest: dest}); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dest, "d", "a.txt")) != "real 7z" {
		t.Error("round trip")
	}
	if _, err := Test(context.Background(), target, Format7z, tool, nil); err != nil {
		t.Error(err)
	}
}
