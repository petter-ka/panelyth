//go:build !windows

package fsx

import (
	"io/fs"
	"strings"
)

// HiddenKind reports dot-names as hidden (the Unix convention); there are no
// system entries. No stat needed.
func HiddenKind(e fs.DirEntry) (hidden, system bool) {
	return strings.HasPrefix(e.Name(), "."), false
}

// IsHidden reports whether an entry is hidden.
func IsHidden(e fs.DirEntry) bool {
	hidden, _ := HiddenKind(e)
	return hidden
}
