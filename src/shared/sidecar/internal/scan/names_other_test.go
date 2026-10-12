//go:build !windows

package scan

import "testing"

// makeCaseSensitive: a folder cannot be switched here; on macOS the test
// runs only where the temp folder is on a case-sensitive volume.
func makeCaseSensitive(*testing.T, string) bool { return true }
