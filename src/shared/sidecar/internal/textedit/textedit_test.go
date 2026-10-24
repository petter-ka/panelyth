package textedit

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/unicode"
)

func newManager(t *testing.T, cfg Config) *Manager {
	t.Helper()
	m := NewManager(cfg)
	t.Cleanup(m.Shutdown)
	return m
}

func writeTemp(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func versionOf(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// pageText decodes a file as the editor page does (TextDecoder with the
// reported encoding, the mark dropped) and joins lines with "\n", as
// CodeMirror keeps them.
func pageText(t *testing.T, data []byte, info Info) string {
	t.Helper()
	body := data[info.BOM:]
	var s string
	switch info.Encoding {
	case UTF8:
		s = string(body)
	case UTF16LE:
		b, err := unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewDecoder().Bytes(body)
		if err != nil {
			t.Fatal(err)
		}
		s = string(b)
	case UTF16BE:
		b, err := unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM).NewDecoder().Bytes(body)
		if err != nil {
			t.Fatal(err)
		}
		s = string(b)
	default:
		s = decodeWHATWG(singleByte[info.Encoding], body)
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\r", "\n")
}

// decodeWHATWG decodes a code page as TextDecoder does: a byte the code
// page leaves undefined is the C1 control of the same value.
func decodeWHATWG(cm *charmap.Charmap, b []byte) string {
	var sb strings.Builder
	for _, c := range b {
		r := cm.DecodeByte(c)
		if r == '�' && c >= 0x80 && c <= 0x9F {
			r = rune(c)
		}
		sb.WriteRune(r)
	}
	return sb.String()
}

// stringify is JSON.stringify of a JS string given as UTF-16 code units: a
// lone surrogate becomes a \u escape.
func stringify(units []uint16) []byte {
	var b bytes.Buffer
	b.WriteByte('"')
	for i := 0; i < len(units); i++ {
		u := units[i]
		switch {
		case u >= 0xD800 && u <= 0xDBFF && i+1 < len(units) && units[i+1] >= 0xDC00 && units[i+1] <= 0xDFFF:
			b.WriteString(string(utf16.DecodeRune(rune(u), rune(units[i+1]))))
			i++
		case u >= 0xD800 && u <= 0xDFFF:
			fmt.Fprintf(&b, `\u%04x`, u)
		case u == '"' || u == '\\':
			b.WriteByte('\\')
			b.WriteByte(byte(u))
		case u < 0x20:
			fmt.Fprintf(&b, `\u%04x`, u)
		default:
			b.WriteString(string(rune(u)))
		}
	}
	b.WriteByte('"')
	return b.Bytes()
}

// stage sends text in chunks of at most n UTF-16 code units, cutting
// surrogate pairs where they fall (as a naive page would).
func stage(t *testing.T, m *Manager, id, text string, n int) {
	t.Helper()
	units := utf16.Encode([]rune(text))
	seq := 0
	for off := 0; off == 0 || off < len(units); off += n {
		end := min(len(units), off+n)
		if err := m.Write(id, seq, stringify(units[off:end])); err != nil {
			t.Fatalf("chunk %d: %v", seq, err)
		}
		seq++
	}
}

func jsonChunk(s string) []byte {
	b, _ := json.Marshal(s)
	return b
}

func TestRoundTripByteForByte(t *testing.T) {
	utf16le := func(s string, bom bool) []byte {
		var out []byte
		if bom {
			out = append(out, 0xFF, 0xFE)
		}
		for _, u := range utf16.Encode([]rune(s)) {
			out = append(out, byte(u), byte(u>>8))
		}
		return out
	}
	utf16be := func(s string, bom bool) []byte {
		var out []byte
		if bom {
			out = append(out, 0xFE, 0xFF)
		}
		for _, u := range utf16.Encode([]rune(s)) {
			out = append(out, byte(u>>8), byte(u))
		}
		return out
	}
	var all1252 []byte
	for i := 0; i < 4; i++ {
		for c := 0x20; c <= 0xFF; c++ {
			all1252 = append(all1252, byte(c))
		}
		all1252 = append(all1252, '\r', '\n')
	}
	all1252 = append(all1252, '\t', 0x1b, '\r', '\n')
	cases := []struct {
		name string
		data []byte
		enc  string
		bom  int
		eol  string
	}{
		{"utf8-lf", []byte("# Title\n\nSome text, é and 😀.\nlast line without end"), UTF8, 0, LF},
		{"utf8-bom-crlf", append([]byte{0xEF, 0xBB, 0xBF}, "a = 1\r\nb = \"ü\"\r\n"...), UTF8, 3, CRLF},
		{"utf8-cr", []byte("one\rtwo\rthree\r"), UTF8, 0, CR},
		{"utf8-empty", nil, UTF8, 0, LF},
		{"utf16le-bom-crlf", utf16le("Zeile 1\r\nZeile 2 😀 ß\r\n", true), UTF16LE, 2, CRLF},
		{"utf16be-bom-lf", utf16be("line 1\nline 2 €\n", true), UTF16BE, 2, LF},
		{"utf16le-nobom", utf16le("plain ascii text in UTF-16\r\nsecond line\r\n", false), UTF16LE, 0, CRLF},
		{"windows-1252", []byte("caf\xe9 costs 5 \x80\r\nna\xefve\r\n"), Windows1252, 0, CRLF},
		{"windows-1252-every-byte", all1252, Windows1252, 0, CRLF},
		{"utf8-bom-then-invalid", []byte("\xEF\xBB\xBFcaf\xe9\n"), Windows1252, 0, LF},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := newManager(t, Config{})
			path := writeTemp(t, t.TempDir(), "f.txt", c.data)
			info, err := m.Open(context.Background(), path)
			if err != nil {
				t.Fatal(err)
			}
			if info.Encoding != c.enc || info.BOM != c.bom || info.LineEnding != c.eol {
				t.Fatalf("detected %s bom %d %s, want %s %d %s", info.Encoding, info.BOM, info.LineEnding, c.enc, c.bom, c.eol)
			}
			if info.State.Version != versionOf(c.data) || info.State.SizeBytes != int64(len(c.data)) || info.Name != "f.txt" {
				t.Fatalf("state %+v", info)
			}
			// Small chunks: pairs are cut, chunks joined.
			stage(t, m, info.SessionID, pageText(t, c.data, info), 7)
			out, err := m.Commit(context.Background(), info.SessionID, info.State.Version, false, false)
			if err != nil || out.Status != StatusSaved || out.Encoding != c.enc {
				t.Fatalf("commit %+v %v", out, err)
			}
			got, _ := os.ReadFile(path)
			if !bytes.Equal(got, c.data) {
				t.Fatalf("saved bytes differ:\n got %x\nwant %x", got, c.data)
			}
			if out.State.Version != info.State.Version {
				t.Errorf("the same bytes have another version: %s", out.State.Version)
			}
		})
	}
}

