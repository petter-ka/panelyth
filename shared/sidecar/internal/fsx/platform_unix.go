//go:build !windows && !darwin

package fsx

import (
	"io/fs"
	"os"
)

// FileTimes: Linux has no portable birth time through stat(2); statx is a
// Stage P04 refinement. Access time is read where the platform exposes it.
func FileTimes(fi fs.FileInfo) Times {
	return Times{AccessNs: accessNs(fi)}
}

// Volumes lists "/" plus user-visible mounts from /proc/self/mountinfo.
func Volumes() ([]Volume, error) {
	data, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return []Volume{{Path: "/", Label: "/", Kind: "fixed"}}, nil
	}
	return ParseMountInfo(string(data)), nil
}
