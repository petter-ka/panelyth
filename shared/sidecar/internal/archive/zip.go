package archive

import (
	"archive/zip"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
)

// maxLinkBytes bounds a stored link target.
const maxLinkBytes = 4096

type zipReader struct {
	f *os.File
	z *zip.Reader
}

// countingReaderAt reports bytes read (compressed data, central directory).
type countingReaderAt struct {
	r  io.ReaderAt
	fn func(int64)
}

func (c countingReaderAt) ReadAt(p []byte, off int64) (int, error) {
	n, err := c.r.ReadAt(p, off)
	if n > 0 {
		c.fn(int64(n))
	}
	return n, err
}

func openZip(path string, counted func(int64)) (reader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	var ra io.ReaderAt = f
	if counted != nil {
		ra = countingReaderAt{r: f, fn: counted}
	}
	z, err := zip.NewReader(ra, fi.Size())
	// Insecure names are rejected per entry (CleanPath), not for the archive.
	if err != nil && !errors.Is(err, zip.ErrInsecurePath) {
		_ = f.Close()
		return nil, corrupt(err)
	}
	return &zipReader{f: f, z: z}, nil
}

func (r *zipReader) close() error { return r.f.Close() }

func zipHeader(f *zip.File) Header {
	name := f.Name
	if f.Flags&0x800 == 0 {
		name = legacyName(name)
	}
	h := Header{Raw: name, Size: int64(f.UncompressedSize64), Mode: f.Mode(), Encrypted: f.Flags&1 != 0}
	if !f.Modified.IsZero() {
		h.MtimeNs = f.Modified.UnixNano()
	}
	mode := f.Mode()
	switch {
	case mode.IsDir() || (len(f.Name) > 0 && (f.Name[len(f.Name)-1] == '/' || f.Name[len(f.Name)-1] == '\\')):
		h.Kind, h.Size = KindDir, 0
	case mode&fs.ModeSymlink != 0:
		h.Kind = KindSymlink
	case mode&(fs.ModeDevice|fs.ModeNamedPipe|fs.ModeSocket|fs.ModeCharDevice) != 0:
		h.Kind = KindSpecial
	}
	h.Path, h.Unsafe = CleanPath(name)
	return h
}

func (r *zipReader) walk(ctx context.Context, want func(h *Header) bool, fn func(h *Header, data io.Reader) error) error {
	for _, f := range r.z.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		h := zipHeader(f)
		if want == nil || !want(&h) || h.Kind == KindDir || h.Unsafe != "" || h.Encrypted {
			if err := fn(&h, nil); err != nil {
				return err
			}
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return corrupt(err)
		}
		var data io.Reader = dataReader(ctx, rc)
		if h.Kind == KindSymlink {
			b, lerr := io.ReadAll(io.LimitReader(data, maxLinkBytes))
			if lerr != nil {
				_ = rc.Close()
				return corrupt(lerr)
			}
			h.Link, data = string(b), nil
		}
		err = fn(&h, data)
		_ = rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
