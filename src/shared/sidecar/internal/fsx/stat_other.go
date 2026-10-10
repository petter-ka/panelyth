//go:build !linux

package fsx

import (
	"io/fs"
	"os"
)

// EntryInfo stats a directory entry read from dir. Outside Linux,
// DirEntry.Info already carries the birth time (free on Windows, where the
// listing returns it).
func EntryInfo(_ *os.File, e fs.DirEntry) (fs.FileInfo, error) { return e.Info() }

// Stat is os.Stat; the birth time comes with it outside Linux.
func Stat(path string) (fs.FileInfo, error) { return os.Stat(path) }

// birthNs: the BSDs other than macOS are not targets (FileTimes in
// platform_unix.go).
func birthNs(fs.FileInfo) int64 { return 0 }
