//go:build linux

package fsx

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

func isRotational(path string) bool {
	fi, err := os.Stat(nearest(path))
	if err != nil {
		return false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	dev := fmt.Sprintf("/sys/dev/block/%d:%d", unix.Major(uint64(st.Dev)), unix.Minor(uint64(st.Dev)))
	// A partition's queue is its disk's (one level up).
	for _, q := range []string{dev + "/queue/rotational", dev + "/../queue/rotational"} {
		if b, err := os.ReadFile(q); err == nil {
			return strings.TrimSpace(string(b)) == "1"
		}
	}
	return false
}

// Filesystem magic numbers with Windows naming rules.
var windowsFS = map[int64]bool{
	0x4d44:     true, // msdos (FAT)
	0x2011bab0: true, // exfat
	0x5346544e: true, // ntfs
	0x7366746e: true, // ntfs3
	0x65735546: true, // fuse (ntfs-3g, exfat-fuse)
}

// WindowsNames reports whether dir's filesystem follows Windows naming rules.
func WindowsNames(dir string) bool {
	var st unix.Statfs_t
	if unix.Statfs(nearest(dir), &st) != nil {
		return false
	}
	return windowsFS[int64(st.Type)] //nolint:unconvert // int64 on most arches
}

func nearest(path string) string {
	for p := filepath.Clean(path); ; p = filepath.Dir(p) {
		if _, err := os.Stat(p); err == nil || filepath.Dir(p) == p {
			return p
		}
	}
}
