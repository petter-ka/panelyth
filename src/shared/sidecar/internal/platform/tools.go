package platform

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// ToolFinder locates optional external tools (ffmpeg and ffprobe, ADR-0018;
// 7-Zip, ADR-0030) the same way on every OS (Stage P04). The fields are
// what a search depends on, so the rules of each OS are tested on any host.
type ToolFinder struct {
	GOOS   string
	Getenv func(string) string
	// SelfDir is the folder of the sidecar executable (packaged builds ship
	// tools there); "" when unknown.
	SelfDir  string
	LookPath func(string) (string, error)
	IsFile   func(string) bool
}

// HostTools is the finder for this process.
func HostTools(getenv func(string) string) ToolFinder {
	f := ToolFinder{GOOS: runtime.GOOS, Getenv: getenv, LookPath: exec.LookPath, IsFile: isFile}
	if self, err := os.Executable(); err == nil {
		f.SelfDir = filepath.Dir(self)
	}
	return f
}

func isFile(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}

// Exe is the file name of a program: "ffmpeg.exe" on Windows.
func (f ToolFinder) Exe(name string) string {
	if f.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

// File returns p when it is an existing file, "" otherwise.
func (f ToolFinder) File(p string) string {
	if p != "" && f.IsFile(p) {
		return p
	}
	return ""
}

// Beside looks for a program next to the sidecar executable.
func (f ToolFinder) Beside(name string) string {
	if f.SelfDir == "" {
		return ""
	}
	return f.File(filepath.Join(f.SelfDir, f.Exe(name)))
}

// Installed looks for the first of names on PATH, then in the folders
// where the OS's package managers put programs. An app started from the
// Finder or the Dock gets launchd's PATH, which has neither Homebrew nor
// MacPorts; a Windows installer such as 7-Zip's adds nothing to PATH.
func (f ToolFinder) Installed(names []string, windowsFolders ...string) string {
	for _, n := range names {
		if p, err := f.LookPath(n); err == nil && p != "" {
			return p
		}
	}
	for _, dir := range f.installDirs(windowsFolders) {
		for _, n := range names {
			if p := f.File(filepath.Join(dir, f.Exe(n))); p != "" {
				return p
			}
		}
	}
	return ""
}

func (f ToolFinder) installDirs(windowsFolders []string) []string {
	switch f.GOOS {
	case "darwin":
		// Homebrew on Apple silicon, Homebrew on Intel, MacPorts.
		return []string{"/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"}
	case "windows":
		var out []string
		for _, base := range []string{f.Getenv("ProgramFiles"), f.Getenv("ProgramFiles(x86)")} {
			if base == "" {
				continue
			}
			for _, folder := range windowsFolders {
				out = append(out, filepath.Join(base, folder))
			}
		}
		return out
	default:
		// A desktop launcher's PATH can lack these on some distributions.
		return []string{"/usr/local/bin", "/snap/bin"}
	}
}
