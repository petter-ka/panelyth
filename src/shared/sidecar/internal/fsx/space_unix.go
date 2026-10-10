//go:build !windows

package fsx

import "golang.org/x/sys/unix"

func diskSpace(root string) (free, total int64, ok bool) {
	var st unix.Statfs_t
	if unix.Statfs(root, &st) != nil {
		return 0, 0, false
	}
	bs := int64(st.Bsize) //nolint:unconvert // uint32 on darwin, int64 on linux
	return int64(st.Bavail) * bs, int64(st.Blocks) * bs, true
}
