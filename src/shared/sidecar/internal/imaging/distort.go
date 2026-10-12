package imaging

import (
	"context"
	"encoding/json"
	"image"
	"math"

	"golang.org/x/image/vector"
)

// --- lens ---

type lensStep struct {
	sameSize
	// Mode: bulge and pinch act inside a circle; barrel and pincushion on
	// the whole picture.
	Mode string `json:"mode,omitempty"`
	// Amount 0..100.
	Amount float64 `json:"amount"`
	// The centre, 0..1 of the picture (the middle when absent); it may lie
	// outside the picture (-1..2).
	CX *float64 `json:"cx,omitempty"`
	CY *float64 `json:"cy,omitempty"`
	// Radius of the circle in percent of the shorter edge (1..200), and how
	// soft its rim is (0..100).
	Radius float64 `json:"radius,omitempty"`
	Soft   float64 `json:"soft,omitempty"`

	cx, cy float64
}

func parseLens(raw json.RawMessage) (Step, error) {
	s := &lensStep{Radius: 50, cx: 0.5, cy: 0.5}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	switch s.Mode {
	case "":
		s.Mode = "bulge"
	case "bulge", "pinch", "barrel", "pincushion":
	default:
		return nil, invalid("lens mode %q", s.Mode)
	}
	if s.CX != nil {
		s.cx = *s.CX
	}
	if s.CY != nil {
		s.cy = *s.CY
	}
	if !inRange(s.Amount, 0, 100) || !inRange(s.cx, -1, 2) || !inRange(s.cy, -1, 2) ||
		!inRange(s.Radius, 1, 200) || !inRange(s.Soft, 0, 100) {
		return nil, invalid("lens: amount 0..100, centre -1..2, radius 1..200, softness 0..100")
	}
	return s, nil
}

// Apply maps every output pixel back to where it comes from and samples the
// picture there (bicubic; bilinear in a draft).
func (s *lensStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	if s.Amount == 0 {
		return img, nil
	}
	img = toRGBA(img)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	fw, fh := float64(w), float64(h)
	cx, cy := s.cx*fw, s.cy*fh
	k := s.Amount / 100
	radius := s.Radius / 100 * shortEdge(env)
	soft := s.Soft / 100
	whole := s.Mode == "barrel" || s.Mode == "pincushion"
	if whole {
		// The distance to the farthest corner is 1.
		radius = math.Hypot(math.Max(cx, fw-cx), math.Max(cy, fh-cy))
	}
	if radius < 1 {
		return img, nil
	}
	// from maps a normalized distance from the centre to the one sampled.
	from := func(r float64) float64 {
		switch s.Mode {
		case "barrel":
			c := 0.6 * k
			return r * (1 + c*r*r) / (1 + c)
		case "pincushion":
			c := -0.3 * k
			return r * (1 + c*r*r) / (1 + c)
		case "pinch":
			return math.Pow(r, 1/(1+1.5*k))
		}
		return math.Pow(r, 1+1.5*k)
	}
	table := cubicWeights()
	dst := image.NewRGBA(img.Rect)
	err := Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			src := img.Pix[y*img.Stride : y*img.Stride+w*4]
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			dy := float64(y) + 0.5 - cy
			for x := range w {
				dx := float64(x) + 0.5 - cx
				r := math.Hypot(dx, dy) / radius
				o := x * 4
				if r < 1e-6 || (!whole && r >= 1) {
					copy(d[o:o+4], src[o:o+4])
					continue
				}
				rs := from(r)
				if !whole && soft > 0 {
					// Towards the rim the picture is left more and more alone.
					rs = r + (rs-r)*(1-smooth((r-(1-soft))/soft))
				}
				sx, sy := cx+dx*rs/r-0.5, cy+dy*rs/r-0.5
				ix, iy := int(math.Floor(sx)), int(math.Floor(sy))
				wx, wy := int32((sx-float64(ix))*256), int32((sy-float64(iy))*256)
				var p [4]int32
				if env.Draft {
					p = sampleLinear(img, w, h, ix, iy, wx, wy)
				} else {
					p = sampleCubic(img, w, h, ix, iy, &table[wx&0xFF], &table[wy&0xFF])
				}
				d[o], d[o+1], d[o+2], d[o+3] = uint8(p[0]), uint8(p[1]), uint8(p[2]), uint8(p[3])
			}
		}
	})
	return dst, err
}

// --- obscure ---

// MaxPolygonPoints bounds a drawn region.
const MaxPolygonPoints = 256

