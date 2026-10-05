//go:build windows

package fsx

import (
	"io/fs"
	"testing"

	"golang.org/x/sys/windows"
)

func TestUnavailable(t *testing.T) {
	cases := map[error]string{
		&fs.PathError{Op: "stat", Path: `E:\`, Err: windows.ERROR_NOT_READY}:      "notReady",
		&fs.PathError{Op: "stat", Path: `\nas\x`, Err: windows.ERROR_BAD_NETPATH}: "network",
		&fs.PathError{Op: "stat", Path: `C:\x`, Err: windows.ERROR_ACCESS_DENIED}: "",
		fs.ErrNotExist: "",
	}
	for err, want := range cases {
		if got := Unavailable(err); got != want {
			t.Errorf("%v: got %q want %q", err, got, want)
		}
	}
}
