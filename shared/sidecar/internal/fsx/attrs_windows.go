//go:build windows

package fsx

import (
	"io/fs"
	"syscall"
)

// executableExts mark files Windows runs directly.
var executableExts = map[string]bool{"exe": true, "com": true, "bat": true, "cmd": true}

func platformAttrs(name string, info fs.FileInfo) int {
	a := 0
	if d, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		f := d.FileAttributes
		if f&syscall.FILE_ATTRIBUTE_HIDDEN != 0 {
			a |= AttrHidden
		}
		if f&syscall.FILE_ATTRIBUTE_SYSTEM != 0 {
			a |= AttrSystem
		}
		if f&syscall.FILE_ATTRIBUTE_READONLY != 0 {
			a |= AttrReadOnly
		}
		if f&syscall.FILE_ATTRIBUTE_ARCHIVE != 0 {
			a |= AttrArchive
		}
	}
	if !info.IsDir() {
		if i := lastDot(name); i > 0 && executableExts[lowerASCII(name[i+1:])] {
			a |= AttrExecutable
		}
	}
	return a
}

func lastDot(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '.' {
			return i
		}
	}
	return -1
}

func lowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + 'a' - 'A'
		}
	}
	return string(b)
}
