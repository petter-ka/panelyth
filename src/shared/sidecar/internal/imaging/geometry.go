package imaging

import (
	"context"
	"encoding/json"
	"image"
	"image/color"
	"math"
	"strconv"
	"strings"
	"sync"
)

// The geometry operations of the editor (Stage 12): rotate, flip, crop,
// resize, canvas and dpi. All are batch-capable.

func init() {
	RegisterOp("rotate", OpInfo{Version: 1, Batchable: true, Parse: parseRotate})
	RegisterOp("flip", OpInfo{Version: 1, Batchable: true, Parse: parseFlip})
	RegisterOp("crop", OpInfo{Version: 1, Batchable: true, Parse: parseCrop})
	RegisterOp("resize", OpInfo{Version: 1, Batchable: true, Parse: parseResize})
	RegisterOp("canvas", OpInfo{Version: 1, Batchable: true, Parse: parseCanvas})
	RegisterOp("dpi", OpInfo{Version: 1, Batchable: true, Parse: parseDPI})
}

// ParseColor reads "transparent", "#rgb", "#rrggbb" or "#rrggbbaa" as a
// premultiplied color.
func ParseColor(s string) (color.RGBA, error) {
	if s == "" || s == "transparent" {
		return color.RGBA{}, nil
	}
	h := strings.TrimPrefix(s, "#")
	if len(h) == len(s) {
		return color.RGBA{}, invalid("color %q", s)
	}
	if len(h) == 3 {
		h = string([]byte{h[0], h[0], h[1], h[1], h[2], h[2]})
	}
	if len(h) == 6 {
		h += "ff"
	}
	if len(h) != 8 {
		return color.RGBA{}, invalid("color %q", s)
	}
	v, err := strconv.ParseUint(h, 16, 32)
	if err != nil {
		return color.RGBA{}, invalid("color %q", s)
	}
	n := color.NRGBA{R: uint8(v >> 24), G: uint8(v >> 16), B: uint8(v >> 8), A: uint8(v)}
	r, g, b, a := n.RGBA()
	return color.RGBA{R: uint8(r >> 8), G: uint8(g >> 8), B: uint8(b >> 8), A: uint8(a >> 8)}, nil
}

// --- rotate ---

type rotateStep struct {
	Angle float64 `json:"angle"`
	// Mode: "expand" grows the canvas to hold the turned picture, "crop"
	// keeps the largest upright rectangle without corners, "fill" keeps the
	// size and fills the corners.
	Mode string `json:"mode,omitempty"`
	Fill string `json:"fill,omitempty"`

	fill color.RGBA
}

func parseRotate(raw json.RawMessage) (Step, error) {
	s := &rotateStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if !(s.Angle >= -360 && s.Angle <= 360) {
		return nil, invalid("rotate angle is -360..360 degrees")
	}
	switch s.Mode {
	case "":
		s.Mode = "expand"
	case "expand", "crop", "fill":
	default:
		return nil, invalid("rotate mode %q", s.Mode)
	}
	var err error
	if s.fill, err = ParseColor(s.Fill); err != nil {
		return nil, err
	}
	return s, nil
}

// quarterTurns returns the clockwise quarter turns of an angle that is a
// multiple of 90 degrees.
func (s *rotateStep) quarterTurns() (int, bool) {
	q := math.Round(s.Angle / 90)
	if math.Abs(s.Angle-q*90) > 1e-9 {
		return 0, false
	}
	return ((int(q) % 4) + 4) % 4, true
}

func (s *rotateStep) Size(w, h int, _ *DPI) (int, int) {
	if q, ok := s.quarterTurns(); ok {
		if q%2 == 1 {
			return h, w
		}
		return w, h
	}
	sin, cos := math.Sincos(s.Angle * math.Pi / 180)
	sin, cos = math.Abs(sin), math.Abs(cos)
	fw, fh := float64(w), float64(h)
	switch s.Mode {
	case "fill":
		return w, h
	case "crop":
		cw, ch := inscribed(fw, fh, sin, cos)
		return max(1, int(math.Floor(cw+1e-9))), max(1, int(math.Floor(ch+1e-9)))
	}
	return max(1, int(math.Ceil(fw*cos+fh*sin-1e-9))), max(1, int(math.Ceil(fw*sin+fh*cos-1e-9)))
}

