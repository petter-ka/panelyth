//go:build windows

package fsx

import (
	"io/fs"
	"syscall"
)

// executableExts mark files Windows runs directly.
var executableExts = map[string]bool{"exe": true, "com": true, "bat": true, "cmd": true}

// programExts open into running code through their default app: binaries,
// scripts, installers, shortcuts and control panel items.
var programExts = map[string]bool{
	"exe": true, "com": true, "bat": true, "cmd": true, "scr": true, "pif": true, "cpl": true,
	"msi": true, "msp": true, "msc": true, "appx": true, "msix": true, "appref-ms": true,
	"ps1": true, "psm1": true, "vbs": true, "vbe": true, "js": true, "jse": true, "wsf": true, "wsh": true,
	"hta": true, "jar": true, "reg": true, "lnk": true, "url": true, "scf": true, "inf": true,
}

func platformProgram(ext string, info fs.FileInfo) bool {
	return !info.IsDir() && programExts[ext]
}

func platformAttrs(name string, info fs.FileInfo) int {
	a := 0
	if d, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		f := d.FileAttributes
		if f&syscall.FILE_ATTRIBUTE_HIDDEN != 0 {
			a |= AttrHidden
		}
		if f&syscall.FILE_ATTRIBUTE_SYSTEM != 0 {
			a |= AttrSystem
		}
		if f&syscall.FILE_ATTRIBUTE_READONLY != 0 {
			a |= AttrReadOnly
		}
		if f&syscall.FILE_ATTRIBUTE_ARCHIVE != 0 {
			a |= AttrArchive
		}
	}
	if !info.IsDir() {
		if i := lastDot(name); i > 0 && executableExts[lowerASCII(name[i+1:])] {
			a |= AttrExecutable
		}
	}
	return a
}
