//go:build !windows && !linux && !darwin

package fsx

func isRotational(string) bool { return false }

// WindowsNames: unknown filesystems use their platform's rules.
func WindowsNames(string) bool { return false }