func TestMixedLineEndingsSaveTheMostCommon(t *testing.T) {
	m := newManager(t, Config{})
	path := writeTemp(t, t.TempDir(), "mixed.txt", []byte("a\r\nb\r\nc\nd\re\r\n"))
	info, err := m.Open(context.Background(), path)
	if err != nil || info.LineEnding != CRLF {
		t.Fatalf("%+v %v", info, err)
	}
	stage(t, m, info.SessionID, "a\nb\nc\nd\ne\n", ChunkChars)
	if out, err := m.Commit(context.Background(), info.SessionID, info.State.Version, false, false); err != nil || out.Status != StatusSaved {
		t.Fatalf("%+v %v", out, err)
	}
	if got, _ := os.ReadFile(path); string(got) != "a\r\nb\r\nc\r\nd\r\ne\r\n" {
		t.Errorf("saved %q", got)
	}
	for in, want := range map[string]string{"": LF, "x": LF, "a\nb\r\n": LF, "a\rb\r\nc\r\n": CRLF, "a\rb\rc\n": CR} {
		if got := lineEnding([]byte(in), UTF8); got != want {
			t.Errorf("lineEnding(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestEditSavedAndMtimeChanges(t *testing.T) {
	m := newManager(t, Config{})
	path := writeTemp(t, t.TempDir(), "notes.md", []byte("# Notes\r\n"))
	old := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	_ = os.Chtimes(path, old, old)
	info, _ := m.Open(context.Background(), path)
	stage(t, m, info.SessionID, "# Notes\n\nMore, with € and 日本.\n", ChunkChars)
	out, err := m.Commit(context.Background(), info.SessionID, info.State.Version, false, false)
	if err != nil || out.Status != StatusSaved {
		t.Fatalf("%+v %v", out, err)
	}
	want := "# Notes\r\n\r\nMore, with € and 日本.\r\n"
	got, _ := os.ReadFile(path)
	if string(got) != want || out.State.Version != versionOf(got) || out.State.SizeBytes != int64(len(got)) {
		t.Fatalf("saved %q %+v", got, out)
	}
	if fi, _ := os.Stat(path); !fi.ModTime().After(old) || fi.ModTime().UnixNano() != out.State.MtimeNs {
		t.Errorf("modified time %v (state %d)", fi.ModTime(), out.State.MtimeNs)
	}
	// The staged text is gone with the save: a commit needs chunks again.
	if _, err := m.Commit(context.Background(), info.SessionID, out.State.Version, false, false); !errors.Is(err, ErrChunk) {
		t.Errorf("commit with nothing staged: %v", err)
	}
	// The next save starts from the saved version.
	stage(t, m, info.SessionID, "# Notes\n", ChunkChars)
	if out2, err := m.Commit(context.Background(), info.SessionID, out.State.Version, false, false); err != nil || out2.Status != StatusSaved {
		t.Fatalf("second save %+v %v", out2, err)
	}
	if entries, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".*panelyth-partial")); len(entries) != 0 {
		t.Errorf("partial files left: %v", entries)
	}
}

func TestUnencodableThenAsUTF8(t *testing.T) {
	m := newManager(t, Config{})
	orig := []byte("caf\xe9\r\nsecond\r\n")
	path := writeTemp(t, t.TempDir(), "legacy.txt", orig)
	info, _ := m.Open(context.Background(), path)
	if info.Encoding != Windows1252 {
		t.Fatal(info.Encoding)
	}
	stage(t, m, info.SessionID, "café\nsecond\nthird 日本\n", ChunkChars)
	out, err := m.Commit(context.Background(), info.SessionID, info.State.Version, false, false)
	if err != nil || out.Status != StatusUnencodable || out.Line != 3 {
		t.Fatalf("%+v %v", out, err)
	}
	if got, _ := os.ReadFile(path); !bytes.Equal(got, orig) {
		t.Fatal("an unencodable save wrote the file")
	}
	// The staged text is kept: save it as UTF-8 without sending it again.
	out, err = m.Commit(context.Background(), info.SessionID, info.State.Version, false, true)
	if err != nil || out.Status != StatusSaved || out.Encoding != UTF8 {
		t.Fatalf("%+v %v", out, err)
	}
	if got, _ := os.ReadFile(path); string(got) != "café\r\nsecond\r\nthird 日本\r\n" {
		t.Fatalf("saved %q", got)
	}
	// From now on the file is UTF-8.
	stage(t, m, info.SessionID, "日本\n", ChunkChars)
	if out, err := m.Commit(context.Background(), info.SessionID, out.State.Version, false, false); err != nil || out.Encoding != UTF8 {
		t.Fatalf("%+v %v", out, err)
	}
	// A UTF-8 file with a mark saved "as UTF-8" loses its mark.
	p2 := writeTemp(t, t.TempDir(), "bom.txt", []byte("\xEF\xBB\xBFx\n"))
	i2, _ := m.Open(context.Background(), p2)
	stage(t, m, i2.SessionID, "x\n", ChunkChars)
	if _, err := m.Commit(context.Background(), i2.SessionID, i2.State.Version, false, true); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(p2); string(got) != "x\n" {
		t.Errorf("as UTF-8: %q", got)
	}
}

func TestEncodeEveryEncoding(t *testing.T) {
	samples := map[string]string{"utf-8": "Ж😀", "utf-16le": "Ж😀", "utf-16be": "Ж😀", "windows-1252": "é€",
		"windows-1250": "őč", "windows-1251": "Жё", "iso-8859-2": "őč", "koi8-r": "Жё"}
	for _, enc := range Encodings {
		text := "a " + samples[enc] + "\nb\n"
		out, _, ok := encode(text, enc, false, CRLF)
		if !ok {
			t.Errorf("%s: unencodable", enc)
			continue
		}
		var want []byte
		var err error
		crlf := strings.ReplaceAll(text, "\n", "\r\n")
		switch enc {
		case UTF8:
			want = []byte(crlf)
		case UTF16LE:
			want, err = unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewEncoder().Bytes([]byte(crlf))
		case UTF16BE:
			want, err = unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM).NewEncoder().Bytes([]byte(crlf))
		default:
			want, err = singleByte[enc].NewEncoder().Bytes([]byte(crlf))
		}
		if err != nil || !bytes.Equal(out, want) {
			t.Errorf("%s: %x, want %x (%v)", enc, out, want, err)
		}
	}
	if _, line, ok := encode("ok\nő\n", "windows-1252", false, LF); ok || line != 2 {
		t.Errorf("ő in windows-1252: ok %v line %d", ok, line)
	}
	if _, _, ok := encode("€", "iso-8859-2", false, LF); ok {
		t.Error("€ in iso-8859-2 encoded")
	}
	// Every byte of the Windows code pages decodes (as the page decodes it)
	// to a character that encodes back.
	for _, enc := range []string{"windows-1252", "windows-1250", "windows-1251"} {
		for c := 1; c < 256; c++ {
			text := decodeWHATWG(singleByte[enc], []byte{byte(c)})
			if out, _, ok := encode(text, enc, false, LF); !ok || len(out) != 1 || out[0] != byte(c) {
				t.Errorf("%s byte %#x: %q → %x %v", enc, c, text, out, ok)
			}
		}
	}
}

