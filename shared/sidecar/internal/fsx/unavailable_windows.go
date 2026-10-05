//go:build windows

package fsx

import (
	"errors"

	"golang.org/x/sys/windows"
)

// Unavailable classifies errors of a volume that is there but cannot be read
// right now (CFR-28): "notReady" (an empty card reader or optical drive, a
// removed device), "network" (an unreachable share) or "".
func Unavailable(err error) string {
	var errno windows.Errno
	if !errors.As(err, &errno) {
		return ""
	}
	switch errno {
	case windows.ERROR_NOT_READY, windows.ERROR_DEVICE_NOT_CONNECTED:
		return "notReady"
	case windows.ERROR_BAD_NETPATH, windows.ERROR_BAD_NET_NAME, windows.ERROR_NETNAME_DELETED,
		windows.ERROR_UNEXP_NET_ERR, windows.ERROR_NETWORK_UNREACHABLE, windows.ERROR_HOST_UNREACHABLE,
		windows.ERROR_NO_NET_OR_BAD_PATH:
		return "network"
	}
	return ""
}
