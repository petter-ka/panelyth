//go:build linux

package fsx

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// statxMask asks for what stat(2) returns plus the birth time.
const statxMask = unix.STATX_BASIC_STATS | unix.STATX_BTIME

// noStatx is set once statx is missing (kernels before 4.11, or a seccomp
// filter that denies it); every call then uses stat(2), without birth times.
var noStatx atomic.Bool

// statxInfo is an fs.FileInfo built from statx(2). Sys returns the
// *syscall.Stat_t that os.Lstat would, so callers reading device, inode or
// access time see no difference; the birth time is extra (zero when the
// filesystem does not record it).
type statxInfo struct {
	name    string
	mode    fs.FileMode
	sys     syscall.Stat_t
	birthNs int64
}

func (s *statxInfo) Name() string       { return s.name }
func (s *statxInfo) Size() int64        { return s.sys.Size }
func (s *statxInfo) Mode() fs.FileMode  { return s.mode }
func (s *statxInfo) ModTime() time.Time { return time.Unix(s.sys.Mtim.Unix()) }
func (s *statxInfo) IsDir() bool        { return s.mode.IsDir() }
func (s *statxInfo) Sys() any           { return &s.sys }

// EntryInfo stats a directory entry read from dir: statx relative to the
// directory's descriptor (one syscall, like DirEntry.Info), so the index
// gets birth times on Linux.
func EntryInfo(dir *os.File, e fs.DirEntry) (fs.FileInfo, error) {
	if noStatx.Load() {
		return e.Info()
	}
	fi, err := statx(int(dir.Fd()), e.Name(), e.Name(), unix.AT_SYMLINK_NOFOLLOW)
	if fi == nil && err == nil {
		return e.Info()
	}
	return fi, err
}

// Stat is os.Stat with the birth time on Linux.
func Stat(path string) (fs.FileInfo, error) {
	if noStatx.Load() {
		return os.Stat(path)
	}
	fi, err := statx(unix.AT_FDCWD, path, filepath.Base(path), 0)
	if fi == nil && err == nil {
		return os.Stat(path)
	}
	return fi, err
}

// statx returns (nil, nil) when statx itself is unavailable.
func statx(dirfd int, path, name string, flags int) (fs.FileInfo, error) {
	var x unix.Statx_t
	for {
		err := unix.Statx(dirfd, path, flags|unix.AT_STATX_SYNC_AS_STAT, statxMask, &x)
		if err == nil {
			break
		}
		if errors.Is(err, unix.EINTR) {
			continue
		}
		// stat(2) never fails with EPERM; statx does when an old container
		// seccomp profile denies it.
		if errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EPERM) {
			noStatx.Store(true)
			return nil, nil
		}
		return nil, &fs.PathError{Op: "statx", Path: path, Err: err}
	}
	s := &statxInfo{name: name}
	s.sys = syscall.Stat_t{
		Dev:     unix.Mkdev(x.Dev_major, x.Dev_minor),
		Ino:     x.Ino,
		Nlink:   uint64(x.Nlink),
		Mode:    uint32(x.Mode),
		Uid:     x.Uid,
		Gid:     x.Gid,
		Rdev:    unix.Mkdev(x.Rdev_major, x.Rdev_minor),
		Size:    int64(x.Size),
		Blksize: int64(x.Blksize),
		Blocks:  int64(x.Blocks),
		Atim:    syscall.Timespec{Sec: x.Atime.Sec, Nsec: int64(x.Atime.Nsec)},
		Mtim:    syscall.Timespec{Sec: x.Mtime.Sec, Nsec: int64(x.Mtime.Nsec)},
		Ctim:    syscall.Timespec{Sec: x.Ctime.Sec, Nsec: int64(x.Ctime.Nsec)},
	}
	s.mode = modeOf(uint32(x.Mode))
	if x.Mask&unix.STATX_BTIME != 0 {
		s.birthNs = time.Unix(x.Btime.Sec, int64(x.Btime.Nsec)).UnixNano()
	}
	return s, nil
}

// modeOf converts st_mode the way os.Lstat does.
func modeOf(m uint32) fs.FileMode {
	mode := fs.FileMode(m & 0o777)
	switch m & syscall.S_IFMT {
	case syscall.S_IFBLK:
		mode |= fs.ModeDevice
	case syscall.S_IFCHR:
		mode |= fs.ModeDevice | fs.ModeCharDevice
	case syscall.S_IFDIR:
		mode |= fs.ModeDir
	case syscall.S_IFIFO:
		mode |= fs.ModeNamedPipe
	case syscall.S_IFLNK:
		mode |= fs.ModeSymlink
	case syscall.S_IFSOCK:
		mode |= fs.ModeSocket
	}
	if m&syscall.S_ISGID != 0 {
		mode |= fs.ModeSetgid
	}
	if m&syscall.S_ISUID != 0 {
		mode |= fs.ModeSetuid
	}
	if m&syscall.S_ISVTX != 0 {
		mode |= fs.ModeSticky
	}
	return mode
}

func birthNs(fi fs.FileInfo) int64 {
	if s, ok := fi.(*statxInfo); ok {
		return s.birthNs
	}
	return 0
}
