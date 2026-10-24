package textedit

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"panelyth/sidecar/internal/fileops"
)

// Pictures in a document (Stage C10.7, ADR-0046): a pasted or dropped
// picture arrives in chunks, is checked to be a picture by its bytes, and is
// written under a unique name into a folder beside the document (or linked
// where an identical copy already is). Linked pictures are resolved in
// batches, only inside the document's folder tree, for main to hand out as
// read-only tokens.

// Limits (mirror src/shared/contracts/src/textedit.ts).
const (
	// MaxImageBytes bounds one picture (TEXTEDIT_MAX_IMAGE_BYTES).
	MaxImageBytes = 25 << 20
	// ImageChunkBytes bounds one decoded chunk (TEXTEDIT_IMAGE_CHUNK_BYTES).
	ImageChunkBytes = 1 << 20
	// MaxImageLinks bounds one resolveImages call (TEXTEDIT_MAX_IMAGE_LINKS).
	MaxImageLinks = 200
	// maxLinkedBytes: a linked file larger than this is not shown.
	maxLinkedBytes = 64 << 20
	// maxDedupeFiles bounds the files of the assets folder compared with a
	// new picture.
	maxDedupeFiles = 2000
	// maxNameRunes bounds an asset's file name (without its extension) and
	// the folder's name.
	maxNameRunes = 64
	sniffImage   = 64
)

var (
	// ErrNotImage: the bytes are none of the picture types.
	ErrNotImage = errors.New("textedit: not a picture")
	// ErrAssetFolder: the assets folder's name is not one plain name, or
	// the name is taken by something that is not a folder of the document.
	ErrAssetFolder = errors.New("textedit: invalid assets folder")
	// ErrTooManyLinks: more than MaxImageLinks in one call.
	ErrTooManyLinks = errors.New("textedit: too many links")
)

// Image types are the contract's TEXTEDIT_IMAGE_TYPES.
var imageExt = map[string]string{"png": ".png", "jpeg": ".jpg", "gif": ".gif", "webp": ".webp", "bmp": ".bmp", "avif": ".avif"}

// imageExts are the extensions a dedupe looks at.
var imageExts = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true, ".avif": true}

// SniffImage names a picture's type by its first bytes (at least 32 are
// needed for every type); the extension is not believed. SVG is not a
// picture here: it is a document that can carry scripts.
func SniffImage(head []byte) string {
	switch {
	case bytes.HasPrefix(head, []byte("\x89PNG\r\n\x1a\n")):
		return "png"
	case bytes.HasPrefix(head, []byte{0xFF, 0xD8, 0xFF}):
		return "jpeg"
	case bytes.HasPrefix(head, []byte("GIF87a")), bytes.HasPrefix(head, []byte("GIF89a")):
		return "gif"
	case len(head) >= 12 && string(head[:4]) == "RIFF" && string(head[8:12]) == "WEBP":
		return "webp"
	case len(head) >= 18 && string(head[:2]) == "BM":
		// "BM" alone is any text starting so: the DIB header's size must be
		// one of the known ones.
		switch binary.LittleEndian.Uint32(head[14:]) {
		case 12, 40, 52, 56, 64, 108, 124:
			return "bmp"
		}
	case len(head) >= 16 && string(head[4:8]) == "ftyp":
		// An ISO-BMFF file: AVIF by its major or a compatible brand.
		size := min(int(binary.BigEndian.Uint32(head)), len(head))
		for off := 8; off+4 <= size; off += 4 {
			if off == 12 {
				continue // the minor version
			}
			if b := string(head[off : off+4]); b == "avif" || b == "avis" {
				return "avif"
			}
		}
	}
	return ""
}

