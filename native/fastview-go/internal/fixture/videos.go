package fixture

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
)

// VideoSpec describes a synthetic test video made with ffmpeg's lavfi
// sources (tests skip when ffmpeg is not installed).
type VideoSpec struct {
	Width, Height int
	Seconds       float64
	// Codec is an ffmpeg encoder ("libx264", "libvpx-vp9", "mpeg4", ...).
	Codec string
	// Audio adds a sine tone (AAC for mp4/mov, Opus for webm, MP3 otherwise).
	Audio bool
	// Rotate writes a display-matrix rotation (degrees, mp4/mov only).
	Rotate int
}

// GenerateVideo writes path (container from its extension).
func GenerateVideo(ffmpeg, path string, s VideoSpec) error {
	args := []string{"-nostdin", "-v", "error", "-y",
		"-f", "lavfi", "-i", fmt.Sprintf("testsrc2=size=%dx%d:rate=25:duration=%s", s.Width, s.Height, strconv.FormatFloat(s.Seconds, 'f', 2, 64))}
	if s.Audio {
		args = append(args, "-f", "lavfi", "-i", "sine=frequency=440:duration="+strconv.FormatFloat(s.Seconds, 'f', 2, 64))
	}
	codec := s.Codec
	if codec == "" {
		codec = "libx264"
	}
	args = append(args, "-c:v", codec, "-pix_fmt", "yuv420p")
	if codec == "libx264" {
		args = append(args, "-preset", "ultrafast")
	}
	if s.Audio {
		switch ext := Ext(path); ext {
		case "webm":
			args = append(args, "-c:a", "libopus")
		case "mp4", "m4v", "mov":
			args = append(args, "-c:a", "aac")
		default:
			args = append(args, "-c:a", "libmp3lame")
		}
	}
	if s.Rotate == 0 {
		return ffmpegRun(ffmpeg, append(args, path)...)
	}
	// Rotation metadata: encode, then remux with a display matrix (stream
	// copy keeps the stored pixels unrotated, as phones write them).
	tmp := path + ".tmp." + Ext(path)
	if err := ffmpegRun(ffmpeg, append(args, tmp)...); err != nil {
		return err
	}
	defer os.Remove(tmp)
	return ffmpegRun(ffmpeg, "-nostdin", "-v", "error", "-y", "-display_rotation", strconv.Itoa(s.Rotate),
		"-i", tmp, "-c", "copy", path)
}

func ffmpegRun(ffmpeg string, args ...string) error {
	out, err := exec.Command(ffmpeg, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg: %v: %s", err, out)
	}
	return nil
}

// Ext returns the lowercase extension of path without the dot.
func Ext(path string) string {
	for i := len(path) - 1; i >= 0 && path[i] != '/' && path[i] != '\\'; i-- {
		if path[i] == '.' {
			ext := []byte(path[i+1:])
			for j, c := range ext {
				if 'A' <= c && c <= 'Z' {
					ext[j] = c + 32
				}
			}
			return string(ext)
		}
	}
	return ""
}
