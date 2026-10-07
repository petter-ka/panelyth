package archive

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"fastview/sidecar/internal/fileops"
)

// Item error codes of archive jobs (mirror shared/contracts JobItemErrorCode).
const (
	CodeUnsafePath = "UNSAFE_PATH"
	CodeCorrupt    = "CORRUPT"
	CodeEncrypted  = "ENCRYPTED"
	// CodeTooLarge: an entry wrote more than it declared (a zip bomb), or is
	// too large to view.
	CodeTooLarge = "TOO_LARGE"
)

// Decision answers an entry whose name is taken in the target.
type Decision int

const (
	DecideSkip Decision = iota
	DecideReplace
	// DecideKeepBoth extracts under a free name ("name (2).ext").
	DecideKeepBoth
	// DecideRenameExisting moves the existing item aside first.
	DecideRenameExisting
)

// ExtractOptions configure an extraction. Every callback is optional.
type ExtractOptions struct {
	// Dest is the target folder; it must exist. Nothing is ever written
	// outside it.
	Dest string
	// Base is the inner folder whose contents land in Dest ("" = the root):
	// copying "docs/a.txt" out of the panel showing "docs" writes Dest/a.txt.
	Base string
	// Include limits the entries (by clean inner path); nil means all.
	Include func(inner string) bool
	// Selected names the chosen entries' inner paths (with Include), so
	// 7-Zip extracts only those.
	Selected []string
	// Links creates the symbolic and hard links an archive stores, when they
	// stay inside Dest; otherwise they are skipped. Links are created after
	// everything else, so extraction never writes through one.
	Links bool
	// WindowsNames applies Windows naming rules (a FAT or NTFS target).
	WindowsNames bool
	// MaxFileBytes stops a file that grows beyond it (0 = no limit).
	MaxFileBytes int64

	Gate     func(context.Context) error
	Progress func(n int64)
	// Conflict decides about an existing item (default: skip).
	Conflict func(rel string, h *Header, existing fs.FileInfo) (Decision, error)
	// Failed reports an entry that was not extracted; extraction goes on.
	Failed func(rel string, err error)
	// Extracted reports a written file, created folder or link, by its
	// path relative to Dest as written (after a keep-both rename).
	Extracted func(rel string, h *Header)
	// Skipped reports an entry left out by a conflict decision or the
	// links option.
	Skipped func(rel string, h *Header)
}

func (o *ExtractOptions) fail(rel string, err error) {
	if o.Failed != nil {
		o.Failed(rel, err)
	}
}

// Extract writes the entries of an archive below o.Dest. It returns an
// error only for the job as a whole (the archive can't be read, cancelled);
// entries that fail are reported through o.Failed.
func Extract(ctx context.Context, path string, format Format, tool *Tool, counted func(int64), o *ExtractOptions) error {
	x := &extractor{o: o, ctx: ctx}
	var err error
	if format == Format7z {
		err = tool.extract(ctx, path, o, x, counted)
	} else {
		var r reader
		if r, err = openReader(path, format, counted); err != nil {
			return err
		}
		err = r.walk(ctx, x.want, x.entry)
		_ = r.close()
	}
	if err != nil {
		return err
	}
	x.links()
	return ctx.Err()
}

type extractor struct {
	o        *ExtractOptions
	ctx      context.Context
	deferred []pendingLink
	// renamed maps folders extracted under another name (keep both) to it,
	// so their contents follow.
	renamed map[string]string
	// made caches folders known to exist.
	made map[string]bool
}

type pendingLink struct {
	rel string
	h   Header
}

// rel maps an inner path to its path below Dest; false when it is outside
// Base or excluded.
func (x *extractor) rel(inner string) (string, bool) {
	if inner == "" || (x.o.Include != nil && !x.o.Include(inner)) {
		return "", false
	}
	if x.o.Base == "" {
		return x.follow(inner), true
	}
	if !strings.HasPrefix(inner, x.o.Base+"/") {
		return "", false
	}
	return x.follow(inner[len(x.o.Base)+1:]), true
}

// follow applies folder renames (keep both) to a relative path.
func (x *extractor) follow(rel string) string {
	if len(x.renamed) == 0 {
		return rel
	}
	for p := parentOf(rel); p != ""; p = parentOf(p) {
		if to, ok := x.renamed[p]; ok {
			return to + rel[len(p):]
		}
	}
	return rel
}

