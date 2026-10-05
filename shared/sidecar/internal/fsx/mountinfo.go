package fsx

import (
	"path/filepath"
	"strconv"
	"strings"
)

// userMountPrefixes are where desktop Linux mounts disks users care about.
var userMountPrefixes = []string{"/media/", "/mnt/", "/run/media/"}

var networkFS = map[string]bool{"nfs": true, "nfs4": true, "cifs": true, "smb3": true, "sshfs": true, "fuse.sshfs": true}

// ParseMountInfo extracts "/" and user mounts from /proc/self/mountinfo text.
// Pseudo filesystems (proc, sysfs, tmpfs, overlay, snaps...) never qualify
// because they are not mounted under the user prefixes.
func ParseMountInfo(text string) []Volume {
	out := []Volume{{Path: "/", Label: "/", Kind: "fixed"}}
	seen := map[string]bool{"/": true}
	for _, line := range strings.Split(text, "\n") {
		pre, post, ok := strings.Cut(line, " - ")
		if !ok {
			continue
		}
		f := strings.Fields(pre)
		pf := strings.Fields(post)
		if len(f) < 5 || len(pf) < 1 {
			continue
		}
		mp := unescapeMount(f[4])
		user := false
		for _, p := range userMountPrefixes {
			if strings.HasPrefix(mp, p) {
				user = true
			}
		}
		if !user || seen[mp] {
			continue
		}
		seen[mp] = true
		kind := "removable"
		if networkFS[pf[0]] {
			kind = "network"
		}
		out = append(out, Volume{Path: mp, Label: filepath.Base(mp), Kind: kind})
	}
	return out
}

// unescapeMount decodes the octal escapes mountinfo uses (\040 = space).
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