type obscureStep struct {
	sameSize
	// Method: blur, pixelate or mosaic (blocks with joints).
	Method string `json:"method,omitempty"`
	// Strength 1..100.
	Strength float64 `json:"strength"`
	// Shape: rect, ellipse (both inside Rect) or polygon (Points). All
	// coordinates are 0..1 of the picture.
	Shape  string       `json:"shape,omitempty"`
	Rect   *Rect        `json:"rect,omitempty"`
	Points [][2]float64 `json:"points,omitempty"`
	// Feather fades the effect out beyond the region's edge (what was drawn
	// stays fully obscured), in percent of half its shorter side (0..100).
	Feather float64 `json:"feather,omitempty"`
	// Invert obscures everything but the region.
	Invert bool `json:"invert,omitempty"`
}

func parseObscure(raw json.RawMessage) (Step, error) {
	s := &obscureStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	switch s.Method {
	case "":
		s.Method = "blur"
	case "blur", "pixelate", "mosaic":
	default:
		return nil, invalid("obscure method %q", s.Method)
	}
	if !inRange(s.Strength, 1, 100) || !inRange(s.Feather, 0, 100) {
		return nil, invalid("obscure: strength 1..100, feather 0..100")
	}
	switch s.Shape {
	case "":
		s.Shape = "rect"
		fallthrough
	case "rect", "ellipse":
		if s.Rect == nil || len(s.Points) > 0 {
			return nil, invalid("obscure: a %s needs a rect", s.Shape)
		}
		r := *s.Rect
		if !(r.W > 0 && r.H > 0) || !inRange(r.X, -1, 2) || !inRange(r.Y, -1, 2) || r.W > 3 || r.H > 3 {
			return nil, invalid("obscure: the region is outside -1..2")
		}
	case "polygon":
		if s.Rect != nil || len(s.Points) < 3 || len(s.Points) > MaxPolygonPoints {
			return nil, invalid("obscure: a polygon has 3..%d points", MaxPolygonPoints)
		}
		for _, p := range s.Points {
			if !inRange(p[0], -1, 2) || !inRange(p[1], -1, 2) {
				return nil, invalid("obscure: a point is outside -1..2")
			}
		}
	default:
		return nil, invalid("obscure shape %q", s.Shape)
	}
	return s, nil
}

// region is the shape's bounding box in working pixels.
func (s *obscureStep) region(w, h int) (x0, y0, x1, y1 float64) {
	fw, fh := float64(w), float64(h)
	if s.Shape != "polygon" {
		return s.Rect.X * fw, s.Rect.Y * fh, (s.Rect.X + s.Rect.W) * fw, (s.Rect.Y + s.Rect.H) * fh
	}
	x0, y0, x1, y1 = math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, p := range s.Points {
		x0, y0 = math.Min(x0, p[0]*fw), math.Min(y0, p[1]*fh)
		x1, y1 = math.Max(x1, p[0]*fw), math.Max(y1, p[1]*fh)
	}
	return x0, y0, x1, y1
}

// pixelate fills box with square blocks of their average color; with joints
// the last row and column of a block are darkened.
func pixelate(ctx context.Context, img *image.RGBA, box image.Rectangle, block int, joints bool) (*image.RGBA, error) {
	out := image.NewRGBA(image.Rect(0, 0, box.Dx(), box.Dy()))
	w, h := img.Rect.Dx(), img.Rect.Dy()
	// Blocks are aligned to the picture, so they do not move with the region.
	by0, by1 := box.Min.Y/block, (box.Max.Y-1)/block
	err := Rows(ctx, box.Dx()*block, by1-by0+1, func(ra, rb int) {
		for by := by0 + ra; by < by0+rb; by++ {
			for bx := box.Min.X / block; bx <= (box.Max.X-1)/block; bx++ {
				x0, y0 := bx*block, by*block
				x1, y1 := min(x0+block, w), min(y0+block, h)
				var sum [4]int64
				for y := y0; y < y1; y++ {
					p := img.Pix[y*img.Stride+x0*4 : y*img.Stride+x1*4]
					for i := 0; i < len(p); i += 4 {
						sum[0] += int64(p[i])
						sum[1] += int64(p[i+1])
						sum[2] += int64(p[i+2])
						sum[3] += int64(p[i+3])
					}
				}
				n := int64((x1 - x0) * (y1 - y0))
				c := [4]uint8{uint8((sum[0] + n/2) / n), uint8((sum[1] + n/2) / n), uint8((sum[2] + n/2) / n), uint8((sum[3] + n/2) / n)}
				dark := [4]uint8{uint8(int(c[0]) * 3 / 4), uint8(int(c[1]) * 3 / 4), uint8(int(c[2]) * 3 / 4), c[3]}
				for y := max(y0, box.Min.Y); y < min(y1, box.Max.Y); y++ {
					row := out.Pix[(y-box.Min.Y)*out.Stride:]
					for x := max(x0, box.Min.X); x < min(x1, box.Max.X); x++ {
						v := c
						if joints && block >= 4 && (x == x0+block-1 || y == y0+block-1) {
							v = dark
						}
						o := (x - box.Min.X) * 4
						row[o], row[o+1], row[o+2], row[o+3] = v[0], v[1], v[2], v[3]
					}
				}
			}
		}
	})
	return out, err
}

