//go:build !windows

package fsx

import "io/fs"

func platformAttrs(_ string, info fs.FileInfo) int {
	a := 0
	m := info.Mode()
	if m.Perm()&0o222 == 0 {
		a |= AttrReadOnly
	}
	if m.IsRegular() && m.Perm()&0o111 != 0 {
		a |= AttrExecutable
	}
	return a
}
