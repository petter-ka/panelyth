//go:build !windows

package fileops

import (
	"io/fs"
	"os"
)

// setAttrs sets and clears permission bits; the Windows attributes have no
// place here.
func setAttrs(path string, c AttrChange) error {
	set, clear := c.ModeSet&fs.ModePerm, c.ModeClear&fs.ModePerm
	if set == 0 && clear == 0 {
		return nil
	}
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	next := fi.Mode().Perm()&^clear | set
	if next == fi.Mode().Perm() {
		return nil
	}
	return os.Chmod(path, next)
}