func TestDetect(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		enc  string
		ok   bool
	}{
		{"nul", []byte("PK\x03\x04\x14\x00\x00\x00\x08\x00"), "", false},
		{"controls", bytes.Repeat([]byte{0x01, 0x02, 'a'}, 100), "", false},
		{"utf16le odd length", []byte{0xFF, 0xFE, 'a', 0, 'b'}, "", false},
		{"utf16le lone surrogate", []byte{0xFF, 0xFE, 0x00, 0xD8, 'a', 0}, "", false},
		{"utf16be", []byte{0, 'h', 0, 'i', 0, '\n'}, UTF16BE, true},
		{"latin", []byte("na\xefve"), Windows1252, true},
		{"utf8", []byte("naïve"), UTF8, true},
	}
	for _, c := range cases {
		enc, _, ok := detect(c.data)
		if ok != c.ok || enc != c.enc {
			t.Errorf("%s: %q %v", c.name, enc, ok)
		}
	}
}

func TestOpenRefusals(t *testing.T) {
	m := newManager(t, Config{})
	dir := t.TempDir()
	ctx := context.Background()
	if _, err := m.Open(ctx, writeTemp(t, dir, "a.bin", []byte("PK\x03\x04\x00\x00\x00binary"))); !errors.Is(err, ErrBinary) {
		t.Errorf("binary: %v", err)
	}
	big := bytes.Repeat([]byte("0123456789abcde\n"), MaxBytes/16)
	if _, err := m.Open(ctx, writeTemp(t, dir, "exact.txt", big)); err != nil {
		t.Errorf("exactly the limit: %v", err)
	}
	if _, err := m.Open(ctx, writeTemp(t, dir, "big.txt", append(big, 'x'))); !errors.Is(err, ErrTooLarge) {
		t.Errorf("too large: %v", err)
	}
	if _, err := m.Open(ctx, dir); !errors.Is(err, ErrFolder) {
		t.Errorf("folder: %v", err)
	}
	if _, err := m.Open(ctx, filepath.Join(dir, "missing.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("missing: %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := m.Open(cancelled, filepath.Join(dir, "exact.txt")); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled: %v", err)
	}
	if m.Count() != 1 {
		t.Errorf("%d sessions", m.Count())
	}
}

func TestConflict(t *testing.T) {
	ctx := context.Background()
	m := newManager(t, Config{})
	path := writeTemp(t, t.TempDir(), "c.txt", []byte("one\n"))
	info, _ := m.Open(ctx, path)

	// Changed on disk, same size: found by its hash.
	if err := os.WriteFile(path, []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stage(t, m, info.SessionID, "mine\n", ChunkChars)
	out, err := m.Commit(ctx, info.SessionID, info.State.Version, false, false)
	if err != nil || out.Status != StatusConflict || out.Gone {
		t.Fatalf("%+v %v", out, err)
	}
	if got, _ := os.ReadFile(path); string(got) != "two\n" {
		t.Fatalf("a conflict wrote %q", got)
	}
	// Changed size: a conflict without reading.
	_ = os.WriteFile(path, []byte("three!\n"), 0o644)
	if out, _ := m.Commit(ctx, info.SessionID, info.State.Version, false, false); out.Status != StatusConflict {
		t.Fatalf("%+v", out)
	}
	// Overwrite.
	out, err = m.Commit(ctx, info.SessionID, info.State.Version, true, false)
	if err != nil || out.Status != StatusSaved {
		t.Fatalf("force: %+v %v", out, err)
	}
	if got, _ := os.ReadFile(path); string(got) != "mine\n" {
		t.Fatalf("forced %q", got)
	}
	// The file deleted: gone; an overwrite creates it again.
	_ = os.Remove(path)
	stage(t, m, info.SessionID, "again\n", ChunkChars)
	if out, _ := m.Commit(ctx, info.SessionID, out.State.Version, false, false); out.Status != StatusConflict || !out.Gone {
		t.Fatalf("deleted: %+v", out)
	}
	if out, err := m.Commit(ctx, info.SessionID, "", true, false); err != nil || out.Status != StatusSaved {
		t.Fatalf("recreate: %+v %v", out, err)
	}
	if got, _ := os.ReadFile(path); string(got) != "again\n" {
		t.Fatalf("recreated %q", got)
	}
	// Reload: the page takes the version check reports and saves from it.
	_ = os.WriteFile(path, []byte("theirs\n"), 0o644)
	disk, err := m.Check(ctx, info.SessionID)
	if err != nil || disk == nil || disk.Version != versionOf([]byte("theirs\n")) {
		t.Fatalf("check %+v %v", disk, err)
	}
	stage(t, m, info.SessionID, "theirs and mine\n", ChunkChars)
	if out, err := m.Commit(ctx, info.SessionID, disk.Version, false, false); err != nil || out.Status != StatusSaved {
		t.Fatalf("after reload %+v %v", out, err)
	}
	// A cancelled commit writes nothing.
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	stage(t, m, info.SessionID, "never\n", ChunkChars)
	if _, err := m.Commit(cancelled, info.SessionID, "", true, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "theirs and mine\n" {
		t.Fatalf("a cancelled commit wrote %q", got)
	}
}

func TestCheck(t *testing.T) {
	ctx := context.Background()
	m := newManager(t, Config{})
	path := writeTemp(t, t.TempDir(), "c.txt", []byte("one\n"))
	info, _ := m.Open(ctx, path)
	disk, err := m.Check(ctx, info.SessionID)
	if err != nil || disk == nil || *disk != info.State {
		t.Fatalf("unchanged: %+v %v", disk, err)
	}
	_ = os.WriteFile(path, []byte("changed\n"), 0o644)
	disk, err = m.Check(ctx, info.SessionID)
	if err != nil || disk == nil || disk.Version != versionOf([]byte("changed\n")) || disk.SizeBytes != 8 {
		t.Fatalf("changed: %+v %v", disk, err)
	}
	_ = os.Remove(path)
	if disk, err := m.Check(ctx, info.SessionID); err != nil || disk != nil {
		t.Fatalf("gone: %+v %v", disk, err)
	}
}

func TestFailedWriteLeavesOriginal(t *testing.T) {
	ctx := context.Background()
	m := newManager(t, Config{})
	dir := t.TempDir()
	path := writeTemp(t, dir, "keep.txt", []byte("original\n"))
	info, _ := m.Open(ctx, path)
	failure := errors.New("injected")
	replace = func(string, string) error { return failure }
	t.Cleanup(func() { replace = replaceFile })
	stage(t, m, info.SessionID, "new text\n", ChunkChars)
	if _, err := m.Commit(ctx, info.SessionID, info.State.Version, false, false); !errors.Is(err, failure) {
		t.Fatalf("commit: %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "original\n" {
		t.Fatalf("original changed: %q", got)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, ".*")); len(left) != 0 {
		t.Fatalf("left behind: %v", left)
	}
	// The staged text survives a failed save; the next try works.
	replace = replaceFile
	if out, err := m.Commit(ctx, info.SessionID, info.State.Version, false, false); err != nil || out.Status != StatusSaved {
		t.Fatalf("retry: %+v %v", out, err)
	}
}

func TestFailedWriteInReadOnlyFolder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a read-only folder does not stop writes on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root writes into read-only folders")
	}
	ctx := context.Background()
	m := newManager(t, Config{})
	dir := t.TempDir()
	path := writeTemp(t, dir, "keep.txt", []byte("original\n"))
	info, _ := m.Open(ctx, path)
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	stage(t, m, info.SessionID, "new\n", ChunkChars)
	if _, err := m.Commit(ctx, info.SessionID, info.State.Version, false, false); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("commit: %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "original\n" {
		t.Fatalf("original changed: %q", got)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, ".*")); len(left) != 0 {
		t.Fatalf("left behind: %v", left)
	}
}

