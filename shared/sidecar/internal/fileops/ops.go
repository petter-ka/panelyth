package fileops

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// PartialSuffix marks unfinished copies. The leading dot keeps them out of
// the index (hidden-entry rule); startup recovery removes leftovers.
const PartialSuffix = ".fastview-partial"

// Item error codes (mirror shared/contracts JobItemErrorCode).
const (
	CodeNotFound         = "NOT_FOUND"
	CodePermission       = "PERMISSION_DENIED"
	CodeExists           = "ALREADY_EXISTS"
	CodeInvalidName      = "INVALID_NAME"
	CodeTrashUnavailable = "TRASH_UNAVAILABLE"
	CodeNoSpace          = "NO_SPACE"
	CodeInUse            = "IN_USE"
	CodeIntoItself       = "INTO_ITSELF"
	CodeSkippedLink      = "SKIPPED_LINK"
	CodeIO               = "IO_ERROR"
)

// Error is a per-item failure with a stable code.
type Error struct {
	Code string
	Err  error
}

func (e *Error) Error() string { return e.Code + ": " + e.Err.Error() }
func (e *Error) Unwrap() error { return e.Err }

// Errorf builds an Error with a message.
func Errorf(code, format string, args ...any) *Error {
	return &Error{Code: code, Err: fmt.Errorf(format, args...)}
}

// Code classifies any error into an item error code.
func Code(err error) string {
	var e *Error
	switch {
	case err == nil:
		return ""
	case errors.As(err, &e):
		return e.Code
	case errors.Is(err, ErrInvalidName):
		return CodeInvalidName
	case errors.Is(err, fs.ErrNotExist):
		return CodeNotFound
	case errors.Is(err, fs.ErrPermission):
		return CodePermission
	case errors.Is(err, fs.ErrExist):
		return CodeExists
	case isNoSpace(err):
		return CodeNoSpace
	case isInUse(err):
		return CodeInUse
	}
	return CodeIO
}

// PartialName is the in-progress name for a copy into dir.
func PartialName(dir, name string) string {
	return filepath.Join(dir, "."+name+PartialSuffix)
}

// copyChunk is the cancellation and progress granularity of copies.
const copyChunk = 4 << 20

// Progress receives bytes copied since the previous call.
type Progress func(n int64)

func copyData(ctx context.Context, dst io.Writer, src io.Reader, progress Progress) error {
	buf := make([]byte, 1<<20)
	var sinceCheck int64
	for {
		n, rerr := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
			if progress != nil {
				progress(int64(n))
			}
			sinceCheck += int64(n)
			if sinceCheck >= copyChunk {
				sinceCheck = 0
				if err := ctx.Err(); err != nil {
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

// copyFileTo copies a regular file's bytes and mtime to target, which is
// created exclusively.
func copyFileTo(ctx context.Context, src, target string, progress Progress) (err error) {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	fi, err := in.Stat()
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return Errorf(CodeSkippedLink, "%s is not a regular file", filepath.Base(src))
	}
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fi.Mode().Perm()|0o200)
	if err != nil {
		return err
	}
	if err = copyData(ctx, out, in, progress); err != nil {
		_ = out.Close()
		return err
	}
	if err = out.Close(); err != nil {
		return err
	}
	return os.Chtimes(target, fi.ModTime(), fi.ModTime())
}

// CopyFile copies src to dst through a partial file, renamed into place when
// complete. With replace=false an existing dst is an ALREADY_EXISTS error.
// On any failure (including cancellation) the partial file is removed.
func CopyFile(ctx context.Context, src, dst string, replace bool, progress Progress) error {
	partial := PartialName(filepath.Dir(dst), filepath.Base(dst))
	_ = os.Remove(partial) // leftover of an interrupted run
	if err := copyFileTo(ctx, src, partial, progress); err != nil {
		_ = os.Remove(partial)
		return err
	}
	return commit(partial, dst, replace, false)
}

func commit(partial, dst string, replace, isDir bool) error {
	if !replace {
		if _, err := os.Lstat(dst); err == nil {
			removePartial(partial, isDir)
			return Errorf(CodeExists, "%s already exists", filepath.Base(dst))
		}
	}
	if err := os.Rename(partial, dst); err != nil {
		removePartial(partial, isDir)
		return err
	}
	return nil
}

func removePartial(p string, isDir bool) {
	if isDir {
		_ = os.RemoveAll(p)
	} else {
		_ = os.Remove(p)
	}
}

// TreeSize sums the regular files under dir (symlinks are not followed).
func TreeSize(ctx context.Context, dir string) (int64, error) {
	var total int64
	err := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		if d.Type().IsRegular() {
			if fi, ierr := d.Info(); ierr == nil {
				total += fi.Size()
			}
		}
		return nil
	})
	return total, err
}

