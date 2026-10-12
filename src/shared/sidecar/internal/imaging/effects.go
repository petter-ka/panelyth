package imaging

import (
	"context"
	"encoding/json"
	"image"
	"image/color"
	"math"
)

// Effects (Stage 14, ADR-0035): border, frame mask, watermark, bump map,
// sketch, oil painting, lens and obscure. Sizes are percentages of the
// picture's shorter edge unless a field says pixels, so one list gives the
// same look on a small and on a large picture (ADR-0036).

func init() {
	RegisterOp("border", OpInfo{Version: 1, Batchable: true, Parse: parseBorder})
	RegisterOp("frameMask", OpInfo{Version: 1, Batchable: true, Parse: parseFrameMask})
	RegisterOp("watermark", OpInfo{Version: 1, Batchable: true, Parse: parseWatermark})
	RegisterOp("bump", OpInfo{Version: 1, Batchable: true, Parse: parseBump})
	RegisterOp("sketch", OpInfo{Version: 1, Batchable: true, Parse: parseSketch})
	RegisterOp("oil", OpInfo{Version: 1, Batchable: true, Parse: parseOil})
	RegisterOp("lens", OpInfo{Version: 1, Batchable: true, Parse: parseLens})
	RegisterOp("obscure", OpInfo{Version: 1, Batchable: true, Parse: parseObscure})
}

// --- shapes and blending ---

func clamp01(v float64) float64 { return math.Min(math.Max(v, 0), 1) }

// smooth is the smoothstep of t in 0..1.
func smooth(t float64) float64 {
	t = clamp01(t)
	return t * t * (3 - 2*t)
}

// sdRoundRect is the signed distance from a point to a rectangle with
// rounded corners: negative inside, in pixels.
func sdRoundRect(px, py, x0, y0, x1, y1, r float64) float64 {
	r = math.Max(math.Min(r, math.Min(x1-x0, y1-y0)/2), 0)
	dx := math.Abs(px-(x0+x1)/2) - ((x1-x0)/2 - r)
	dy := math.Abs(py-(y0+y1)/2) - ((y1-y0)/2 - r)
	return math.Hypot(math.Max(dx, 0), math.Max(dy, 0)) + math.Min(math.Max(dx, dy), 0) - r
}

// sdEllipse approximates the signed distance to an ellipse (exact for a
// circle): the implicit function divided by its gradient.
func sdEllipse(px, py, cx, cy, rx, ry float64) float64 {
	if rx <= 0 || ry <= 0 {
		return math.Inf(1)
	}
	x, y := (px-cx)/rx, (py-cy)/ry
	f := x*x + y*y - 1
	g := 2 * math.Hypot(x/rx, y/ry)
	if g < 1e-9 {
		return -math.Min(rx, ry)
	}
	return f / g
}

// edge turns a signed distance into coverage 0..1: an anti-aliased edge one
// pixel wide, or a soft one that is nothing at the outline and everything
// feather pixels inside it.
func edge(d, feather float64) float64 {
	if feather <= 1 {
		return clamp01(0.5 - d)
	}
	return smooth(-d / feather)
}

// shortEdge is the length a percentage refers to, in working pixels.
func shortEdge(env *Env) float64 {
	return float64(min(env.OutW, env.OutH)) * env.Scale
}

// mixPix writes a·src + (1−a)·dst for premultiplied pixels, a in 0..256.
func mixPix(d []uint8, s []uint8, a int32) {
	if a >= 256 {
		copy(d[:4], s[:4])
		return
	}
	if a <= 0 {
		return
	}
	for c := range 4 {
		d[c] = uint8((int32(s[c])*a + int32(d[c])*(256-a) + 128) >> 8)
	}
}

// overColor draws a premultiplied color over a pixel with coverage a in 0..256.
func overColor(d []uint8, c color.RGBA, a int32) {
	if a <= 0 || c.A == 0 {
		return
	}
	inv := 256*255 - int32(c.A)*a
	d[0] = uint8((int32(c.R)*a*255 + int32(d[0])*inv + 32640) / 65280)
	d[1] = uint8((int32(c.G)*a*255 + int32(d[1])*inv + 32640) / 65280)
	d[2] = uint8((int32(c.B)*a*255 + int32(d[2])*inv + 32640) / 65280)
	d[3] = uint8((int32(c.A)*a*255 + int32(d[3])*inv + 32640) / 65280)
}

