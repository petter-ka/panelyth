//go:build darwin

package fileops

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

// fastCopy clones the file on APFS when source and target share a volume
// (instant, no bytes moved); otherwise the portable copy runs.
func fastCopy(ctx context.Context, src string, in fs.FileInfo, target string, o *CopyOptions) (bool, bool, error) {
	dir, err := os.Stat(filepath.Dir(target))
	if err != nil {
		return true, false, err
	}
	a, ok1 := in.Sys().(*syscall.Stat_t)
	b, ok2 := dir.Sys().(*syscall.Stat_t)
	if !ok1 || !ok2 || a.Dev != b.Dev {
		return false, false, nil
	}
	if err := unix.Clonefile(src, target, unix.CLONE_NOFOLLOW); err != nil {
		_ = os.Remove(target)
		return false, false, nil // not APFS, or no clone support: copy the bytes
	}
	o.progress(in.Size())
	return true, false, o.gate(ctx)
}
