// Package pathkey normalizes filesystem paths into stable comparison keys
// (ADR-0015). A key is used for identity, uniqueness and subtree ranges; the
// OS path is kept separately for I/O.
package pathkey

import (
	"errors"
	"path/filepath"
	"runtime"
	"strings"

	"golang.org/x/text/unicode/norm"

	"panelyth/sidecar/internal/fsx"
)

// ErrNotAbsolute is returned for relative or empty paths.
var ErrNotAbsolute = errors.New("path is not absolute")

// Both rules are the platform's default, not the volume's (ADR-0015,
// decided in Stage P04): a key is built from a path or from a parent's key
// and a name, in hot paths that cannot ask the volume.
var (
	// caseInsensitive: NTFS and APFS as they are formatted by default.
	caseInsensitive = runtime.GOOS == "windows" || runtime.GOOS == "darwin"
	// normalize: APFS and HFS+ treat the composed and the decomposed form
	// of a name as one file, so one key must cover both. NTFS, ext4 and the
	// other filesystems of Windows and Linux keep them apart as two files.
	normalize = runtime.GOOS == "darwin"
)

// Clean validates and cleans an absolute OS path.
func Clean(p string) (string, error) {
	if p == "" || strings.ContainsRune(p, 0) || !filepath.IsAbs(p) {
		return "", ErrNotAbsolute
	}
	return filepath.Clean(p), nil
}

// DirKey returns the key of a directory: '/'-separated, NFC-normalized and
// case-folded where the platform's filesystems are, and always ending in
// '/' so that a key is a prefix of every descendant key.
func DirKey(cleanAbs string) string {
	// A folder has one key however its path is spelled (fsx.JoinName).
	k := fold(filepath.ToSlash(fsx.PlainPath(cleanAbs)))
	if !strings.HasSuffix(k, "/") {
		k += "/"
	}
	return k
}

// ChildKey returns the key of an entry named name inside the directory
// whose key is dirKey. Directories get a trailing '/'.
func ChildKey(dirKey, name string, isDir bool) string {
	k := dirKey + fold(name)
	if isDir {
		k += "/"
	}
	return k
}

// SubtreeRange returns [lo, hi) covering all strict descendants of dirKey.
// '0' is the byte after '/', so hi sorts after every key with the prefix.
func SubtreeRange(dirKey string) (lo, hi string) {
	return dirKey, dirKey[:len(dirKey)-1] + "0"
}

func fold(s string) string {
	if normalize {
		s = norm.NFC.String(s)
	}
	if caseInsensitive {
		s = strings.ToLower(s)
	}
	return s
}

// NameKey pairs names across two folders (compare and synchronize): the
// composed and the decomposed form of a name are the same name on every
// platform, since the two sides may be volumes of different systems. Case
// follows the platform.
func NameKey(name string) string {
	name = norm.NFC.String(name)
	if caseInsensitive {
		name = strings.ToLower(name)
	}
	return name
}
