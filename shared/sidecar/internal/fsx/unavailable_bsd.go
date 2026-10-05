//go:build !windows && !linux

package fsx

import "syscall"

// No "no medium" errno outside Linux; ENODEV is the closest on macOS.
const errNoMedium = syscall.ENODEV
