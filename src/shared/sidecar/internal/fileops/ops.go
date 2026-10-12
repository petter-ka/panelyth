package fileops

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"panelyth/sidecar/internal/fsx"
)

// PartialSuffix marks unfinished copies. The leading dot keeps them out of
// the index (hidden-entry rule); startup recovery removes leftovers.
const PartialSuffix = ".panelyth-partial"

// Item error codes (mirror src/shared/contracts JobItemErrorCode).
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

// renameItem is os.Rename; tests make it fail like a rename across volumes.
var renameItem = os.Rename

// PartialName is the in-progress name for a copy into dir.
func PartialName(dir, name string) string {
	return filepath.Join(dir, "."+name+PartialSuffix)
}

// TreeSize sums the regular files under dir (symlinks are not followed).
func TreeSize(ctx context.Context, dir string) (int64, error) {
	var total int64
	err := filepath.WalkDir(fsx.Verbatim(dir), func(_ string, d fs.DirEntry, err error) error {
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

// Move renames src to dst. Across volumes it copies (with o), checks the
// size, and removes the source. dst must not exist unless replace is set
// (files and links only).
func Move(ctx context.Context, src, dst string, isDir, replace bool, o *CopyOptions) error {
	if err := o.validName(filepath.Base(dst)); err != nil {
		return err
	}
	if !replace || isDir {
		if _, err := os.Lstat(dst); err == nil && !sameFile(src, dst) {
			return Errorf(CodeExists, "%s already exists", filepath.Base(dst))
		}
	} else {
		clearReadOnly(dst)
	}
	err := renameItem(src, dst)
	if err == nil || !isCrossDevice(err) {
		return err
	}
	srcInfo, err := os.Lstat(src)
	if err != nil {
		return err
	}
	switch {
	case srcInfo.Mode()&fs.ModeSymlink != 0:
		if replace {
			_ = forceRemove(dst)
		}
		if err := CopyLink(src, dst); err != nil {
			return err
		}
	case isDir:
		if err := CopyTree(ctx, src, dst, o); err != nil {
			return err
		}
		if err := os.RemoveAll(src); err != nil {
			return Errorf(CodeIO, "copied, but the original couldn't be removed: %v", err)
		}
		return nil
	default:
		if err := CopyFile(ctx, src, dst, replace, o); err != nil {
			return err
		}
		if dstInfo, err := os.Stat(dst); err != nil || dstInfo.Size() != srcInfo.Size() {
			_ = forceRemove(dst)
			return Errorf(CodeIO, "the copy on the other drive is incomplete")
		}
	}
	if err := forceRemove(src); err != nil {
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
// allowed on volumes that ignore case (renameCase).
func Rename(src, newName string) (string, error) {
	if err := ValidateName(newName); err != nil {
		return "", err
	}
	dst := filepath.Join(filepath.Dir(src), newName)
	if dst == src {
		return dst, nil
	}
	if _, err := os.Lstat(dst); err == nil {
		if !sameFile(src, dst) || !strings.EqualFold(filepath.Base(src), newName) {
			return "", Errorf(CodeExists, "%s already exists", newName)
		}
		return dst, renameCase(src, dst)
	}
	return dst, renameItem(src, dst)
}

// renamingPrefix starts the name an entry has between the two steps of a
// case-only rename. Nothing removes such a name: after a crash it still
// holds the user's file.
const renamingPrefix = ".panelyth-renaming-"

// renameCase changes only the case of a name on a volume that ignores it
// ("photo.jpg" → "Photo.JPG"). Some file systems and network shares treat a
// direct rename onto the same entry as nothing to do, so it takes two steps
// through a temporary name (Stage C09). If dst turns out to be an entry of
// its own (a hard link of src where case matters), nothing changes.
func renameCase(src, dst string) error {
	dir := filepath.Dir(src)
	tmp := ""
	for n := 0; n < 100 && tmp == ""; n++ {
		c := filepath.Join(dir, renamingPrefix+strconv.FormatInt(time.Now().UnixNano()+int64(n), 36))
		if _, err := os.Lstat(c); err != nil {
			tmp = c
		}
	}
	if tmp == "" {
		return Errorf(CodeIO, "no temporary name is free in this folder")
	}
	if err := renameItem(src, tmp); err != nil {
		return err
	}
	err := error(Errorf(CodeExists, "%s already exists", filepath.Base(dst)))
	if _, lerr := os.Lstat(dst); lerr != nil {
		if err = renameItem(tmp, dst); err == nil {
			return nil
		}
	}
	if back := renameItem(tmp, src); back != nil {
		return Errorf(CodeIO, "the rename failed half way: the item is now named %s", filepath.Base(tmp))
	}
	return err
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

// CommitFile renames a finished partial file into place (archive extraction,
// Stage C07); without replace an existing dst is ALREADY_EXISTS. The
// partial file is removed on failure.
func CommitFile(partial, dst string, replace bool) error {
	return commit(partial, dst, replace, false)
}

// RemovePartial removes a partial file or folder (read-only ones too).
func RemovePartial(p string, isDir bool) { removePartial(p, isDir) }
