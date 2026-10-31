//go:build windows

package fileops

import (
	"context"
	"errors"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// CopyFileExW is the Windows fast path (ADR-0029): the OS copies the bytes
// (with its own buffering and, for large files, unbuffered I/O) and the
// attributes; a progress routine reports bytes and is where a copy pauses
// or cancels. One callback is registered for the process (Windows limits
// how many can exist); each copy is found by the id passed as its data.

var (
	kernel32        = windows.NewLazySystemDLL("kernel32.dll")
	procCopyFileExW = kernel32.NewProc("CopyFileExW")
	progressRoutine = syscall.NewCallback(copyProgressRoutine)

	ctlMu   sync.Mutex
	ctls    = map[uintptr]*copyCtl{}
	nextCtl uintptr
)

const (
	copyFileFailIfExists = 0x00000001
	copyFileNoBuffering  = 0x00001000
	progressContinue     = 0
	progressCancel       = 1
)

// NoBufferingFrom is the size from which CopyFileExW copies unbuffered
// (COPY_FILE_NO_BUFFERING). Off: Stage P03 measured buffered copies faster
// for 4 GB on NVMe and NVMe to HDD alike (kept for tuning per machine).
var NoBufferingFrom int64 = math.MaxInt64

type copyCtl struct {
	ctx  context.Context
	o    *CopyOptions
	last int64
	// atime is set on the copy through the handle CopyFileExW writes with,
	// once all bytes are written (it keeps attributes and the modification
	// time itself), which saves reopening every file.
	atime    windows.Filetime
	timesSet bool
	// stopped is the gate's error when it ended the copy.
	stopped error
}

func copyProgressRoutine(total, transferred, streamSize, streamTransferred, streamNo, reason, hSrc, hDst, data uintptr) uintptr {
	ctlMu.Lock()
	c := ctls[data]
	ctlMu.Unlock()
	if c == nil {
		return progressContinue
	}
	done := int64(transferred)
	if d := done - c.last; d > 0 {
		c.o.progress(d)
		c.last = done
	}
	if !c.timesSet && hDst != 0 && done == int64(total) {
		c.timesSet = windows.SetFileTime(windows.Handle(hDst), nil, &c.atime, nil) == nil
	}
	if err := c.o.gate(c.ctx); err != nil {
		c.stopped = err
		return progressCancel
	}
	return progressContinue
}

// fastCopy copies with CopyFileExW. It reports done=false (and no error)
// when the portable copy should run instead, after removing what it wrote;
// preserved when times and attributes are already right.
func fastCopy(ctx context.Context, src string, in fs.FileInfo, target string, o *CopyOptions) (done, preserved bool, err error) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		return false, false, nil // the progress routine passes 64-bit sizes in single words
	}
	s, err := windows.UTF16PtrFromString(LongPath(src))
	if err != nil {
		return false, false, nil
	}
	t, err := windows.UTF16PtrFromString(LongPath(target))
	if err != nil {
		return false, false, nil
	}
	c := &copyCtl{ctx: ctx, o: o, atime: windows.NsecToFiletime(in.ModTime().UnixNano())}
	if d, ok := in.Sys().(*syscall.Win32FileAttributeData); ok {
		c.atime = windows.Filetime{LowDateTime: d.LastAccessTime.LowDateTime, HighDateTime: d.LastAccessTime.HighDateTime}
	}
	ctlMu.Lock()
	nextCtl++
	id := nextCtl
	ctls[id] = c
	ctlMu.Unlock()
	defer func() {
		ctlMu.Lock()
		delete(ctls, id)
		ctlMu.Unlock()
	}()
	flags := uintptr(copyFileFailIfExists)
	if in.Size() >= NoBufferingFrom {
		flags |= copyFileNoBuffering
	}
	r, _, callErr := procCopyFileExW.Call(uintptr(unsafe.Pointer(s)), uintptr(unsafe.Pointer(t)),
		progressRoutine, id, 0, flags)
	if r != 0 {
		return true, c.timesSet, nil
	}
	switch {
	case c.stopped != nil:
		_ = forceRemove(target)
		return true, false, c.stopped
	case errors.Is(callErr, windows.ERROR_REQUEST_ABORTED):
		_ = forceRemove(target)
		return true, false, ctx.Err()
	case errors.Is(callErr, windows.ERROR_FILE_EXISTS), errors.Is(callErr, windows.ERROR_ALREADY_EXISTS),
		errors.Is(callErr, windows.ERROR_DISK_FULL), errors.Is(callErr, windows.ERROR_HANDLE_DISK_FULL),
		errors.Is(callErr, windows.ERROR_SHARING_VIOLATION), errors.Is(callErr, windows.ERROR_LOCK_VIOLATION),
		errors.Is(callErr, windows.ERROR_ACCESS_DENIED), errors.Is(callErr, windows.ERROR_FILE_NOT_FOUND),
		errors.Is(callErr, windows.ERROR_PATH_NOT_FOUND):
		// The portable copy would fail the same way.
		if !errors.Is(callErr, windows.ERROR_FILE_EXISTS) && !errors.Is(callErr, windows.ERROR_ALREADY_EXISTS) {
			_ = forceRemove(target)
		}
		return true, false, &os.PathError{Op: "copy", Path: src, Err: callErr}
	}
	// Anything else (a network share without the fast path): portable copy,
	// with the bytes reported so far taken back.
	_ = forceRemove(target)
	if o != nil && o.Progress != nil && c.last > 0 {
		o.Progress(-c.last)
	}
	return false, false, nil
}

