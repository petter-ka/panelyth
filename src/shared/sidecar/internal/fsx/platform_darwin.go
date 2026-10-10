//go:build darwin

package fsx

import (
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// FileTimes reads birth and access times from stat.
func FileTimes(fi fs.FileInfo) Times {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return Times{BirthNs: st.Birthtimespec.Nano(), AccessNs: st.Atimespec.Nano()}
	}
	return Times{}
}

// listVolumes lists /Volumes; the boot volume (a symlink to "/") maps to "/".
func listVolumes() ([]Volume, error) {
	ents, err := os.ReadDir("/Volumes")
	if err != nil {
		return []Volume{{Path: "/", Label: "Macintosh HD", Kind: "fixed"}}, nil
	}
	out := []Volume{}
	for _, e := range ents {
		if IsHidden(e) {
			continue
		}
		p := filepath.Join("/Volumes", e.Name())
		v := Volume{Path: p, Label: e.Name(), Kind: "removable"}
		if target, err := filepath.EvalSymlinks(p); err == nil && target == "/" {
			v.Path, v.Kind = "/", "fixed"
		}
		out = append(out, v)
	}
	return out, nil
}
