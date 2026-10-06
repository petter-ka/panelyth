package fsx

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestVolumeInfo(t *testing.T) {
	dir := t.TempDir()
	if VolumeID(dir) == "" || VolumeID(dir) != VolumeID(filepath.Join(dir, "not-yet")) {
		t.Errorf("volume id %q", VolumeID(dir))
	}
	if runtime.GOOS == "windows" && !WindowsNames(dir) {
		t.Error("Windows volumes use Windows names")
	}
	// The answers depend on the machine; logged for the stage record.
	t.Logf("%s: rotational=%v windowsNames=%v", dir, IsRotational(dir), WindowsNames(dir))
	if runtime.GOOS == "windows" {
		for _, d := range []string{`C:\`, `D:\`, `E:\`} {
			if _, err := os.Stat(d); err == nil {
				t.Logf("%s rotational=%v", d, IsRotational(d))
			}
		}
	}
}
