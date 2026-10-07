package archive

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/flate"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"fastview/sidecar/internal/fileops"
)

// PackItem is one marked entry: a file or folder packed under its name.
type PackItem struct {
	Path string
	Name string
}

// PackOptions configure Pack. Callbacks are optional.
type PackOptions struct {
	// Format is FormatZip, FormatTgz or Format7z (with the tool).
	Format Format
	// Level is the compression level, 0 (store) to 9.
	Level int
	Items []PackItem
	// Target is the archive to create; it is written through a partial file
	// next to it and renamed into place when complete.
	Target string
	// Replace overwrites an existing Target.
	Replace bool

	Gate     func(context.Context) error
	Progress func(n int64)
	// Failed reports an entry that could not be added (the archive is still
	// written); item is the index of the marked entry it belongs to.
	Failed func(item int, rel string, err error)
}

// ErrUnsupported: the format can't be created.
var ErrUnsupported = errors.New("archive: this format can't be created")

// CanCreate reports whether Pack writes the format.
func CanCreate(f Format, tool *Tool) bool {
	return f == FormatZip || f == FormatTgz || (f == Format7z && tool.Available())
}

// Pack creates an archive from files and folders. Links are stored as links
// and never followed; devices and pipes are skipped and reported.
func Pack(ctx context.Context, tool *Tool, o *PackOptions) error {
	if !CanCreate(o.Format, tool) {
		if o.Format == Format7z {
			return ErrNoTool
		}
		return ErrUnsupported
	}
	if o.Level < 0 || o.Level > 9 {
		return fmt.Errorf("%w: level must be 0..9", ErrUnsupported)
	}
	partial := fileops.PartialName(filepath.Dir(o.Target), filepath.Base(o.Target))
	_ = os.RemoveAll(partial)
	var err error
	if o.Format == Format7z {
		err = tool.pack(ctx, o, partial)
	} else {
		err = packStd(ctx, o, partial)
	}
	if err != nil {
		fileops.RemovePartial(partial, false)
		return err
	}
	return fileops.CommitFile(partial, o.Target, o.Replace)
}

// entryWriter adds one entry to a zip or tar stream.
type entryWriter interface {
	add(rel string, fi fs.FileInfo, link string, data io.Reader) error
	close() error
}

