package fsx

import (
	"io/fs"
	"strings"
)

// IsProgram reports whether opening path with its default app may run code
// (ADR-0027: the commander asks first). It is broader than AttrExecutable:
// scripts, installers, shortcuts and app bundles count too. info is a stat
// of path (links followed: the target is what opens).
func IsProgram(path string, info fs.FileInfo) bool {
	name := path
	if i := strings.LastIndexAny(path, `/\`); i >= 0 {
		name = path[i+1:]
	}
	ext := ""
	if i := lastDot(name); i > 0 {
		ext = lowerASCII(name[i+1:])
	}
	return platformProgram(ext, info)
}

func lastDot(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '.' {
			return i
		}
	}
	return -1
}

func lowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + 'a' - 'A'
		}
	}
	return string(b)
}
