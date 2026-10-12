package imaging

import (
	"context"
	"encoding/json"
	"image"
	"math"
)

// --- bump map ---

type bumpStep struct {
	sameSize
	// Source of the heights: "picture" (its own brightness) or "texture"
	// (an asset, tiled or stretched over the picture).
	Source  string `json:"source,omitempty"`
	AssetID string `json:"assetId,omitempty"`
	Tile    bool   `json:"tile,omitempty"`
	// Angle is where the light comes from in degrees (0 from the right, 90
	// from the top); Elevation its height above the surface (5..90).
	Angle     float64 `json:"angle,omitempty"`
	Elevation float64 `json:"elevation,omitempty"`
	// Height of the relief (0..100) and Smooth, a blur of the heights in
	// pixels of the full picture (0..20).
	Height float64 `json:"height"`
	Smooth float64 `json:"smooth,omitempty"`
	// Color: 0 is a gray relief, 100 the picture itself, lit.
	Color float64 `json:"color,omitempty"`
}

func parseBump(raw json.RawMessage) (Step, error) {
	s := &bumpStep{Elevation: 45}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	switch s.Source {
	case "":
		s.Source = "picture"
	case "picture":
	case "texture":
		if !validAssetID(s.AssetID) {
			return nil, invalid("bump map: a texture needs an asset")
		}
	default:
		return nil, invalid("bump map source %q", s.Source)
	}
	if s.Source == "picture" && s.AssetID != "" {
		return nil, invalid("bump map: only a texture takes an asset")
	}
	if !inRange(s.Angle, -360, 360) || !inRange(s.Elevation, 5, 90) || !inRange(s.Height, 0, 100) ||
		!inRange(s.Smooth, 0, 20) || !inRange(s.Color, 0, 100) {
		return nil, invalid("bump map: angle -360..360, elevation 5..90, height 0..100, smooth 0..20, color 0..100")
	}
	return s, nil
}

// heights builds the height field for a w×h working picture, padded by one
// pixel on every side (the border repeated).
func (s *bumpStep) heights(ctx context.Context, img *image.RGBA, env *Env) ([]uint8, int, error) {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	src := img
	tiled := false
	if s.Source == "texture" {
		asset, err := env.asset(ctx, s.AssetID)
		if err != nil {
			return nil, 0, err
		}
		if s.Tile {
			// A texture pixel is a pixel of the full picture.
			tw := max(1, int(math.Round(float64(asset.Rect.Dx())*env.Scale)))
			th := max(1, int(math.Round(float64(asset.Rect.Dy())*env.Scale)))
			if src, err = Resample(ctx, asset, tw, th, Bilinear); err != nil {
				return nil, 0, err
			}
			tiled = true
		} else if src, err = Resample(ctx, asset, w, h, Bilinear); err != nil {
			return nil, 0, err
		}
	}
	sw, sh := src.Rect.Dx(), src.Rect.Dy()
	flat := make([]uint8, w*h)
	if err := Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			yy := y
			if tiled {
				yy = y % sh
			}
			row := src.Pix[yy*src.Stride:]
			for x := range w {
				xx := x
				if tiled {
					xx = x % sw
				}
				flat[y*w+x] = Luma(row[xx*4], row[xx*4+1], row[xx*4+2])
			}
		}
	}); err != nil {
		return nil, 0, err
	}
	if err := blurPlane(ctx, flat, w, h, s.Smooth*env.Scale); err != nil {
		return nil, 0, err
	}
	stride := w + 2
	plane := make([]uint8, stride*(h+2))
	for y := -1; y <= h; y++ {
		row := flat[clampInt(y, 0, h-1)*w:]
		out := plane[(y+1)*stride:]
		copy(out[1:1+w], row[:w])
		out[0], out[w+1] = row[0], row[w-1]
	}
	return plane, stride, nil
}

