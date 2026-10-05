//go:build !windows

package fsx

import (
	"io/fs"
	"syscall"
	"testing"
)

func TestUnavailable(t *testing.T) {
	cases := map[error]string{
		&fs.PathError{Op: "stat", Path: "/media/card", Err: errNoMedium}:    "notReady",
		&fs.PathError{Op: "stat", Path: "/mnt/nas", Err: syscall.EHOSTDOWN}: "network",
		&fs.PathError{Op: "stat", Path: "/root", Err: syscall.EACCES}:       "",
		fs.ErrNotExist: "",
	}
	for err, want := range cases {
		if got := Unavailable(err); got != want {
			t.Errorf("%v: got %q want %q", err, got, want)
		}
	}
}