func TestSymlinkIsWrittenThrough(t *testing.T) {
	ctx := context.Background()
	m := newManager(t, Config{})
	dir := t.TempDir()
	target := writeTemp(t, dir, "real.txt", []byte("real\n"))
	link := filepath.Join(dir, "link.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks need privileges here: %v", err)
	}
	info, err := m.Open(ctx, link)
	if err != nil {
		t.Fatal(err)
	}
	stage(t, m, info.SessionID, "through the link\n", ChunkChars)
	if out, err := m.Commit(ctx, info.SessionID, info.State.Version, false, false); err != nil || out.Status != StatusSaved {
		t.Fatalf("%+v %v", out, err)
	}
	if got, _ := os.ReadFile(target); string(got) != "through the link\n" {
		t.Fatalf("target %q", got)
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the link was replaced: %v %v", fi.Mode(), err)
	}
	// A link whose target is gone: a conflict, and an overwrite refuses to
	// guess.
	_ = os.Remove(target)
	stage(t, m, info.SessionID, "x\n", ChunkChars)
	if out, _ := m.Commit(ctx, info.SessionID, "", false, false); out.Status != StatusConflict || !out.Gone {
		t.Fatalf("dangling: %+v", out)
	}
	if _, err := m.Commit(ctx, info.SessionID, "", true, false); !errors.Is(err, ErrLinkBroken) {
		t.Fatalf("dangling overwrite: %v", err)
	}
}

