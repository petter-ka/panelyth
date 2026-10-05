//go:build !windows

package fsx

import (
	"io/fs"
	"strings"
)

// IsHidden skips dot-names (the Unix convention); no stat needed.
func IsHidden(e fs.DirEntry) bool {
	return strings.HasPrefix(e.Name(), ".")
}
