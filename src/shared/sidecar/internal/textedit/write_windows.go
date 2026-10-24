//go:build windows

package textedit

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"time"

	"golang.org/x/sys/windows"

	"panelyth/sidecar/internal/fileops"
)

const keptAttrs = windows.FILE_ATTRIBUTE_READONLY | windows.FILE_ATTRIBUTE_HIDDEN | windows.FILE_ATTRIBUTE_SYSTEM

func isInUse(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}

func attrsOf(path string) (uint32, error) {
	p, err := windows.UTF16PtrFromString(fileops.LongPath(path))
	if err != nil {
		return 0, err
	}
	return windows.GetFileAttributes(p)
}

func setAttrs(path string, attrs uint32) error {
	p, err := windows.UTF16PtrFromString(fileops.LongPath(path))
	if err != nil {
		return err
	}
	return windows.SetFileAttributes(p, attrs)
}

// replaceFile renames partial over target (MoveFileEx with
// MOVEFILE_REPLACE_EXISTING, written through). A read-only target cannot be
// replaced: the attribute is cleared first and put back when the rename
// fails (partial carries it already). A file held for a moment (a virus
// scanner, the indexer) is waited for, as fileops does for a copy's commit.
func replaceFile(partial, target string) error {
	p, err := windows.UTF16PtrFromString(fileops.LongPath(partial))
	if err != nil {
		return err
	}
	d, err := windows.UTF16PtrFromString(fileops.LongPath(target))
	if err != nil {
		return err
	}
	attrs, aerr := windows.GetFileAttributes(d)
	readOnly := aerr == nil && attrs&windows.FILE_ATTRIBUTE_READONLY != 0
	if readOnly {
		_ = windows.SetFileAttributes(d, attrs&^windows.FILE_ATTRIBUTE_READONLY)
	}
	const flags = windows.MOVEFILE_REPLACE_EXISTING | windows.MOVEFILE_WRITE_THROUGH
	err = windows.MoveFileEx(p, d, flags)
	for _, wait := range commitWaits {
		if err == nil || !isInUse(err) {
			break
		}
		time.Sleep(wait)
		err = windows.MoveFileEx(p, d, flags)
	}
	if err != nil {
		if readOnly {
			_ = windows.SetFileAttributes(d, attrs)
		}
		return &os.LinkError{Op: "rename", Old: partial, New: target, Err: err}
	}
	return nil
}

// keepAttrs gives partial the original's read-only, hidden and system
// attributes (it keeps its own archive bit: the file changed).
func keepAttrs(target string, _ fs.FileInfo, partial string) error {
	attrs, err := attrsOf(target)
	if err != nil {
		return err
	}
	keep := attrs & keptAttrs
	if keep == 0 {
		return nil
	}
	own, err := attrsOf(partial)
	if err != nil {
		return err
	}
	return setAttrs(partial, (own&^windows.FILE_ATTRIBUTE_NORMAL)|keep)
}

// linkCount is the number of hard links to the file at path.
func linkCount(path string) uint64 {
	p, err := windows.UTF16PtrFromString(fileops.LongPath(path))
	if err != nil {
		return 1
	}
	h, err := windows.CreateFile(p, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return 1
	}
	defer windows.CloseHandle(h)
	var d windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &d); err != nil {
		return 1
	}
	return uint64(d.NumberOfLinks)
}

// writeInPlace overwrites a file that keeps its identity (hard links). A
// read-only file is made writable for the write and read-only again after.
func writeInPlace(ctx context.Context, target string, data []byte) error {
	attrs, err := attrsOf(target)
	if err != nil {
		return err
	}
	if attrs&windows.FILE_ATTRIBUTE_READONLY != 0 {
		if err := setAttrs(target, attrs&^windows.FILE_ATTRIBUTE_READONLY); err != nil {
			return err
		}
		defer func() { _ = setAttrs(target, attrs) }()
	}
	return overwrite(ctx, target, data)
}

// syncDir is not needed: the rename was written through.
func syncDir(string) {}