// overPix draws a premultiplied pixel over another with coverage a in 0..256.
func overPix(d []uint8, s []uint8, a int32) {
	overColor(d, color.RGBA{R: s[0], G: s[1], B: s[2], A: s[3]}, a)
}

func cov256(v float64) int32 { return int32(clamp01(v)*256 + 0.5) }

// tone mixes a premultiplied color towards white (t > 0) or black (t < 0).
func tone(c color.RGBA, t float64) color.RGBA {
	target := 0.0
	if t > 0 {
		target = float64(c.A)
	}
	t = math.Abs(t)
	f := func(v uint8) uint8 { return uint8(float64(v)*(1-t) + target*t + 0.5) }
	return color.RGBA{R: f(c.R), G: f(c.G), B: f(c.B), A: c.A}
}

func colorOr(s, fallback string) (color.RGBA, error) {
	if s == "" {
		s = fallback
	}
	return ParseColor(s)
}

// blurPlane blurs a single-channel plane in place with three box passes
// (running sums: the cost does not grow with sigma).
func blurPlane(ctx context.Context, plane []uint8, w, h int, sigma float64) error {
	if sigma < minSigma {
		return ctx.Err()
	}
	tmp := make([]uint8, len(plane))
	for _, r := range boxRadii(sigma) {
		if r < 1 {
			continue
		}
		r := r
		if err := Rows(ctx, w, h, func(y0, y1 int) {
			for y := y0; y < y1; y++ {
				boxLine(plane[y*w:y*w+w], tmp[y*w:y*w+w], 1, w, r)
			}
		}); err != nil {
			return err
		}
		// Columns: bands of columns, each walked top to bottom.
		if err := Rows(ctx, h, w, func(x0, x1 int) {
			for x := x0; x < x1; x++ {
				boxLine(tmp[x:], plane[x:], w, h, r)
			}
		}); err != nil {
			return err
		}
	}
	return ctx.Err()
}

// boxLine averages n samples spaced by step over a window of radius r, with
// the ends repeated.
func boxLine(src, dst []uint8, step, n, r int) {
	win := int32(2*r + 1)
	var sum int32
	for i := -r; i <= r; i++ {
		sum += int32(src[clampInt(i, 0, n-1)*step])
	}
	for i := range n {
		dst[i*step] = uint8((sum + win/2) / win)
		sum += int32(src[clampInt(i+r+1, 0, n-1)*step]) - int32(src[clampInt(i-r, 0, n-1)*step])
	}
}

// shadowTable is the coverage (0..256) of a soft edge at t standard
// deviations from it, for t in -3..3 in steps of 1/32.
var shadowTable = func() (t [193]int32) {
	for i := range t {
		x := float64(i-96) / 32
		t[i] = int32(math.Round(128 * math.Erfc(x/math.Sqrt2)))
	}
	return t
}()

// shadowFalloff is how much of a shadow shows at a signed distance from
// its outline, in standard deviations of its blur.
func shadowFalloff(t float64) int32 {
	switch {
	case t <= -3:
		return 256
	case t >= 3:
		return 0
	}
	return shadowTable[int(math.Round(t*32))+96]
}

// --- border ---

type borderStep struct {
	// Style: solid, double, bevel, rounded, shadow or polaroid.
	Style string `json:"style,omitempty"`
	// Width of the frame: percent of the shorter edge (0..50), or pixels of
	// the full picture with Unit "px" (0..4000).
	Width float64 `json:"width"`
	Unit  string  `json:"unit,omitempty"`
	// Color of the frame; Color2 is the line between the two of a double frame.
	Color  string `json:"color,omitempty"`
	Color2 string `json:"color2,omitempty"`
	// Opacity of the frame, 0..100 (100 when absent).
	Opacity *float64 `json:"opacity,omitempty"`
	// Inside draws the frame over the picture's edge; otherwise the canvas grows.
	Inside bool `json:"inside,omitempty"`
	// Radius rounds the picture's corners: percent of the shorter edge, 0..50.
	Radius float64 `json:"radius,omitempty"`
	// A drop shadow (outside frames only): Blur and Offset in percent of the
	// shorter edge (0..20), Shadow its color.
	Blur   float64 `json:"blur,omitempty"`
	Offset float64 `json:"offset,omitempty"`
	Shadow string  `json:"shadow,omitempty"`
	// Background shows around rounded corners and under the shadow: a color
	// or "transparent".
	Background string `json:"background,omitempty"`

	color, color2, shadow, background color.RGBA
	opacity                           float64
}

