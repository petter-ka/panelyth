package archive

import (
	"errors"
	"path/filepath"
	"testing"

	"panelyth/sidecar/internal/platform"
)

// host is a finder over a set of files and a PATH of program names, so the
// rules of each OS run on any machine (Stage P04).
func host(goos string, env, onPath map[string]string, files ...string) platform.ToolFinder {
	set := map[string]bool{}
	for _, f := range files {
		set[filepath.Clean(f)] = true
	}
	return platform.ToolFinder{
		GOOS:    goos,
		Getenv:  func(k string) string { return env[k] },
		SelfDir: filepath.Join("app", "bin"),
		LookPath: func(n string) (string, error) {
			if p, ok := onPath[n]; ok {
				return p, nil
			}
			return "", errors.New("not found")
		},
		IsFile: func(p string) bool { return set[filepath.Clean(p)] },
	}
}

func TestLocateToolPerOS(t *testing.T) {
	custom := filepath.Join("tools", "7zz")
	programFiles := map[string]string{"ProgramFiles": `C:\Program Files`}
	installed := filepath.Join(`C:\Program Files`, "7-Zip", "7z.exe")
	cases := []struct {
		name string
		f    platform.ToolFinder
		want string
	}{
		{"off disables the tool even when it is installed",
			host("linux", map[string]string{"PANELYTH_7Z": "off"}, map[string]string{"7z": "/usr/bin/7z"}), ""},
		{"the variable names the program",
			host("darwin", map[string]string{"PANELYTH_7Z": custom}, nil, custom), custom},
		{"a wrong path in the variable does not fall back to PATH",
			host("linux", map[string]string{"PANELYTH_7Z": custom}, map[string]string{"7z": "/usr/bin/7z"}), ""},
		{"packaged: beside the sidecar wins over PATH",
			host("linux", nil, map[string]string{"7z": "/usr/bin/7z"}, filepath.Join("app", "bin", "7zz")), filepath.Join("app", "bin", "7zz")},
		{"packaged on Windows",
			host("windows", nil, nil, filepath.Join("app", "bin", "7za.exe")), filepath.Join("app", "bin", "7za.exe")},
		{"Linux: p7zip's 7z on PATH",
			host("linux", nil, map[string]string{"7z": "/usr/bin/7z"}), "/usr/bin/7z"},
		{"Linux: only the standalone 7zz",
			host("linux", nil, map[string]string{"7zz": "/usr/bin/7zz"}), "/usr/bin/7zz"},
		{"macOS started from the Finder: Homebrew's 7zz is not on PATH",
			host("darwin", nil, nil, filepath.Join("/opt/homebrew/bin", "7zz")), filepath.Join("/opt/homebrew/bin", "7zz")},
		{"Windows: the installer adds nothing to PATH",
			host("windows", programFiles, nil, installed), installed},
		{"Windows: PATH wins over the installer's folder",
			host("windows", programFiles, map[string]string{"7z": `D:\tools\7z.exe`}, installed), `D:\tools\7z.exe`},
		{"nothing installed", host("windows", programFiles, nil), ""},
	}
	for _, c := range cases {
		got := locateTool(c.f)
		if got.Path != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got.Path, c.want)
		}
		if got.Available() != (c.want != "") {
			t.Errorf("%s: available = %v", c.name, got.Available())
		}
	}
}
