package jobs

import (
	"os"
	"runtime"
	"testing"

	"fastview/sidecar/internal/fileops"
)

// TestMain: these tests cover the job engine (pause and cancel mid-file,
// progress, conflicts). On APFS the fast path is a clone, one instant step
// with nothing to pause or cancel, so macOS runs them on the streaming copy;
// the clone itself is tested in fileops.
func TestMain(m *testing.M) {
	if runtime.GOOS == "darwin" {
		fileops.ForcePortableCopy()
	}
	os.Exit(m.Run())
}
