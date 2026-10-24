//go:build !windows

package textedit

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"syscall"
	"time"
)

// replaceFile renames partial over target. Unix renames replace atomically
// whatever the target's permissions; a busy file (EBUSY on some network
// filesystems) is waited for briefly.
func replaceFile(partial, target string) error {
	err := os.Rename(partial, target)
	for _, wait := range commitWaits {
		if err == nil || !errors.Is(err, syscall.EBUSY) {
			break
		}
		time.Sleep(wait)
		err = os.Rename(partial, target)
	}
	return err
}

// keepAttrs gives partial the original's owner (when this process may) and
// permission bits, read-only included. Hidden is a leading dot on Unix and
// comes with the name.
func keepAttrs(_ string, cur fs.FileInfo, partial string) error {
	if st, ok := cur.Sys().(*syscall.Stat_t); ok && (int(st.Uid) != os.Geteuid() || int(st.Gid) != os.Getegid()) {
		// Best effort: only root may give a file away; a group the user is
		// in works. Before the mode, since a change of owner clears setuid.
		_ = os.Lchown(partial, int(st.Uid), int(st.Gid))
	}
	return os.Chmod(partial, cur.Mode()&(fs.ModePerm|fs.ModeSetuid|fs.ModeSetgid|fs.ModeSticky))
}

// linkCount is the number of hard links to the file at path.
func linkCount(path string) uint64 {
	fi, err := os.Stat(path)
	if err != nil {
		return 1
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Nlink)
	}
	return 1
}

// writeInPlace overwrites a file that keeps its inode (hard links).
func writeInPlace(ctx context.Context, target string, data []byte) error {
	return overwrite(ctx, target, data)
}

// syncDir makes the rename durable: the folder's entry is synced too.
func syncDir(dir string) {
	if f, err := os.Open(dir); err == nil {
		_ = f.Sync()
		_ = f.Close()
	}
}