func (s *bumpStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	if s.Height == 0 {
		return img, nil
	}
	img = toRGBA(img)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	plane, stride, err := s.heights(ctx, img, env)
	if err != nil {
		return nil, err
	}
	az, el := s.Angle*math.Pi/180, s.Elevation*math.Pi/180
	// The light, with y pointing down the picture.
	lx, ly, lz := math.Cos(el)*math.Cos(az), -math.Cos(el)*math.Sin(az), math.Sin(el)
	// Slopes are per pixel of the full picture, so a proxy looks the same.
	k := s.Height / 100 * 6 / 255 * env.Scale
	mix := s.Color / 100
	dst := image.NewRGBA(img.Rect)
	err = Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			src := img.Pix[y*img.Stride : y*img.Stride+w*4]
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			up, mid, down := plane[y*stride:], plane[(y+1)*stride:], plane[(y+2)*stride:]
			for x := range w {
				gx := (float64(mid[x+2]) - float64(mid[x])) * k
				gy := (float64(down[x+1]) - float64(up[x+1])) * k
				// The surface normal is (-gx, -gy, 1), normalized.
				lit := (-gx*lx - gy*ly + lz) / math.Sqrt(gx*gx+gy*gy+1)
				ratio := math.Max(lit, 0) / lz
				o := x * 4
				a := src[o+3]
				gray := 128 * ratio * float64(a) / 255
				for c := range 3 {
					v := gray*(1-mix) + float64(src[o+c])*ratio*mix
					d[o+c] = uint8(math.Min(math.Max(v+0.5, 0), float64(a)))
				}
				d[o+3] = a
			}
		}
	})
	return dst, err
}

// plain is the straight value of a premultiplied channel; a fully
// transparent pixel has none and counts as black.
func plain(c, a uint8) uint8 {
	switch a {
	case 0:
		return 0
	case 255:
		return c
	}
	return unmul(c, a)
}

// --- sketch ---

type sketchStep struct {
	sameSize
	// Style: pencil, ink or color (colored pencil).
	Style string `json:"style,omitempty"`
	// Detail 0..100: from broad strokes to fine lines.
	Detail float64 `json:"detail,omitempty"`
	// Strength of the lines, 0..100.
	Strength float64 `json:"strength,omitempty"`
	// Paper 0..100: from white to a warm paper tone.
	Paper float64 `json:"paper,omitempty"`
	// Color 0..100: how much of the picture's color shows (color style).
	Color float64 `json:"color,omitempty"`
}

func parseSketch(raw json.RawMessage) (Step, error) {
	s := &sketchStep{Detail: 50, Strength: 50}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	switch s.Style {
	case "":
		s.Style = "pencil"
	case "pencil", "ink", "color":
	default:
		return nil, invalid("sketch style %q", s.Style)
	}
	if !inRange(s.Detail, 0, 100) || !inRange(s.Strength, 0, 100) || !inRange(s.Paper, 0, 100) || !inRange(s.Color, 0, 100) {
		return nil, invalid("sketch: detail, strength, paper and color are 0..100")
	}
	return s, nil
}

