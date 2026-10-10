package fsx

import (
	"io/fs"
	"strings"
)

// Attribute bits stored in entries.attrs (ADR-0026). Values are part of the
// index schema.
const (
	AttrHidden     = 1
	AttrSystem     = 2
	AttrReadOnly   = 4
	AttrArchive    = 8
	AttrExecutable = 16
	AttrLink       = 32
)

// AttrsOf returns the attribute bits of a directory entry from data the
// directory read already returned (no extra syscall on Windows; on Unix the
// mode comes from the stat the scanner does anyway).
func AttrsOf(name string, info fs.FileInfo) int {
	a := platformAttrs(name, info)
	if strings.HasPrefix(name, ".") {
		a |= AttrHidden
	}
	if info.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
		a |= AttrLink
	}
	return a
}

// IsLink reports whether a directory entry is a symlink, junction or mount
// point. Links are listed but never followed.
func IsLink(e fs.DirEntry) bool {
	return e.Type()&(fs.ModeSymlink|fs.ModeIrregular) != 0
}