func packStd(ctx context.Context, o *PackOptions, partial string) error {
	f, err := os.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	bw := bufio.NewWriterSize(f, 1<<20)
	var w entryWriter
	if o.Format == FormatZip {
		w = newZipWriter(bw, o.Level)
	} else {
		w, err = newTgzWriter(bw, o.Level)
		if err != nil {
			_ = f.Close()
			return err
		}
	}
	err = walkItems(ctx, o, w)
	if cerr := w.close(); err == nil {
		err = cerr
	}
	if ferr := bw.Flush(); err == nil {
		err = ferr
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// walkItems feeds every marked entry (folders recursively, links never
// followed) to w.
func walkItems(ctx context.Context, o *PackOptions, w entryWriter) error {
	buf := make([]byte, 256<<10)
	for i, it := range o.Items {
		root := it.Path
		err := filepath.WalkDir(root, func(p string, d fs.DirEntry, werr error) error {
			if o.Gate != nil {
				if err := o.Gate(ctx); err != nil {
					return err
				}
			} else if err := ctx.Err(); err != nil {
				return err
			}
			rel := it.Name
			if p != root {
				r, _ := filepath.Rel(root, p)
				rel = it.Name + "/" + filepath.ToSlash(r)
			}
			if werr != nil {
				o.fail(i, rel, werr)
				if d != nil && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			fi, err := d.Info()
			if err != nil {
				o.fail(i, rel, err)
				return nil
			}
			switch {
			case fi.IsDir():
				return w.add(rel, fi, "", nil)
			case fi.Mode()&fs.ModeSymlink != 0:
				link, err := os.Readlink(p)
				if err != nil {
					o.fail(i, rel, err)
					return nil
				}
				return w.add(rel, fi, filepath.ToSlash(link), nil)
			case !fi.Mode().IsRegular():
				o.fail(i, rel, fileops.Errorf(fileops.CodeSkippedLink, "devices and pipes are not packed"))
				return nil
			}
			src, err := os.Open(p)
			if err != nil {
				o.fail(i, rel, err)
				return nil
			}
			defer src.Close()
			return w.add(rel, fi, "", &progressReader{ctx: ctx, r: src, fn: o.Progress, buf: buf})
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func (o *PackOptions) fail(item int, rel string, err error) {
	if o.Failed != nil {
		o.Failed(item, rel, err)
	}
}

type progressReader struct {
	ctx context.Context
	r   io.Reader
	fn  func(int64)
	buf []byte
}

func (p *progressReader) Read(b []byte) (int, error) {
	if err := p.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := p.r.Read(b)
	if n > 0 && p.fn != nil {
		p.fn(int64(n))
	}
	return n, err
}

// WriteTo lets io.Copy use the shared buffer.
func (p *progressReader) WriteTo(w io.Writer) (int64, error) {
	return io.CopyBuffer(w, struct{ io.Reader }{p}, p.buf)
}

type zipWriter struct {
	z      *zip.Writer
	method uint16
}

func newZipWriter(w io.Writer, level int) *zipWriter {
	z := zip.NewWriter(w)
	method := zip.Deflate
	if level == 0 {
		method = zip.Store
	} else {
		z.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
			return pooledFlate(out, level)
		})
	}
	return &zipWriter{z: z, method: method}
}

func (z *zipWriter) add(rel string, fi fs.FileInfo, link string, data io.Reader) error {
	h, err := zip.FileInfoHeader(fi)
	if err != nil {
		return err
	}
	h.Name, h.Method = rel, z.method
	if fi.IsDir() {
		h.Name, h.Method = rel+"/", zip.Store
	}
	if link != "" {
		h.Method = zip.Store
	}
	// UTF-8 names get the flag; ASCII names need none.
	w, err := z.z.CreateHeader(h)
	if err != nil {
		return err
	}
	switch {
	case link != "":
		_, err = io.WriteString(w, link)
	case data != nil:
		_, err = io.Copy(w, data)
	}
	return err
}

func (z *zipWriter) close() error { return z.z.Close() }

// A deflate compressor holds about 1 MB of state: one per entry made packing
// 10k small files allocation-bound, so they are reused per level.
var flatePools [10]sync.Pool

type flateWriter struct {
	*flate.Writer
	level int
}

func pooledFlate(out io.Writer, level int) (io.WriteCloser, error) {
	if w, ok := flatePools[level].Get().(*flateWriter); ok {
		w.Reset(out)
		return w, nil
	}
	fw, err := flate.NewWriter(out, level)
	if err != nil {
		return nil, err
	}
	return &flateWriter{Writer: fw, level: level}, nil
}

// Close finishes the entry and returns the compressor to its pool.
func (w *flateWriter) Close() error {
	err := w.Writer.Close()
	flatePools[w.level].Put(w)
	return err
}

type tgzWriter struct {
	gz *gzip.Writer
	t  *tar.Writer
}

func newTgzWriter(w io.Writer, level int) (*tgzWriter, error) {
	gz, err := gzip.NewWriterLevel(w, level)
	if err != nil {
		return nil, err
	}
	return &tgzWriter{gz: gz, t: tar.NewWriter(gz)}, nil
}

func (t *tgzWriter) add(rel string, fi fs.FileInfo, link string, data io.Reader) error {
	h, err := tar.FileInfoHeader(fi, link)
	if err != nil {
		return err
	}
	h.Name = rel
	if fi.IsDir() {
		h.Name = rel + "/"
	}
	// Owner names are this machine's business; numeric ids are enough.
	h.Uname, h.Gname = "", ""
	if strings.ContainsFunc(h.Name, func(r rune) bool { return r > 127 }) {
		h.Format = tar.FormatPAX
	}
	if err := t.t.WriteHeader(h); err != nil {
		return err
	}
	if data != nil && h.Typeflag == tar.TypeReg {
		// A file that grows while it is read is cut at its size from the stat.
		_, err = io.CopyN(t.t, data, h.Size)
	}
	return err
}

func (t *tgzWriter) close() error {
	err := t.t.Close()
	if gerr := t.gz.Close(); err == nil {
		err = gerr
	}
	return err
}
