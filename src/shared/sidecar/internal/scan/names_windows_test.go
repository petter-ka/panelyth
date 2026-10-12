//go:build windows

package scan

import (
	"os/exec"
	"testing"
)

// makeCaseSensitive marks a folder case-sensitive (the per-folder flag WSL
// uses). It needs the Windows Subsystem for Linux feature.
func makeCaseSensitive(t *testing.T, dir string) bool {
	t.Helper()
	out, err := exec.Command("fsutil.exe", "file", "setCaseSensitiveInfo", dir, "enable").CombinedOutput()
	if err != nil {
		t.Logf("fsutil: %v: %s", err, out)
		return false
	}
	return true
}
