package textedit

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Minimal headers of every picture type (enough bytes for the sniffer).
func samplePictures() map[string][]byte {
	bmp := make([]byte, 54)
	copy(bmp, "BM")
	binary.LittleEndian.PutUint32(bmp[14:], 40)
	avif := []byte("\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1miaf")
	avis := []byte("\x00\x00\x00\x20ftypmif1\x00\x00\x00\x00mif1avismiafMA1B")
	return map[string][]byte{
		"png":  append([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"), make([]byte, 24)...),
		"jpeg": append([]byte{0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 'J', 'F', 'I', 'F'}, make([]byte, 30)...),
		"gif":  append([]byte("GIF89a"), make([]byte, 30)...),
		"webp": append([]byte("RIFF\x24\x00\x00\x00WEBPVP8 "), make([]byte, 30)...),
		"bmp":  bmp,
		"avif": avif,
		"avis": avis,
	}
}

func TestSniffImage(t *testing.T) {
	for name, b := range samplePictures() {
		want := name
		if name == "avis" {
			want = "avif"
		}
		if got := SniffImage(b); got != want {
			t.Errorf("%s: %q", name, got)
		}
	}
	for name, b := range map[string][]byte{
		"text":     []byte("BM is not a bitmap, it is text with enough length"),
		"svg":      []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`),
		"mp4":      []byte("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"),
		"riff-wav": []byte("RIFF\x24\x00\x00\x00WAVEfmt "),
		"empty":    nil,
	} {
		if got := SniffImage(b); got != "" {
			t.Errorf("%s sniffed as %q", name, got)
		}
	}
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// newDoc opens a session on a Markdown file in a new folder.
func newDoc(t *testing.T, m *Manager) (Info, string) {
	t.Helper()
	dir := t.TempDir()
	info, err := m.Open(context.Background(), writeTemp(t, dir, "doc.md", []byte("# Doc\n")))
	if err != nil {
		t.Fatal(err)
	}
	return info, dir
}

func sendPicture(t *testing.T, m *Manager, id string, pic []byte) {
	t.Helper()
	for seq, off := 0, 0; off == 0 || off < len(pic); seq, off = seq+1, off+ImageChunkBytes {
		if err := m.AssetChunk(id, seq, b64(pic[off:min(len(pic), off+ImageChunkBytes)])); err != nil {
			t.Fatalf("chunk %d: %v", seq, err)
		}
	}
}

func TestAssetChunks(t *testing.T) {
	m := newManager(t, Config{})
	info, _ := newDoc(t, m)
	id := info.SessionID
	if err := m.AssetChunk(id, 1, b64([]byte("x"))); !errors.Is(err, ErrChunk) {
		t.Errorf("seq 1 first: %v", err)
	}
	if err := m.AssetChunk(id, 0, "not base64!"); !errors.Is(err, ErrChunk) {
		t.Errorf("bad base64: %v", err)
	}
	if err := m.AssetChunk(id, 0, b64(make([]byte, ImageChunkBytes+1))); !errors.Is(err, ErrChunk) {
		t.Errorf("chunk too large: %v", err)
	}
	if err := m.AssetChunk(id, 0, b64([]byte("a"))); err != nil {
		t.Fatal(err)
	}
	if err := m.AssetChunk(id, 2, b64([]byte("c"))); !errors.Is(err, ErrChunk) {
		t.Errorf("gap: %v", err)
	}
	// The gap dropped the picture.
	if _, _, err := m.AssetCommit(context.Background(), id, "x", "assets"); !errors.Is(err, ErrChunk) {
		t.Errorf("commit after a gap: %v", err)
	}
	full := b64(make([]byte, ImageChunkBytes))
	for seq := 0; seq < MaxImageBytes/ImageChunkBytes; seq++ {
		if err := m.AssetChunk(id, seq, full); err != nil {
			t.Fatalf("chunk %d: %v", seq, err)
		}
	}
	if err := m.AssetChunk(id, MaxImageBytes/ImageChunkBytes, b64([]byte("x"))); !errors.Is(err, ErrChunk) {
		t.Errorf("past 25 MB: %v", err)
	}
	if m.staged.Load() != 0 {
		t.Errorf("%d bytes staged after a rejection", m.staged.Load())
	}
	// The staging budget is shared with the text.
	small := newManager(t, Config{StagingBytes: 16})
	i2, _ := newDoc(t, small)
	if err := small.Write(i2.SessionID, 0, jsonChunk("0123456789")); err != nil {
		t.Fatal(err)
	}
	if err := small.AssetChunk(i2.SessionID, 0, b64(make([]byte, 7))); !errors.Is(err, ErrBusy) {
		t.Errorf("over the shared budget: %v", err)
	}
	if err := small.AssetChunk("gone", 0, ""); !errors.Is(err, ErrGone) {
		t.Errorf("unknown session: %v", err)
	}
}

func TestAssetCommit(t *testing.T) {
	ctx := context.Background()
	m := newManager(t, Config{})
	info, dir := newDoc(t, m)
	id := info.SessionID
	pics := samplePictures()

	sendPicture(t, m, id, pics["png"])
	link, reused, err := m.AssetCommit(ctx, id, "My Screenshot (1).PNG", "my assets")
	if err != nil || reused || link != "my%20assets/My%20Screenshot%201.png" {
		t.Fatalf("first: %q %v %v", link, reused, err)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "my assets", "My Screenshot 1.png")); err != nil || !bytes.Equal(b, pics["png"]) {
		t.Fatalf("written: %v", err)
	}
	// The staged picture is gone with the commit.
	if _, _, err := m.AssetCommit(ctx, id, "x", "my assets"); !errors.Is(err, ErrChunk) {
		t.Errorf("second commit: %v", err)
	}
	// The same bytes again: linked, not written.
	sendPicture(t, m, id, pics["png"])
	if link, reused, err := m.AssetCommit(ctx, id, "other", "my assets"); err != nil || !reused || link != "my%20assets/My%20Screenshot%201.png" {
		t.Errorf("dedupe: %q %v %v", link, reused, err)
	}
	// Other bytes with the same name: a unique name; the type by the bytes.
	for i, want := range []string{"assets/image.jpg", "assets/image-1.jpg", "assets/image-2.jpg"} {
		pic := append(bytes.Clone(pics["jpeg"]), byte(i))
		sendPicture(t, m, id, pic)
		if link, reused, err := m.AssetCommit(ctx, id, "", "assets"); err != nil || reused || link != want {
			t.Errorf("unique %d: %q %v %v", i, link, reused, err)
		}
	}
	sendPicture(t, m, id, pics["avif"])
	if link, _, err := m.AssetCommit(ctx, id, "../../evil/con.gif", "assets"); err != nil || link != "assets/image.avif" {
		t.Errorf("a path and a reserved name: %q %v", link, err)
	}
	// Not a picture.
	sendPicture(t, m, id, []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`))
	if _, _, err := m.AssetCommit(ctx, id, "x", "assets"); !errors.Is(err, ErrNotImage) {
		t.Errorf("svg: %v", err)
	}
	// Bad folder names.
	for _, folder := range []string{"", ".", "..", "a/b", `a\b`, "con", "nul.txt", "trailing.", "trailing ", "a:b",
		strings.Repeat("x", 65)} {
		sendPicture(t, m, id, pics["gif"])
		if _, _, err := m.AssetCommit(ctx, id, "x", folder); !errors.Is(err, ErrAssetFolder) {
			t.Errorf("folder %q: %v", folder, err)
		}
	}
	// A file where the folder should be.
	writeTemp(t, dir, "taken", []byte("x"))
	if _, _, err := m.AssetCommit(ctx, id, "x", "taken"); !errors.Is(err, ErrAssetFolder) {
		t.Errorf("a file named like the folder: %v", err)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, "*", ".*")); len(left) != 0 {
		t.Errorf("left behind: %v", left)
	}
}

