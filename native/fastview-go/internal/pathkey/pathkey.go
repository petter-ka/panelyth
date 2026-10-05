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
)

// ErrNotAbsolute is returned for relative or empty paths.
var ErrNotAbsolute = errors.New("path is not absolute")

// caseInsensitive reflects the platform default. Per-volume detection
// (case-sensitive APFS/NTFS directories) is a Stage 09 refinement.
var caseInsensitive = runtime.GOOS == "windows" || runtime.GOOS == "darwin"

// Clean validates and cleans an absolute OS path.
func Clean(p string) (string, error) {
	if p == "" || strings.ContainsRune(p, 0) || !filepath.IsAbs(p) {
		return "", ErrNotAbsolute
	}
	return filepath.Clean(p), nil
}

// DirKey returns the key of a directory: NFC-normalized, '/'-separated,
// case-folded where the platform is case-insensitive, and always ending in
// '/' so that a key is a prefix of every descendant key.
func DirKey(cleanAbs string) string {
	k := fold(filepath.ToSlash(cleanAbs))
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
	s = norm.NFC.String(s)
	if caseInsensitive {
		s = strings.ToLower(s)
	}
	return s
}
