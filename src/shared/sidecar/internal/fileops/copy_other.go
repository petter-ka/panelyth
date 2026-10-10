//go:build !windows && !linux && !darwin

package fileops

import (
	"context"
	"io/fs"
)

// fastCopy: no fast path here; the portable copy runs.
func fastCopy(context.Context, string, fs.FileInfo, string, *CopyOptions) (bool, bool, error) {
	return false, false, nil
}
