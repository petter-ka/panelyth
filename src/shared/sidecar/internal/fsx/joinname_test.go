package fsx

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestSuspectName(t *testing.T) {
	for name, want := range map[string]bool{
		"photo.jpg": false, "IMG_0001.JPG": false, "a": false, "": false, "console.log": false,
		"nulls.txt": false, "com10": false, "..hidden": false, ".config": false, "conout": false,
		"photo.jpg.": true, "photo.jpg ": true, "folder.": true, "x ": true, "...": true,
		"NUL": true, "nul": true, "Nul.txt": true, "aux.jpg": true, "CON": true, "prn .txt": true,
		"com1": true, "COM9.log": true, "lpt3": true, "COM\u00b2": true, "conin$": true, "CONOUT$": true,
		"nul.tar.gz": true,
	} {
		if got := suspectName(name); got != want {
			t.Errorf("suspectName(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestPlainPath(t *testing.T) {
	for in, want := range map[string]string{
		`\\?\C:\a\b.`:              `C:\a\b.`,
		`\\?\UNC\server\share\a `:  `\\server\share\a `,
		`C:\a\b`:                   `C:\a\b`,
		`\\server\share\a`:         `\\server\share\a`,
		`/home/user/photo.jpg.`:    `/home/user/photo.jpg.`,
		`\\?\C:\`:                  `C:\`,
		`\\?\UNC\server\share`:     `\\server\share`,
		``:                         ``,
		`\\?\Volume{0000}\a`:       `Volume{0000}\a`,
		`\\.\pipe\x`:               `\\.\pipe\x`,
		`\\?\UNC\server\share\NUL`: `\\server\share\NUL`,
	} {
		if got := PlainPath(in); got != want {
			t.Errorf("PlainPath(%q) = %q, want %q", in, got, want)
		}
		if IsVerbatim(in) != (in != PlainPath(in)) {
			t.Errorf("IsVerbatim(%q) = %v", in, IsVerbatim(in))
		}
	}
	for in, want := range map[string]string{
		`C:\a\b.`:            `\\?\C:\a\b.`,
		`\\server\share\NUL`: `\\?\UNC\server\share\NUL`,
		`\\?\C:\a`:           `\\?\C:\a`,
	} {
		if got := verbatim(in); got != want {
			t.Errorf("verbatim(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestJoinName(t *testing.T) {
	dir := t.TempDir()
	if got := JoinName(dir, "photo.jpg"); got != filepath.Join(dir, "photo.jpg") {
		t.Fatalf("an ordinary name: %q", got)
	}
	if runtime.GOOS != "windows" {
		// Other systems open every name as it is written.
		for _, n := range []string{"photo.jpg.", "NUL", "x "} {
			if got := JoinName(dir, n); got != filepath.Join(dir, n) {
				t.Errorf("%q: %q", n, got)
			}
		}
		if SafePath(dir) != dir || Verbatim(dir) != dir {
			t.Error("paths change outside Windows")
		}
		return
	}
	// Which device names a path is rewritten for is the Windows version's
	// business (Windows 11 opens "COM1" in a folder as a file); the dot,
	// the space and NUL are rewritten by all of them.
	for _, n := range []string{"photo.jpg.", "x ", "NUL", "nul"} {
		if got := JoinName(dir, n); got != `\\?\`+dir+`\`+n {
			t.Errorf("%q: %q", n, got)
		}
	}
	// Below a prefixed folder every name is joined as written, ordinary
	// ones too; a drive's root keeps its one separator.
	if got := JoinName(`\\?\`+dir+`\folder.`, "a.jpg"); got != `\\?\`+dir+`\folder.\a.jpg` {
		t.Errorf("below a prefixed folder: %q", got)
	}
	if got := JoinName(`\\?\C:\`, "a.jpg"); got != `\\?\C:\a.jpg` {
		t.Errorf("below a prefixed root: %q", got)
	}
	if got := JoinName(`\\server\share\dir`, "x."); got != `\\?\UNC\server\share\dir\x.` {
		t.Errorf("on a share: %q", got)
	}
	// SafePath is JoinName for a whole path, and undoes a prefix that is
	// not needed.
	if got := SafePath(`\\?\` + dir); got != dir {
		t.Errorf("SafePath of an ordinary prefixed path: %q", got)
	}
	if got := SafePath(dir + `\folder.`); got != `\\?\`+dir+`\folder.` {
		t.Errorf("SafePath of a rewritten path: %q", got)
	}
	if got := SafePath(`C:\`); got != `C:\` {
		t.Errorf("SafePath of a root: %q", got)
	}
}

// The scanner joins every folder's path and the index every entry's: the
// test for a rewritten name must cost next to nothing for ordinary names.
func BenchmarkJoinName(b *testing.B) {
	dir := b.TempDir()
	names := []string{"IMG_0001.JPG", "photo (2).jpeg", "notes.txt", "Thumbs.db", "folder 12", "конец.png", "console.log", "a"}
	b.Run("JoinName", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; b.Loop(); i++ {
			_ = JoinName(dir, names[i%len(names)])
		}
	})
	b.Run("filepath.Join", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; b.Loop(); i++ {
			_ = filepath.Join(dir, names[i%len(names)])
		}
	})
}
