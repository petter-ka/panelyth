// Package archive reads, extracts, tests and creates archives (ADR-0030):
// zip, tar, tar.gz and tar.bz2 and single .gz files with the standard
// library, 7z, rar and others through an optional external 7-Zip. Open
// archives are browsed like folders through a query session source; their
// entries never reach index.db.
package archive

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"strings"
)

// Format names an archive format (mirrors shared/contracts ArchiveFormat).
type Format string

const (
	FormatZip  Format = "zip"
	FormatTar  Format = "tar"
	FormatTgz  Format = "tgz"
	FormatTbz2 Format = "tbz2"
	FormatGz   Format = "gz"
	// Format7z covers everything 7-Zip reads (7z, rar, xz, cab, iso, …).
	Format7z Format = "7z"
)

// Limits (ADR-0030).
const (
	// MaxEntries caps one archive's listing (about 100 bytes each in memory).
	MaxEntries = 1_000_000
	// MaxViewBytes caps an entry extracted for viewing (F3, quick view).
	MaxViewBytes = 1 << 30
	// BombRatio: an archive whose expanded size exceeds its compressed size
	// by this factor (and BombMinBytes) gets a warning before extraction.
	BombRatio    = 100
	BombMinBytes = 1 << 30
)

var (
	// ErrNotArchive: the file is not an archive this build can open.
	ErrNotArchive = errors.New("archive: not a supported archive")
	// ErrNoTool: the format needs 7-Zip, which was not found.
	ErrNoTool = errors.New("archive: 7-Zip is not available")
	// ErrCorrupt: the archive could not be read.
	ErrCorrupt = errors.New("archive: the archive is damaged or not readable")
	// ErrTooLarge: more than MaxEntries entries, or an entry too large to view.
	ErrTooLarge = errors.New("archive: too large")
	// ErrChanged: the archive file changed since it was listed.
	ErrChanged = errors.New("archive: the archive changed since it was opened")
	// ErrEncrypted: the entry or archive needs a password (not supported).
	ErrEncrypted = errors.New("archive: the archive is encrypted")
)

// Warnings checks an extraction before it starts (ADR-0030): "space" when
// the expanded size exceeds the free space (free < 0: unknown), "ratio" when
// it exceeds the compressed size BombRatio times and BombMinBytes (a zip
// bomb).
func Warnings(expanded, packed, free int64) []string {
	w := []string{}
	if free >= 0 && expanded > free {
		w = append(w, "space")
	}
	if expanded >= BombMinBytes && expanded > packed*BombRatio {
		w = append(w, "ratio")
	}
	return w
}

// Detect returns the format of a file name, and whether it needs 7-Zip.
// Detection is by name; reading then confirms it.
func Detect(name string) (Format, bool) {
	n := strings.ToLower(name)
	switch {
	case strings.HasSuffix(n, ".zip"):
		return FormatZip, true
	case strings.HasSuffix(n, ".tar"):
		return FormatTar, true
	case strings.HasSuffix(n, ".tar.gz"), strings.HasSuffix(n, ".tgz"):
		return FormatTgz, true
	case strings.HasSuffix(n, ".tar.bz2"), strings.HasSuffix(n, ".tbz2"), strings.HasSuffix(n, ".tbz"):
		return FormatTbz2, true
	case strings.HasSuffix(n, ".gz"):
		return FormatGz, true
	}
	for _, ext := range toolExts {
		if strings.HasSuffix(n, ext) {
			return Format7z, true
		}
	}
	return "", false
}

// toolExts are the names 7-Zip opens (the built-in formats are tried first).
var toolExts = []string{".7z", ".rar", ".xz", ".txz", ".lzma", ".bz2", ".cab", ".iso", ".arj", ".lzh", ".lha",
	".wim", ".zst", ".tzst", ".z", ".cpio", ".rpm", ".deb"}

// Builtin reports whether the standard library handles the format.
func (f Format) Builtin() bool { return f != Format7z && f != "" }

// StripExt removes an archive's extension(s): "photos.tar.gz" → "photos"
// (the folder an archive is unpacked into).
func StripExt(name string) string {
	n := strings.ToLower(name)
	for _, ext := range []string{".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"} {
		if strings.HasSuffix(n, ext) && len(n) > len(ext) {
			return name[:len(name)-len(ext)]
		}
	}
	if ext := filepath.Ext(name); ext != "" && len(ext) < len(name) {
		return name[:len(name)-len(ext)]
	}
	return name
}

// Kind of an archive entry.
type Kind uint8

const (
	KindFile Kind = iota
	KindDir
	KindSymlink
	KindHardlink
	// KindSpecial: devices, pipes and the like; never extracted.
	KindSpecial
)

// Header describes one entry as an archive stores it.
type Header struct {
	// Path is the cleaned inner path ("a/b/c.txt"); "" when Unsafe is set.
	Path string
	// Raw is the stored name (for messages).
	Raw string
	// Unsafe explains why the path is rejected (absolute, "..", …).
	Unsafe string
	Kind   Kind
	Size   int64
	// SizeEstimated: Size is a guess (single .gz files store it modulo 4 GiB).
	SizeEstimated bool
	MtimeNs       int64
	Mode          fs.FileMode
	// Link is a symlink's target or a hard link's archive path.
	Link string
	// Encrypted entries cannot be read.
	Encrypted bool
}

// reader walks an archive's entries in stored order. want decides whether
// fn needs the entry's data; data is valid only during fn.
type reader interface {
	walk(ctx context.Context, want func(h *Header) bool, fn func(h *Header, data io.Reader) error) error
	close() error
}

// openReader opens a built-in format. counted, when set, receives the
// number of archive bytes consumed (progress of whole-archive jobs).
func openReader(path string, f Format, counted func(int64)) (reader, error) {
	switch f {
	case FormatZip:
		return openZip(path, counted)
	case FormatTar, FormatTgz, FormatTbz2:
		return openTar(path, f, counted)
	case FormatGz:
		return openGz(path, counted)
	}
	return nil, fmt.Errorf("%w: %s", ErrNotArchive, f)
}

// countingReader reports consumed bytes.
type countingReader struct {
	r  io.Reader
	fn func(int64)
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if n > 0 && c.fn != nil {
		c.fn(int64(n))
	}
	return n, err
}

// ctxReader stops a long read when ctx is cancelled.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// dataReader is an entry's data as walk hands it out: it stops when ctx is
// cancelled, and read errors (checksums, truncation) come back as
// ErrCorrupt, so a caller can tell them from its own write errors.
func dataReader(ctx context.Context, r io.Reader) io.Reader {
	return tagReader{ctxReader{ctx: ctx, r: r}}
}

type tagReader struct{ r io.Reader }

func (t tagReader) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if err != nil && err != io.EOF {
		err = corrupt(err)
	}
	return n, err
}

// corrupt wraps a format error so callers can tell damaged archives apart.
func corrupt(err error) error {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, ErrCorrupt) || errors.Is(err, ErrEncrypted) {
		return err
	}
	var pe *fs.PathError
	if errors.As(err, &pe) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return err // the file itself could not be read
	}
	return fmt.Errorf("%w: %v", ErrCorrupt, err)
}
