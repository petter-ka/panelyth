package fileops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// Engine v2 (ADR-0029): OS fast paths with a portable fallback, pooled
// buffers, pause points, optional verification, preserved times and
// attributes, links copied as links when the caller asks for it, and a few
// small files in flight inside a folder copy.

// Links says what a copy does with symbolic links (a job option set by the
// app that starts the job, ADR-0029).
type Links int

const (
	// LinksSkip skips links and reports them (the viewer, ADR-0021).
	LinksSkip Links = iota
	// LinksCopy copies a link as a link, never its target (the commander).
	LinksCopy
)

// CopyOptions controls one copy, move or folder copy.
type CopyOptions struct {
	// Progress receives bytes copied since its previous call; it may be
	// called from several goroutines when files are copied in parallel.
	Progress Progress
	// Gate is a pause point: it blocks while the job is paused and returns
	// the context's error once it is cancelled. Nil never blocks.
	Gate func(ctx context.Context) error
	// Verify hashes the source and the copy of each file; a mismatch fails
	// the item with VERIFY_FAILED and removes the copy.
	Verify bool
	Links  Links
	// Skipped is told about links and special files that were not copied.
	Skipped func(path string)
	// WindowsNames applies Windows naming rules to every name written (a
	// FAT, exFAT or NTFS destination, or Windows itself).
	WindowsNames bool
	// InFlight is how many small files of a folder are copied at once
	// (1 = one after another; HDD lanes).
	InFlight int
	// Include, when set, filters the files (and links) copied inside folders
	// by name (the copy dialog's mask, Stage C04); folders are always walked.
	Include func(name string) bool
	// Conflict decides an existing name inside a folder being merged into
	// another one (copy or move onto an existing folder). Nil means skip.
	Conflict func(ctx context.Context, c MergeConflict) (MergeDecision, error)
}

// MergeConflict is a file that exists on both sides of a folder merge.
type MergeConflict struct {
	Source, Target string
	Src, Dst       fs.FileInfo
}

// MergeDecision answers a MergeConflict.
type MergeDecision int

const (
	MergeSkip MergeDecision = iota
	MergeReplace
	MergeRenameNew
	MergeRenameExisting
)

// Progress receives bytes copied since the previous call (negative when a
// failed fast path is retried by the portable copy).
type Progress func(n int64)

// SmallFile is the size under which files are copied several at once
// (InFlight): their cost is in opening and closing, not in bytes. Chosen by
// measurement in Stage P03.
var SmallFile int64 = 4 << 20

// BufferSize is the portable copy's buffer (pooled; at most InFlight per job).
const BufferSize = 1 << 20

// CodeVerify is the item code of a verification mismatch.
const CodeVerify = "VERIFY_FAILED"

// Test hooks: force the portable copy, and change a copy before it is
// verified (an injected mismatch).
var (
	noFastPath    bool
	testAfterCopy func(target string)
)

var bufPool = sync.Pool{New: func() any { b := make([]byte, BufferSize); return &b }}

func (o *CopyOptions) gate(ctx context.Context) error {
	if o != nil && o.Gate != nil {
		return o.Gate(ctx)
	}
	return ctx.Err()
}

func (o *CopyOptions) progress(n int64) {
	if o != nil && o.Progress != nil && n > 0 {
		o.Progress(n)
	}
}

// ValidName checks a name against the destination's naming rules.
func (o *CopyOptions) ValidName(name string) error {
	if err := ValidateName(name); err != nil {
		return err
	}
	return o.validName(name)
}

func (o *CopyOptions) validName(name string) error {
	if o != nil && o.WindowsNames {
		return validateName(name, true)
	}
	return nil
}

// chunkCheck is how often (in bytes) the portable copy checks the gate.
const chunkCheck = 4 << 20

