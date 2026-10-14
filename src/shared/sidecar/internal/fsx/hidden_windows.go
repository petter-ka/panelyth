//go:build windows

package fsx

import (
	"io/fs"
	"strings"
	"syscall"
)

// HiddenKind reports whether an entry is hidden (a dot-name or the hidden
// attribute) and whether it is a system entry (the system attribute). On
// Windows DirEntry.Info is served from the directory read, so this costs no
// extra syscall.
func HiddenKind(e fs.DirEntry) (hidden, system bool) {
	hidden = strings.HasPrefix(e.Name(), ".")
	info, err := e.Info()
	if err != nil {
		return hidden, false
	}
	if a, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		hidden = hidden || a.FileAttributes&syscall.FILE_ATTRIBUTE_HIDDEN != 0
		system = a.FileAttributes&syscall.FILE_ATTRIBUTE_SYSTEM != 0
	}
	return hidden, system
}

// IsHidden reports whether an entry is hidden or a system entry.
func IsHidden(e fs.DirEntry) bool {
	hidden, system := HiddenKind(e)
	return hidden || system
}
