package imaging

import (
	"context"
	"image"
	"math"
)

// Kernel is a resampling filter of the editor's resize (ADR-0035). The
// filters are separable and run in fixed point, so the result is the same
// for every worker count.
type Kernel int

const (
	Nearest Kernel = iota
	Bilinear
	CatmullRom
	Lanczos3
)

// KernelNames are the wire names of the kernels.
var KernelNames = map[string]Kernel{"nearest": Nearest, "bilinear": Bilinear, "catmull": CatmullRom, "lanczos3": Lanczos3}

func (k Kernel) support() float64 {
	switch k {
	case Bilinear:
		return 1
	case CatmullRom:
		return 2
	case Lanczos3:
		return 3
	}
	return 0.5
}

func (k Kernel) at(x float64) float64 {
	x = math.Abs(x)
	switch k {
	case Bilinear:
		if x < 1 {
			return 1 - x
		}
	case CatmullRom:
		switch {
		case x < 1:
			return (1.5*x-2.5)*x*x + 1
		case x < 2:
			return ((-0.5*x+2.5)*x-4)*x + 2
		}
	case Lanczos3:
		switch {
		case x < 1e-9:
			return 1
		case x < 3:
			px := math.Pi * x
			return 3 * math.Sin(px) * math.Sin(px/3) / (px * px)
		}
	}
	return 0
}

// weightBits is the fixed-point precision of a filter weight.
const weightBits = 14

// contrib lists the source samples of one destination sample: weights[i]
// applies to source index start+i and the weights sum to 1<<weightBits.
type contrib struct {
	start   int
	weights []int32
}

// contributions builds the filter of every destination index when n source
// samples map onto m. Downscaling widens the kernel, so it also low-passes.
func contributions(n, m int, k Kernel) []contrib {
	scale := float64(n) / float64(m)
	fscale := math.Max(scale, 1)
	support := k.support() * fscale
	out := make([]contrib, m)
	buf := make([]float64, 0, int(2*support)+3)
	for i := range out {
		center := (float64(i)+0.5)*scale - 0.5
		lo := max(int(math.Ceil(center-support)), 0)
		hi := min(int(math.Floor(center+support)), n-1)
		if hi < lo { // a kernel that falls between samples at the border
			lo = min(max(int(math.Round(center)), 0), n-1)
			hi = lo
		}
		buf = buf[:0]
		sum := 0.0
		for s := lo; s <= hi; s++ {
			w := k.at((float64(s) - center) / fscale)
			buf = append(buf, w)
			sum += w
		}
		if sum == 0 {
			buf[len(buf)/2], sum = 1, 1
		}
		ws := make([]int32, len(buf))
		total, largest := int32(0), 0
		for j, w := range buf {
			ws[j] = int32(math.Round(w / sum * (1 << weightBits)))
			total += ws[j]
			if ws[j] > ws[largest] {
				largest = j
			}
		}
		ws[largest] += 1<<weightBits - total // the weights sum exactly
		out[i] = contrib{start: lo, weights: ws}
	}
	return out
}

func clamp8(v int32) uint8 {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v)
}

// Resample scales src to tw×th with k. src is not modified. Premultiplied
// alpha is filtered as stored, and colors are kept within alpha afterwards
// (a kernel with negative lobes can overshoot).
func Resample(ctx context.Context, src *image.RGBA, tw, th int, k Kernel) (*image.RGBA, error) {
	src = toRGBA(src)
	sw, sh := src.Rect.Dx(), src.Rect.Dy()
	tw, th = max(tw, 1), max(th, 1)
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	if k == Nearest {
		xs := make([]int, tw)
		for x := range xs {
			xs[x] = min((2*x+1)*sw/(2*tw), sw-1) * 4
		}
		err := Rows(ctx, tw, th, func(y0, y1 int) {
			for y := y0; y < y1; y++ {
				row := src.Pix[min((2*y+1)*sh/(2*th), sh-1)*src.Stride:]
				d := dst.Pix[y*dst.Stride : y*dst.Stride+tw*4]
				for x, so := range xs {
					copy(d[x*4:x*4+4], row[so:so+4])
				}
			}
		})
		return dst, err
	}
	// Horizontal pass into tw×sh, then vertical into tw×th.
	mid := src
	if tw != sw {
		cx := contributions(sw, tw, k)
		mid = image.NewRGBA(image.Rect(0, 0, tw, sh))
		if err := Rows(ctx, tw, sh, func(y0, y1 int) {
			for y := y0; y < y1; y++ {
				row := src.Pix[y*src.Stride:]
				d := mid.Pix[y*mid.Stride:]
				for x, c := range cx {
					var r, g, b, a int32
					o := c.start * 4
					for _, w := range c.weights {
						r += int32(row[o]) * w
						g += int32(row[o+1]) * w
						b += int32(row[o+2]) * w
						a += int32(row[o+3]) * w
						o += 4
					}
					const half = 1 << (weightBits - 1)
					d[x*4] = clamp8((r + half) >> weightBits)
					d[x*4+1] = clamp8((g + half) >> weightBits)
					d[x*4+2] = clamp8((b + half) >> weightBits)
					d[x*4+3] = clamp8((a + half) >> weightBits)
				}
			}
		}); err != nil {
			return dst, err
		}
	}
	if th == sh {
		copy(dst.Pix, mid.Pix)
		return dst, clampToAlpha(ctx, dst, k)
	}
	cy := contributions(sh, th, k)
	if err := Rows(ctx, tw, th, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			c := cy[y]
			d := dst.Pix[y*dst.Stride : y*dst.Stride+tw*4]
			for x := 0; x < tw*4; x += 4 {
				var r, g, b, a int32
				o := c.start*mid.Stride + x
				for _, w := range c.weights {
					r += int32(mid.Pix[o]) * w
					g += int32(mid.Pix[o+1]) * w
					b += int32(mid.Pix[o+2]) * w
					a += int32(mid.Pix[o+3]) * w
					o += mid.Stride
				}
				const half = 1 << (weightBits - 1)
				d[x] = clamp8((r + half) >> weightBits)
				d[x+1] = clamp8((g + half) >> weightBits)
				d[x+2] = clamp8((b + half) >> weightBits)
				d[x+3] = clamp8((a + half) >> weightBits)
			}
		}
	}); err != nil {
		return dst, err
	}
	return dst, clampToAlpha(ctx, dst, k)
}

// clampToAlpha keeps premultiplied colors valid after a kernel with
// negative lobes.
func clampToAlpha(ctx context.Context, img *image.RGBA, k Kernel) error {
	if k != CatmullRom && k != Lanczos3 {
		return ctx.Err()
	}
	w, h := img.Rect.Dx(), img.Rect.Dy()
	return Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			row := img.Pix[y*img.Stride : y*img.Stride+w*4]
			for i := 0; i < len(row); i += 4 {
				if a := row[i+3]; a != 0xFF {
					row[i], row[i+1], row[i+2] = min(row[i], a), min(row[i+1], a), min(row[i+2], a)
				}
			}
		}
	})
}