// inscribed is the largest upright rectangle inside a w×h rectangle turned
// by an angle with the given |sin| and |cos|.
func inscribed(w, h, sin, cos float64) (float64, float64) {
	long, short := w, h
	if h > w {
		long, short = h, w
	}
	if short <= 2*sin*cos*long || math.Abs(sin-cos) < 1e-10 {
		// Two corners touch the long sides.
		x := 0.5 * short
		if w >= h {
			return x / sin, x / cos
		}
		return x / cos, x / sin
	}
	cos2 := cos*cos - sin*sin
	return (w*cos - h*sin) / cos2, (h*cos - w*sin) / cos2
}

func (s *rotateStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	if q, ok := s.quarterTurns(); ok {
		if q == 0 {
			return img, nil
		}
		return orientRows(ctx, img, [4]int{1, 6, 3, 8}[q])
	}
	return rotateAny(ctx, img, env.TargetW, env.TargetH, s.Angle, s.fill, s.Mode == "crop", !env.Draft)
}

const fracBits = 24

var (
	cubicOnce  sync.Once
	cubicTable [256][4]int32
)

// cubicWeights are the Catmull-Rom weights of the four taps around a sample
// for each of 256 sub-pixel positions, in weightBits fixed point.
func cubicWeights() *[256][4]int32 {
	cubicOnce.Do(func() {
		for i := range cubicTable {
			t := float64(i) / 256
			ws := [4]float64{CatmullRom.at(1 + t), CatmullRom.at(t), CatmullRom.at(1 - t), CatmullRom.at(2 - t)}
			total, largest := int32(0), 0
			for j, w := range ws {
				cubicTable[i][j] = int32(math.Round(w * (1 << weightBits)))
				total += cubicTable[i][j]
				if cubicTable[i][j] > cubicTable[i][largest] {
					largest = j
				}
			}
			cubicTable[i][largest] += 1<<weightBits - total
		}
	})
	return &cubicTable
}

// rotateAny turns src clockwise by angle degrees about its center into a
// tw×th image. Source positions are stepped in fixed point per row, so the
// result does not depend on how rows are split between workers. Outside the
// source the result is fill, with a one-pixel blend at the border; clampEdge
// repeats the border instead (the "crop" mode, which has no outside).
func rotateAny(ctx context.Context, src *image.RGBA, tw, th int, angle float64, fill color.RGBA, clampEdge, cubic bool) (*image.RGBA, error) {
	src = toRGBA(src)
	sw, sh := src.Rect.Dx(), src.Rect.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	sin, cos := math.Sincos(angle * math.Pi / 180)
	const one = 1 << fracBits
	stepX, stepY := int64(math.Round(cos*one)), int64(math.Round(-sin*one))
	u0 := -float64(tw-1) / 2
	cx, cy := float64(sw-1)/2, float64(sh-1)/2
	maxX, maxY := int64(sw-1)<<fracBits, int64(sh-1)<<fracBits
	table := cubicWeights()
	err := Rows(ctx, tw, th, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			v := float64(y) - float64(th-1)/2
			// Explicit conversions keep the products from being fused, so
			// every platform computes the same row start.
			fx := int64(math.Round((float64(cos*u0) + float64(sin*v) + cx) * one))
			fy := int64(math.Round((float64(-sin*u0) + float64(cos*v) + cy) * one))
			d := dst.Pix[y*dst.Stride : y*dst.Stride+tw*4]
			for x := 0; x < tw*4; x, fx, fy = x+4, fx+stepX, fy+stepY {
				cov := int32(256)
				if !clampEdge {
					cov = coverage(fx, maxX) * coverage(fy, maxY) >> 8
					if cov == 0 {
						d[x], d[x+1], d[x+2], d[x+3] = fill.R, fill.G, fill.B, fill.A
						continue
					}
				}
				ix, iy := int(fx>>fracBits), int(fy>>fracBits)
				wx, wy := int32(fx>>(fracBits-8))&0xFF, int32(fy>>(fracBits-8))&0xFF
				var p [4]int32
				if cubic {
					p = sampleCubic(src, sw, sh, ix, iy, &table[wx], &table[wy])
				} else {
					p = sampleLinear(src, sw, sh, ix, iy, wx, wy)
				}
				if cov != 256 {
					p[0] = (p[0]*cov + int32(fill.R)*(256-cov) + 128) >> 8
					p[1] = (p[1]*cov + int32(fill.G)*(256-cov) + 128) >> 8
					p[2] = (p[2]*cov + int32(fill.B)*(256-cov) + 128) >> 8
					p[3] = (p[3]*cov + int32(fill.A)*(256-cov) + 128) >> 8
				}
				d[x], d[x+1], d[x+2], d[x+3] = uint8(p[0]), uint8(p[1]), uint8(p[2]), uint8(p[3])
			}
		}
	})
	return dst, err
}