func (s *obscureStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	img = toRGBA(img)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	short := shortEdge(env)
	rx0, ry0, rx1, ry1 := s.region(w, h)
	feather := s.Feather / 100 * math.Min(rx1-rx0, ry1-ry0) / 2
	// What is processed: the region with its soft edge, or everything.
	box := image.Rect(int(math.Floor(rx0-feather))-1, int(math.Floor(ry0-feather))-1,
		int(math.Ceil(rx1+feather))+1, int(math.Ceil(ry1+feather))+1).Intersect(img.Rect)
	if s.Invert {
		box = img.Rect
	}
	if box.Empty() {
		return img, nil
	}
	bw, bh := box.Dx(), box.Dy()

	// The obscured version of the box.
	var hidden *image.RGBA
	var err error
	switch s.Method {
	case "blur":
		// Up to 5 % of the shorter edge; the surroundings blur into the box.
		sigma := math.Max(s.Strength/100*0.05*short, 0.5)
		pad := int(math.Ceil(3 * sigma))
		grown := image.Rect(box.Min.X-pad, box.Min.Y-pad, box.Max.X+pad, box.Max.Y+pad).Intersect(img.Rect)
		part := image.NewRGBA(image.Rect(0, 0, grown.Dx(), grown.Dy()))
		for y := 0; y < grown.Dy(); y++ {
			so := (grown.Min.Y+y)*img.Stride + grown.Min.X*4
			copy(part.Pix[y*part.Stride:y*part.Stride+grown.Dx()*4], img.Pix[so:so+grown.Dx()*4])
		}
		blurred, berr := GaussianBlur(ctx, part, sigma)
		if berr != nil {
			return nil, berr
		}
		hidden = image.NewRGBA(image.Rect(0, 0, bw, bh))
		ox, oy := box.Min.X-grown.Min.X, box.Min.Y-grown.Min.Y
		for y := 0; y < bh; y++ {
			so := (y+oy)*blurred.Stride + ox*4
			copy(hidden.Pix[y*hidden.Stride:y*hidden.Stride+bw*4], blurred.Pix[so:so+bw*4])
		}
	default:
		// Blocks of up to 8 % of the shorter edge.
		block := max(2, int(math.Round(s.Strength/100*0.08*short)))
		if hidden, err = pixelate(ctx, img, box, block, s.Method == "mosaic"); err != nil {
			return nil, err
		}
	}

	// The region as coverage over the box.
	var drawn []uint8
	if s.Shape == "polygon" {
		z := vector.NewRasterizer(bw, bh)
		for i, p := range s.Points {
			x, y := float32(p[0]*float64(w))-float32(box.Min.X), float32(p[1]*float64(h))-float32(box.Min.Y)
			if i == 0 {
				z.MoveTo(x, y)
			} else {
				z.LineTo(x, y)
			}
		}
		z.ClosePath()
		alpha := image.NewAlpha(image.Rect(0, 0, bw, bh))
		z.Draw(alpha, alpha.Rect, image.Opaque, image.Point{})
		drawn = alpha.Pix
		if feather > 1 {
			// Blurred and doubled: full up to the outline, fading beyond it.
			if err := blurPlane(ctx, drawn, bw, bh, feather/2); err != nil {
				return nil, err
			}
			for i, v := range drawn {
				drawn[i] = uint8(min(int(v)*2, 255))
			}
		}
	}
	inside := func(x, y int) int32 {
		if drawn != nil {
			return int32(drawn[y*bw+x]) * 256 / 255
		}
		cx, cy := float64(x+box.Min.X)+0.5, float64(y+box.Min.Y)+0.5
		// The soft part lies outside the shape.
		out := 0.0
		if feather > 1 {
			out = feather
		}
		if s.Shape == "ellipse" {
			return cov256(edge(sdEllipse(cx, cy, (rx0+rx1)/2, (ry0+ry1)/2, (rx1-rx0)/2, (ry1-ry0)/2)-out, feather))
		}
		return cov256(edge(sdRoundRect(cx, cy, rx0, ry0, rx1, ry1, 0)-out, feather))
	}

	dst := image.NewRGBA(img.Rect)
	copy(dst.Pix, img.Pix)
	err = Rows(ctx, bw, bh, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			d := dst.Pix[(y+box.Min.Y)*dst.Stride+box.Min.X*4:]
			src := hidden.Pix[y*hidden.Stride : y*hidden.Stride+bw*4]
			for x := range bw {
				a := inside(x, y)
				if s.Invert {
					a = 256 - a
				}
				mixPix(d[x*4:x*4+4], src[x*4:x*4+4], a)
			}
		}
	})
	return dst, err
}
