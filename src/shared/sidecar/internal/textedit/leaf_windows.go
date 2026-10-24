//go:build windows

package textedit

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"

	"panelyth/sidecar/internal/fileops"
)

var errNotFile = errors.New("textedit: not a regular file")

// openLeaf opens a regular file without following a reparse point at its
// name (FILE_FLAG_OPEN_REPARSE_POINT): link reports one (a symbolic link, a
// junction; the caller resolves it in full). The attributes and the size
// come from the handle, so a file costs one lookup by path, not two. A
// folder does not open (no FILE_FLAG_BACKUP_SEMANTICS).
func openLeaf(path string) (f *os.File, size int64, link bool, err error) {
	p, err := windows.UTF16PtrFromString(fileops.LongPath(path))
	if err != nil {
		return nil, 0, false, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, 0, false, err
	}
	var d windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &d); err != nil {
		_ = windows.CloseHandle(h)
		return nil, 0, false, err
	}
	switch {
	case d.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0:
		_ = windows.CloseHandle(h)
		return nil, 0, true, nil
	case d.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_DEVICE) != 0:
		_ = windows.CloseHandle(h)
		return nil, 0, false, errNotFile
	}
	return os.NewFile(uintptr(h), path), int64(d.FileSizeHigh)<<32 | int64(d.FileSizeLow), false, nil
}