func TestHardLinksStayOneFile(t *testing.T) {
	ctx := context.Background()
	m := newManager(t, Config{})
	dir := t.TempDir()
	a := writeTemp(t, dir, "a.txt", []byte("shared\n"))
	b := filepath.Join(dir, "b.txt")
	if err := os.Link(a, b); err != nil {
		t.Skipf("hard links: %v", err)
	}
	info, _ := m.Open(ctx, a)
	stage(t, m, info.SessionID, "changed for both\n", ChunkChars)
	if out, err := m.Commit(ctx, info.SessionID, info.State.Version, false, false); err != nil || out.Status != StatusSaved {
		t.Fatalf("%+v %v", out, err)
	}
	for _, p := range []string{a, b} {
		if got, _ := os.ReadFile(p); string(got) != "changed for both\n" {
			t.Errorf("%s: %q", filepath.Base(p), got)
		}
	}
	if linkCount(a) != 2 {
		t.Errorf("links %d", linkCount(a))
	}
}

func TestReadOnlyFileStaysReadOnly(t *testing.T) {
	ctx := context.Background()
	m := newManager(t, Config{})
	path := writeTemp(t, t.TempDir(), "ro.txt", []byte("locked\n"))
	if err := os.Chmod(path, 0o444); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o644) })
	info, _ := m.Open(ctx, path)
	stage(t, m, info.SessionID, "still locked\n", ChunkChars)
	if out, err := m.Commit(ctx, info.SessionID, info.State.Version, false, false); err != nil || out.Status != StatusSaved {
		t.Fatalf("%+v %v", out, err)
	}
	fi, _ := os.Stat(path)
	if fi.Mode().Perm()&0o222 != 0 {
		t.Errorf("mode %v", fi.Mode())
	}
	if got, _ := os.ReadFile(path); string(got) != "still locked\n" {
		t.Errorf("saved %q", got)
	}
	if runtime.GOOS != "windows" {
		p2 := writeTemp(t, t.TempDir(), "secret.txt", []byte("s\n"))
		_ = os.Chmod(p2, 0o600)
		i2, _ := m.Open(ctx, p2)
		stage(t, m, i2.SessionID, "t\n", ChunkChars)
		if _, err := m.Commit(ctx, i2.SessionID, i2.State.Version, false, false); err != nil {
			t.Fatal(err)
		}
		if fi, _ := os.Stat(p2); fi.Mode().Perm() != 0o600 {
			t.Errorf("mode %v", fi.Mode())
		}
	}
}

