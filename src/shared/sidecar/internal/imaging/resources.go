package imaging

import (
	"context"
	"encoding/json"
	"image"
	"image/draw"
	"math"
	"slices"
	"strings"
	"sync"

	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/font/sfnt"
	"golang.org/x/image/math/fixed"

	"panelyth/sidecar/internal/fonts"
)

// Resources are what a step may need besides the picture (Stage 14,
// ADR-0035): the pictures the user picked (a logo, a texture, a mask), fonts
// and facts about the picture being edited. An edit list names an asset by
// id and a font by family; it never holds a path.
type Resources interface {
	// Asset returns a registered picture. The image is shared: a step must
	// not modify it.
	Asset(ctx context.Context, id string) (*image.RGBA, error)
	// Font returns the font of a family in the closest style; an unknown
	// family gives the built-in default.
	Font(family string, bold, italic bool) (*sfnt.Font, error)
	// Token is a fact about the picture for text ("name", "exif.model", …).
	Token(name string) (string, bool)
}

// MaxAssetIDLen bounds an asset id in an edit list.
const MaxAssetIDLen = 64

func validAssetID(id string) bool {
	if id == "" || len(id) > MaxAssetIDLen {
		return false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// AssetIDs lists the assets an edit list names, each once, in order. Stage
// 16 checks them before a batch starts (ADR-0036).
func (e EditList) AssetIDs() []string {
	var ids []string
	for _, op := range e {
		var p struct {
			AssetID string `json:"assetId"`
		}
		if op.Off || json.Unmarshal(op.Params, &p) != nil || p.AssetID == "" || slices.Contains(ids, p.AssetID) {
			continue
		}
		ids = append(ids, p.AssetID)
	}
	return ids
}

// asset fetches a step's asset, or fails as an invalid edit when there is no
// such asset (it was released, or the list came from another session).
func (env *Env) asset(ctx context.Context, id string) (*image.RGBA, error) {
	if env.Res == nil {
		return nil, invalid("asset %q is not available", id)
	}
	img, err := env.Res.Asset(ctx, id)
	if err != nil {
		return nil, err
	}
	if img == nil || img.Rect.Empty() {
		return nil, invalid("asset %q is not available", id)
	}
	return img, nil
}

func (env *Env) font(family string, bold, italic bool) (*sfnt.Font, error) {
	if env.Res != nil {
		return env.Res.Font(family, bold, italic)
	}
	return fonts.System().Font(family, bold, italic)
}

// --- tokens ---

// TokenNames are the tokens a picture always has; "exif.<tag>" tokens exist
// when the picture carries that tag. Stage 16 uses the same tokens for file
// name templates.
var TokenNames = []string{"name", "filename", "ext", "folder", "date", "time", "year", "month", "day", "width", "height"}

// MaxTokenValue bounds one expanded token.
const MaxTokenValue = 256

// ExpandTokens replaces {token} in text by what lookup says. Names are
// letters, digits, dots and underscores, and are matched without regard to
// case. A token lookup does not know stays as written, so a brace in
// ordinary text needs no escape.
func ExpandTokens(text string, lookup func(name string) (string, bool)) string {
	if lookup == nil || !strings.Contains(text, "{") {
		return text
	}
	var b strings.Builder
	for i := 0; i < len(text); {
		open := strings.IndexByte(text[i:], '{')
		if open < 0 {
			b.WriteString(text[i:])
			break
		}
		b.WriteString(text[i : i+open])
		i += open
		end := i + 1
		for end < len(text) && tokenChar(text[end]) {
			end++
		}
		if end < len(text) && text[end] == '}' && end > i+1 {
			if v, ok := lookup(strings.ToLower(text[i+1 : end])); ok {
				if len(v) > MaxTokenValue {
					v = v[:MaxTokenValue]
				}
				b.WriteString(v)
				i = end + 1
				continue
			}
		}
		b.WriteByte('{')
		i++
	}
	return b.String()
}

func tokenChar(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_'
}

// --- text ---

// Limits of drawn text.
const (
	MaxTextChars = 1000
	maxTextLines = 20
	maxFontPx    = 4096
	maxMarkEdge  = 16384
	maxMarkArea  = 64_000_000
)

// textMask draws lines of text into an alpha mask with the font at a pixel
// size. The mask has a margin of pad pixels on every side (room for an
// outline or a shadow). Text is laid out left to right with the font's
// kerning; scripts that need shaping (Arabic, Indic) are not shaped.
func textMask(f *sfnt.Font, text string, px float64, pad int) (*image.Alpha, error) {
	px = math.Min(math.Max(px, 2), maxFontPx)
	face, err := opentype.NewFace(f, &opentype.FaceOptions{Size: px, DPI: 72, Hinting: font.HintingNone})
	if err != nil {
		return nil, invalid("font: %v", err)
	}
	defer face.Close()
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	if len(lines) > maxTextLines {
		lines = lines[:maxTextLines]
	}
	m := face.Metrics()
	ascent, descent := m.Ascent.Ceil(), m.Descent.Ceil()
	lineH := max(m.Height.Ceil(), ascent+descent, 1)
	width := 1
	widths := make([]int, len(lines))
	for i, line := range lines {
		widths[i] = font.MeasureString(face, line).Ceil()
		width = max(width, widths[i])
	}
	w, h := width+2*pad, lineH*(len(lines)-1)+ascent+descent+2*pad
	if w > maxMarkEdge || h > maxMarkEdge || int64(w)*int64(h) > maxMarkArea {
		return nil, invalid("the text is too large to draw")
	}
	mask := image.NewAlpha(image.Rect(0, 0, w, h))
	d := font.Drawer{Dst: mask, Src: image.Opaque, Face: face}
	for i, line := range lines {
		// Lines are centred on the widest one.
		d.Dot = fixed.P(pad+(width-widths[i])/2, pad+ascent+i*lineH)
		d.DrawString(line)
	}
	return mask, nil
}

// --- a small cache of built marks ---

// A watermark is drawn once and placed many times: while its position or
// opacity is dragged the text is not laid out again.
const markCacheSize = 8

type markEntry struct {
	key string
	img *image.RGBA
}

var (
	markMu    sync.Mutex
	markCache []markEntry
)

func cachedMark(key string, build func() (*image.RGBA, error)) (*image.RGBA, error) {
	markMu.Lock()
	for i, e := range markCache {
		if e.key == key {
			markCache = append(append(markCache[:i:i], markCache[i+1:]...), e)
			markMu.Unlock()
			return e.img, nil
		}
	}
	markMu.Unlock()
	img, err := build()
	if err != nil {
		return nil, err
	}
	markMu.Lock()
	markCache = append(markCache, markEntry{key, img})
	if len(markCache) > markCacheSize {
		markCache = append([]markEntry(nil), markCache[len(markCache)-markCacheSize:]...)
	}
	markMu.Unlock()
	return img, nil
}

// toRGBAImage converts any decoded image to premultiplied RGBA.
func toRGBAImage(src image.Image) *image.RGBA {
	if rgba, ok := src.(*image.RGBA); ok && rgba.Rect.Min == (image.Point{}) {
		return rgba
	}
	b := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Rect, src, b.Min, draw.Src)
	return dst
}
