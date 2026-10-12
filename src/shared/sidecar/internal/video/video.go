// Package video probes video files and extracts poster frames through
// ffprobe/ffmpeg subprocesses (ADR-0018). The sidecar stays CGO_ENABLED=0
// (ADR-0019): the tools are separate executables found at runtime, and
// everything degrades gracefully when they are missing (playback itself is
// Chromium's job, ADR-0009).
package video

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"panelyth/sidecar/internal/platform"
)

var (
	// ErrUnavailable means ffmpeg/ffprobe were not found. Not a property of
	// the file: nothing about it may be cached.
	ErrUnavailable = errors.New("video: ffmpeg/ffprobe not available")
	// ErrCorrupt means ffprobe could not read the container.
	ErrCorrupt = errors.New("video: unreadable container")
	// ErrNoVideo means the file has no decodable video stream (audio only,
	// or a codec this ffmpeg build cannot decode).
	ErrNoVideo = errors.New("video: no decodable video stream")
	// ErrTimeout means a tool ran longer than its limit (slow network
	// share, pathological file). Worth retrying later.
	ErrTimeout = errors.New("video: tool timed out")
)

const (
	probeTimeout = 10 * time.Second
	frameTimeout = 20 * time.Second
	// maxFrameBytes bounds what is read from ffmpeg's stdout (a 2560 px RGB
	// PNG is well below this).
	maxFrameBytes = 64 << 20
	// maxProbeBytes bounds ffprobe's JSON output.
	maxProbeBytes  = 1 << 20
	probeCacheSize = 512
	// maxConcurrentProbes bounds ffprobe processes started by media.resolve
	// (a user holding an arrow key must not fork a process per step).
	maxConcurrentProbes = 2
)

// Info is what ffprobe reports about a file.
type Info struct {
	DurationMs int64
	// Display size (rotation applied); 0 when there is no video stream.
	Width, Height int
	VideoCodec    string
	AudioCodec    string
}

// Tools runs ffprobe/ffmpeg. The zero value (and nil) is "unavailable".
type Tools struct {
	FFmpeg  string
	FFprobe string

	probeSem chan struct{}
	mu       sync.Mutex
	cache    map[string]*cacheEntry
	order    []string // insertion order for eviction (bounded)
}

type cacheEntry struct {
	info Info
	err  error
}

// New returns tools for explicit executable paths ("" for missing).
func New(ffmpeg, ffprobe string) *Tools {
	return &Tools{FFmpeg: ffmpeg, FFprobe: ffprobe, probeSem: make(chan struct{}, maxConcurrentProbes),
		cache: map[string]*cacheEntry{}}
}

// Locate finds the tools: PANELYTH_FFMPEG (path to ffmpeg, ffprobe is its
// sibling; "off" disables video tools), then next to the sidecar executable
// (packaged builds), then PATH and the folders package managers install to
// (platform.ToolFinder).
func Locate(getenv func(string) string) *Tools {
	return locate(platform.HostTools(getenv))
}

func locate(f platform.ToolFinder) *Tools {
	if v := f.Getenv("PANELYTH_FFMPEG"); v != "" {
		if v == "off" {
			return New("", "")
		}
		return New(f.File(v), f.File(filepath.Join(filepath.Dir(v), f.Exe("ffprobe"))))
	}
	// A packaged pair is used only when it is complete: ffmpeg from the
	// package beside an ffprobe of another version reads files differently.
	if ff, fp := f.Beside("ffmpeg"), f.Beside("ffprobe"); ff != "" && fp != "" {
		return New(ff, fp)
	}
	return New(f.Installed([]string{"ffmpeg"}), f.Installed([]string{"ffprobe"}))
}

// Available reports whether posters and probing work.
func (t *Tools) Available() bool { return t != nil && t.FFmpeg != "" && t.FFprobe != "" }

// Probe reads duration, display size and codecs. Results are cached per
// source identity (path + size + mtime), so a poster job and media.resolve
// for the same file run ffprobe once.
func (t *Tools) Probe(ctx context.Context, path string, size, mtimeNs int64) (Info, error) {
	if !t.Available() {
		return Info{}, ErrUnavailable
	}
	key := path + "\x00" + strconv.FormatInt(size, 10) + "\x00" + strconv.FormatInt(mtimeNs, 10)
	t.mu.Lock()
	if e, ok := t.cache[key]; ok {
		t.mu.Unlock()
		return e.info, e.err
	}
	t.mu.Unlock()

	select {
	case t.probeSem <- struct{}{}:
	case <-ctx.Done():
		return Info{}, ctx.Err()
	}
	info, err := t.probe(ctx, path)
	<-t.probeSem
	if ctx.Err() != nil || errors.Is(err, ErrTimeout) {
		return info, err // not a property of the file
	}
	t.mu.Lock()
	if _, ok := t.cache[key]; !ok {
		t.cache[key] = &cacheEntry{info: info, err: err}
		t.order = append(t.order, key)
		for len(t.order) > probeCacheSize {
			delete(t.cache, t.order[0])
			t.order = t.order[1:]
		}
	}
	t.mu.Unlock()
	return info, err
}

