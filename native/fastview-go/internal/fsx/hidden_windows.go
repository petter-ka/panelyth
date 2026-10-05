//go:build windows

package fsx

import (
	"io/fs"
	"strings"
	"syscall"
)

// IsHidden skips dot-names and entries with the hidden or system attribute.
// On Windows DirEntry.Info is served from the directory read, so this costs
// no extra syscall.
func IsHidden(e fs.DirEntry) bool {
	if strings.HasPrefix(e.Name(), ".") {
		return true
	}
	info, err := e.Info()
	if err != nil {
		return false
	}
	if a, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		return a.FileAttributes&(syscall.FILE_ATTRIBUTE_HIDDEN|syscall.FILE_ATTRIBUTE_SYSTEM) != 0
	}
	return false
}
