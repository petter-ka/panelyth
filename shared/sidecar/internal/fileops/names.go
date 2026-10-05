// Package fileops implements the filesystem side of batch jobs (ADR-0021):
// name validation, conflict-free names, cancellable copies, moves with a
// cross-volume fallback, trash and permanent delete. Everything here is
// one-item-at-a-time; the job manager owns ordering, progress and the index.
package fileops

import (
	"errors"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"unicode/utf8"
)

// MaxNameBytes is the common filename limit (NTFS, APFS, ext4).
const MaxNameBytes = 255

// ErrInvalidName is returned (wrapped, with a reason) by ValidateName.
var ErrInvalidName = errors.New("invalid name")

type nameError struct{ reason string }

func (e *nameError) Error() string { return e.reason }
func (e *nameError) Unwrap() error { return ErrInvalidName }

func invalid(reason string) error { return &nameError{reason: reason} }

var windowsReserved = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true, "COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true, "LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// ValidateName checks a single path component for the current platform.
func ValidateName(name string) error {
	return validateName(name, runtime.GOOS == "windows")
}

func validateName(name string, windows bool) error {
	switch {
	case strings.TrimSpace(name) == "":
		return invalid("The name can't be empty.")
	case name == "." || name == "..":
		return invalid("That name is reserved.")
	case len(name) > MaxNameBytes:
		return invalid("The name is too long.")
	case !utf8.ValidString(name):
		return invalid("The name contains invalid characters.")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f || r == '/' || (windows && strings.ContainsRune(`<>:"\|?*`, r)) {
			if r == '/' || r == '\\' {
				return invalid("The name can't contain / or \\.")
			}
			return invalid("The name contains characters that aren't allowed.")
		}
	}
	if windows {
		if strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
			return invalid("The name can't end with a dot or a space.")
		}
		base := strings.ToUpper(name)
		if i := strings.IndexByte(base, '.'); i >= 0 {
			base = base[:i]
		}
		if windowsReserved[strings.TrimRight(base, " ")] {
			return invalid("That name is reserved by Windows.")
		}
	}
	return nil
}

// SplitExt splits "a.b.jpg" into "a.b" and ".jpg". Names starting with a dot
// and names without an extension return ext "". Folders never have one.
func SplitExt(name string, isDir bool) (stem, ext string) {
	if isDir {
		return name, ""
	}
	i := strings.LastIndexByte(name, '.')
	if i <= 0 || i == len(name)-1 {
		return name, ""
	}
	return name[:i], name[i:]
}

// UniqueName returns name, or "stem (2).ext", "stem (3).ext"… for the first
// candidate exists reports as free. It gives up after 10,000 attempts.
func UniqueName(name string, isDir bool, exists func(string) bool) (string, bool) {
	if !exists(name) {
		return name, true
	}
	stem, ext := SplitExt(name, isDir)
	// "photo (2)" continues as "photo (3)", not "photo (2) (2)".
	if open := strings.LastIndex(stem, " ("); open > 0 && strings.HasSuffix(stem, ")") {
		if n, err := strconv.Atoi(stem[open+2 : len(stem)-1]); err == nil && n >= 2 {
			stem = stem[:open]
		}
	}
	for n := 2; n < 10_000; n++ {
		c := stem + " (" + strconv.Itoa(n) + ")" + ext
		if len(c) <= MaxNameBytes && !exists(c) {
			return c, true
		}
	}
	return "", false
}

// IsWithin reports whether path equals root or lies inside it. Both must be
// clean absolute paths; comparison follows the platform's case rule.
func IsWithin(path, root string) bool {
	if caseInsensitive {
		path, root = strings.ToLower(path), strings.ToLower(root)
	}
	if path == root {
		return true
	}
	if !strings.HasSuffix(root, string(filepath.Separator)) {
		root += string(filepath.Separator)
	}
	return strings.HasPrefix(path, root)
}

var caseInsensitive = runtime.GOOS == "windows" || runtime.GOOS == "darwin"