func TestChunks(t *testing.T) {
	ctx := context.Background()
	m := newManager(t, Config{})
	path := writeTemp(t, t.TempDir(), "c.txt", []byte("x\n"))
	info, _ := m.Open(ctx, path)
	id := info.SessionID
	if err := m.Write(id, 1, jsonChunk("a")); !errors.Is(err, ErrChunk) {
		t.Errorf("seq 1 first: %v", err)
	}
	if err := m.Write(id, 0, jsonChunk("a")); err != nil {
		t.Fatal(err)
	}
	if err := m.Write(id, 2, jsonChunk("c")); !errors.Is(err, ErrChunk) {
		t.Errorf("gap: %v", err)
	}
	// The gap dropped the staged text: no partial save.
	if _, err := m.Commit(ctx, id, info.State.Version, false, false); !errors.Is(err, ErrChunk) {
		t.Errorf("commit after a gap: %v", err)
	}
	if err := m.Write(id, 0, []byte(`42`)); !errors.Is(err, ErrChunk) {
		t.Errorf("not a string: %v", err)
	}
	if err := m.Write(id, 0, jsonChunk(strings.Repeat("a", ChunkChars+1))); !errors.Is(err, ErrChunk) {
		t.Errorf("chunk too long: %v", err)
	}
	// Non-BMP characters count two units each.
	if err := m.Write(id, 0, jsonChunk(strings.Repeat("😀", ChunkChars/2+1))); !errors.Is(err, ErrChunk) {
		t.Errorf("chunk too long in units: %v", err)
	}
	full := jsonChunk(strings.Repeat("a", ChunkChars))
	for seq := 0; seq < MaxChars/ChunkChars; seq++ {
		if err := m.Write(id, seq, full); err != nil {
			t.Fatalf("chunk %d: %v", seq, err)
		}
	}
	if err := m.Write(id, MaxChars/ChunkChars, jsonChunk("a")); !errors.Is(err, ErrChunk) {
		t.Errorf("past the total: %v", err)
	}
	if m.staged.Load() != 0 {
		t.Errorf("staged %d bytes after a rejection", m.staged.Load())
	}

	// All sessions share a staging budget.
	small := newManager(t, Config{StagingBytes: 8})
	i2, _ := small.Open(ctx, path)
	if err := small.Write(i2.SessionID, 0, jsonChunk("123456789")); !errors.Is(err, ErrBusy) {
		t.Errorf("over budget: %v", err)
	}
	if err := small.Write(i2.SessionID, 0, jsonChunk("1234")); err != nil {
		t.Errorf("within budget: %v", err)
	}
	small.Close(i2.SessionID)
	if small.staged.Load() != 0 {
		t.Errorf("a closed session keeps %d staged bytes", small.staged.Load())
	}
}

