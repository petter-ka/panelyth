//go:build !windows

package archive

import "os/exec"

func hideWindow(*exec.Cmd) {}
