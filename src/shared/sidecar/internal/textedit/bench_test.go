package textedit

import (
	"context"
	"crypto/sha256"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"unicode/utf16"
)

// Budgets (Stage C10.6, docs/commander/PERFORMANCE.md): opening 1 MB of
// Markdown ≤ 300 ms in all (the sidecar's part should be a few ms), a local
// save of 1 MB ≤ 150 ms. The save is measured as the sidecar sees it: the
// chunks decoded and staged, the conflict check (a hash of the file on
// disk), the encoding, the partial file written and synced, the rename.
//
//	go test ./internal/textedit -run '^$' -bench . -benchtime 20x

const benchBytes = 1 << 20

// markdown is about n bytes of Markdown with some non-ASCII prose.
func markdown(n int) string {
	para := "## Section\n\nSome *prose* with `code`, a [link](https://example.org) and naïve café text — ü, ß.\n\n" +
		"- a list item\n- another item with **bold**\n\n```go\nfunc main() { println(\"hi\") }\n```\n\n"
	return strings.Repeat(para, n/len(para)+1)[:n]
}

// latin is about n bytes of windows-1252 text (as decoded: é, €, ü).
func latin(n int) string {
	line := "Prix: 12,50 € — café, crème brûlée, Müller; naïve façade.\n"
	s := strings.Repeat(line, n/len(line)+1)
	return s[:strings.LastIndexByte(s[:n], '\n')+1]
}

// chunks splits text as the page does: JSON strings of ChunkChars units.
func benchChunks(text string) [][]byte {
	units := utf16.Encode([]rune(text))
	var out [][]byte
	for off := 0; off < len(units); off += ChunkChars {
		out = append(out, stringify(units[off:min(len(units), off+ChunkChars)]))
	}
	return out
}

func benchCommit(b *testing.B, text, enc string) {
	b.Helper()
	m := NewManager(Config{})
	defer m.Shutdown()
	data, _, ok := encode(text, enc, false, CRLF)
	if !ok {
		b.Fatal("sample not encodable")
	}
	path := filepath.Join(b.TempDir(), "bench.txt")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		b.Fatal(err)
	}
	ctx := context.Background()
	info, err := m.Open(ctx, path)
	if err != nil || info.Encoding != enc {
		b.Fatalf("%+v %v", info, err)
	}
	chunks := benchChunks(text)
	version := info.State.Version
	b.SetBytes(int64(len(data)))
	b.ResetTimer()
	for b.Loop() {
		for seq, c := range chunks {
			if err := m.Write(info.SessionID, seq, c); err != nil {
				b.Fatal(err)
			}
		}
		out, err := m.Commit(ctx, info.SessionID, version, false, false)
		if err != nil || out.Status != StatusSaved {
			b.Fatalf("%+v %v", out, err)
		}
		version = out.State.Version
	}
}

func BenchmarkCommit(b *testing.B) {
	b.Run("markdown-utf8-1MiB", func(b *testing.B) { benchCommit(b, markdown(benchBytes), UTF8) })
	b.Run("windows-1252-1MiB", func(b *testing.B) { benchCommit(b, latin(benchBytes), Windows1252) })
}

// BenchmarkCommitCPU is a save without the disk: the chunks decoded and
// staged, the text encoded and hashed. The rest of BenchmarkCommit is the
// file system's (the write, fsync and a written-through rename).
func BenchmarkCommitCPU(b *testing.B) {
	for _, c := range []struct {
		name, text, enc string
	}{{"markdown-utf8-1MiB", markdown(benchBytes), UTF8}, {"windows-1252-1MiB", latin(benchBytes), Windows1252}} {
		b.Run(c.name, func(b *testing.B) {
			m := NewManager(Config{})
			defer m.Shutdown()
			path := filepath.Join(b.TempDir(), "bench.txt")
			if err := os.WriteFile(path, []byte("x\n"), 0o644); err != nil {
				b.Fatal(err)
			}
			info, err := m.Open(context.Background(), path)
			if err != nil {
				b.Fatal(err)
			}
			chunks := benchChunks(c.text)
			b.SetBytes(int64(len(c.text)))
			for b.Loop() {
				for seq, ch := range chunks {
					if err := m.Write(info.SessionID, seq, ch); err != nil {
						b.Fatal(err)
					}
				}
				s, _ := m.get(info.SessionID)
				out, _, ok := encode(s.staged(), c.enc, false, CRLF)
				if !ok {
					b.Fatal("unencodable")
				}
				_ = sha256.Sum256(out)
			}
		})
	}
}

func BenchmarkOpen(b *testing.B) {
	for _, c := range []struct {
		name, text, enc string
	}{{"markdown-utf8-1MiB", markdown(benchBytes), UTF8}, {"windows-1252-1MiB", latin(benchBytes), Windows1252}} {
		b.Run(c.name, func(b *testing.B) {
			m := NewManager(Config{})
			defer m.Shutdown()
			data, _, _ := encode(c.text, c.enc, false, CRLF)
			path := filepath.Join(b.TempDir(), "bench.txt")
			if err := os.WriteFile(path, data, 0o644); err != nil {
				b.Fatal(err)
			}
			b.SetBytes(int64(len(data)))
			for b.Loop() {
				info, err := m.Open(context.Background(), path)
				if err != nil {
					b.Fatal(err)
				}
				m.Close(info.SessionID)
			}
		})
	}
}

// BenchmarkResolveImages resolves a visible range's 200 links (Stage C10.7):
// each a link resolve, a stat and a 64-byte read; the cache is warm.
func BenchmarkResolveImages(b *testing.B) {
	m := NewManager(Config{})
	defer m.Shutdown()
	dir := b.TempDir()
	doc := filepath.Join(dir, "doc.md")
	if err := os.WriteFile(doc, []byte("# Doc\n"), 0o644); err != nil {
		b.Fatal(err)
	}
	_ = os.Mkdir(filepath.Join(dir, "assets"), 0o755)
	png := append([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"), make([]byte, 1024)...)
	links := make([]string, MaxImageLinks)
	for i := range links {
		name := "image-" + strconv.Itoa(i) + ".png"
		if err := os.WriteFile(filepath.Join(dir, "assets", name), png, 0o644); err != nil {
			b.Fatal(err)
		}
		links[i] = "assets/" + name
	}
	info, err := m.Open(context.Background(), doc)
	if err != nil {
		b.Fatal(err)
	}
	b.Run("resolve", func(b *testing.B) {
		for b.Loop() {
			res, err := m.ResolveImages(context.Background(), info.SessionID, links)
			if err != nil || res[MaxImageLinks-1].Type != "png" {
				b.Fatalf("%+v %v", res[MaxImageLinks-1], err)
			}
		}
	})
	// The floor: only an open and a close of each file.
	b.Run("open-close-floor", func(b *testing.B) {
		for b.Loop() {
			for _, l := range links {
				f, err := os.Open(filepath.Join(dir, filepath.FromSlash(l)))
				if err != nil {
					b.Fatal(err)
				}
				_ = f.Close()
			}
		}
	})
}