// commitWaits are the pauses before a commit is tried again. A file that was
// just written is often opened for a moment by a virus scanner or the search
// indexer; the rename then fails with a sharing violation that is gone a few
// milliseconds later. A batch of thousands of files meets that moment sooner
// or later (Stage 16), so the commit waits it out, for at most 410 ms.
var commitWaits = []time.Duration{5 * time.Millisecond, 15 * time.Millisecond, 40 * time.Millisecond,
	100 * time.Millisecond, 250 * time.Millisecond}

// renameNoReplace commits a partial copy atomically, failing when dst
// exists (MoveFileEx without MOVEFILE_REPLACE_EXISTING).
func renameNoReplace(partial, dst string) error {
	return commitRename(partial, dst, 0)
}

// renameReplace commits a partial copy over an existing dst.
func renameReplace(partial, dst string) error {
	return commitRename(partial, dst, windows.MOVEFILE_REPLACE_EXISTING)
}

func commitRename(partial, dst string, flags uint32) error {
	p, err := windows.UTF16PtrFromString(LongPath(partial))
	if err != nil {
		return err
	}
	d, err := windows.UTF16PtrFromString(LongPath(dst))
	if err != nil {
		return err
	}
	err = windows.MoveFileEx(p, d, flags)
	for _, wait := range commitWaits {
		// Only the partial file being held is waited for: nothing else of a
		// commit is transient.
		if err == nil || !held(err) {
			break
		}
		time.Sleep(wait)
		err = windows.MoveFileEx(p, d, flags)
	}
	if err != nil {
		if errors.Is(err, windows.ERROR_ALREADY_EXISTS) || errors.Is(err, windows.ERROR_FILE_EXISTS) {
			return Errorf(CodeExists, "%s already exists", filepath.Base(dst))
		}
		return &os.LinkError{Op: "rename", Old: partial, New: dst, Err: err}
	}
	return nil
}

// held reports a commit refused only for a moment. Besides a sharing
// violation, a copy that carries the mark of the web (a Zone.Identifier
// stream, kept by CopyFileExW) can be refused as ACCESS_DENIED right after it
// is written: in a folder with extra permission entries every such commit
// was, for 8 to 32 ms whatever the size (1 KB to 200 MB, Defender on). A
// lasting denial still fails, after the bound.
func held(err error) bool {
	return isInUse(err) || errors.Is(err, windows.ERROR_ACCESS_DENIED)
}

const preservedAttrs = windows.FILE_ATTRIBUTE_READONLY | windows.FILE_ATTRIBUTE_HIDDEN | windows.FILE_ATTRIBUTE_SYSTEM

// preserve sets target's modification and access times and its read-only,
// hidden and system attributes to src's (CopyFileExW keeps the attributes,
// the portable copy does not; neither keeps the access time).
func preserve(src string, in fs.FileInfo, target string) error {
	p, err := windows.UTF16PtrFromString(LongPath(src))
	if err != nil {
		return err
	}
	attrs, err := windows.GetFileAttributes(p)
	if err != nil {
		return err
	}
	atime := in.ModTime()
	if d, ok := in.Sys().(*syscall.Win32FileAttributeData); ok {
		atime = time.Unix(0, d.LastAccessTime.Nanoseconds())
	}
	tp, err := windows.UTF16PtrFromString(LongPath(target))
	if err != nil {
		return err
	}
	// Times need write access: clear read-only first, set the attributes last.
	_ = windows.SetFileAttributes(tp, windows.FILE_ATTRIBUTE_NORMAL)
	if err := os.Chtimes(target, atime, in.ModTime()); err != nil {
		return err
	}
	if keep := attrs & preservedAttrs; keep != 0 {
		return windows.SetFileAttributes(tp, keep)
	}
	return nil
}

// clearReadOnly drops the read-only attribute, so the item can be replaced
// or removed.
func clearReadOnly(path string) {
	p, err := windows.UTF16PtrFromString(LongPath(path))
	if err != nil {
		return
	}
	attrs, err := windows.GetFileAttributes(p)
	if err == nil && attrs&windows.FILE_ATTRIBUTE_READONLY != 0 {
		_ = windows.SetFileAttributes(p, attrs&^windows.FILE_ATTRIBUTE_READONLY)
	}
}

// LongPath prefixes a long absolute path with \\?\ (or \\?\UNC\) for the
// Win32 calls made here directly; the os package does this itself.
func LongPath(p string) string {
	if len(p) < 248 || strings.HasPrefix(p, `\\?\`) {
		return p
	}
	if strings.HasPrefix(p, `\\`) {
		return `\\?\UNC\` + p[2:]
	}
	return `\\?\` + p
}

func linkHint(err error) string {
	if errors.Is(err, windows.ERROR_PRIVILEGE_NOT_HELD) {
		return "Windows allows it only with Developer Mode on or as administrator"
	}
	return err.Error()
}
