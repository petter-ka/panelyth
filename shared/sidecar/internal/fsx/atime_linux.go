//go:build linux

package fsx

import (
	"io/fs"
	"syscall"
)

func accessNs(fi fs.FileInfo) int64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return st.Atim.Nano()
	}
	return 0
}
