//go:build windows

package fsx

import (
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// JoinName is the path of the entry called name in dir (a clean absolute
// path), for a name that was read from the folder. Where Win32 would open
// something else under the joined path, the result has the \\?\ prefix, and
// so has everything joined below it.
func JoinName(dir, name string) string {
	if IsVerbatim(dir) {
		if strings.HasSuffix(dir, `\`) {
			return dir + name
		}
		return dir + `\` + name
	}
	joined := filepath.Join(dir, name)
	if !suspectName(name) || !rewritten(joined) {
		return joined
	}
	return verbatim(joined)
}

// SafePath spells a clean absolute path so that Windows opens what it
// names: with the \\?\ prefix where Win32 would rewrite it, plain otherwise.
func SafePath(path string) string {
	plain := PlainPath(path)
	if rewritten(plain) {
		return verbatim(plain)
	}
	return plain
}

// Verbatim spells a clean absolute folder path with the \\?\ prefix, for a
// walk that joins the names it reads onto it: every path below is then
// taken as written.
func Verbatim(path string) string { return verbatim(path) }

// rewritten asks Windows what it would open for path.
func rewritten(path string) bool {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	buf := make([]uint16, len(path)+16)
	n, err := windows.GetFullPathName(p, uint32(len(buf)), &buf[0], nil)
	if err != nil || n == 0 || int(n) > len(buf) {
		// A longer answer is not the same path either.
		return err == nil && n != 0
	}
	return windows.UTF16ToString(buf[:n]) != path
}
