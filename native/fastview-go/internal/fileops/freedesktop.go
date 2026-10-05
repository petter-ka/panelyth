package fileops

import (
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// trashInto implements the freedesktop.org Trash specification for one
// item: it reserves files/<name> by creating info/<name>.trashinfo
// exclusively, then renames the item. infoPath is the path recorded in the
// info file (absolute for the home trash, relative to the volume top for
// $topdir trashes). Kept free of build tags so every platform tests it.
func trashInto(trashDir, path, infoPath string, now time.Time) error {
	files, info := filepath.Join(trashDir, "files"), filepath.Join(trashDir, "info")
	for _, d := range []string{trashDir, files, info} {
		if err := os.Mkdir(d, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
			return Errorf(CodeTrashUnavailable, "can't create the trash folder: %v", err)
		}
	}
	base := filepath.Base(path)
	var infoFile string
	var name string
	for n := 1; n < 10_000; n++ {
		name = base
		if n > 1 {
			stem, ext := SplitExt(base, false)
			name = stem + "." + itoa(n) + ext
		}
		infoFile = filepath.Join(info, name+".trashinfo")
		f, err := os.OpenFile(infoFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return Errorf(CodeTrashUnavailable, "can't write to the trash: %v", err)
		}
		_, werr := f.WriteString("[Trash Info]\nPath=" + escapeTrashPath(infoPath) +
			"\nDeletionDate=" + now.Format("2006-01-02T15:04:05") + "\n")
		if cerr := f.Close(); werr == nil {
			werr = cerr
		}
		if werr != nil {
			_ = os.Remove(infoFile)
			return Errorf(CodeTrashUnavailable, "can't write to the trash: %v", werr)
		}
		break
	}
	if err := os.Rename(path, filepath.Join(files, name)); err != nil {
		_ = os.Remove(infoFile)
		return err
	}
	return nil
}

// escapeTrashPath percent-encodes like a URL path (spec: "Path" key).
func escapeTrashPath(p string) string {
	parts := strings.Split(filepath.ToSlash(p), "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for ; n > 0; n /= 10 {
		i--
		b[i] = byte('0' + n%10)
	}
	return string(b[i:])
}
