//go:build windows

package main

import "fastview/sidecar/internal/fileops"

func setNoBuffering(mb int) {
	if mb >= 0 {
		fileops.NoBufferingFrom = int64(mb) << 20
	}
}

func noBufferingMB() int { return int(fileops.NoBufferingFrom >> 20) }
