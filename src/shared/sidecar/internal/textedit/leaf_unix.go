//go:build !windows

package textedit

import (
	"errors"
	"io/fs"
	"os"
)

var errNotFile = errors.New("textedit: not a regular file")

// openLeaf opens a regular file without following a link at its name: link
// reports one (the caller resolves it in full).
func openLeaf(path string) (f *os.File, size int64, link bool, err error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, 0, false, err
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		return nil, 0, true, nil
	}
	if !fi.Mode().IsRegular() {
		return nil, 0, false, errNotFile
	}
	f, err = os.Open(path)
	if err != nil {
		return nil, 0, false, err
	}
	return f, fi.Size(), false, nil
}
