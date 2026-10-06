//go:build !windows

package fileops

import (
	"errors"
	"syscall"
)

func isNoSpace(err error) bool { return errors.Is(err, syscall.ENOSPC) }

func isInUse(err error) bool { return errors.Is(err, syscall.EBUSY) || errors.Is(err, syscall.ETXTBSY) }

func isCrossDevice(err error) bool { return errors.Is(err, syscall.EXDEV) }

// errCrossDevice is what a rename across volumes fails with (tests).
var errCrossDevice error = syscall.EXDEV
