//go:build darwin

package fsx

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// isRotational: Macs with spinning disks are rare; treated as SSD.
func isRotational(string) bool { return false }

// WindowsNames reports whether dir is on a FAT, exFAT, NTFS or SMB volume.
func WindowsNames(dir string) bool {
	p := filepath.Clean(dir)
	for {
		if _, err := os.Stat(p); err == nil || filepath.Dir(p) == p {
			break
		}
		p = filepath.Dir(p)
	}
	var st unix.Statfs_t
	if unix.Statfs(p, &st) != nil {
		return false
	}
	switch unix.ByteSliceToString(st.Fstypename[:]) {
	case "msdos", "exfat", "ntfs", "smbfs":
		return true
	}
	return false
}
