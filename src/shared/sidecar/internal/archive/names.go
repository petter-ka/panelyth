package archive

import (
	"path/filepath"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
)

// CleanPath turns a stored entry name into a safe relative inner path
// ("a/b/c"), or explains why it is rejected (zip-slip, ADR-0030): absolute
// paths, drive letters, UNC prefixes and ".." components are never
// extracted. Backslashes count as separators (archives made on Windows).
// A trailing separator marks a folder and is dropped.
func CleanPath(name string) (string, string) {
	if strings.ContainsRune(name, 0) {
		return "", "the name contains a NUL character"
	}
	p := strings.ReplaceAll(name, `\`, "/")
	switch {
	case strings.HasPrefix(p, "/"):
		return "", "absolute path"
	case len(p) >= 2 && p[1] == ':' && isLetter(p[0]):
		return "", "absolute path with a drive letter"
	}
	parts := strings.Split(p, "/")
	out := parts[:0]
	for _, c := range parts {
		switch c {
		case "", ".":
			continue
		case "..":
			return "", "the path leaves the archive (\"..\")"
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return "", "empty name"
	}
	return strings.Join(out, "/"), ""
}

func isLetter(b byte) bool { return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' }

// Join resolves a clean inner path below dest. It re-checks containment, so
// a path that slipped past CleanPath still can't leave dest.
func Join(dest, inner string) (string, bool) {
	if inner == "" {
		return dest, true
	}
	if _, bad := CleanPath(inner); bad != "" {
		return "", false
	}
	p := filepath.Join(dest, filepath.FromSlash(inner))
	rel, err := filepath.Rel(dest, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	if filepath.VolumeName(rel) != "" {
		return "", false
	}
	return p, true
}

// LinkInside reports whether a symlink stored at inner path at, pointing to
// target, resolves (lexically) inside the extraction root. Absolute targets
// never do.
func LinkInside(at, target string) bool {
	t := strings.ReplaceAll(target, `\`, "/")
	if t == "" || strings.HasPrefix(t, "/") || (len(t) >= 2 && t[1] == ':') {
		return false
	}
	depth := strings.Count(at, "/") // folders above the link inside the root
	for _, c := range strings.Split(t, "/") {
		switch c {
		case "", ".":
		case "..":
			depth--
			if depth < 0 {
				return false
			}
		default:
			depth++
		}
	}
	return true
}

// legacyName decodes a zip name stored without the UTF-8 flag: valid UTF-8
// stays as it is (many tools write UTF-8 without the flag), anything else
// is read as code page 437, the zip default.
func legacyName(name string) string {
	if utf8.ValidString(name) {
		return name
	}
	s, err := charmap.CodePage437.NewDecoder().String(name)
	if err != nil {
		return strings.ToValidUTF8(name, "_")
	}
	return s
}

// baseName is the last component of a clean inner path.
func baseName(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}

// parentOf is the folder of a clean inner path ("" for the root).
func parentOf(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[:i]
	}
	return ""
}
