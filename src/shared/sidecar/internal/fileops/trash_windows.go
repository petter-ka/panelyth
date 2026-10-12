//go:build windows

package fileops

import (
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"

	"panelyth/sidecar/internal/fsx"
)

var procSHFileOperationW = windows.NewLazySystemDLL("shell32.dll").NewProc("SHFileOperationW")

// SHFILEOPSTRUCTW (64-bit layout; natural alignment matches Go's).
type shFileOp struct {
	hwnd          uintptr
	wFunc         uint32
	pFrom         *uint16
	pTo           *uint16
	fFlags        uint16
	anyAborted    int32
	nameMappings  uintptr
	progressTitle *uint16
}

const (
	foDelete          = 0x0003
	fofSilent         = 0x0004
	fofNoConfirmation = 0x0010
	fofAllowUndo      = 0x0040
	fofNoErrorUI      = 0x0400
)

// canTrash: only fixed drives have a Recycle Bin the shell reliably uses. On
// removable and network drives SHFileOperation with FOF_ALLOWUNDO deletes
// permanently without a word (ADR-0021).
func canTrash(path string) bool {
	vol := filepath.VolumeName(path)
	if len(vol) != 2 || vol[1] != ':' { // UNC shares, \\?\ paths
		return false
	}
	root, err := windows.UTF16PtrFromString(vol + `\`)
	if err != nil {
		return false
	}
	return windows.GetDriveType(root) == windows.DRIVE_FIXED
}

// noTrash says why path cannot go to the Recycle Bin. The shell cannot
// address a name Win32 rewrites (fsx.JoinName), on any drive.
func noTrash(path string) error {
	if fsx.IsVerbatim(path) {
		return Errorf(CodeTrashUnavailable, "Windows can't move an item with this name to the Recycle Bin")
	}
	return Errorf(CodeTrashUnavailable, "this drive has no Recycle Bin")
}

// CanTrash reports whether items in dir can go to the Recycle Bin (fixed
// drives only, ADR-0021).
func CanTrash(dir string) bool { return canTrash(dir) }

// Trash moves path to the Recycle Bin.
func Trash(path string) error {
	if _, err := os.Lstat(path); err != nil {
		return err
	}
	if !canTrash(path) {
		return noTrash(path)
	}
	// pFrom is a list of NUL-terminated paths ending with an extra NUL.
	from, err := windows.UTF16FromString(path)
	if err != nil {
		return Errorf(CodeInvalidName, "invalid path")
	}
	from = append(from, 0)
	op := shFileOp{
		wFunc:  foDelete,
		pFrom:  &from[0],
		fFlags: fofAllowUndo | fofNoConfirmation | fofSilent | fofNoErrorUI,
	}
	r, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	switch {
	case r == 0 && op.anyAborted == 0:
	case r == 2 || r == 3: // ERROR_FILE_NOT_FOUND / PATH_NOT_FOUND
		return Errorf(CodeNotFound, "the item no longer exists")
	case r == 5 || r == 0x78: // ERROR_ACCESS_DENIED / DE_ACCESSDENIEDSRC
		return Errorf(CodePermission, "access denied")
	case r == 32 || r == 33: // sharing / lock violation
		return Errorf(CodeInUse, "the item is open in another program")
	case r == 0x4C7 || op.anyAborted != 0: // ERROR_CANCELLED
		return Errorf(CodeTrashUnavailable, "moving to the Recycle Bin was cancelled")
	default:
		return Errorf(CodeIO, "couldn't move to the Recycle Bin (shell error 0x%X)", r)
	}
	// The shell reports success for some items it could not recycle; check.
	if _, err := os.Lstat(path); err == nil {
		return Errorf(CodeIO, "the item is still there after moving it to the Recycle Bin")
	}
	return nil
}

// TrashMany moves paths to the Recycle Bin with one shell call per batch
// (Stage P03: one call per item cost ~28 ms each), then checks every path:
// an item still there is retried alone, which reports its own error. The
// result has one entry per path (nil = trashed).
func TrashMany(paths []string) []error {
	errs := make([]error, len(paths))
	var from []uint16
	var batch []int
	for i, p := range paths {
		if _, err := os.Lstat(p); err != nil {
			errs[i] = err
			continue
		}
		if !canTrash(p) {
			errs[i] = noTrash(p)
			continue
		}
		u, err := windows.UTF16FromString(p)
		if err != nil {
			errs[i] = Errorf(CodeInvalidName, "invalid path")
			continue
		}
		from = append(from, u...) // u ends with its NUL
		batch = append(batch, i)
	}
	if len(batch) == 0 {
		return errs
	}
	from = append(from, 0)
	op := shFileOp{
		wFunc:  foDelete,
		pFrom:  &from[0],
		fFlags: fofAllowUndo | fofNoConfirmation | fofSilent | fofNoErrorUI,
	}
	_, _, _ = procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	for _, i := range batch {
		if _, err := os.Lstat(paths[i]); err == nil {
			errs[i] = Trash(paths[i])
		}
	}
	return errs
}