func TestAssetCommitFailureLeavesNothing(t *testing.T) {
	ctx := context.Background()
	m := newManager(t, Config{})
	info, dir := newDoc(t, m)
	failure := errors.New("injected")
	commitNew = func(partial, _ string) error {
		_ = os.Remove(partial) // as fileops.CommitFile does on failure
		return failure
	}
	t.Cleanup(func() { commitNew = defaultCommitNew })
	sendPicture(t, m, info.SessionID, samplePictures()["webp"])
	if _, _, err := m.AssetCommit(ctx, info.SessionID, "pic", "assets"); !errors.Is(err, failure) {
		t.Fatalf("commit: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "assets"))
	if len(entries) != 0 {
		t.Errorf("left behind: %v", entries)
	}
	// The picture is still staged: the next try works.
	commitNew = defaultCommitNew
	if link, _, err := m.AssetCommit(ctx, info.SessionID, "pic", "assets"); err != nil || link != "assets/pic.webp" {
		t.Errorf("retry: %q %v", link, err)
	}
}

func TestResolveImages(t *testing.T) {
	ctx := context.Background()
	m := newManager(t, Config{})
	info, dir := newDoc(t, m)
	pics := samplePictures()
	_ = os.MkdirAll(filepath.Join(dir, "assets", "deep"), 0o755)
	writeTemp(t, dir, "top.png", pics["png"])
	writeTemp(t, filepath.Join(dir, "assets"), "a b.gif", pics["gif"])
	writeTemp(t, filepath.Join(dir, "assets", "deep"), "d.bmp", pics["bmp"])
	writeTemp(t, filepath.Join(dir, "assets"), "fake.png", []byte("not a picture at all, just text"))
	outside := t.TempDir()
	writeTemp(t, outside, "out.png", pics["png"])
	rel, _ := filepath.Rel(dir, filepath.Join(outside, "out.png"))

	cases := map[string]string{ // link → type ("" for none)
		"top.png":                         "png",
		"./top.png":                       "png",
		"assets/a%20b.gif":                "gif",
		"<assets/a b.gif>":                "gif",
		"assets/deep/d.bmp#frag":          "bmp",
		"assets/deep/d.bmp?v=2":           "bmp",
		"assets/deep/../../top.png":       "png",
		"assets/fake.png":                 "",
		"assets/missing.png":              "",
		"assets":                          "",
		"../" + filepath.ToSlash(rel):     "",
		filepath.ToSlash(rel):             "",
		filepath.Join(dir, "top.png"):     "",
		"/top.png":                        "",
		`assets\a b.gif`:                  "",
		`\\server\share\x.png`:            "",
		"https://example.org/top.png":     "",
		"data:image/png;base64,iVBORw0KG": "",
		"file:///top.png":                 "",
		"C:/top.png":                      "",
		"C%3A/top.png":                    "",
		"%2e%2e/" + filepath.ToSlash(rel): "",
		"":                                "",
	}
	var links []string
	for l := range cases {
		links = append(links, l)
	}
	got, err := m.ResolveImages(ctx, info.SessionID, links)
	if err != nil || len(got) != len(links) {
		t.Fatalf("%v %v", got, err)
	}
	for i, r := range got {
		want := cases[links[i]]
		if r.Link != links[i] || r.Type != want || (want == "") != (r.Path == "") {
			t.Errorf("%q: %+v, want type %q", links[i], r, want)
		}
		if r.Path != "" && !filepath.IsAbs(r.Path) {
			t.Errorf("%q: path %q", links[i], r.Path)
		}
	}
	if _, err := m.ResolveImages(ctx, info.SessionID, make([]string, MaxImageLinks+1)); !errors.Is(err, ErrTooManyLinks) {
		t.Errorf("201 links: %v", err)
	}
	if _, err := m.ResolveImages(ctx, "gone", nil); !errors.Is(err, ErrGone) {
		t.Errorf("unknown session: %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := m.ResolveImages(cancelled, info.SessionID, []string{"top.png"}); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled: %v", err)
	}
	// A link inside that points outside resolves to nothing.
	if err := os.Symlink(filepath.Join(outside, "out.png"), filepath.Join(dir, "assets", "link.png")); err != nil {
		t.Skipf("symlinks need privileges here: %v", err)
	}
	if got, _ := m.ResolveImages(ctx, info.SessionID, []string{"assets/link.png"}); got[0].Path != "" {
		t.Errorf("a link to outside resolved: %+v", got[0])
	}
}

func TestEncodeLinkAndCleanName(t *testing.T) {
	for in, want := range map[string]string{"assets/a b.png": "assets/a%20b.png", "x/(1)<2>.png": "x/%281%29%3C2%3E.png",
		"x/100%#?.png": "x/100%25%23%3F.png", "bilder/ärger.png": "bilder/ärger.png"} {
		if got := encodeLink(in); got != want {
			t.Errorf("encodeLink(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{"": "image", "...": "image", "Screenshot 2026-10-24 at 10.00.png": "Screenshot 2026-10-24 at 10.00",
		".hidden.png": "hidden", "a*b?c.png": "abc", "Ärger.jpeg": "Ärger", "PRN.png": "image", strings.Repeat("y", 80) + ".png": strings.Repeat("y", 64)} {
		if got := cleanAssetName(in); got != want {
			t.Errorf("cleanAssetName(%q) = %q, want %q", in, got, want)
		}
	}
}