func (x *extractor) want(h *Header) bool {
	if h.Unsafe != "" {
		return x.o.Include == nil
	}
	_, ok := x.rel(h.Path)
	return ok
}

func (x *extractor) entry(h *Header, data io.Reader) error {
	if h.Unsafe != "" {
		if x.o.Include == nil && x.o.Base == "" {
			x.o.fail(h.Raw, fileops.Errorf(CodeUnsafePath, "%s; it was not extracted", h.Unsafe))
		}
		return nil
	}
	rel, ok := x.rel(h.Path)
	if !ok {
		return nil
	}
	if x.o.Gate != nil {
		if err := x.o.Gate(x.ctx); err != nil {
			return err
		}
	} else if err := x.ctx.Err(); err != nil {
		return err
	}
	switch h.Kind {
	case KindSpecial:
		x.o.fail(rel, fileops.Errorf(fileops.CodeSkippedLink, "devices and pipes are not extracted"))
		return nil
	case KindSymlink, KindHardlink:
		x.deferred = append(x.deferred, pendingLink{rel: rel, h: *h})
		return nil
	case KindDir:
		return x.dir(rel, h)
	}
	if h.Encrypted {
		x.o.fail(rel, &fileops.Error{Code: CodeEncrypted, Err: errors.New("the entry is encrypted; FastView can't extract it")})
		return nil
	}
	err := x.file(rel, h, data)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, context.Canceled):
		return err
	case errors.Is(err, ErrCorrupt):
		// The stream can't be trusted past this point.
		x.o.fail(rel, &fileops.Error{Code: CodeCorrupt, Err: err})
		return err
	}
	x.o.fail(rel, err)
	return nil
}

// target validates a relative path's names and resolves it below Dest.
func (x *extractor) target(rel string) (string, error) {
	for _, c := range strings.Split(rel, "/") {
		var err error
		if x.o.WindowsNames {
			err = fileops.ValidateWindowsName(c)
		} else {
			err = fileops.ValidateName(c)
		}
		if err != nil {
			return "", &fileops.Error{Code: fileops.CodeInvalidName, Err: err}
		}
	}
	p, ok := Join(x.o.Dest, rel)
	if !ok {
		return "", fileops.Errorf(CodeUnsafePath, "the path leaves the target folder")
	}
	return p, nil
}

// mkdirs creates a folder and its parents below Dest; existing files in the
// way are errors, never replaced.
func (x *extractor) mkdirs(dir string) error {
	if dir == x.o.Dest || x.made[dir] {
		return nil
	}
	fi, err := os.Lstat(dir)
	switch {
	case err == nil && fi.IsDir():
	case err == nil:
		return fileops.Errorf(fileops.CodeExists, "%s is a file, not a folder", filepath.Base(dir))
	case errors.Is(err, fs.ErrNotExist):
		if err := x.mkdirs(filepath.Dir(dir)); err != nil {
			return err
		}
		err := os.Mkdir(dir, 0o755)
		if err != nil && !errors.Is(err, fs.ErrExist) {
			return err
		}
		// A folder the archive does not store itself, made for its files.
		if err == nil && filepath.Dir(dir) == x.o.Dest && x.o.Extracted != nil {
			x.o.Extracted(filepath.Base(dir), &Header{Kind: KindDir})
		}
	default:
		return err
	}
	if x.made == nil {
		x.made = map[string]bool{}
	}
	x.made[dir] = true
	return nil
}

