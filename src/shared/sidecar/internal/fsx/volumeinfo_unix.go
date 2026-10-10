//go:build !windows

package fsx

import (
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

// VolumeID is the device of path, or of its nearest existing ancestor.
func VolumeID(path string) string {
	for p := filepath.Clean(path); ; p = filepath.Dir(p) {
		if fi, err := os.Stat(p); err == nil {
			if st, ok := fi.Sys().(*syscall.Stat_t); ok {
				return strconv.FormatUint(uint64(st.Dev), 10)
			}
			return ""
		}
		if filepath.Dir(p) == p {
			return ""
		}
	}
}
