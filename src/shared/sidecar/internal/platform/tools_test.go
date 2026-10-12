package platform

import (
	"errors"
	"path/filepath"
	"testing"
)

// fakeHost is a finder over a set of files and a PATH of program names.
func fakeHost(goos string, env map[string]string, onPath map[string]string, files ...string) ToolFinder {
	set := map[string]bool{}
	for _, f := range files {
		set[filepath.Clean(f)] = true
	}
	return ToolFinder{
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

func TestToolFinderExeAndBeside(t *testing.T) {
	win := fakeHost("windows", nil, nil, filepath.Join("app", "bin", "ffmpeg.exe"), filepath.Join("app", "bin", "ffprobe"))
	if got := win.Beside("ffmpeg"); got != filepath.Join("app", "bin", "ffmpeg.exe") {
		t.Errorf("windows beside: %q", got)
	}
	if got := win.Beside("ffprobe"); got != "" {
		t.Errorf("windows: a program without .exe was taken: %q", got)
	}
	mac := fakeHost("darwin", nil, nil, filepath.Join("app", "bin", "ffmpeg"))
	if got := mac.Beside("ffmpeg"); got != filepath.Join("app", "bin", "ffmpeg") {
		t.Errorf("darwin beside: %q", got)
	}
	mac.SelfDir = ""
	if got := mac.Beside("ffmpeg"); got != "" {
		t.Errorf("unknown executable folder: %q", got)
	}
}

func TestToolFinderInstalled(t *testing.T) {
	brew := filepath.Join("/opt/homebrew/bin", "7zz")
	intel := filepath.Join("/usr/local/bin", "7z")
	cases := []struct {
		name string
		f    ToolFinder
		want string
	}{
		{"PATH wins over the install folders",
			fakeHost("darwin", nil, map[string]string{"7zz": "/custom/7zz"}, brew), "/custom/7zz"},
		{"the first name on PATH wins",
			fakeHost("linux", nil, map[string]string{"7za": "/usr/bin/7za", "7z": "/usr/bin/7z"}), "/usr/bin/7z"},
		{"macOS started from the Finder: Homebrew on Apple silicon",
			fakeHost("darwin", nil, nil, brew), brew},
		{"macOS: an earlier folder wins over an earlier name",
			fakeHost("darwin", nil, nil, brew, intel), brew},
		{"macOS: Homebrew on Intel",
			fakeHost("darwin", nil, nil, intel), intel},
		{"macOS: MacPorts",
			fakeHost("darwin", nil, nil, filepath.Join("/opt/local/bin", "7za")), filepath.Join("/opt/local/bin", "7za")},
		{"Linux: snap",
			fakeHost("linux", nil, nil, filepath.Join("/snap/bin", "7z")), filepath.Join("/snap/bin", "7z")},
		{"Linux does not look in Homebrew's folder",
			fakeHost("linux", nil, nil, brew), ""},
		{"Windows: the installer's folder",
			fakeHost("windows", map[string]string{"ProgramFiles": `C:\Program Files`}, nil, filepath.Join(`C:\Program Files`, "7-Zip", "7z.exe")),
			filepath.Join(`C:\Program Files`, "7-Zip", "7z.exe")},
		{"Windows: the 32-bit installer's folder",
			fakeHost("windows", map[string]string{"ProgramFiles": `C:\Program Files`, "ProgramFiles(x86)": `C:\Program Files (x86)`}, nil,
				filepath.Join(`C:\Program Files (x86)`, "7-Zip", "7z.exe")),
			filepath.Join(`C:\Program Files (x86)`, "7-Zip", "7z.exe")},
		{"Windows without ProgramFiles in the environment",
			fakeHost("windows", nil, nil, filepath.Join("7-Zip", "7z.exe")), ""},
		{"nothing installed", fakeHost("darwin", nil, nil), ""},
	}
	for _, c := range cases {
		if got := c.f.Installed([]string{"7z", "7zz", "7za"}, "7-Zip"); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestHostTools(t *testing.T) {
	f := HostTools(func(string) string { return "" })
	if f.SelfDir == "" || f.File(f.SelfDir) != "" {
		t.Errorf("self dir %q must be a folder", f.SelfDir)
	}
	if got := f.Installed([]string{"panelyth-no-such-tool"}); got != "" {
		t.Errorf("found %q", got)
	}
}
