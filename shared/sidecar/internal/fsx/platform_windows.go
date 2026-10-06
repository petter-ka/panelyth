//go:build windows

package fsx

import (
	"io/fs"
	"syscall"

	"golang.org/x/sys/windows"
)

// FileTimes reads creation and access times from the directory-read data.
func FileTimes(fi fs.FileInfo) Times {
	if a, ok := fi.Sys().(*syscall.Win32FileAttributeData); ok {
		return Times{BirthNs: a.CreationTime.Nanoseconds(), AccessNs: a.LastAccessTime.Nanoseconds()}
	}
	return Times{}
}

// listVolumes lists drive letters. Labels are read only for local drives:
// querying a disconnected network share can stall for seconds.
func listVolumes() ([]Volume, error) {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return nil, err
	}
	// No "insert a disk" dialogs for empty card readers or optical drives.
	old := windows.SetErrorMode(windows.SEM_FAILCRITICALERRORS | windows.SEM_NOOPENFILEERRORBOX)
	defer windows.SetErrorMode(old)
	var out []Volume
	for i := range 26 {
		if mask&(1<<i) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		rootp, _ := windows.UTF16PtrFromString(root)
		v := Volume{Path: root, Kind: "other"}
		switch windows.GetDriveType(rootp) {
		case windows.DRIVE_FIXED, windows.DRIVE_RAMDISK:
			v.Kind = "fixed"
		case windows.DRIVE_REMOVABLE:
			v.Kind = "removable"
		case windows.DRIVE_REMOTE:
			v.Kind = "network"
		case windows.DRIVE_CDROM:
			v.Kind = "optical"
		case windows.DRIVE_NO_ROOT_DIR:
			continue
		}
		if v.Kind == "fixed" || v.Kind == "removable" {
			var name [windows.MAX_PATH + 1]uint16
			if windows.GetVolumeInformation(rootp, &name[0], uint32(len(name)), nil, nil, nil, nil, 0) == nil {
				v.Label = windows.UTF16ToString(name[:])
			}
		}
		out = append(out, v)
	}
	return out, nil
}

func diskSpace(root string) (free, total int64, ok bool) {
	p, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return 0, 0, false
	}
	old := windows.SetErrorMode(windows.SEM_FAILCRITICALERRORS | windows.SEM_NOOPENFILEERRORBOX)
	defer windows.SetErrorMode(old)
	var avail, size, totalFree uint64
	if windows.GetDiskFreeSpaceEx(p, &avail, &size, &totalFree) != nil {
		return 0, 0, false
	}
	return int64(avail), int64(size), true
}
