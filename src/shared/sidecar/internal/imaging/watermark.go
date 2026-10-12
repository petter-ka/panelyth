package imaging

import (
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"math"
	"unicode/utf8"
)

// --- watermark ---

type watermarkStep struct {
	sameSize
	// Kind: "text" (with {tokens}) or "image" (an asset).
	Kind string `json:"kind,omitempty"`
	Text string `json:"text,omitempty"`
	// Font is a family name; empty is the built-in default.
	Font   string `json:"font,omitempty"`
	Bold   bool   `json:"bold,omitempty"`
	Italic bool   `json:"italic,omitempty"`
	// Size in percent of the picture's shorter edge (0.5..100): the height
	// of a line of text, or the longer edge of the image.
	Scale float64 `json:"size"`
	Color string  `json:"color,omitempty"`
	// Opacity 0..100 (100 when absent).
	Opacity *float64 `json:"opacity,omitempty"`
	// Outline around the letters in percent of the text size (0..20).
	Outline      float64 `json:"outline,omitempty"`
	OutlineColor string  `json:"outlineColor,omitempty"`
	Shadow       bool    `json:"shadow,omitempty"`
	AssetID      string  `json:"assetId,omitempty"`
	// Anchor is one of the nine points (se when absent); Margin keeps the
	// mark from the edge, in percent of the shorter edge (0..50).
	Anchor   string  `json:"anchor,omitempty"`
	Margin   float64 `json:"margin,omitempty"`
	Rotation float64 `json:"rotation,omitempty"`
	// Tile repeats the mark over the picture; Spacing is the gap in percent
	// of the mark's longer side (0..500); Stagger shifts every other row.
	Tile    bool    `json:"tile,omitempty"`
	Spacing float64 `json:"spacing,omitempty"`
	Stagger bool    `json:"stagger,omitempty"`
	// Blend: normal, multiply or screen.
	Blend string `json:"blend,omitempty"`

	color, outline color.RGBA
	opacity        float64
	ax, ay         float64
}

func parseWatermark(raw json.RawMessage) (Step, error) {
	s := &watermarkStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	switch s.Kind {
	case "":
		s.Kind = "text"
	case "text":
	case "image":
		if !validAssetID(s.AssetID) {
			return nil, invalid("watermark: an image mark needs an asset")
		}
	default:
		return nil, invalid("watermark kind %q", s.Kind)
	}
	if s.Kind == "text" && s.AssetID != "" {
		return nil, invalid("watermark: a text mark takes no asset")
	}
	if utf8.RuneCountInString(s.Text) > MaxTextChars || !utf8.ValidString(s.Text) {
		return nil, invalid("watermark text is at most %d characters", MaxTextChars)
	}
	if len(s.Font) > 128 {
		return nil, invalid("watermark font name is too long")
	}
	s.opacity = 100
	if s.Opacity != nil {
		s.opacity = *s.Opacity
	}
	if !inRange(s.Scale, 0.5, 100) || !inRange(s.opacity, 0, 100) || !inRange(s.Outline, 0, 20) ||
		!inRange(s.Margin, 0, 50) || !inRange(s.Rotation, -180, 180) || !inRange(s.Spacing, 0, 500) {
		return nil, invalid("watermark: size 0.5..100, opacity 0..100, outline 0..20, margin 0..50, rotation -180..180, spacing 0..500")
	}
	if s.Anchor == "" {
		s.Anchor = "se"
	}
	a, ok := anchors[s.Anchor]
	if !ok {
		return nil, invalid("watermark anchor %q", s.Anchor)
	}
	s.ax, s.ay = a[0], a[1]
	switch s.Blend {
	case "", "normal", "multiply", "screen":
	default:
		return nil, invalid("watermark blend %q", s.Blend)
	}
	var err error
	if s.color, err = colorOr(s.Color, "#ffffff"); err != nil {
		return nil, err
	}
	if s.outline, err = colorOr(s.OutlineColor, "#000000"); err != nil {
		return nil, err
	}
	return s, nil
}

