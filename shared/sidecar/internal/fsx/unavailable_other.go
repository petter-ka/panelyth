//go:build !windows

package fsx

import (
	"errors"
	"syscall"
)

// Unavailable classifies errors of a volume that is there but cannot be read
// right now (CFR-28): "notReady", "network" or "".
func Unavailable(err error) string {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return ""
	}
	switch errno {
	case errNoMedium:
		return "notReady"
	case syscall.EHOSTDOWN, syscall.EHOSTUNREACH, syscall.ENETUNREACH, syscall.ESTALE:
		return "network"
	}
	return ""
}