func parseBorder(raw json.RawMessage) (Step, error) {
	s := &borderStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	switch s.Style {
	case "":
		s.Style = "solid"
	case "solid", "double", "bevel", "rounded", "shadow", "polaroid":
	default:
		return nil, invalid("border style %q", s.Style)
	}
	switch s.Unit {
	case "", "percent":
		if !inRange(s.Width, 0, 50) {
			return nil, invalid("border width is 0..50 percent")
		}
	case "px":
		if !inRange(s.Width, 0, 4000) {
			return nil, invalid("border width is 0..4000 pixels")
		}
	default:
		return nil, invalid("border unit %q", s.Unit)
	}
	if !inRange(s.Radius, 0, 50) || !inRange(s.Blur, 0, 20) || !inRange(s.Offset, 0, 20) {
		return nil, invalid("border: radius 0..50, blur and offset 0..20 percent")
	}
	s.opacity = 100
	if s.Opacity != nil {
		s.opacity = *s.Opacity
	}
	if !inRange(s.opacity, 0, 100) {
		return nil, invalid("border opacity is 0..100")
	}
	var err error
	if s.color, err = colorOr(s.Color, "#ffffff"); err != nil {
		return nil, err
	}
	if s.color2, err = colorOr(s.Color2, "#000000"); err != nil {
		return nil, err
	}
	if s.shadow, err = colorOr(s.Shadow, "#00000099"); err != nil {
		return nil, err
	}
	if s.background, err = ParseColor(s.Background); err != nil {
		return nil, err
	}
	return s, nil
}

// frame is the border's geometry in full-resolution pixels: the width of
// the band and what the canvas grows by on each side.
func (s *borderStep) frame(w, h int) (bw float64, left, top, right, bottom int) {
	short := float64(min(w, h))
	bw = s.Width / 100 * short
	if s.Unit == "px" {
		bw = s.Width
	}
	if s.Inside {
		return bw, 0, 0, 0, 0
	}
	side := int(math.Round(bw))
	margin := 0
	if s.Blur > 0 || s.Offset > 0 {
		margin = int(math.Ceil((2*s.Blur + s.Offset) / 100 * short))
	}
	left, top, right, bottom = side+margin, side+margin, side+margin, side+margin
	if s.Style == "polaroid" {
		bottom = int(math.Round(4*bw)) + margin
	}
	return bw, left, top, right, bottom
}

func (s *borderStep) Size(w, h int, _ *DPI) (int, int) {
	_, l, t, r, b := s.frame(w, h)
	return w + l + r, h + t + b
}