// bufferedCopy streams src into dst with a pooled buffer, stopping at the
// gate every chunkCheck bytes.
func bufferedCopy(ctx context.Context, dst io.Writer, src io.Reader, o *CopyOptions) error {
	bp := bufPool.Get().(*[]byte)
	defer bufPool.Put(bp)
	buf := *bp
	var since int64
	for {
		n, rerr := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
			o.progress(int64(n))
			since += int64(n)
			if since >= chunkCheck {
				since = 0
				if err := o.gate(ctx); err != nil {
					return err
				}
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

// portableCopy creates target exclusively and streams the bytes.
func portableCopy(ctx context.Context, src string, in fs.FileInfo, target string, o *CopyOptions) error {
	r, err := os.Open(src)
	if err != nil {
		return err
	}
	defer r.Close()
	w, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, in.Mode().Perm()|0o200)
	if err != nil {
		return err
	}
	if err := bufferedCopy(ctx, w, r, o); err != nil {
		_ = w.Close()
		return err
	}
	return w.Close()
}

// copyRegular copies a regular file's bytes, times and attributes to
// target (created exclusively), through the platform's fast path when it
// has one. On failure target is removed.
func copyRegular(ctx context.Context, src, target string, o *CopyOptions) error {
	in, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if !in.Mode().IsRegular() {
		return Errorf(CodeSkippedLink, "%s is not a regular file", filepath.Base(src))
	}
	if err := o.gate(ctx); err != nil {
		return err
	}
	done, preserved, err := false, false, error(nil)
	if !noFastPath {
		done, preserved, err = fastCopy(ctx, src, in, target, o)
	}
	if !done && err == nil {
		err = portableCopy(ctx, src, in, target, o)
	}
	if err == nil && !preserved {
		err = preserve(src, in, target)
	}
	if err == nil && testAfterCopy != nil {
		testAfterCopy(target)
	}
	if err == nil && o != nil && o.Verify {
		err = verify(ctx, src, target, o)
	}
	if err != nil {
		_ = forceRemove(target)
	}
	return err
}

// verify compares the SHA-256 of src and target (ADR-0029).
func verify(ctx context.Context, src, target string, o *CopyOptions) error {
	a, err := hashFile(ctx, src, o)
	if err != nil {
		return err
	}
	b, err := hashFile(ctx, target, o)
	if err != nil {
		return err
	}
	if !bytes.Equal(a, b) {
		return Errorf(CodeVerify, "the copy of %s differs from the original", filepath.Base(src))
	}
	return nil
}

func hashFile(ctx context.Context, path string, o *CopyOptions) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	h := sha256.New()
	// Hashing reports no progress (the bytes were counted by the copy).
	quiet := &CopyOptions{Gate: gateOf(o)}
	if err := bufferedCopy(ctx, h, f, quiet); err != nil {
		return nil, err
	}
	return h.Sum(nil), nil
}

func gateOf(o *CopyOptions) func(context.Context) error {
	if o == nil {
		return nil
	}
	return o.Gate
}

// CopyFile copies src to dst through a partial file, renamed into place when
// complete. With replace=false an existing dst is an ALREADY_EXISTS error.
// On any failure (including cancellation) the partial file is removed.
func CopyFile(ctx context.Context, src, dst string, replace bool, o *CopyOptions) error {
	if err := o.validName(filepath.Base(dst)); err != nil {
		return err
	}
	partial := PartialName(filepath.Dir(dst), filepath.Base(dst))
	err := copyRegular(ctx, src, partial, o)
	if errors.Is(err, fs.ErrExist) {
		// A leftover of an interrupted run (removed by the failed attempt).
		err = copyRegular(ctx, src, partial, o)
	}
	if err != nil {
		return err
	}
	return commit(partial, dst, replace, false)
}

func commit(partial, dst string, replace, isDir bool) error {
	var err error
	if replace {
		clearReadOnly(dst) // a read-only target can't be replaced by a rename on Windows
		err = os.Rename(partial, dst)
	} else {
		err = renameNoReplace(partial, dst)
	}
	if err != nil {
		removePartial(partial, isDir)
		return err
	}
	return nil
}

func removePartial(p string, isDir bool) {
	if isDir {
		_ = os.RemoveAll(p)
	} else {
		_ = forceRemove(p)
	}
}

// forceRemove removes a file even when it is read-only (a copy of a
// read-only file keeps the attribute).
func forceRemove(p string) error {
	err := os.Remove(p)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		clearReadOnly(p)
		err = os.Remove(p)
	}
	return err
}