func (x *extractor) dir(rel string, h *Header) error {
	target, err := x.target(rel)
	if err != nil {
		x.o.fail(rel, err)
		return nil
	}
	if fi, err := os.Lstat(target); err == nil && !fi.IsDir() {
		// A file has the folder's name: keep both, or skip.
		d := DecideSkip
		if x.o.Conflict != nil {
			if d, err = x.o.Conflict(rel, h, fi); err != nil {
				return err
			}
		}
		if d != DecideKeepBoth && d != DecideRenameExisting {
			if x.o.Skipped != nil {
				x.o.Skipped(rel, h)
			}
			return nil
		}
		if d == DecideRenameExisting {
			if err := renameAside(target); err != nil {
				x.o.fail(rel, err)
				return nil
			}
		} else {
			name, ok := fileops.UniqueName(filepath.Base(target), true, func(c string) bool {
				_, err := os.Lstat(filepath.Join(filepath.Dir(target), c))
				return err == nil
			})
			if !ok {
				x.o.fail(rel, fileops.Errorf(fileops.CodeExists, "no free name was found"))
				return nil
			}
			newRel := joinRel(parentOf(rel), name)
			if x.renamed == nil {
				x.renamed = map[string]string{}
			}
			x.renamed[rel] = newRel
			rel, target = newRel, filepath.Join(filepath.Dir(target), name)
		}
	}
	_, serr := os.Lstat(target)
	created := errors.Is(serr, fs.ErrNotExist)
	if err := x.mkdirs(target); err != nil {
		x.o.fail(rel, err)
		return nil
	}
	// New folders are reported once (mkdirs reports those at the top).
	if created && filepath.Dir(target) != x.o.Dest && x.o.Extracted != nil {
		x.o.Extracted(rel, h)
	}
	return nil
}

func joinRel(dir, name string) string {
	if dir == "" {
		return name
	}
	return dir + "/" + name
}

// renameAside moves an existing item to a free name next to it.
func renameAside(p string) error {
	fi, err := os.Lstat(p)
	if err != nil {
		return err
	}
	name, ok := fileops.UniqueName(filepath.Base(p), fi.IsDir(), func(c string) bool {
		_, err := os.Lstat(filepath.Join(filepath.Dir(p), c))
		return err == nil
	})
	if !ok {
		return fileops.Errorf(fileops.CodeExists, "no free name was found for the existing %s", filepath.Base(p))
	}
	_, err = fileops.Rename(p, name)
	return err
}

// place decides what happens when target exists: the final path and
// whether it replaces; skip reports a skipped entry.
func (x *extractor) place(rel, target string, h *Header) (string, string, bool, bool, error) {
	fi, err := os.Lstat(target)
	if errors.Is(err, fs.ErrNotExist) {
		return rel, target, false, false, nil
	}
	if err != nil {
		return "", "", false, false, err
	}
	d := DecideSkip
	if x.o.Conflict != nil {
		if d, err = x.o.Conflict(rel, h, fi); err != nil {
			return "", "", false, false, err
		}
	}
	switch d {
	case DecideReplace:
		if fi.IsDir() {
			return "", "", false, false, fileops.Errorf(fileops.CodeExists, "a folder has this name; it was not replaced")
		}
		return rel, target, true, false, nil
	case DecideRenameExisting:
		if err := renameAside(target); err != nil {
			return "", "", false, false, err
		}
		return rel, target, false, false, nil
	case DecideKeepBoth:
		name, ok := fileops.UniqueName(filepath.Base(target), false, func(c string) bool {
			_, err := os.Lstat(filepath.Join(filepath.Dir(target), c))
			return err == nil
		})
		if !ok {
			return "", "", false, false, fileops.Errorf(fileops.CodeExists, "no free name was found")
		}
		return joinRel(parentOf(rel), name), filepath.Join(filepath.Dir(target), name), false, false, nil
	}
	return rel, target, false, true, nil
}

// errTooLarge stops a file that writes more than it may.
var errTooLarge = &fileops.Error{Code: CodeTooLarge, Err: errors.New("the entry expands beyond its stored size (a damaged archive or a zip bomb)")}