// dilate grows a mask by r pixels. A small radius takes the true maximum
// over a disc; a large one blurs and boosts, which is softer but costs the
// same for any radius.
func dilate(ctx context.Context, mask []uint8, w, h int, r float64) ([]uint8, error) {
	out := make([]uint8, len(mask))
	if r < 0.5 {
		copy(out, mask)
		return out, ctx.Err()
	}
	if r > 16 {
		copy(out, mask)
		if err := blurPlane(ctx, out, w, h, r/2); err != nil {
			return nil, err
		}
		for i, v := range out {
			out[i] = uint8(min(int(v)*4, 255))
		}
		return out, ctx.Err()
	}
	n := int(math.Ceil(r))
	// Half-widths of the disc per row offset.
	half := make([]int, 2*n+1)
	for dy := -n; dy <= n; dy++ {
		half[dy+n] = int(math.Sqrt(math.Max((r+0.5)*(r+0.5)-float64(dy*dy), 0)))
	}
	err := Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			for x := range w {
				best := mask[y*w+x]
				for dy := -n; dy <= n && best < 255; dy++ {
					yy := y + dy
					if yy < 0 || yy >= h {
						continue
					}
					row := mask[yy*w : yy*w+w]
					for xx := max(x-half[dy+n], 0); xx <= min(x+half[dy+n], w-1); xx++ {
						if row[xx] > best {
							best = row[xx]
						}
					}
				}
				out[y*w+x] = best
			}
		}
	})
	return out, err
}

// textMark draws the text, with its outline and shadow, as a premultiplied
// picture at the working scale.
func (s *watermarkStep) textMark(ctx context.Context, env *Env, text string, px float64) (*image.RGBA, error) {
	f, err := env.font(s.Font, s.Bold, s.Italic)
	if err != nil {
		return nil, err
	}
	ro := s.Outline / 100 * px
	shadowOff, shadowSigma := 0.0, 0.0
	if s.Shadow {
		shadowOff, shadowSigma = math.Max(px*0.06, 1), math.Max(px*0.04, 0.6)
	}
	pad := int(math.Ceil(ro+shadowOff+3*shadowSigma)) + 1
	mask, err := textMask(f, text, px, pad)
	if err != nil {
		return nil, err
	}
	w, h := mask.Rect.Dx(), mask.Rect.Dy()
	letters := mask.Pix
	var grown, shade []uint8
	if ro >= 0.5 {
		if grown, err = dilate(ctx, letters, w, h, ro); err != nil {
			return nil, err
		}
	}
	if s.Shadow {
		// The shadow of the letters (with their outline), moved down right.
		from := letters
		if grown != nil {
			from = grown
		}
		shade = make([]uint8, len(from))
		off := int(math.Round(shadowOff))
		for y := off; y < h; y++ {
			copy(shade[y*w+off:y*w+w], from[(y-off)*w:(y-off)*w+w-off])
		}
		if err := blurPlane(ctx, shade, w, h, shadowSigma); err != nil {
			return nil, err
		}
	}
	mark := image.NewRGBA(image.Rect(0, 0, w, h))
	shadowColor := color.RGBA{A: 166}
	err = Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			d := mark.Pix[y*mark.Stride : y*mark.Stride+w*4]
			for x := range w {
				o := d[x*4 : x*4+4]
				if shade != nil {
					overColor(o, shadowColor, int32(shade[y*w+x])*256/255)
				}
				if grown != nil {
					overColor(o, s.outline, int32(grown[y*w+x])*256/255)
				}
				overColor(o, s.color, int32(letters[y*w+x])*256/255)
			}
		}
	})
	return mark, err
}

// mark builds what is stamped: the text or the image, turned.
func (s *watermarkStep) mark(ctx context.Context, env *Env) (*image.RGBA, error) {
	short := shortEdge(env)
	size := s.Scale / 100 * short
	var key string
	var build func() (*image.RGBA, error)
	if s.Kind == "image" {
		key = fmt.Sprintf("image|%s|%.2f", s.AssetID, size)
		build = func() (*image.RGBA, error) {
			asset, err := env.asset(ctx, s.AssetID)
			if err != nil {
				return nil, err
			}
			aw, ah := asset.Rect.Dx(), asset.Rect.Dy()
			k := size / float64(max(aw, ah))
			mw, mh := max(1, int(math.Round(float64(aw)*k))), max(1, int(math.Round(float64(ah)*k)))
			if mw > maxMarkEdge || mh > maxMarkEdge || int64(mw)*int64(mh) > maxMarkArea {
				return nil, invalid("the watermark image is too large")
			}
			if mw == aw && mh == ah {
				return asset, nil
			}
			return Resample(ctx, asset, mw, mh, CatmullRom)
		}
	} else {
		text := s.Text
		if env.Res != nil {
			text = ExpandTokens(text, env.Res.Token)
		}
		if text == "" {
			return nil, nil
		}
		key = fmt.Sprintf("text|%q|%q|%v|%v|%.2f|%v|%.2f|%v|%v", text, s.Font, s.Bold, s.Italic, size, s.color,
			s.Outline, s.outline, s.Shadow)
		build = func() (*image.RGBA, error) { return s.textMark(ctx, env, text, size) }
	}
	if s.Rotation == 0 {
		return cachedMark(key, build)
	}
	return cachedMark(fmt.Sprintf("%s|rot%.2f", key, s.Rotation), func() (*image.RGBA, error) {
		flat, err := cachedMark(key, build)
		if err != nil || flat == nil {
			return flat, err
		}
		sin, cos := math.Sincos(s.Rotation * math.Pi / 180)
		w, h := float64(flat.Rect.Dx()), float64(flat.Rect.Dy())
		tw := int(math.Ceil(math.Abs(w*cos)+math.Abs(h*sin))) + 2
		th := int(math.Ceil(math.Abs(w*sin)+math.Abs(h*cos))) + 2
		if tw > maxMarkEdge || th > maxMarkEdge {
			return nil, invalid("the watermark is too large")
		}
		return rotateAny(ctx, flat, tw, th, s.Rotation, color.RGBA{}, false, true)
	})
}