// AssetChunk stages one chunk of a picture, base64. Seq 0 starts a new
// picture (dropping one not committed); each next chunk is the one after.
// Errors: ErrGone, ErrChunk (the staged picture is dropped), ErrBusy.
func (m *Manager) AssetChunk(id string, seq int, data string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrGone
	}
	if seq == 0 {
		m.dropPicture(s)
		s.picNext = 0
	}
	if s.picNext < 0 || seq != s.picNext {
		want := s.picNext
		m.dropPicture(s)
		if want < 0 {
			return fmt.Errorf("%w: picture chunk %d comes before chunk 0", ErrChunk, seq)
		}
		return fmt.Errorf("%w: picture chunk %d out of order, expected %d", ErrChunk, seq, want)
	}
	// Refused by its length before anything is decoded.
	if base64.StdEncoding.DecodedLen(len(data)) > ImageChunkBytes+2 {
		m.dropPicture(s)
		return fmt.Errorf("%w: a picture chunk is at most %d bytes", ErrChunk, ImageChunkBytes)
	}
	b, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		m.dropPicture(s)
		return fmt.Errorf("%w: the picture chunk is not base64", ErrChunk)
	}
	if len(b) > ImageChunkBytes {
		m.dropPicture(s)
		return fmt.Errorf("%w: a picture chunk is at most %d bytes", ErrChunk, ImageChunkBytes)
	}
	if len(s.pic)+len(b) > MaxImageBytes {
		m.dropPicture(s)
		return fmt.Errorf("%w: a picture is at most %d MB", ErrChunk, MaxImageBytes>>20)
	}
	n := int64(len(b))
	if m.staged.Add(n) > m.cfg.StagingBytes {
		m.staged.Add(-n)
		m.dropPicture(s)
		return ErrBusy
	}
	if s.pic == nil && seq == 0 {
		// Most pictures are one or a few chunks: room for four.
		s.pic = make([]byte, 0, min(MaxImageBytes, 4*max(len(b), 1)))
	}
	s.pic = append(s.pic, b...)
	s.picNext++
	return nil
}

// dropPicture forgets the staged picture. Callers hold s.mu.
func (m *Manager) dropPicture(s *session) {
	m.staged.Add(-int64(len(s.pic)))
	s.pic, s.picNext = nil, -1
}

// AssetCommit writes the staged picture into folder beside the document,
// under name cleaned and made unique, and returns its relative Markdown
// link. A file of the folder with the same bytes is linked instead (reused).
// Errors: ErrGone, ErrChunk (no picture staged), ErrNotImage, ErrAssetFolder,
// I/O errors.
func (m *Manager) AssetCommit(ctx context.Context, id, name, folder string) (link string, reused bool, err error) {
	s, err := m.get(id)
	if err != nil {
		return "", false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return "", false, ErrGone
	}
	if s.picNext < 0 || len(s.pic) == 0 {
		return "", false, fmt.Errorf("%w: no picture was sent (chunk 0 is missing)", ErrChunk)
	}
	typ := SniffImage(s.pic[:min(len(s.pic), sniffImage)])
	if typ == "" {
		m.dropPicture(s)
		return "", false, ErrNotImage
	}
	if err := validFolder(folder); err != nil {
		return "", false, err
	}
	docDir, err := documentDir(s.path)
	if err != nil {
		return "", false, err
	}
	dir := filepath.Join(docDir, folder)
	if err := os.Mkdir(dir, 0o777); err != nil && !errors.Is(err, fs.ErrExist) {
		return "", false, err
	}
	// The folder must be a folder in the document's tree: a link that
	// leads elsewhere would put the picture where no link reaches it.
	if real, err := filepath.EvalSymlinks(dir); err != nil {
		return "", false, err
	} else if fi, err := os.Stat(real); err != nil || !fi.IsDir() || !inside(docDir, real) {
		return "", false, fmt.Errorf("%w: %s is not a folder beside the document", ErrAssetFolder, folder)
	}
	sum := sha256.Sum256(s.pic)
	if same, err := findSame(ctx, dir, s.pic, sum); err != nil {
		return "", false, err
	} else if same != "" {
		m.dropPicture(s)
		return encodeLink(folder + "/" + same), true, nil
	}
	base := cleanAssetName(name)
	ext := imageExt[typ]
	for i := 0; i < 10000; i++ {
		if err := ctx.Err(); err != nil {
			return "", false, err
		}
		file := base + ext
		if i > 0 {
			file = base + "-" + strconv.Itoa(i) + ext
		}
		dst := filepath.Join(dir, file)
		if _, err := os.Lstat(dst); err == nil {
			continue
		}
		err := writeNew(ctx, dir, file, s.pic)
		if fileops.Code(err) == fileops.CodeExists {
			continue // taken between the look and the rename
		}
		if err != nil {
			return "", false, err
		}
		m.dropPicture(s)
		return encodeLink(folder + "/" + file), false, nil
	}
	return "", false, fmt.Errorf("textedit: no free name for %s%s", base, ext)
}

