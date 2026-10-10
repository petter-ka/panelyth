//go:build !windows

package fsx

import "io/fs"

func platformAttrs(_ string, info fs.FileInfo) int {
	a := 0
	m := info.Mode()
	if m.Perm()&0o222 == 0 {
		a |= AttrReadOnly
	}
	if m.IsRegular() && m.Perm()&0o111 != 0 {
		a |= AttrExecutable
	}
	return a
}

// programExts open into running code through their default app on macOS
// and Linux desktops (besides files with an execute bit).
var programExts = map[string]bool{
	"sh": true, "bash": true, "zsh": true, "command": true, "tool": true, "desktop": true,
	"appimage": true, "run": true, "jar": true, "pkg": true, "mpkg": true, "deb": true, "rpm": true,
}

func platformProgram(ext string, info fs.FileInfo) bool {
	if info.IsDir() {
		// A macOS app bundle is a folder that "open" launches.
		return ext == "app"
	}
	return programExts[ext] || (info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0)
}