func TestSurrogatePairCutByChunks(t *testing.T) {
	ctx := context.Background()
	m := newManager(t, Config{})
	path := writeTemp(t, t.TempDir(), "e.txt", []byte("x\n"))
	info, _ := m.Open(ctx, path)
	// 😀 is D83D DE00: the first chunk ends after D83D.
	if err := m.Write(info.SessionID, 0, []byte(`"a\ud83d"`)); err != nil {
		t.Fatal(err)
	}
	if err := m.Write(info.SessionID, 1, []byte(`"\ude00b\\"`)); err != nil {
		t.Fatal(err)
	}
	// An escaped backslash before "ud83d" is text, not an escape.
	if err := m.Write(info.SessionID, 2, []byte(`"\\ud83d"`)); err != nil {
		t.Fatal(err)
	}
	// A lone half is U+FFFD, as any decoder makes it.
	if err := m.Write(info.SessionID, 3, []byte(`"\ud83d"`)); err != nil {
		t.Fatal(err)
	}
	if out, err := m.Commit(ctx, info.SessionID, info.State.Version, false, false); err != nil || out.Status != StatusSaved {
		t.Fatalf("%+v %v", out, err)
	}
	if got, _ := os.ReadFile(path); string(got) != "a😀b\\\\ud83d�" {
		t.Errorf("saved %q", got)
	}
}

