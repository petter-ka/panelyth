package video

import (
	"errors"
	"os"
	"os/exec"
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

func TestLocatePerOS(t *testing.T) {
	beside := func(n string) string { return filepath.Join("app", "bin", n) }
	brew := func(n string) string { return filepath.Join("/opt/homebrew/bin", n) }
	custom := filepath.Join("tools", "ffmpeg")
	cases := []struct {
		name            string
		f               platform.ToolFinder
		ffmpeg, ffprobe string
	}{
		{"off disables the tools even when they are installed",
			host("linux", map[string]string{"PANELYTH_FFMPEG": "off"}, map[string]string{"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe"}), "", ""},
		{"the variable names ffmpeg; ffprobe is its sibling",
			host("linux", map[string]string{"PANELYTH_FFMPEG": custom}, nil, custom, filepath.Join("tools", "ffprobe")),
			custom, filepath.Join("tools", "ffprobe")},
		{"Windows: the sibling is ffprobe.exe",
			host("windows", map[string]string{"PANELYTH_FFMPEG": custom + ".exe"}, nil, custom+".exe", filepath.Join("tools", "ffprobe.exe")),
			custom + ".exe", filepath.Join("tools", "ffprobe.exe")},
		{"a wrong path in the variable does not fall back to PATH",
			host("darwin", map[string]string{"PANELYTH_FFMPEG": custom}, map[string]string{"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe"}), "", ""},
		{"packaged: both beside the sidecar win over PATH",
			host("linux", nil, map[string]string{"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe"}, beside("ffmpeg"), beside("ffprobe")),
			beside("ffmpeg"), beside("ffprobe")},
		{"packaged on Windows",
			host("windows", nil, nil, beside("ffmpeg.exe"), beside("ffprobe.exe")), beside("ffmpeg.exe"), beside("ffprobe.exe")},
		{"half a packaged pair is not mixed with the system's",
			host("linux", nil, map[string]string{"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe"}, beside("ffmpeg")),
			"/usr/bin/ffmpeg", "/usr/bin/ffprobe"},
		{"macOS started from the Finder: Homebrew is not on PATH",
			host("darwin", nil, nil, brew("ffmpeg"), brew("ffprobe")), brew("ffmpeg"), brew("ffprobe")},
		{"macOS on Intel",
			host("darwin", nil, nil, filepath.Join("/usr/local/bin", "ffmpeg"), filepath.Join("/usr/local/bin", "ffprobe")),
			filepath.Join("/usr/local/bin", "ffmpeg"), filepath.Join("/usr/local/bin", "ffprobe")},
		{"Linux: snap",
			host("linux", nil, nil, filepath.Join("/snap/bin", "ffmpeg"), filepath.Join("/snap/bin", "ffprobe")),
			filepath.Join("/snap/bin", "ffmpeg"), filepath.Join("/snap/bin", "ffprobe")},
		{"nothing installed", host("windows", nil, nil), "", ""},
	}
	for _, c := range cases {
		got := locate(c.f)
		if got.FFmpeg != c.ffmpeg || got.FFprobe != c.ffprobe {
			t.Errorf("%s: ffmpeg %q, ffprobe %q", c.name, got.FFmpeg, got.FFprobe)
		}
		if got.Available() != (c.ffmpeg != "" && c.ffprobe != "") {
			t.Errorf("%s: available = %v", c.name, got.Available())
		}
	}
	// ffmpeg alone is not enough: posters need the probe.
	if locate(host("linux", nil, map[string]string{"ffmpeg": "/usr/bin/ffmpeg"})).Available() {
		t.Error("ffmpeg without ffprobe counts as available")
	}
}

// On this machine: what a shell finds, the sidecar finds too.
func TestLocateOnThisMachine(t *testing.T) {
	got := Locate(func(k string) string {
		if k == "PANELYTH_FFMPEG" {
			return ""
		}
		return os.Getenv(k)
	})
	t.Logf("ffmpeg %q, ffprobe %q", got.FFmpeg, got.FFprobe)
	for name, found := range map[string]string{"ffmpeg": got.FFmpeg, "ffprobe": got.FFprobe} {
		if p, err := exec.LookPath(name); err == nil && found == "" {
			t.Errorf("%s is on PATH (%s) but was not found", name, p)
		}
	}
}
