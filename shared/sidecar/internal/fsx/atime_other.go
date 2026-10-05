//go:build !windows && !darwin && !linux

package fsx

import "io/fs"

func accessNs(fs.FileInfo) int64 { return 0 }