func TestSessionsGoneCappedAndIdle(t *testing.T) {
	ctx := context.Background()
	path := writeTemp(t, t.TempDir(), "s.txt", []byte("x\n"))
	m := newManager(t, Config{MaxSessions: 2})
	if err := m.Write("nope", 0, jsonChunk("a")); !errors.Is(err, ErrGone) {
		t.Errorf("write: %v", err)
	}
	if _, err := m.Commit(ctx, "nope", "", false, false); !errors.Is(err, ErrGone) {
		t.Errorf("commit: %v", err)
	}
	if _, err := m.Check(ctx, "nope"); !errors.Is(err, ErrGone) {
		t.Errorf("check: %v", err)
	}
	a, _ := m.Open(ctx, path)
	time.Sleep(2 * time.Millisecond)
	b, _ := m.Open(ctx, path)
	time.Sleep(2 * time.Millisecond)
	if _, err := m.Check(ctx, a.SessionID); err != nil { // a is now the more recent
		t.Fatal(err)
	}
	c, _ := m.Open(ctx, path)
	if m.Count() != 2 {
		t.Fatalf("%d sessions", m.Count())
	}
	if _, err := m.Check(ctx, b.SessionID); !errors.Is(err, ErrGone) {
		t.Errorf("the least recently used was kept: %v", err)
	}
	for _, id := range []string{a.SessionID, c.SessionID} {
		if _, err := m.Check(ctx, id); err != nil {
			t.Errorf("%s: %v", id, err)
		}
	}
	if !m.Close(a.SessionID) || m.Close(a.SessionID) {
		t.Error("close is not idempotent")
	}
	if err := m.Write(a.SessionID, 0, jsonChunk("a")); !errors.Is(err, ErrGone) {
		t.Errorf("write after close: %v", err)
	}

	idle := newManager(t, Config{Idle: 40 * time.Millisecond})
	if _, err := idle.Open(ctx, path); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for idle.Count() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if idle.Count() != 0 {
		t.Error("an idle session stayed open")
	}
	idle.Shutdown()
	if _, err := idle.Open(ctx, path); !errors.Is(err, ErrGone) {
		t.Errorf("open after shutdown: %v", err)
	}
}