// CopyLink recreates the link src at dst (its target text, never followed).
func CopyLink(src, dst string) error {
	target, err := os.Readlink(src)
	if err != nil {
		return err
	}
	if err := os.Symlink(target, dst); err != nil {
		return &Error{Code: CodeSkippedLink, Err: errors.New("links can't be created here: " + linkHint(err))}
	}
	return nil
}

// CopyTree copies the folder src to dst through a partial folder renamed
// into place at the end. Links are copied as links or skipped (o.Links);
// special files are skipped and reported. Nothing is followed.
func CopyTree(ctx context.Context, src, dst string, o *CopyOptions) error {
	if err := o.validName(filepath.Base(dst)); err != nil {
		return err
	}
	partial := PartialName(filepath.Dir(dst), filepath.Base(dst))
	_ = os.RemoveAll(partial)
	if err := copyDir(ctx, src, partial, o); err != nil {
		_ = os.RemoveAll(partial)
		return err
	}
	return commit(partial, dst, false, true)
}

// copyDir copies a folder's contents depth first. Small files go through a
// bounded group of InFlight workers; everything else is sequential.
func copyDir(ctx context.Context, src, dst string, o *CopyOptions) error {
	fi, err := os.Stat(src)
	if err != nil {
		return err
	}
	if err := os.Mkdir(dst, fi.Mode().Perm()|0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	g := newGroup(ctx, inFlight(o))
	for _, e := range entries {
		if err := g.err(); err != nil {
			break
		}
		if err := o.gate(ctx); err != nil {
			g.fail(err)
			break
		}
		if err := o.validName(e.Name()); err != nil {
			g.fail(&Error{Code: CodeInvalidName, Err: errors.New(e.Name() + ": " + err.Error())})
			break
		}
		s, d := filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())
		if !e.IsDir() && !o.included(e.Name()) {
			continue
		}
		switch {
		case e.IsDir():
			g.wait() // keep the walk depth first and bounded
			if err := copyDir(ctx, s, d, o); err != nil {
				g.fail(err)
			}
		case e.Type().IsRegular():
			info, ierr := e.Info()
			if ierr == nil && info.Size() < SmallFile && g.n > 1 {
				g.go_(func() error { return copyRegular(g.ctx, s, d, o) })
				continue
			}
			if err := copyRegular(ctx, s, d, o); err != nil {
				g.fail(err)
			}
		case e.Type()&fs.ModeSymlink != 0 && o != nil && o.Links == LinksCopy:
			if err := CopyLink(s, d); err != nil {
				g.fail(err)
			}
		default:
			if o != nil && o.Skipped != nil {
				o.Skipped(s)
			}
		}
	}
	if err := g.wait(); err != nil {
		return err
	}
	return os.Chtimes(dst, fi.ModTime(), fi.ModTime())
}

// included applies o.Include to a file name.
func (o *CopyOptions) included(name string) bool {
	return o == nil || o.Include == nil || o.Include(name)
}

func inFlight(o *CopyOptions) int {
	if o == nil || o.InFlight < 1 {
		return 1
	}
	return o.InFlight
}

// group runs at most n functions at once and keeps the first error.
type group struct {
	n    int
	sem  chan struct{}
	wg   sync.WaitGroup
	mu   sync.Mutex
	e    error
	ctx  context.Context
	stop context.CancelFunc
}

func newGroup(ctx context.Context, n int) *group {
	c, stop := context.WithCancel(ctx)
	return &group{n: n, sem: make(chan struct{}, n), ctx: c, stop: stop}
}

func (g *group) go_(fn func() error) {
	g.sem <- struct{}{}
	g.wg.Add(1)
	go func() {
		defer func() { <-g.sem; g.wg.Done() }()
		if g.ctx.Err() != nil {
			return
		}
		if err := fn(); err != nil {
			g.fail(err)
		}
	}()
}

func (g *group) fail(err error) {
	g.mu.Lock()
	if g.e == nil {
		g.e = err
		g.stop()
	}
	g.mu.Unlock()
}

func (g *group) err() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.e
}

func (g *group) wait() error {
	g.wg.Wait()
	return g.err()
}
