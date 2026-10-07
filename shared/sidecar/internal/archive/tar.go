package archive

import (
	"archive/tar"
	"bufio"
	"compress/bzip2"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// streamBuffer is the read buffer in front of decompressors.
const streamBuffer = 256 << 10

type tarReader struct {
	f      *os.File
	format Format
	src    io.Reader // the file, counted and buffered
}

func openTar(path string, format Format, counted func(int64)) (reader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	var src io.Reader = f
	if counted != nil {
		src = &countingReader{r: f, fn: counted}
	}
	return &tarReader{f: f, format: format, src: bufio.NewReaderSize(src, streamBuffer)}, nil
}

func (r *tarReader) close() error { return r.f.Close() }

// stream is the decompressed tar stream.
func (r *tarReader) stream() (io.Reader, error) {
	switch r.format {
	case FormatTgz:
		z, err := gzip.NewReader(r.src)
		if err != nil {
			return nil, corrupt(err)
		}
		return z, nil
	case FormatTbz2:
		return bzip2.NewReader(r.src), nil
	}
	return r.src, nil
}

func tarHeader(th *tar.Header) Header {
	h := Header{Raw: th.Name, Size: th.Size, Mode: fs.FileMode(th.Mode).Perm(), Link: th.Linkname}
	if !th.ModTime.IsZero() {
		h.MtimeNs = th.ModTime.UnixNano()
	}
	switch th.Typeflag {
	case tar.TypeDir:
		h.Kind, h.Size = KindDir, 0
	case tar.TypeReg, tar.TypeGNUSparse:
		h.Kind = KindFile
		if strings.HasSuffix(th.Name, "/") {
			h.Kind, h.Size = KindDir, 0
		}
	case tar.TypeSymlink:
		h.Kind, h.Size = KindSymlink, 0
	case tar.TypeLink:
		h.Kind, h.Size = KindHardlink, 0
	default:
		h.Kind, h.Size = KindSpecial, 0
	}
	h.Path, h.Unsafe = CleanPath(th.Name)
	return h
}

func (r *tarReader) walk(ctx context.Context, want func(h *Header) bool, fn func(h *Header, data io.Reader) error) error {
	s, err := r.stream()
	if err != nil {
		return err
	}
	tr := tar.NewReader(dataReader(ctx, s))
	for {
		th, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		// Insecure names are rejected per entry (CleanPath).
		if err != nil && !errors.Is(err, tar.ErrInsecurePath) {
			if cerr := ctx.Err(); cerr != nil {
				return cerr
			}
			return corrupt(err)
		}
		switch th.Typeflag {
		case tar.TypeXHeader, tar.TypeXGlobalHeader, tar.TypeGNULongName, tar.TypeGNULongLink:
			continue // consumed by the reader; never entries of their own
		}
		h := tarHeader(th)
		var data io.Reader
		if want != nil && h.Kind == KindFile && h.Unsafe == "" && want(&h) {
			data = tr
		}
		if err := fn(&h, data); err != nil {
			return err
		}
	}
}

// gzReader is a single gzip-compressed file: one entry.
type gzReader struct {
	f       *os.File
	src     io.Reader
	name    string
	size    int64
	mtimeNs int64
}

func openGz(path string, counted func(int64)) (reader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	r := &gzReader{f: f, name: StripExt(filepath.Base(path)), size: -1, mtimeNs: fi.ModTime().UnixNano()}
	// ISIZE, the last four bytes: the uncompressed size modulo 2^32 (an
	// estimate for listings; exact below 4 GiB for single-member files).
	if fi.Size() >= 18 {
		var b [4]byte
		if _, err := f.ReadAt(b[:], fi.Size()-4); err == nil {
			r.size = int64(uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24)
		}
	}
	var src io.Reader = f
	if counted != nil {
		src = &countingReader{r: f, fn: counted}
	}
	r.src = bufio.NewReaderSize(src, streamBuffer)
	return r, nil
}

func (r *gzReader) close() error { return r.f.Close() }

func (r *gzReader) walk(ctx context.Context, want func(h *Header) bool, fn func(h *Header, data io.Reader) error) error {
	z, err := gzip.NewReader(r.src)
	if err != nil {
		return corrupt(err)
	}
	name := r.name
	// The stored name, when there is one, is only a base name.
	if z.Name != "" {
		if base := filepath.Base(filepath.FromSlash(strings.ReplaceAll(z.Name, `\`, "/"))); base != "." && base != string(filepath.Separator) {
			name = base
		}
	}
	h := Header{Raw: name, Kind: KindFile, Size: max(r.size, 0), SizeEstimated: true, MtimeNs: r.mtimeNs, Mode: 0o644}
	if !z.ModTime.IsZero() && z.ModTime.After(time.Unix(0, 0)) {
		h.MtimeNs = z.ModTime.UnixNano()
	}
	h.Path, h.Unsafe = CleanPath(name)
	var data io.Reader
	if want != nil && h.Unsafe == "" && want(&h) {
		data = dataReader(ctx, z)
	}
	return fn(&h, data)
}
