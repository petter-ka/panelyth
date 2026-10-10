//go:build linux

package fileops

import (
	"context"
	"errors"
	"io/fs"
	"os"

	"golang.org/x/sys/unix"
)

// rangeChunk is how much copy_file_range moves per call (a pause point).
const rangeChunk = 16 << 20

// fastCopy copies with copy_file_range (in-kernel, reflinks on Btrfs and
// XFS). Filesystems or kernels without it fall back to the portable copy.
func fastCopy(ctx context.Context, src string, in fs.FileInfo, target string, o *CopyOptions) (bool, bool, error) {
	done, err := copyRange(ctx, src, in, target, o)
	return done, false, err
}

func copyRange(ctx context.Context, src string, in fs.FileInfo, target string, o *CopyOptions) (bool, error) {
	r, err := os.Open(src)
	if err != nil {
		return true, err
	}
	defer r.Close()
	w, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, in.Mode().Perm()|0o200)
	if err != nil {
		return true, err
	}
	var copied int64
	for copied < in.Size() {
		n, err := unix.CopyFileRange(int(r.Fd()), nil, int(w.Fd()), nil, rangeChunk, 0)
		if err != nil || (n == 0 && copied == 0) {
			_ = w.Close()
			if copied == 0 && unsupported(err) {
				_ = os.Remove(target)
				return false, nil
			}
			if err == nil {
				err = errors.New("copy_file_range made no progress")
			}
			return true, err
		}
		if n == 0 {
			break // the source shrank while copying
		}
		copied += int64(n)
		o.progress(int64(n))
		if err := o.gate(ctx); err != nil {
			_ = w.Close()
			return true, err
		}
	}
	return true, w.Close()
}

func unsupported(err error) bool {
	return err == nil || errors.Is(err, unix.EXDEV) || errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EINVAL) ||
		errors.Is(err, unix.EOPNOTSUPP) || errors.Is(err, unix.EBADF) || errors.Is(err, unix.EPERM)
}