// writeNew writes data to a new file dir/name through a partial file and a
// rename that never replaces (fileops.CommitFile). Nothing is left behind
// on failure.
func writeNew(ctx context.Context, dir, name string, data []byte) error {
	partial := fileops.PartialName(dir, name)
	fileops.RemovePartial(partial, false)
	if err := writePartial(ctx, partial, data, false); err != nil {
		fileops.RemovePartial(partial, false)
		return err
	}
	if err := ctx.Err(); err != nil {
		fileops.RemovePartial(partial, false)
		return err
	}
	// CommitFile removes the partial file when it fails.
	return commitNew(partial, filepath.Join(dir, name))
}

// commitNew is fileops.CommitFile without replacing; tests make it fail.
var commitNew = defaultCommitNew

func defaultCommitNew(partial, dst string) error { return fileops.CommitFile(partial, dst, false) }

// findSame looks for a picture file in dir with these bytes: same size
// first, then the same SHA-256.
func findSame(ctx context.Context, dir string, data []byte, sum [32]byte) (string, error) {
	f, err := os.Open(dir)
	if err != nil {
		return "", err
	}
	entries, err := f.ReadDir(maxDedupeFiles)
	_ = f.Close()
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if !e.Type().IsRegular() || !imageExts[strings.ToLower(filepath.Ext(e.Name()))] ||
			strings.HasSuffix(e.Name(), fileops.PartialSuffix) {
			continue
		}
		fi, err := e.Info()
		if err != nil || fi.Size() != int64(len(data)) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err == nil && sha256.Sum256(b) == sum {
			return e.Name(), nil
		}
	}
	return "", nil
}