type probeJSON struct {
	Streams []struct {
		CodecType string `json:"codec_type"`
		CodecName string `json:"codec_name"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
		Duration  string `json:"duration"`
		// Attached pictures (cover art in .mkv/.mp4) are not the video.
		Disposition struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
		Tags struct {
			Rotate string `json:"rotate"`
		} `json:"tags"`
		SideData []struct {
			Rotation float64 `json:"rotation"`
		} `json:"side_data_list"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

func (t *Tools) probe(ctx context.Context, path string) (Info, error) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	out, err := run(ctx, t.FFprobe, maxProbeBytes,
		"-v", "error", "-print_format", "json",
		"-show_entries", "format=duration:stream=codec_type,codec_name,width,height,duration:stream_disposition=attached_pic:stream_tags=rotate:stream_side_data=rotation",
		"-i", path)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return Info{}, ErrTimeout
		}
		if ctx.Err() != nil {
			return Info{}, ctx.Err()
		}
		return Info{}, fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	return parseProbe(out)
}

func parseProbe(out []byte) (Info, error) {
	var pj probeJSON
	if err := json.Unmarshal(out, &pj); err != nil {
		return Info{}, fmt.Errorf("%w: ffprobe output: %v", ErrCorrupt, err)
	}
	var info Info
	streamDur := 0.0
	for _, s := range pj.Streams {
		switch {
		case s.CodecType == "video" && s.Disposition.AttachedPic == 0 && info.VideoCodec == "":
			info.VideoCodec = s.CodecName
			info.Width, info.Height = s.Width, s.Height
			rot := 0.0
			if r, err := strconv.ParseFloat(s.Tags.Rotate, 64); err == nil {
				rot = r
			}
			for _, sd := range s.SideData {
				if sd.Rotation != 0 {
					rot = sd.Rotation
				}
			}
			if q := int(rot) % 180; q == 90 || q == -90 {
				info.Width, info.Height = info.Height, info.Width
			}
			if d, err := strconv.ParseFloat(s.Duration, 64); err == nil {
				streamDur = d
			}
		case s.CodecType == "audio" && info.AudioCodec == "":
			info.AudioCodec = s.CodecName
		}
	}
	dur, err := strconv.ParseFloat(pj.Format.Duration, 64)
	if err != nil || dur <= 0 {
		dur = streamDur
	}
	if dur > 0 {
		info.DurationMs = int64(dur * 1000)
	}
	if info.VideoCodec == "" && info.AudioCodec == "" {
		return info, fmt.Errorf("%w: no audio or video streams", ErrCorrupt)
	}
	return info, nil
}

// PosterTime picks the frame for the poster: 10 % into the video (past
// black intros and fades), at most 10 s in; 0 when the duration is unknown.
func PosterTime(durationMs int64) time.Duration {
	if durationMs <= 0 {
		return 0
	}
	return min(time.Duration(durationMs)*time.Millisecond/10, 10*time.Second)
}

// Frame decodes one frame at `at`, scaled by ffmpeg to fit maxEdge (never
// upscaled) in display orientation. When seeking yields no frame (the
// reported duration was wrong), it falls back to the first frame.
func (t *Tools) Frame(ctx context.Context, path string, at time.Duration, maxEdge int) (image.Image, error) {
	if !t.Available() {
		return nil, ErrUnavailable
	}
	img, err := t.frame(ctx, path, at, maxEdge)
	if errors.Is(err, ErrNoVideo) && at > 0 {
		img, err = t.frame(ctx, path, 0, maxEdge)
	}
	return img, err
}

func (t *Tools) frame(ctx context.Context, path string, at time.Duration, maxEdge int) (image.Image, error) {
	ctx, cancel := context.WithTimeout(ctx, frameTimeout)
	defer cancel()
	edge := strconv.Itoa(maxEdge)
	scale := "scale=w='min(iw," + edge + ")':h='min(ih," + edge + ")':force_original_aspect_ratio=decrease"
	out, err := run(ctx, t.FFmpeg, maxFrameBytes,
		"-nostdin", "-v", "error", "-threads", "1",
		// Input seeking: jumps to the keyframe before `at`, then decodes up to it.
		"-ss", strconv.FormatFloat(at.Seconds(), 'f', 3, 64),
		"-i", path,
		"-map", "0:V:0", "-an", "-sn", "-dn",
		"-frames:v", "1", "-vf", scale,
		"-f", "image2pipe", "-c:v", "png", "-pix_fmt", "rgb24", "pipe:1")
	if ctx.Err() == context.DeadlineExceeded {
		return nil, ErrTimeout
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil || len(out) == 0 {
		// Exit with an error or no frame: no stream ffmpeg can decode.
		return nil, fmt.Errorf("%w: %v", ErrNoVideo, err)
	}
	img, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		return nil, fmt.Errorf("%w: frame output: %v", ErrNoVideo, err)
	}
	return img, nil
}

// run executes a tool and returns stdout (bounded). stderr is kept short
// for the error message.
func run(ctx context.Context, bin string, limit int64, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	hideWindow(cmd)
	cmd.WaitDelay = time.Second
	var stdout bytes.Buffer
	var stderr limitedBuffer
	stderr.limit = 512
	cmd.Stderr = &stderr
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	_, copyErr := io.Copy(&stdout, io.LimitReader(pipe, limit+1))
	if int64(stdout.Len()) > limit {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, fmt.Errorf("%s output exceeds %d bytes", filepath.Base(bin), limit)
	}
	if err := cmd.Wait(); err != nil {
		return nil, fmt.Errorf("%s: %v: %s", filepath.Base(bin), err, strings.TrimSpace(stderr.String()))
	}
	if copyErr != nil {
		return nil, copyErr
	}
	return stdout.Bytes(), nil
}

type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.limit - b.Len(); room > 0 {
		b.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}
