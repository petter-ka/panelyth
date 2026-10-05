// Package media classifies directory entries. Detection at scan time is by
// extension only (ADR-0015); content sniffing happens lazily in Stage 02.
package media

import "strings"

// Kind is stored in entries.kind. Values are part of the index schema.
type Kind int

const (
	KindDir   Kind = 0
	KindImage Kind = 1
	KindVideo Kind = 2
)

func (k Kind) String() string {
	switch k {
	case KindDir:
		return "dir"
	case KindImage:
		return "image"
	case KindVideo:
		return "video"
	}
	return "unknown"
}

// ParseKind is the inverse of String for protocol input.
func ParseKind(s string) (Kind, bool) {
	switch s {
	case "dir":
		return KindDir, true
	case "image":
		return KindImage, true
	case "video":
		return KindVideo, true
	}
	return 0, false
}

// BRS §6 MVP candidates. AVIF/HEIF/RAW join when a decoder supports them.
var byExt = map[string]Kind{
	"jpg": KindImage, "jpeg": KindImage, "jpe": KindImage, "jfif": KindImage,
	"png": KindImage, "webp": KindImage, "gif": KindImage, "bmp": KindImage,
	"tif": KindImage, "tiff": KindImage,
	"mp4": KindVideo, "m4v": KindVideo, "webm": KindVideo, "mov": KindVideo, "mkv": KindVideo,
}

// Ext returns the lowercase extension without the dot ("" if none).
func Ext(name string) string {
	i := strings.LastIndexByte(name, '.')
	if i <= 0 || i == len(name)-1 {
		return ""
	}
	return strings.ToLower(name[i+1:])
}

// Classify reports the media kind of a file name, or ok=false if the file is
// not a supported media file.
func Classify(name string) (kind Kind, ext string, ok bool) {
	ext = Ext(name)
	kind, ok = byExt[ext]
	return kind, ext, ok
}
