//go:build !windows && !darwin

package fsx

import (
	"io/fs"
	"os"
)

// FileTimes: stat(2) has no birth time on Linux; infos from EntryInfo and
// Stat (statx, Stage P04) carry it. Access time is read where the platform
// exposes it.
func FileTimes(fi fs.FileInfo) Times {
	return Times{BirthNs: birthNs(fi), AccessNs: accessNs(fi)}
}

// listVolumes lists "/" plus user-visible mounts from /proc/self/mountinfo.
func listVolumes() ([]Volume, error) {
	data, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return []Volume{{Path: "/", Label: "/", Kind: "fixed"}}, nil
	}
	return ParseMountInfo(string(data)), nil
}
