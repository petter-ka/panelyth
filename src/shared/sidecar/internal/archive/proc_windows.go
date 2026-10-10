package archive

import (
	"os/exec"
	"syscall"
)

// The sidecar has no console; without CREATE_NO_WINDOW every ffmpeg run
// would flash a console window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
