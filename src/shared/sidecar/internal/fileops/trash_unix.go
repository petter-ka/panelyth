//go:build unix

package fileops

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"
)

func devOf(path string) (uint64, bool) {
	fi, err := os.Lstat(path)
	if err != nil {
		return 0, false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return uint64(st.Dev), true //nolint:unconvert // Dev is int32 on darwin
}

// mountTop walks up from path to the topmost directory on the same device.
func mountTop(path string, dev uint64) string {
	top := filepath.Dir(path)
	for {
		parent := filepath.Dir(top)
		if parent == top {
			return top
		}
		if d, ok := devOf(parent); !ok || d != dev {
			return top
		}
		top = parent
	}
}

// CanTrash: every volume can get a trash folder on Unix; an item that
// still can't be trashed fails with TRASH_UNAVAILABLE (ADR-0021).
func CanTrash(string) bool { return true }

// Trash moves path to the user's trash on its volume (ADR-0021).
func Trash(path string) error {
	dev, ok := devOf(path)
	if !ok {
		_, err := os.Lstat(path)
		return err
	}
	home, _ := os.UserHomeDir()
	uid := strconv.Itoa(os.Getuid())
	if runtime.GOOS == "darwin" {
		return macTrash(path, home, uid, dev)
	}
	dataHome := os.Getenv("XDG_DATA_HOME")
	if dataHome == "" && home != "" {
		dataHome = filepath.Join(home, ".local", "share")
	}
	if dataHome != "" {
		if d, ok := devOf(dataHome); ok && d == dev {
			return trashInto(filepath.Join(dataHome, "Trash"), path, path, time.Now())
		}
	}
	top := mountTop(path, dev)
	rel, err := filepath.Rel(top, path)
	if err != nil {
		return Errorf(CodeTrashUnavailable, "no trash on this volume")
	}
	// $topdir/.Trash/$uid when the admin provided a sticky .Trash, else $topdir/.Trash-$uid.
	if fi, err := os.Lstat(filepath.Join(top, ".Trash")); err == nil && fi.IsDir() && fi.Mode()&os.ModeSticky != 0 {
		if err := trashInto(filepath.Join(top, ".Trash", uid), path, rel, time.Now()); err == nil {
			return nil
		}
	}
	return trashInto(filepath.Join(top, ".Trash-"+uid), path, rel, time.Now())
}

// macTrash renames into ~/.Trash or the volume's .Trashes/<uid>. Finder's
// "Put Back" needs Finder scripting and is not supported (ADR-0021).
func macTrash(path, home, uid string, dev uint64) error {
	trash := filepath.Join(home, ".Trash")
	if d, ok := devOf(home); !ok || d != dev {
		trash = filepath.Join(mountTop(path, dev), ".Trashes", uid)
	}
	if err := os.MkdirAll(trash, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return Errorf(CodeTrashUnavailable, "no trash on this volume")
	}
	name, ok := UniqueName(filepath.Base(path), false, func(n string) bool {
		_, err := os.Lstat(filepath.Join(trash, n))
		return err == nil
	})
	if !ok {
		return Errorf(CodeTrashUnavailable, "the trash is full of items with this name")
	}
	return os.Rename(path, filepath.Join(trash, name))
}

// TrashMany trashes each path (renames; no batching needed).
func TrashMany(paths []string) []error {
	errs := make([]error, len(paths))
	for i, p := range paths {
		errs[i] = Trash(p)
	}
	return errs
}