func floorMod(a, n int) int {
	m := a % n
	if m < 0 {
		m += n
	}
	return m
}

func floorDiv(a, n int) int {
	q := a / n
	if a%n != 0 && (a < 0) != (n < 0) {
		q--
	}
	return q
}

// blendPix draws a premultiplied source pixel, scaled by a (0..256), over a
// destination pixel in the given mode.
func blendPix(d, s []uint8, a int32, mode string) {
	sr, sg, sb, sa := int32(s[0])*a>>8, int32(s[1])*a>>8, int32(s[2])*a>>8, int32(s[3])*a>>8
	if sa == 0 {
		return
	}
	da := int32(d[3])
	src := [3]int32{sr, sg, sb}
	for c := range 3 {
		dc := int32(d[c])
		var v int32
		switch mode {
		case "multiply":
			v = (src[c]*dc + src[c]*(255-da) + dc*(255-sa) + 127) / 255
		case "screen":
			v = src[c] + dc - (src[c]*dc+127)/255
		default:
			v = src[c] + (dc*(255-sa)+127)/255
		}
		d[c] = uint8(min(max(v, 0), 255))
	}
	d[3] = uint8(min(sa+da-(sa*da+127)/255, 255))
	// Premultiplied colors stay within alpha.
	d[0], d[1], d[2] = min(d[0], d[3]), min(d[1], d[3]), min(d[2], d[3])
}

func (s *watermarkStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	if s.opacity == 0 {
		return img, nil
	}
	mark, err := s.mark(ctx, env)
	if err != nil {
		return nil, err
	}
	if mark == nil {
		return img, nil
	}
	img = toRGBA(img)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	mw, mh := mark.Rect.Dx(), mark.Rect.Dy()
	margin := s.Margin / 100 * shortEdge(env)
	x0 := int(math.Round(margin + (float64(w)-2*margin-float64(mw))*s.ax))
	y0 := int(math.Round(margin + (float64(h)-2*margin-float64(mh))*s.ay))
	gap := int(math.Round(s.Spacing / 100 * float64(max(mw, mh))))
	stepX, stepY := mw+gap, mh+gap
	a := int32(math.Round(s.opacity / 100 * 256))

	dst := img
	if !env.Scratch {
		dst = image.NewRGBA(img.Rect)
		copy(dst.Pix, img.Pix)
	}
	err = Rows(ctx, w, h, func(ya, yb int) {
		for y := ya; y < yb; y++ {
			ry, shift := y-y0, 0
			if s.Tile {
				if s.Stagger && floorDiv(y-y0, stepY)&1 == 1 {
					shift = stepX / 2
				}
				ry = floorMod(y-y0, stepY)
			}
			if ry < 0 || ry >= mh {
				continue
			}
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			m := mark.Pix[ry*mark.Stride : ry*mark.Stride+mw*4]
			if !s.Tile {
				for x := max(x0, 0); x < min(x0+mw, w); x++ {
					blendPix(d[x*4:x*4+4], m[(x-x0)*4:(x-x0)*4+4], a, s.Blend)
				}
				continue
			}
			for x := range w {
				if rx := floorMod(x-x0-shift, stepX); rx < mw {
					blendPix(d[x*4:x*4+4], m[rx*4:rx*4+4], a, s.Blend)
				}
			}
		}
	})
	return dst, err
}
