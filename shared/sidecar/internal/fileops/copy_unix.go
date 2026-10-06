//go:build !windows

package fileops

import (
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"fastview/sidecar/internal/fsx"
)

// preserve sets target's access and modification times to src's; the mode
// (read-only included) was set when the copy was created. Hidden is a
// leading dot on Unix and comes with the name.
func preserve(_ string, in fs.FileInfo, target string) error {
	atime := in.ModTime()
	if ns := fsx.FileTimes(in).AccessNs; ns > 0 {
		atime = time.Unix(0, ns)
	}
	return os.Chtimes(target, atime, in.ModTime())
}

// renameNoReplace commits a partial copy, failing when dst exists.
func renameNoReplace(partial, dst string) error {
	if _, err := os.Lstat(dst); err == nil {
		return Errorf(CodeExists, "%s already exists", filepath.Base(dst))
	}
	return os.Rename(partial, dst)
}

// clearReadOnly is a no-op: Unix renames and removes depend on the folder's
// permissions, not the file's.
func clearReadOnly(string) {}

// LongPath is the path itself outside Windows.
func LongPath(p string) string { return p }

func linkHint(err error) string { return err.Error() }