// Apply draws the picture as lines: its brightness divided by a blurred
// copy of itself is white where nothing changes and dark along edges (the
// "color dodge" pencil effect), then darkened to taste.
func (s *sketchStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	img = toRGBA(img)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	gray := make([]uint8, w*h)
	if err := Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			p := img.Pix[y*img.Stride : y*img.Stride+w*4]
			for x := range w {
				a := p[x*4+3]
				gray[y*w+x] = Luma(plain(p[x*4], a), plain(p[x*4+1], a), plain(p[x*4+2], a))
			}
		}
	}); err != nil {
		return nil, err
	}
	soft := append([]uint8(nil), gray...)
	// Fine detail is a small blur: 1.5 to 12 pixels of the full picture.
	sigma := (1.5 + (100-s.Detail)/100*10.5) * env.Scale
	if err := blurPlane(ctx, soft, w, h, math.Max(sigma, minSigma)); err != nil {
		return nil, err
	}
	// The line darkness as a table: a gamma, and for ink a hard step.
	var table [256]uint8
	gamma := 1 + s.Strength/100*5
	for i := range table {
		v := math.Pow(float64(i)/255, gamma)
		if s.Style == "ink" {
			v = smooth((v - 0.45) / 0.25)
		}
		table[i] = uint8(v*255 + 0.5)
	}
	// Paper: white to a warm tone.
	p := s.Paper / 100
	paper := [3]float64{255 - 14*p, 255 - 24*p, 255 - 47*p}
	amount := 0.0
	if s.Style == "color" {
		amount = s.Color / 100
	}
	dst := image.NewRGBA(img.Rect)
	err := Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			src := img.Pix[y*img.Stride : y*img.Stride+w*4]
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			for x := range w {
				g, b := int32(gray[y*w+x]), int32(soft[y*w+x])
				line := float64(table[min(g*255/(b+1), 255)])
				o := x * 4
				a := src[o+3]
				for c := range 3 {
					v := line
					if amount > 0 {
						// The picture, washed out, under the lines.
						pic := 255 - (255-float64(plain(src[o+c], a)))*0.7
						v = line*(1-amount) + pic*line/255*amount
					}
					d[o+c] = mul(uint8(v*paper[c]/255+0.5), a)
				}
				d[o+3] = a
			}
		}
	})
	return dst, err
}

// --- oil painting ---

type oilStep struct {
	sameSize
	// Radius of the brush in pixels of the full picture (1..12).
	Radius float64 `json:"radius"`
	// Levels of brightness the brush tells apart (4..64, 20 when absent).
	Levels int `json:"levels,omitempty"`
}

func parseOil(raw json.RawMessage) (Step, error) {
	s := &oilStep{Levels: 20}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if !inRange(s.Radius, 1, 12) || s.Levels < 4 || s.Levels > 64 {
		return nil, invalid("oil painting: radius 1..12 pixels, levels 4..64")
	}
	return s, nil
}

// Apply paints each pixel in the average color of the brightness level that
// is most common around it. The window slides along a row: a column leaves
// and one enters, so the cost grows with the radius, not with its square.
func (s *oilStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	img = toRGBA(img)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	r := max(1, int(math.Round(s.Radius*env.Scale)))
	levels := int32(s.Levels)
	// The level of every pixel, once.
	bin := make([]uint8, w*h)
	if err := Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			p := img.Pix[y*img.Stride : y*img.Stride+w*4]
			for x := range w {
				bin[y*w+x] = uint8(int32(Luma(p[x*4], p[x*4+1], p[x*4+2])) * levels >> 8)
			}
		}
	}); err != nil {
		return nil, err
	}
	dst := image.NewRGBA(img.Rect)
	err := Rows(ctx, w, h, func(ya, yb int) {
		count := make([]int32, levels)
		sum := make([][4]int32, levels)
		for y := ya; y < yb; y++ {
			clear(count)
			clear(sum)
			top, bottom := max(y-r, 0), min(y+r, h-1)
			column := func(x int, sign int32) {
				for yy := top; yy <= bottom; yy++ {
					b := bin[yy*w+x]
					p := img.Pix[yy*img.Stride+x*4:]
					count[b] += sign
					sum[b][0] += sign * int32(p[0])
					sum[b][1] += sign * int32(p[1])
					sum[b][2] += sign * int32(p[2])
					sum[b][3] += sign * int32(p[3])
				}
			}
			for x := 0; x <= min(r, w-1); x++ {
				column(x, 1)
			}
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			for x := range w {
				best := int32(0)
				for b := int32(1); b < levels; b++ {
					if count[b] > count[best] {
						best = b
					}
				}
				n := count[best]
				o := x * 4
				d[o] = uint8((sum[best][0] + n/2) / n)
				d[o+1] = uint8((sum[best][1] + n/2) / n)
				d[o+2] = uint8((sum[best][2] + n/2) / n)
				d[o+3] = uint8((sum[best][3] + n/2) / n)
				if x-r >= 0 {
					column(x-r, -1)
				}
				if x+r+1 < w {
					column(x+r+1, 1)
				}
			}
		}
	})
	return dst, err
}