// validFolder checks the assets folder's name: one plain name, valid on
// Windows too (a document may move there), at most 64 characters.
func validFolder(folder string) error {
	bad := func(why string) error { return fmt.Errorf("%w: %s", ErrAssetFolder, why) }
	switch {
	case folder == "" || folder == "." || folder == "..":
		return bad("the folder needs a name")
	case strings.ContainsAny(folder, `/\`):
		return bad("the folder is one name, without / or \\")
	case utf8.RuneCountInString(folder) > maxNameRunes:
		return bad("the folder's name is too long")
	}
	if err := fileops.ValidateWindowsName(folder); err != nil {
		return bad(err.Error())
	}
	return nil
}

// cleanAssetName keeps letters, digits, '-', '_', '.' and spaces of name
// without its extension, at most 64 of them; "image" when none is left or
// the name is one Windows reserves.
func cleanAssetName(name string) string {
	name = name[strings.LastIndexAny(name, `/\`)+1:]
	name = strings.TrimSuffix(name, filepath.Ext(name))
	var b strings.Builder
	n := 0
	for _, r := range name {
		if n == maxNameRunes {
			break
		}
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' || r == '.' || r == ' ' {
			b.WriteRune(r)
			n++
		}
	}
	// No hidden file (a leading dot), nothing Windows trims (a trailing dot
	// or space).
	out := strings.Trim(b.String(), ". ")
	if out == "" || fileops.ValidateWindowsName(out+".png") != nil {
		return "image"
	}
	return out
}

// encodeLink percent-encodes what would break a Markdown link target or
// change how it resolves (space ( ) < > % # ? and control characters);
// other characters stay readable.
func encodeLink(link string) string {
	var b strings.Builder
	for i := 0; i < len(link); i++ {
		c := link[i]
		if c <= ' ' || c == 0x7f || strings.IndexByte("()<>%#?", c) >= 0 {
			fmt.Fprintf(&b, "%%%02X", c)
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

// documentDir is the folder of the document's file, links resolved.
func documentDir(path string) (string, error) {
	target, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	return filepath.Dir(target), nil
}

// inside reports whether p is dir or below it (both clean and absolute).
func inside(dir, p string) bool {
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// Resolved is one link of ResolveImages: the picture's path and type, or
// empty when the link names no picture inside the document's tree.
type Resolved struct {
	Link string
	Path string
	Type string
}

// ResolveImages resolves links as written in the document against its
// folder. A link resolves only to a regular picture file (by its bytes) of
// at most 64 MB inside the document's folder or below, also after links
// are followed. Web addresses, other schemes, absolute and UNC paths
// resolve to nothing. Nothing is cached. Errors: ErrGone, ErrTooManyLinks,
// the context's.
func (m *Manager) ResolveImages(ctx context.Context, id string, links []string) ([]Resolved, error) {
	if len(links) > MaxImageLinks {
		return nil, fmt.Errorf("%w: at most %d links at once", ErrTooManyLinks, MaxImageLinks)
	}
	s, err := m.get(id)
	if err != nil {
		return nil, err
	}
	out := make([]Resolved, len(links))
	for i, l := range links {
		out[i].Link = l
	}
	docDir, err := documentDir(s.path)
	if err != nil {
		return out, nil // the document is gone: nothing resolves
	}
	head := make([]byte, sniffImage)
	dirs := map[string]bool{}
	for i, l := range links {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if p := relativeLink(docDir, l); p != "" {
			if path, typ := resolveOne(docDir, p, dirs, head); typ != "" {
				out[i].Path, out[i].Type = path, typ
			}
		}
	}
	return out, nil
}

// relativeLink is the path a relative link names below docDir, or "".
func relativeLink(docDir, link string) string {
	link = strings.TrimSpace(link)
	if strings.HasPrefix(link, "<") && strings.HasSuffix(link, ">") {
		link = link[1 : len(link)-1]
	}
	if link == "" || hasScheme(link) || strings.HasPrefix(link, "/") || strings.ContainsRune(link, '\\') {
		return ""
	}
	if i := strings.IndexAny(link, "#?"); i >= 0 {
		link = link[:i]
	}
	dec, err := url.PathUnescape(link)
	if err != nil || dec == "" || strings.HasPrefix(dec, "/") || strings.ContainsAny(dec, "\\\x00") {
		return ""
	}
	// After decoding: no drive ("C%3A/…") and, on Windows, no stream
	// ("a.png:x").
	if hasScheme(dec) || runtime.GOOS == "windows" && strings.ContainsRune(dec, ':') {
		return ""
	}
	p := filepath.Join(docDir, filepath.FromSlash(dec))
	if !inside(docDir, p) || filepath.VolumeName(dec) != "" {
		return ""
	}
	return p
}

// hasScheme reports a URL scheme ("https:", "data:") or a drive ("C:").
func hasScheme(s string) bool {
	i := strings.IndexByte(s, ':')
	if i <= 0 {
		return false
	}
	for j, c := range s[:i] {
		alpha := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
		if !alpha && (j == 0 || !(c >= '0' && c <= '9' || c == '+' || c == '-' || c == '.')) {
			return false
		}
	}
	return true
}

// resolveOne is the picture p names (inside docDir, resolved already) and
// its type, or "" when it is no picture there or leads outside. The folders
// below docDir are looked at once per call (dirs); the file is opened
// without following a link, so one open tells a plain file from a link (a
// whole EvalSymlinks per link costs 0.7 ms on Windows). A link or another
// reparse point on the way is resolved in full and must stay inside.
func resolveOne(docDir, p string, dirs map[string]bool, head []byte) (string, string) {
	rel, err := filepath.Rel(docDir, p)
	if err != nil || rel == "." {
		return "", ""
	}
	parts := strings.Split(rel, string(filepath.Separator))
	cur := docDir
	for _, part := range parts[:len(parts)-1] {
		cur = filepath.Join(cur, part)
		if dirs[cur] {
			continue
		}
		fi, err := os.Lstat(cur)
		if err != nil {
			return "", ""
		}
		if fi.Mode().Type() != fs.ModeDir {
			return resolveSlow(docDir, p, head)
		}
		dirs[cur] = true
	}
	f, size, link, err := openLeaf(p)
	if err != nil {
		return "", ""
	}
	if link {
		return resolveSlow(docDir, p, head)
	}
	defer f.Close()
	if size > maxLinkedBytes {
		return "", ""
	}
	return p, sniffOpen(f, head)
}

// resolveSlow follows every link of p and checks the result stays inside.
func resolveSlow(docDir, p string, head []byte) (string, string) {
	real, err := filepath.EvalSymlinks(p)
	if err != nil || !inside(docDir, real) {
		return "", ""
	}
	f, err := os.Open(real)
	if err != nil {
		return "", ""
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > maxLinkedBytes {
		return "", ""
	}
	return real, sniffOpen(f, head)
}

// sniffOpen is the picture type of an open file by its first bytes, or "".
func sniffOpen(f *os.File, head []byte) string {
	n, _ := io.ReadFull(f, head)
	return SniffImage(head[:n])
}