// coverage is how much of a sample lies inside [0, max] on one axis, in
// 1/256: full inside, falling to zero one pixel outside.
func coverage(f, hi int64) int32 {
	switch {
	case f < 0:
		return int32(min(max64(256+(f>>(fracBits-8)), 0), 256))
	case f > hi:
		return int32(max64(256-((f-hi)>>(fracBits-8)), 0))
	}
	return 256
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func sampleLinear(src *image.RGBA, sw, sh, ix, iy int, wx, wy int32) [4]int32 {
	x0, x1 := clampInt(ix, 0, sw-1)*4, clampInt(ix+1, 0, sw-1)*4
	r0 := src.Pix[clampInt(iy, 0, sh-1)*src.Stride:]
	r1 := src.Pix[clampInt(iy+1, 0, sh-1)*src.Stride:]
	var out [4]int32
	for c := range 4 {
		top := int32(r0[x0+c])*(256-wx) + int32(r0[x1+c])*wx
		bottom := int32(r1[x0+c])*(256-wx) + int32(r1[x1+c])*wx
		out[c] = (top*(256-wy) + bottom*wy + 1<<15) >> 16
	}
	return out
}

func sampleCubic(src *image.RGBA, sw, sh, ix, iy int, wx, wy *[4]int32) [4]int32 {
	var xs [4]int
	for i := range xs {
		xs[i] = clampInt(ix-1+i, 0, sw-1) * 4
	}
	var acc [4]int64
	for j := range 4 {
		row := src.Pix[clampInt(iy-1+j, 0, sh-1)*src.Stride:]
		for c := range 4 {
			h := int32(row[xs[0]+c])*wx[0] + int32(row[xs[1]+c])*wx[1] + int32(row[xs[2]+c])*wx[2] + int32(row[xs[3]+c])*wx[3]
			acc[c] += int64(h) * int64(wy[j])
		}
	}
	var out [4]int32
	for c := range 4 {
		out[c] = int32(min(max64((acc[c]+1<<(2*weightBits-1))>>(2*weightBits), 0), 255))
	}
	// Premultiplied colors stay within alpha after the overshoot.
	out[0], out[1], out[2] = min(out[0], out[3]), min(out[1], out[3]), min(out[2], out[3])
	return out
}

// orientRows applies an EXIF orientation (1..8) like Orient, in parallel
// bands: each destination row reads the source along a row or a column.
func orientRows(ctx context.Context, img *image.RGBA, orientation int) (*image.RGBA, error) {
	img = toRGBA(img)
	if orientation <= 1 || orientation > 8 {
		return img, nil
	}
	w, h := img.Rect.Dx(), img.Rect.Dy()
	dw, dh := w, h
	if orientation >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	stride := img.Stride
	err := Rows(ctx, dw, dh, func(y0, y1 int) {
		for dy := y0; dy < y1; dy++ {
			// The source pixel of the row's first destination pixel, and the
			// step to the next one.
			var sx, sy, step int
			switch orientation {
			case 2:
				sx, sy, step = w-1, dy, -4
			case 3:
				sx, sy, step = w-1, h-1-dy, -4
			case 4:
				sx, sy, step = 0, h-1-dy, 4
			case 5:
				sx, sy, step = dy, 0, stride
			case 6:
				sx, sy, step = dy, h-1, -stride
			case 7:
				sx, sy, step = w-1-dy, h-1, -stride
			case 8:
				sx, sy, step = w-1-dy, 0, stride
			}
			so := sy*stride + sx*4
			d := dst.Pix[dy*dst.Stride : dy*dst.Stride+dw*4]
			if step == 4 {
				copy(d, img.Pix[so:so+dw*4])
				continue
			}
			for x := 0; x < len(d); x, so = x+4, so+step {
				d[x], d[x+1], d[x+2], d[x+3] = img.Pix[so], img.Pix[so+1], img.Pix[so+2], img.Pix[so+3]
			}
		}
	})
	return dst, err
}

// --- flip ---

type flipStep struct {
	Axis string `json:"axis"`
}

func parseFlip(raw json.RawMessage) (Step, error) {
	s := &flipStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if s.Axis != "h" && s.Axis != "v" {
		return nil, invalid("flip axis is h or v")
	}
	return s, nil
}

func (s *flipStep) Size(w, h int, _ *DPI) (int, int) { return w, h }

func (s *flipStep) Apply(ctx context.Context, img *image.RGBA, _ *Env) (*image.RGBA, error) {
	if s.Axis == "h" {
		return orientRows(ctx, img, 2)
	}
	return orientRows(ctx, img, 4)
}

// --- crop ---

// Rect is a rectangle in 0..1 coordinates of the image at that step.
type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

type cropStep struct {
	Rect *Rect `json:"rect"`
}

func parseCrop(raw json.RawMessage) (Step, error) {
	s := &cropStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	r := s.Rect
	if r == nil || !(r.X >= 0 && r.Y >= 0 && r.W > 0 && r.H > 0 && r.X+r.W <= 1+1e-9 && r.Y+r.H <= 1+1e-9) {
		return nil, invalid("crop rectangle outside the image")
	}
	return s, nil
}

// cropRect converts a normalized rectangle to pixels, at least 1×1.
func cropRect(w, h int, r Rect) image.Rectangle {
	x0 := int(math.Round(r.X * float64(w)))
	y0 := int(math.Round(r.Y * float64(h)))
	x1 := int(math.Round((r.X + r.W) * float64(w)))
	y1 := int(math.Round((r.Y + r.H) * float64(h)))
	x0, y0 = min(max(x0, 0), w-1), min(max(y0, 0), h-1)
	x1, y1 = min(max(x1, x0+1), w), min(max(y1, y0+1), h)
	return image.Rect(x0, y0, x1, y1)
}

func (s *cropStep) Size(w, h int, _ *DPI) (int, int) {
	r := cropRect(w, h, *s.Rect)
	return r.Dx(), r.Dy()
}

func (s *cropStep) Apply(ctx context.Context, img *image.RGBA, _ *Env) (*image.RGBA, error) {
	r := cropRect(img.Rect.Dx(), img.Rect.Dy(), *s.Rect)
	// Always a copy: the result must not pin (or share) the larger buffer.
	dst := image.NewRGBA(image.Rect(0, 0, r.Dx(), r.Dy()))
	for y := range r.Dy() {
		so := (r.Min.Y+y)*img.Stride + r.Min.X*4
		copy(dst.Pix[y*dst.Stride:y*dst.Stride+r.Dx()*4], img.Pix[so:so+r.Dx()*4])
	}
	return dst, ctx.Err()
}

// --- resize ---

type resizeStep struct {
	// Mode: "pixels" (w×h; a zero side follows the aspect ratio), "percent",
	// "fit" (inside w×h), "fill" (covers w×h, the overflow cut off
	// centered) or "print" (w×h in Unit at DPI).
	Mode string  `json:"mode"`
	W    float64 `json:"w"`
	H    float64 `json:"h"`
	Unit string  `json:"unit,omitempty"`
	DPI  float64 `json:"dpi,omitempty"`
	Algo string  `json:"algo,omitempty"`
	// NoEnlarge leaves a picture that is already smaller as it is.
	NoEnlarge bool `json:"noEnlarge,omitempty"`

	kernel Kernel
}

func parseResize(raw json.RawMessage) (Step, error) {
	s := &resizeStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if !(s.W >= 0 && s.H >= 0) || (s.W == 0 && s.H == 0) {
		return nil, invalid("resize needs a width or a height")
	}
	switch s.Mode {
	case "pixels":
		if s.W > MaxEditEdge || s.H > MaxEditEdge || s.W != math.Trunc(s.W) || s.H != math.Trunc(s.H) {
			return nil, invalid("resize to whole pixels, at most %d", MaxEditEdge)
		}
	case "percent":
		if s.W > 10000 || s.H > 10000 {
			return nil, invalid("resize by at most 10000 percent")
		}
	case "fit", "fill":
		if s.W < 1 || s.H < 1 || s.W > MaxEditEdge || s.H > MaxEditEdge || s.W != math.Trunc(s.W) || s.H != math.Trunc(s.H) {
			return nil, invalid("%s needs a width and a height in pixels", s.Mode)
		}
	case "print":
		if s.Unit != "cm" && s.Unit != "in" {
			return nil, invalid("print size is in cm or in")
		}
		if !(s.DPI >= 1 && s.DPI <= 10000) || s.W > 10000 || s.H > 10000 {
			return nil, invalid("print size needs 1..10000 dpi")
		}
	default:
		return nil, invalid("resize mode %q", s.Mode)
	}
	if s.Algo == "" {
		s.Algo = "lanczos3"
	}
	k, ok := KernelNames[s.Algo]
	if !ok {
		return nil, invalid("resize algorithm %q", s.Algo)
	}
	s.kernel = k
	return s, nil
}

func roundEdge(v float64) int {
	return min(max(int(math.Round(v)), 1), MaxEditEdge)
}

// pair resolves a w×h request where a zero side follows the aspect ratio.
func pair(w, h int, tw, th float64) (int, int) {
	switch {
	case tw == 0:
		return roundEdge(float64(w) * th / float64(h)), roundEdge(th)
	case th == 0:
		return roundEdge(tw), roundEdge(float64(h) * tw / float64(w))
	}
	return roundEdge(tw), roundEdge(th)
}

func (s *resizeStep) Size(w, h int, dpi *DPI) (int, int) {
	fw, fh := float64(w), float64(h)
	var tw, th int
	switch s.Mode {
	case "pixels":
		tw, th = pair(w, h, s.W, s.H)
	case "percent":
		ph := s.H
		if ph == 0 {
			ph = s.W
		}
		pw := s.W
		if pw == 0 {
			pw = s.H
		}
		tw, th = roundEdge(fw*pw/100), roundEdge(fh*ph/100)
	case "fit":
		f := math.Min(s.W/fw, s.H/fh)
		if s.NoEnlarge {
			f = math.Min(f, 1)
		}
		return roundEdge(fw * f), roundEdge(fh * f)
	case "fill":
		if s.NoEnlarge {
			return min(int(s.W), w), min(int(s.H), h)
		}
		return int(s.W), int(s.H)
	case "print":
		per := s.DPI
		if s.Unit == "cm" {
			per /= 2.54
		}
		tw, th = pair(w, h, s.W*per, s.H*per)
		*dpi = DPI{s.DPI, s.DPI}
	}
	if s.NoEnlarge && (tw > w || th > h) {
		return w, h
	}
	return tw, th
}

func (s *resizeStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	sw, sh := img.Rect.Dx(), img.Rect.Dy()
	tw, th := env.TargetW, env.TargetH
	if tw == sw && th == sh {
		return img, nil
	}
	k := s.kernel
	if env.Draft && k != Nearest {
		k = Bilinear
	}
	if s.Mode != "fill" {
		return Resample(ctx, img, tw, th, k)
	}
	// Cover the target, then cut the overflow off centered.
	f := math.Max(float64(tw)/float64(sw), float64(th)/float64(sh))
	if s.NoEnlarge {
		f = math.Min(f, 1)
	}
	mw, mh := max(tw, int(math.Round(float64(sw)*f))), max(th, int(math.Round(float64(sh)*f)))
	mid := img
	if mw != sw || mh != sh {
		var err error
		if mid, err = Resample(ctx, img, mw, mh, k); err != nil {
			return nil, err
		}
	}
	return place(ctx, mid, tw, th, (tw-mw)/2, (th-mh)/2, color.RGBA{}, false)
}

// --- canvas ---

type canvasStep struct {
	// W, H in pixels; zero keeps that side.
	W int `json:"w"`
	H int `json:"h"`
	// Anchor is where the picture stays: nw, n, ne, w, c, e, sw, s, se.
	Anchor string `json:"anchor,omitempty"`
	// Fill is a color, "transparent" or "edge" (the border pixels repeat).
	Fill string `json:"fill,omitempty"`

	fill   color.RGBA
	ax, ay float64
}

var anchors = map[string][2]float64{
	"nw": {0, 0}, "n": {0.5, 0}, "ne": {1, 0},
	"w": {0, 0.5}, "c": {0.5, 0.5}, "e": {1, 0.5},
	"sw": {0, 1}, "s": {0.5, 1}, "se": {1, 1},
}

func parseCanvas(raw json.RawMessage) (Step, error) {
	s := &canvasStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if s.W < 0 || s.H < 0 || s.W > MaxEditEdge || s.H > MaxEditEdge || (s.W == 0 && s.H == 0) {
		return nil, invalid("canvas size is 1..%d pixels", MaxEditEdge)
	}
	if s.Anchor == "" {
		s.Anchor = "c"
	}
	a, ok := anchors[s.Anchor]
	if !ok {
		return nil, invalid("canvas anchor %q", s.Anchor)
	}
	s.ax, s.ay = a[0], a[1]
	if s.Fill != "edge" {
		var err error
		if s.fill, err = ParseColor(s.Fill); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *canvasStep) Size(w, h int, _ *DPI) (int, int) {
	if s.W > 0 {
		w = s.W
	}
	if s.H > 0 {
		h = s.H
	}
	return w, h
}

func (s *canvasStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	sw, sh := img.Rect.Dx(), img.Rect.Dy()
	tw, th := env.TargetW, env.TargetH
	if tw == sw && th == sh {
		return img, nil
	}
	ox := int(math.Round(float64(tw-sw) * s.ax))
	oy := int(math.Round(float64(th-sh) * s.ay))
	return place(ctx, img, tw, th, ox, oy, s.fill, s.Fill == "edge")
}

// place draws src at (ox, oy) on a new tw×th image. What src does not cover
// is fill, or src's border pixels repeated (edge).
func place(ctx context.Context, src *image.RGBA, tw, th, ox, oy int, fill color.RGBA, edge bool) (*image.RGBA, error) {
	src = toRGBA(src)
	sw, sh := src.Rect.Dx(), src.Rect.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	// The destination columns src covers.
	x0, x1 := max(ox, 0), min(ox+sw, tw)
	err := Rows(ctx, tw, th, func(ya, yb int) {
		for y := ya; y < yb; y++ {
			d := dst.Pix[y*dst.Stride : y*dst.Stride+tw*4]
			sy := y - oy
			inside := sy >= 0 && sy < sh
			if !inside && !edge {
				fillRow(d, fill)
				continue
			}
			row := src.Pix[clampInt(sy, 0, sh-1)*src.Stride:]
			if x1 > x0 {
				copy(d[x0*4:x1*4], row[(x0-ox)*4:(x1-ox)*4])
			}
			if edge {
				for x := 0; x < tw; x++ {
					if x >= x0 && x < x1 {
						x = x1 - 1
						continue
					}
					so := clampInt(x-ox, 0, sw-1) * 4
					copy(d[x*4:x*4+4], row[so:so+4])
				}
				continue
			}
			if x1 <= x0 {
				fillRow(d, fill)
				continue
			}
			fillRow(d[:x0*4], fill)
			fillRow(d[x1*4:], fill)
		}
	})
	return dst, err
}

func fillRow(d []byte, c color.RGBA) {
	if c == (color.RGBA{}) {
		return // a new image is transparent already
	}
	for i := 0; i+3 < len(d); i += 4 {
		d[i], d[i+1], d[i+2], d[i+3] = c.R, c.G, c.B, c.A
	}
}

// --- dpi ---

type dpiStep struct {
	X float64 `json:"x"`
	Y float64 `json:"y,omitempty"`
	// Resample changes the pixel size so the print size stays the same;
	// otherwise only the resolution written to the file changes.
	Resample bool `json:"resample,omitempty"`
}

func parseDPI(raw json.RawMessage) (Step, error) {
	s := &dpiStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if s.Y == 0 {
		s.Y = s.X
	}
	if !(s.X >= 1 && s.X <= 10000 && s.Y >= 1 && s.Y <= 10000) {
		return nil, invalid("resolution is 1..10000 dpi")
	}
	return s, nil
}

func (s *dpiStep) Size(w, h int, dpi *DPI) (int, int) {
	old := dpi.Or()
	*dpi = DPI{s.X, s.Y}
	if !s.Resample {
		return w, h
	}
	return roundEdge(float64(w) * s.X / old.X), roundEdge(float64(h) * s.Y / old.Y)
}

func (s *dpiStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	if !s.Resample || (env.TargetW == img.Rect.Dx() && env.TargetH == img.Rect.Dy()) {
		return img, nil
	}
	k := Lanczos3
	if env.Draft {
		k = Bilinear
	}
	return Resample(ctx, img, env.TargetW, env.TargetH, k)
}