func (s *borderStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	img = toRGBA(img)
	sw, sh := img.Rect.Dx(), img.Rect.Dy()
	tw, th := env.TargetW, env.TargetH
	bwFull, l, t, _, _ := s.frame(env.InW, env.InH)
	short := float64(min(env.InW, env.InH)) * env.Scale
	bw := bwFull * env.Scale
	if bw <= 0 && s.Radius == 0 && (s.Inside || (s.Blur == 0 && s.Offset == 0)) {
		return img, nil
	}
	rp := s.Radius / 100 * short
	// The picture's rectangle, the frame's, and the picture's visible part.
	px0, py0 := math.Round(float64(l)*env.Scale), math.Round(float64(t)*env.Scale)
	if s.Inside {
		px0, py0 = 0, 0
	}
	px1, py1 := px0+float64(sw), py0+float64(sh)
	fx0, fy0, fx1, fy1 := px0-bw, py0-bw, px1+bw, py1+bw
	vx0, vy0, vx1, vy1 := px0, py0, px1, py1
	rf := 0.0
	if rp > 0 {
		rf = rp + bw
	}
	if s.Style == "polaroid" && !s.Inside {
		fy1 = py1 + 4*bw
	}
	if s.Inside {
		fx0, fy0, fx1, fy1 = px0, py0, px1, py1
		vx0, vy0, vx1, vy1 = px0+bw, py0+bw, px1-bw, py1-bw
		if s.Style == "polaroid" {
			vy1 = py1 - 4*bw
		}
		rf = 0
	}
	opacity := s.opacity / 100

	// The shadow: the frame's shape, moved, fading with the distance from
	// its outline the way a blurred edge does (the integral of a Gaussian).
	// It is computed where it shows, not blurred as a plane of its own.
	shaded := !s.Inside && (s.Blur > 0 || s.Offset > 0) && s.shadow.A > 0
	shadowOff := s.Offset / 100 * short
	sigma := math.Max(s.Blur/100*short/2, 0.5)
	shade := func(cx, cy float64) int32 {
		d := sdRoundRect(cx, cy, fx0+shadowOff, fy0+shadowOff, fx1+shadowOff, fy1+shadowOff, rf)
		return shadowFalloff(d / sigma)
	}

	light, dark := tone(s.color, 0.4), tone(s.color, -0.4)
	frameColor := func(x, y float64) color.RGBA {
		switch s.Style {
		case "double":
			// Distance into the band from the picture's edge, in thirds.
			d := sdRoundRect(x, y, vx0, vy0, vx1, vy1, rp)
			if bw > 0 && d > bw/3 && d <= 2*bw/3 {
				return s.color2
			}
		case "bevel":
			// The nearest side decides: lit from the top left.
			if math.Max(vx0-x, vy0-y) >= math.Max(x-vx1, y-vy1) {
				return light
			}
			return dark
		}
		return s.color
	}

	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	err := Rows(ctx, tw, th, func(ya, yb int) {
		for y := ya; y < yb; y++ {
			d := dst.Pix[y*dst.Stride : y*dst.Stride+tw*4]
			cy := float64(y) + 0.5
			// Columns that are plainly the picture are copied.
			ix0, ix1 := 0, 0
			if cy > vy0+1 && cy < vy1-1 {
				inset := 1.0
				if cy < vy0+rp+1 || cy > vy1-rp-1 {
					inset = rp + 1
				}
				ix0, ix1 = int(math.Ceil(vx0+inset)), min(int(math.Floor(vx1-inset)), tw)
			}
			sy := y - int(py0)
			for x := 0; x < tw; x++ {
				o := d[x*4 : x*4+4]
				if x >= ix0 && x < ix1 {
					n := (ix1 - x) * 4
					so := sy*img.Stride + (x-int(px0))*4
					copy(d[x*4:x*4+n], img.Pix[so:so+n])
					x = ix1 - 1
					continue
				}
				cx := float64(x) + 0.5
				inPic := cov256(0.5 - sdRoundRect(cx, cy, vx0, vy0, vx1, vy1, rp))
				if s.Inside {
					// The picture, with the frame over its edge.
					so := sy*img.Stride + x*4
					copy(o, img.Pix[so:so+4])
					if inPic < 256 {
						overColor(o, frameColor(cx, cy), int32(float64(256-inPic)*opacity+0.5))
					}
					continue
				}
				overColor(o, s.background, 256)
				if shaded {
					overColor(o, s.shadow, shade(cx, cy))
				}
				inFrame := cov256(0.5 - sdRoundRect(cx, cy, fx0, fy0, fx1, fy1, rf))
				if inFrame > 0 && inPic < 256 && bw > 0 {
					overColor(o, frameColor(cx, cy), int32(float64(inFrame)*opacity+0.5))
				}
				if inPic > 0 {
					sx := clampInt(x-int(px0), 0, sw-1)
					so := clampInt(sy, 0, sh-1)*img.Stride + sx*4
					overPix(o, img.Pix[so:so+4], inPic)
				}
			}
		}
	})
	return dst, err
}

// --- frame mask ---

