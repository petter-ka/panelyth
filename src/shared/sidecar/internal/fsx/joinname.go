package fsx

import "strings"

// Names Windows programs cannot type exist on disks all the same (written
// by WSL, git or another system): a name ending in a dot or a space, or a
// device name such as NUL. Win32 rewrites such a path before it opens it:
// "photo.jpg." becomes "photo.jpg" (another file, if there is one) and
// "NUL" becomes the null device. A path with the \\?\ prefix is taken as
// it is written (Stage P04).

const (
	verbatimPrefix    = `\\?\`
	verbatimUNCPrefix = `\\?\UNC\`
)

// IsVerbatim reports whether path has the \\?\ prefix.
func IsVerbatim(path string) bool { return strings.HasPrefix(path, verbatimPrefix) }

// PlainPath drops the \\?\ prefix: `\\?\C:\a` is `C:\a` and
// `\\?\UNC\server\share\a` is `\\server\share\a`. Other paths are returned
// as they are.
func PlainPath(path string) string {
	switch {
	case strings.HasPrefix(path, verbatimUNCPrefix):
		return `\\` + path[len(verbatimUNCPrefix):]
	case strings.HasPrefix(path, verbatimPrefix):
		return path[len(verbatimPrefix):]
	}
	return path
}

// verbatim adds the prefix to a clean absolute Windows path.
func verbatim(path string) string {
	switch {
	case IsVerbatim(path):
		return path
	case strings.HasPrefix(path, `\\`):
		return verbatimUNCPrefix + path[2:]
	}
	return verbatimPrefix + path
}

// win32Devices are the names Win32 has reserved at one time or another;
// which of them a path is rewritten for depends on the Windows version
// (Windows 11 opens "aux.jpg" as a file), so the system is asked.
var win32Devices = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true, "CONIN$": true, "CONOUT$": true,
	"COM0": true, "COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true, "COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"COM\u00b9": true, "COM\u00b2": true, "COM\u00b3": true,
	"LPT0": true, "LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true, "LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
	"LPT\u00b9": true, "LPT\u00b2": true, "LPT\u00b3": true,
}

// suspectName reports whether Win32 may rewrite a path that ends in name.
// It is the cheap test every listed name gets: almost every name fails it
// on its last byte and on the length of its stem.
func suspectName(name string) bool {
	if name == "" {
		return false
	}
	if last := name[len(name)-1]; last == '.' || last == ' ' {
		return true
	}
	stem := name
	if i := strings.IndexAny(name, ".:"); i >= 0 {
		stem = name[:i]
	}
	stem = strings.TrimRight(stem, " ")
	// "CON" to "CONOUT$"; the superscript digits take two bytes.
	if len(stem) < 3 || len(stem) > 7 {
		return false
	}
	return win32Devices[strings.ToUpper(stem)]
}
