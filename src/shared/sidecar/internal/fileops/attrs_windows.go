//go:build windows

package fileops

import (
	"os"

	"golang.org/x/sys/windows"

	"panelyth/sidecar/internal/fsx"
)

func winAttrs(bits int) uint32 {
	var a uint32
	if bits&fsx.AttrReadOnly != 0 {
		a |= windows.FILE_ATTRIBUTE_READONLY
	}
	if bits&fsx.AttrHidden != 0 {
		a |= windows.FILE_ATTRIBUTE_HIDDEN
	}
	if bits&fsx.AttrSystem != 0 {
		a |= windows.FILE_ATTRIBUTE_SYSTEM
	}
	if bits&fsx.AttrArchive != 0 {
		a |= windows.FILE_ATTRIBUTE_ARCHIVE
	}
	return a
}

// setAttrs sets and clears the four attributes and keeps every other one
// (compressed, not indexed, reparse point…).
func setAttrs(path string, c AttrChange) error {
	set, clear := winAttrs(c.Set), winAttrs(c.Clear)
	if set == 0 && clear == 0 {
		return nil
	}
	fail := func(err error) error { return &os.PathError{Op: "setattr", Path: path, Err: err} }
	p, err := windows.UTF16PtrFromString(LongPath(path))
	if err != nil {
		return fail(err)
	}
	attrs, err := windows.GetFileAttributes(p)
	if err != nil {
		return fail(err)
	}
	next := attrs&^clear | set
	if next == attrs {
		return nil
	}
	if next == 0 {
		next = windows.FILE_ATTRIBUTE_NORMAL
	}
	if err := windows.SetFileAttributes(p, next); err != nil {
		return fail(err)
	}
	return nil
}
