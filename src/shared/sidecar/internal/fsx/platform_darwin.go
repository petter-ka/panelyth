//go:build darwin

package fsx

import (
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

// FileTimes reads birth and access times from stat.
func FileTimes(fi fs.FileInfo) Times {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return Times{BirthNs: st.Birthtimespec.Nano(), AccessNs: st.Atimespec.Nano()}
	}
	return Times{}
}

// listVolumes reads the mount table without waiting for any filesystem
// (MNT_NOWAIT): a share that stopped answering cannot stall the list, which
// the volume monitor reads every two seconds.
func listVolumes() ([]Volume, error) {
	n, err := unix.Getfsstat(nil, unix.MNT_NOWAIT)
	if err != nil || n <= 0 {
		return DarwinVolumes(nil, bootLabel()), nil
	}
	// Room for mounts that appear between the two calls.
	buf := make([]unix.Statfs_t, n+8)
	if n, err = unix.Getfsstat(buf, unix.MNT_NOWAIT); err != nil || n <= 0 {
		return DarwinVolumes(nil, bootLabel()), nil
	}
	mounts := make([]Mount, 0, n)
	for i := range buf[:min(n, len(buf))] {
		st := &buf[i]
		mounts = append(mounts, Mount{
			Path:   unix.ByteSliceToString(st.Mntonname[:]),
			FS:     unix.ByteSliceToString(st.Fstypename[:]),
			Local:  st.Flags&unix.MNT_LOCAL != 0,
			Hidden: st.Flags&unix.MNT_DONTBROWSE != 0,
		})
	}
	return DarwinVolumes(mounts, bootLabel()), nil
}

// bootLabel is the boot volume's name: the entry of /Volumes that links
// to "/". Only links are read, never a mount point.
func bootLabel() string {
	ents, err := os.ReadDir("/Volumes")
	if err != nil {
		return ""
	}
	for _, e := range ents {
		if e.Type()&fs.ModeSymlink == 0 {
			continue
		}
		if target, err := os.Readlink(filepath.Join("/Volumes", e.Name())); err == nil && target == "/" {
			return e.Name()
		}
	}
	return ""
}
