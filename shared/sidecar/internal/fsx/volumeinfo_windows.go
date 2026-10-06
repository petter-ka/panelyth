//go:build windows

package fsx

import (
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// VolumeID is the path's volume: "c:" or "\server\share", lower-cased.
func VolumeID(path string) string {
	return strings.ToLower(filepath.VolumeName(path))
}

// WindowsNames: every Windows volume uses Windows naming rules.
func WindowsNames(string) bool { return true }

const (
	ioctlStorageQueryProperty    = 0x2D1400
	storageDeviceSeekPenaltyProp = 7
)

type storagePropertyQuery struct {
	PropertyID uint32
	QueryType  uint32
	Extra      [1]byte
}

type seekPenaltyDescriptor struct {
	Version           uint32
	Size              uint32
	IncursSeekPenalty byte
}

func isRotational(path string) bool {
	vol := filepath.VolumeName(path)
	if len(vol) != 2 || vol[1] != ':' {
		return false // a share: not a local spinning disk
	}
	p, err := windows.UTF16PtrFromString(`\\.\` + vol)
	if err != nil {
		return false
	}
	h, err := windows.CreateFile(p, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	q := storagePropertyQuery{PropertyID: storageDeviceSeekPenaltyProp}
	var d seekPenaltyDescriptor
	var n uint32
	if err := windows.DeviceIoControl(h, ioctlStorageQueryProperty, (*byte)(unsafe.Pointer(&q)), uint32(unsafe.Sizeof(q)),
		(*byte)(unsafe.Pointer(&d)), uint32(unsafe.Sizeof(d)), &n, nil); err != nil {
		return false
	}
	return d.IncursSeekPenalty != 0
}