// CopyTree copies the folder src to dst through a partial folder renamed
// into place at the end. Symbolic links and other non-regular files are
// skipped and reported through skipped; they are never followed.
func CopyTree(ctx context.Context, src, dst string, progress Progress, skipped func(path string)) error {
	partial := PartialName(filepath.Dir(dst), filepath.Base(dst))
	_ = os.RemoveAll(partial)
	if err := copyDir(ctx, src, partial, progress, skipped); err != nil {
		_ = os.RemoveAll(partial)
		return err
	}
	return commit(partial, dst, false, true)
}

func copyDir(ctx context.Context, src, dst string, progress Progress, skipped func(string)) error {
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
	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		s, d := filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())
		switch {
		case e.IsDir():
			err = copyDir(ctx, s, d, progress, skipped)
		case e.Type().IsRegular():
			err = copyFileTo(ctx, s, d, progress)
		default:
			if skipped != nil {
				skipped(s)
			}
		}
		if err != nil {
			return err
		}
	}
	return os.Chtimes(dst, fi.ModTime(), fi.ModTime())
}

// Move renames src to dst. Across volumes it copies, checks the size, and
// removes the source. dst must not exist unless replace is set (files only).
func Move(ctx context.Context, src, dst string, isDir, replace bool, progress Progress, skipped func(string)) error {
	if !replace || isDir {
		if _, err := os.Lstat(dst); err == nil && !sameFile(src, dst) {
			return Errorf(CodeExists, "%s already exists", filepath.Base(dst))
		}
	}
	err := os.Rename(src, dst)
	if err == nil || !isCrossDevice(err) {
		return err
	}
	if isDir {
		if err := CopyTree(ctx, src, dst, progress, skipped); err != nil {
			return err
		}
		if err := os.RemoveAll(src); err != nil {
			return Errorf(CodeIO, "copied, but the original couldn't be removed: %v", err)
		}
		return nil
	}
	srcInfo, err := os.Stat(src)
	if err != nil {
		return err
	}
	if err := CopyFile(ctx, src, dst, replace, progress); err != nil {
		return err
	}
	if dstInfo, err := os.Stat(dst); err != nil || dstInfo.Size() != srcInfo.Size() {
		_ = os.Remove(dst)
		return Errorf(CodeIO, "the copy on the other drive is incomplete")
	}
	if err := os.Remove(src); err != nil {
		return Errorf(CodeIO, "copied, but the original couldn't be removed: %v", err)
	}
	return nil
}

// sameFile is true when a case-only rename targets the item itself
// ("photo.jpg" → "Photo.jpg" on a case-insensitive volume).
func sameFile(a, b string) bool {
	ai, err1 := os.Lstat(a)
	bi, err2 := os.Lstat(b)
	return err1 == nil && err2 == nil && os.SameFile(ai, bi)
}

// Rename renames src to newName in the same folder. A case-only change is
// allowed on case-insensitive volumes.
func Rename(src, newName string) (string, error) {
	if err := ValidateName(newName); err != nil {
		return "", err
	}
	dst := filepath.Join(filepath.Dir(src), newName)
	if dst == src {
		return dst, nil
	}
	if _, err := os.Lstat(dst); err == nil && !sameFile(src, dst) {
		return "", Errorf(CodeExists, "%s already exists", newName)
	}
	return dst, os.Rename(src, dst)
}

// Delete removes a file or a folder tree permanently.
func Delete(path string, isDir bool) error {
	if _, err := os.Lstat(path); err != nil {
		return err
	}
	if isDir {
		return os.RemoveAll(path)
	}
	return os.Remove(path)
}

// RemovePartials deletes leftover partial copies directly inside dir
// (startup recovery after an interrupted job). It returns how many it removed.
func RemovePartials(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") && strings.HasSuffix(e.Name(), PartialSuffix) {
			if os.RemoveAll(filepath.Join(dir, e.Name())) == nil {
				n++
			}
		}
	}
	return n
}
