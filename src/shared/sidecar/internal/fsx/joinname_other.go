//go:build !windows

package fsx

import "path/filepath"

// JoinName is the path of the entry called name in dir. Only Windows
// rewrites paths (joinname.go).
func JoinName(dir, name string) string { return filepath.Join(dir, name) }

// SafePath is the path itself outside Windows.
func SafePath(path string) string { return path }

// Verbatim is the path itself outside Windows.
func Verbatim(path string) string { return path }