func (x *extractor) file(rel string, h *Header, data io.Reader) error {
	target, err := x.target(rel)
	if err != nil {
		return err
	}
	if err := x.mkdirs(filepath.Dir(target)); err != nil {
		return err
	}
	rel, target, replace, skip, err := x.place(rel, target, h)
	if err != nil || skip {
		if skip && x.o.Skipped != nil {
			x.o.Skipped(rel, h)
		}
		return err
	}
	if data == nil {
		data = strings.NewReader("")
	}
	partial := fileops.PartialName(filepath.Dir(target), filepath.Base(target))
	_ = os.Remove(partial) // a leftover of an interrupted run
	f, err := os.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	// A declared size is a promise: a file writing more is damaged or a bomb
	// (tar sizes are exact; the zip reader checks too). -1 = no limit.
	limit := int64(-1)
	if x.o.MaxFileBytes > 0 {
		limit = x.o.MaxFileBytes
	}
	if !h.SizeEstimated && (limit < 0 || h.Size < limit) {
		limit = max(h.Size, 0)
	}
	n, err := copyLimited(x.ctx, f, data, limit, x.o.Progress)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && h.MtimeNs != 0 {
		t := time.Unix(0, h.MtimeNs)
		_ = os.Chtimes(partial, t, t)
	}
	if err == nil && runtime.GOOS != "windows" && h.Mode.Perm() != 0 {
		_ = os.Chmod(partial, h.Mode.Perm()|0o200) // owner keeps write access
	}
	if err != nil {
		fileops.RemovePartial(partial, false)
		if progress := x.o.Progress; progress != nil && n > 0 {
			progress(-n)
		}
		return err
	}
	if err := fileops.CommitFile(partial, target, replace); err != nil {
		return err
	}
	if x.o.Extracted != nil {
		x.o.Extracted(rel, h)
	}
	return nil
}

// copyLimited copies until EOF; with limit >= 0 it reads at most limit+1
// bytes, so a stream larger than allowed is detected without writing it.
func copyLimited(ctx context.Context, dst io.Writer, src io.Reader, limit int64, progress func(int64)) (int64, error) {
	if limit >= 0 {
		src = io.LimitReader(src, limit+1)
	}
	buf := make([]byte, 256<<10)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, rerr := src.Read(buf)
		if n > 0 {
			if limit >= 0 && total+int64(n) > limit {
				return total, errTooLarge
			}
			if _, err := dst.Write(buf[:n]); err != nil {
				return total, err
			}
			total += int64(n)
			if progress != nil {
				progress(int64(n))
			}
		}
		if rerr == io.EOF {
			return total, nil
		}
		if rerr != nil {
			return total, rerr
		}
	}
}

// links creates the deferred links (or reports them skipped).
func (x *extractor) links() {
	for _, l := range x.deferred {
		if x.ctx.Err() != nil {
			return
		}
		if !x.o.Links {
			if x.o.Skipped != nil {
				x.o.Skipped(l.rel, &l.h)
			}
			continue
		}
		if err := x.link(l); err != nil {
			x.o.fail(l.rel, err)
		}
	}
}

func (x *extractor) link(l pendingLink) error {
	target, err := x.target(l.rel)
	if err != nil {
		return err
	}
	if err := x.mkdirs(filepath.Dir(target)); err != nil {
		return err
	}
	rel, target, replace, skip, err := x.place(l.rel, target, &l.h)
	if err != nil || skip {
		if skip && x.o.Skipped != nil {
			x.o.Skipped(l.rel, &l.h)
		}
		return err
	}
	if replace {
		if err := os.Remove(target); err != nil {
			return err
		}
	}
	if l.h.Kind == KindHardlink {
		inner, bad := CleanPath(l.h.Link)
		if bad != "" {
			return fileops.Errorf(CodeUnsafePath, "the link's target %s", bad)
		}
		srcRel, ok := x.rel(inner)
		if !ok {
			return fileops.Errorf(fileops.CodeSkippedLink, "the hard link's target was not extracted")
		}
		src, ok := Join(x.o.Dest, srcRel)
		if !ok {
			return fileops.Errorf(CodeUnsafePath, "the link points outside the target folder")
		}
		fi, err := os.Lstat(src)
		if err != nil || !fi.Mode().IsRegular() {
			return fileops.Errorf(fileops.CodeSkippedLink, "the hard link's target is not an extracted file")
		}
		if err := os.Link(src, target); err != nil {
			return &fileops.Error{Code: fileops.CodeSkippedLink, Err: fmt.Errorf("the hard link can't be created here: %w", err)}
		}
	} else {
		if !LinkInside(rel, l.h.Link) {
			return fileops.Errorf(CodeUnsafePath, "the link points outside the target folder (%s); it was not created", l.h.Link)
		}
		if err := os.Symlink(filepath.FromSlash(strings.ReplaceAll(l.h.Link, `\`, "/")), target); err != nil {
			return &fileops.Error{Code: fileops.CodeSkippedLink, Err: fmt.Errorf("links can't be created here: %w", err)}
		}
	}
	if x.o.Extracted != nil {
		x.o.Extracted(rel, &l.h)
	}
	return nil
}