type frameMaskStep struct {
	sameSize
	// Shape: rounded, ellipse, circle, feather (a soft rectangle), vignette
	// or custom (the brightness of an asset).
	Shape string `json:"shape,omitempty"`
	// Inset from the edge, Feather (the soft part) and Radius (rounded
	// corners) in percent of the shorter edge.
	Inset   float64 `json:"inset,omitempty"`
	Feather float64 `json:"feather,omitempty"`
	Radius  float64 `json:"radius,omitempty"`
	// Strength of a vignette, 0..100.
	Strength float64 `json:"strength,omitempty"`
	Invert   bool    `json:"invert,omitempty"`
	// Background shows where the mask hides the picture: a color or
	// "transparent".
	Background string `json:"background,omitempty"`
	AssetID    string `json:"assetId,omitempty"`

	background color.RGBA
}

func parseFrameMask(raw json.RawMessage) (Step, error) {
	s := &frameMaskStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	switch s.Shape {
	case "":
		s.Shape = "rounded"
	case "rounded", "ellipse", "circle", "feather", "vignette":
	case "custom":
		if !validAssetID(s.AssetID) {
			return nil, invalid("frame mask: a custom mask needs an asset")
		}
	default:
		return nil, invalid("frame mask shape %q", s.Shape)
	}
	if s.Shape != "custom" && s.AssetID != "" {
		return nil, invalid("frame mask: only a custom mask takes an asset")
	}
	if !inRange(s.Inset, 0, 45) || !inRange(s.Feather, 0, 50) || !inRange(s.Radius, 0, 50) || !inRange(s.Strength, 0, 100) {
		return nil, invalid("frame mask: inset 0..45, feather and radius 0..50, strength 0..100")
	}
	fallback := "transparent"
	if s.Shape == "vignette" {
		fallback = "#000000"
	}
	var err error
	if s.background, err = colorOr(s.Background, fallback); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *frameMaskStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	img = toRGBA(img)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	short := shortEdge(env)
	inset, feather, radius := s.Inset/100*short, s.Feather/100*short, s.Radius/100*short
	fw, fh := float64(w), float64(h)

	var custom []uint8
	if s.Shape == "custom" {
		asset, err := env.asset(ctx, s.AssetID)
		if err != nil {
			return nil, err
		}
		scaled, err := Resample(ctx, asset, w, h, Bilinear)
		if err != nil {
			return nil, err
		}
		// White shows the picture, black hides it; a transparent mask hides.
		custom = make([]uint8, w*h)
		if err := Rows(ctx, w, h, func(y0, y1 int) {
			for y := y0; y < y1; y++ {
				p := scaled.Pix[y*scaled.Stride : y*scaled.Stride+w*4]
				for x := range w {
					custom[y*w+x] = Luma(p[x*4], p[x*4+1], p[x*4+2])
				}
			}
		}); err != nil {
			return nil, err
		}
		if err := blurPlane(ctx, custom, w, h, feather/2); err != nil {
			return nil, err
		}
	}

	mask := func(cx, cy float64) float64 {
		switch s.Shape {
		case "ellipse":
			return edge(sdEllipse(cx, cy, fw/2, fh/2, fw/2-inset, fh/2-inset), feather)
		case "circle":
			return edge(math.Hypot(cx-fw/2, cy-fh/2)-(math.Min(fw, fh)/2-inset), feather)
		case "feather":
			return edge(sdRoundRect(cx, cy, inset, inset, fw-inset, fh-inset, 0), feather)
		case "vignette":
			// 0 at the centre, 1 on the inscribed ellipse, more in the corners.
			t := math.Hypot((cx-fw/2)/(fw/2), (cy-fh/2)/(fh/2))
			start := 1 - s.Feather/50
			return 1 - s.Strength/100*smooth((t-start)/(1.25-start))
		}
		return edge(sdRoundRect(cx, cy, inset, inset, fw-inset, fh-inset, radius), feather)
	}

	dst := image.NewRGBA(img.Rect)
	err := Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			src := img.Pix[y*img.Stride : y*img.Stride+w*4]
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			for x := range w {
				var a int32
				if custom != nil {
					a = int32(custom[y*w+x]) * 256 / 255
				} else {
					a = cov256(mask(float64(x)+0.5, float64(y)+0.5))
				}
				if s.Invert {
					a = 256 - a
				}
				o := d[x*4 : x*4+4]
				o[0], o[1], o[2], o[3] = s.background.R, s.background.G, s.background.B, s.background.A
				mixPix(o, src[x*4:x*4+4], a)
			}
		}
	})
	return dst, err
}
