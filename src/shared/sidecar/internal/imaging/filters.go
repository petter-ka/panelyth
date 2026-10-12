package imaging

import (
	"context"
	"encoding/json"
	"image"
	"math"
)

// The neighborhood operations of the editor (Stage 13): blur, sharpen and
// denoise. A radius is given in pixels of the full picture and scaled to the
// working size, so the proxy shows what the save will make. Every pass reads
// one buffer and writes another in row or column bands, with integer
// arithmetic, so the result does not depend on the worker count.

func init() {
	RegisterOp("blur", OpInfo{Version: 1, Batchable: true, Parse: parseBlur})
	RegisterOp("sharpen", OpInfo{Version: 1, Batchable: true, Parse: parseSharpen})
	RegisterOp("denoise", OpInfo{Version: 1, Batchable: true, Parse: parseDenoise})
}

// sameSize is the Size of an operation that keeps the picture's size.
type sameSize struct{}

func (sameSize) Size(w, h int, _ *DPI) (int, int) { return w, h }

// boxH blurs every row of src into dst with a window of 2r+1 pixels; the
// edge pixels repeat beyond the border.
func boxH(ctx context.Context, src, dst *image.RGBA, r int) error {
	w, h := src.Rect.Dx(), src.Rect.Dy()
	win := int32(2*r + 1)
	return Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			row := src.Pix[y*src.Stride : y*src.Stride+w*4]
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			var sum [4]int32
			for i := -r; i <= r; i++ {
				p := clampInt(i, 0, w-1) * 4
				sum[0] += int32(row[p])
				sum[1] += int32(row[p+1])
				sum[2] += int32(row[p+2])
				sum[3] += int32(row[p+3])
			}
			for x := range w {
				o := x * 4
				d[o] = uint8((sum[0] + win/2) / win)
				d[o+1] = uint8((sum[1] + win/2) / win)
				d[o+2] = uint8((sum[2] + win/2) / win)
				d[o+3] = uint8((sum[3] + win/2) / win)
				out, in := clampInt(x-r, 0, w-1)*4, clampInt(x+r+1, 0, w-1)*4
				sum[0] += int32(row[in]) - int32(row[out])
				sum[1] += int32(row[in+1]) - int32(row[out+1])
				sum[2] += int32(row[in+2]) - int32(row[out+2])
				sum[3] += int32(row[in+3]) - int32(row[out+3])
			}
		}
	})
}

// boxV is boxH down the columns, a band of columns at a time.
func boxV(ctx context.Context, src, dst *image.RGBA, r int) error {
	w, h := src.Rect.Dx(), src.Rect.Dy()
	win := int32(2*r + 1)
	return Rows(ctx, h, w, func(x0, x1 int) {
		n := (x1 - x0) * 4
		sums := make([]int32, n)
		for i := -r; i <= r; i++ {
			row := src.Pix[clampInt(i, 0, h-1)*src.Stride+x0*4:]
			for k := range n {
				sums[k] += int32(row[k])
			}
		}
		for y := range h {
			d := dst.Pix[y*dst.Stride+x0*4:]
			out := src.Pix[clampInt(y-r, 0, h-1)*src.Stride+x0*4:]
			in := src.Pix[clampInt(y+r+1, 0, h-1)*src.Stride+x0*4:]
			for k := range n {
				d[k] = uint8((sums[k] + win/2) / win)
				sums[k] += int32(in[k]) - int32(out[k])
			}
		}
	})
}

// boxRadii are the radii of three box blurs that together approximate a
// Gaussian of the given sigma (the widths whose variances add up to it).
func boxRadii(sigma float64) [3]int {
	const n = 3
	ideal := math.Sqrt(12*sigma*sigma/n + 1)
	lo := int(math.Floor(ideal))
	if lo%2 == 0 {
		lo--
	}
	m := int(math.Round((12*sigma*sigma - float64(n*lo*lo+4*n*lo+3*n)) / float64(-4*lo-4)))
	var r [3]int
	for i := range r {
		w := lo
		if i >= m {
			w += 2
		}
		r[i] = max((w-1)/2, 0)
	}
	return r
}

// convolve applies a small kernel along rows (horizontal) or columns.
func convolve(ctx context.Context, src, dst *image.RGBA, k []int32, horizontal bool) error {
	w, h := src.Rect.Dx(), src.Rect.Dy()
	r := len(k) / 2
	return Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			for x := range w {
				var s [4]int32
				for i, wt := range k {
					var o int
					if horizontal {
						o = y*src.Stride + clampInt(x+i-r, 0, w-1)*4
					} else {
						o = clampInt(y+i-r, 0, h-1)*src.Stride + x*4
					}
					s[0] += int32(src.Pix[o]) * wt
					s[1] += int32(src.Pix[o+1]) * wt
					s[2] += int32(src.Pix[o+2]) * wt
					s[3] += int32(src.Pix[o+3]) * wt
				}
				const half = 1 << (weightBits - 1)
				o := x * 4
				d[o] = clamp8((s[0] + half) >> weightBits)
				d[o+1] = clamp8((s[1] + half) >> weightBits)
				d[o+2] = clamp8((s[2] + half) >> weightBits)
				d[o+3] = clamp8((s[3] + half) >> weightBits)
			}
		}
	})
}

// gaussKernel is a normalized Gaussian in weightBits fixed point.
func gaussKernel(sigma float64) []int32 {
	r := max(int(math.Ceil(3*sigma)), 1)
	f := make([]float64, 2*r+1)
	sum := 0.0
	for i := range f {
		x := float64(i - r)
		f[i] = math.Exp(-x * x / (2 * sigma * sigma))
		sum += f[i]
	}
	k := make([]int32, len(f))
	total := int32(0)
	for i, v := range f {
		k[i] = int32(math.Round(v / sum * (1 << weightBits)))
		total += k[i]
	}
	k[r] += 1<<weightBits - total
	return k
}

// minSigma: below this a blur changes nothing worth a pass.
const minSigma = 0.25

// GaussianBlur blurs img with the given sigma in working pixels. A small
// sigma uses the exact kernel; a larger one three box blurs, whose cost does
// not grow with the radius. img is not modified; a sigma too small to
// matter returns img itself.
func GaussianBlur(ctx context.Context, img *image.RGBA, sigma float64) (*image.RGBA, error) {
	img = toRGBA(img)
	if sigma < minSigma {
		return img, ctx.Err()
	}
	a := image.NewRGBA(img.Rect)
	b := image.NewRGBA(img.Rect)
	if sigma < 2 {
		k := gaussKernel(sigma)
		if err := convolve(ctx, img, a, k, true); err != nil {
			return nil, err
		}
		return b, convolve(ctx, a, b, k, false)
	}
	src := img
	for _, r := range boxRadii(sigma) {
		if err := boxH(ctx, src, a, r); err != nil {
			return nil, err
		}
		if err := boxV(ctx, a, b, r); err != nil {
			return nil, err
		}
		src = b
		// b is read by the next horizontal pass into a, then written again.
	}
	return b, ctx.Err()
}

// --- blur ---

type blurStep struct {
	sameSize
	// Type: "gaussian", "box" or "motion".
	Type string `json:"type,omitempty"`
	// Radius in pixels of the full picture (0..100); for motion, the length.
	Radius float64 `json:"radius"`
	// Angle of a motion blur in degrees.
	Angle float64 `json:"angle,omitempty"`
}

func parseBlur(raw json.RawMessage) (Step, error) {
	s := &blurStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	switch s.Type {
	case "":
		s.Type = "gaussian"
	case "gaussian", "box", "motion":
	default:
		return nil, invalid("blur type %q", s.Type)
	}
	if !inRange(s.Radius, 0, 100) || !inRange(s.Angle, -180, 180) {
		return nil, invalid("blur radius is 0..100 pixels, angle -180..180")
	}
	return s, nil
}

func (s *blurStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	r := s.Radius * env.Scale
	switch s.Type {
	case "box":
		n := int(math.Round(r))
		if n < 1 {
			return img, nil
		}
		a, b := image.NewRGBA(img.Rect), image.NewRGBA(img.Rect)
		if err := boxH(ctx, img, a, n); err != nil {
			return nil, err
		}
		return b, boxV(ctx, a, b, n)
	case "motion":
		return motionBlur(ctx, img, r, s.Angle)
	}
	return GaussianBlur(ctx, img, r)
}

// motionBlur averages each pixel along a line of the given length.
func motionBlur(ctx context.Context, img *image.RGBA, length, angle float64) (*image.RGBA, error) {
	n := int(math.Round(length))
	if n < 2 {
		return img, nil
	}
	n = min(n, 400)
	sin, cos := math.Sincos(angle * math.Pi / 180)
	// The pixel offsets of the line, each once.
	type off struct{ dx, dy int }
	var offs []off
	for i := range n {
		t := float64(i) - float64(n-1)/2
		o := off{int(math.Round(float64(cos * t))), int(math.Round(float64(sin * t)))}
		if len(offs) == 0 || offs[len(offs)-1] != o {
			offs = append(offs, o)
		}
	}
	w, h := img.Rect.Dx(), img.Rect.Dy()
	dst := image.NewRGBA(img.Rect)
	count := int32(len(offs))
	err := Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			for x := range w {
				var s [4]int32
				for _, o := range offs {
					p := clampInt(y+o.dy, 0, h-1)*img.Stride + clampInt(x+o.dx, 0, w-1)*4
					s[0] += int32(img.Pix[p])
					s[1] += int32(img.Pix[p+1])
					s[2] += int32(img.Pix[p+2])
					s[3] += int32(img.Pix[p+3])
				}
				i := x * 4
				d[i], d[i+1], d[i+2], d[i+3] = uint8((s[0]+count/2)/count), uint8((s[1]+count/2)/count), uint8((s[2]+count/2)/count), uint8((s[3]+count/2)/count)
			}
		}
	})
	return dst, err
}

// --- sharpen ---

type sharpenStep struct {
	sameSize
	// Amount in percent (0..500), Radius in pixels of the full picture
	// (0.1..20), Threshold 0..255: differences below it are left alone.
	Amount    float64 `json:"amount"`
	Radius    float64 `json:"radius"`
	Threshold float64 `json:"threshold,omitempty"`
}

func parseSharpen(raw json.RawMessage) (Step, error) {
	s := &sharpenStep{Radius: 1}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if !inRange(s.Amount, 0, 500) || !inRange(s.Radius, 0.1, 20) || !inRange(s.Threshold, 0, 255) {
		return nil, invalid("sharpen: amount 0..500, radius 0.1..20, threshold 0..255")
	}
	return s, nil
}

// Apply is an unsharp mask: the picture plus Amount times its difference
// from a blurred copy. Alpha is not sharpened.
func (s *sharpenStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	if s.Amount == 0 {
		return img, nil
	}
	img = toRGBA(img)
	blurred, err := GaussianBlur(ctx, img, math.Max(s.Radius*env.Scale, minSigma))
	if err != nil {
		return nil, err
	}
	amount := int32(math.Round(s.Amount / 100 * 256))
	threshold := int32(math.Round(s.Threshold))
	w, h := img.Rect.Dx(), img.Rect.Dy()
	// The blurred copy is ours: the result is written over it.
	dst := blurred
	err = Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			o := img.Pix[y*img.Stride : y*img.Stride+w*4]
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			for i := 0; i < len(o); i += 4 {
				a := o[i+3]
				for c := range 3 {
					diff := int32(o[i+c]) - int32(d[i+c])
					v := int32(o[i+c])
					if diff >= threshold || -diff >= threshold {
						v += (diff*amount + 128) >> 8
					}
					// Premultiplied colors stay within alpha.
					d[i+c] = uint8(min(max(v, 0), int32(a)))
				}
				d[i+3] = a
			}
		}
	})
	return dst, err
}

// --- denoise ---

type denoiseStep struct {
	sameSize
	// Luminance and Color: strength 0..100. Detail 0..100: how much fine
	// structure is protected. Quality: "fast" (edge-preserving bilateral)
	// or "high" (non-local means: slower, keeps texture better).
	Luminance float64 `json:"luminance"`
	Color     float64 `json:"color,omitempty"`
	Detail    float64 `json:"detail,omitempty"`
	Quality   string  `json:"quality,omitempty"`
}

func parseDenoise(raw json.RawMessage) (Step, error) {
	s := &denoiseStep{Detail: 50}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if s.Quality == "" {
		s.Quality = "fast"
	}
	if s.Quality != "fast" && s.Quality != "high" {
		return nil, invalid("denoise quality %q", s.Quality)
	}
	if !inRange(s.Luminance, 0, 100) || !inRange(s.Color, 0, 100) || !inRange(s.Detail, 0, 100) {
		return nil, invalid("denoise values are 0..100")
	}
	return s, nil
}

// lumaPlane is the luminance of every pixel, padded by pad pixels of
// repeated border on each side, so a window never needs a bounds check.
func lumaPlane(ctx context.Context, img *image.RGBA, pad int) ([]uint8, int, error) {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	stride := w + 2*pad
	plane := make([]uint8, stride*(h+2*pad))
	err := Rows(ctx, w, h+2*pad, func(y0, y1 int) {
		for py := y0; py < y1; py++ {
			row := img.Pix[clampInt(py-pad, 0, h-1)*img.Stride:]
			d := plane[py*stride : (py+1)*stride]
			for px := range d {
				o := clampInt(px-pad, 0, w-1) * 4
				d[px] = Luma(row[o], row[o+1], row[o+2])
			}
		}
	})
	return plane, stride, err
}

// rangeWeights is exp(-d²/2σ²) for d = 0..255, in 1/256.
func rangeWeights(sigma float64) *[256]int32 {
	var t [256]int32
	for d := range t {
		t[d] = int32(math.Round(256 * math.Exp(-float64(d*d)/(2*sigma*sigma))))
	}
	return &t
}

func (s *denoiseStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	if s.Luminance == 0 && s.Color == 0 {
		return img, nil
	}
	img = toRGBA(img)
	out := img
	var err error
	if s.Luminance > 0 {
		// More detail protection narrows what counts as "the same surface".
		sigma := s.Luminance / 100 * 40 * (1 - s.Detail/200)
		sigma = math.Max(sigma, 1)
		if s.Quality == "high" {
			out, err = nonLocalMeans(ctx, img, sigma, env.Draft)
		} else {
			out, err = bilateral(ctx, img, sigma, s.Luminance > 50 && !env.Draft)
		}
		if err != nil {
			return nil, err
		}
	}
	if s.Color > 0 {
		// Color noise is coarse and the eye is forgiving about color
		// detail: the colors are blurred, the brightness is kept.
		soft, err := GaussianBlur(ctx, out, math.Max(s.Color/100*6*env.Scale, 0.8))
		if err != nil {
			return nil, err
		}
		w, h := img.Rect.Dx(), img.Rect.Dy()
		keep := out
		err = Rows(ctx, w, h, func(y0, y1 int) {
			for y := y0; y < y1; y++ {
				k := keep.Pix[y*keep.Stride : y*keep.Stride+w*4]
				d := soft.Pix[y*soft.Stride : y*soft.Stride+w*4]
				for i := 0; i < len(k); i += 4 {
					a := k[i+3]
					shift := int32(Luma(k[i], k[i+1], k[i+2])) - int32(Luma(d[i], d[i+1], d[i+2]))
					d[i] = uint8(min(max(int32(d[i])+shift, 0), int32(a)))
					d[i+1] = uint8(min(max(int32(d[i+1])+shift, 0), int32(a)))
					d[i+2] = uint8(min(max(int32(d[i+2])+shift, 0), int32(a)))
					d[i+3] = a
				}
			}
		})
		if err != nil {
			return nil, err
		}
		out = soft
	}
	return out, nil
}

// bilateral averages each pixel with its neighbours, weighting them by how
// close they are and how similar their brightness is, so edges stay.
func bilateral(ctx context.Context, img *image.RGBA, sigma float64, wide bool) (*image.RGBA, error) {
	r := 2
	if wide {
		r = 3
	}
	plane, stride, err := lumaPlane(ctx, img, r)
	if err != nil {
		return nil, err
	}
	rw := rangeWeights(sigma)
	// Spatial weights, a Gaussian over the window, in 1/16.
	side := 2*r + 1
	sw := make([]int32, side*side)
	for dy := -r; dy <= r; dy++ {
		for dx := -r; dx <= r; dx++ {
			sw[(dy+r)*side+dx+r] = int32(math.Round(16 * math.Exp(-float64(dx*dx+dy*dy)/(2*float64(r*r)/2.25))))
		}
	}
	w, h := img.Rect.Dx(), img.Rect.Dy()
	dst := image.NewRGBA(img.Rect)
	err = Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			for x := range w {
				center := int32(plane[(y+r)*stride+x+r])
				var sr, sg, sb, sum int32
				for dy := -r; dy <= r; dy++ {
					py := clampInt(y+dy, 0, h-1) * img.Stride
					lrow := plane[(y+dy+r)*stride+x:]
					for dx := -r; dx <= r; dx++ {
						diff := int32(lrow[dx+r]) - center
						if diff < 0 {
							diff = -diff
						}
						wt := rw[diff] * sw[(dy+r)*side+dx+r] >> 4
						if wt == 0 {
							continue
						}
						p := py + clampInt(x+dx, 0, w-1)*4
						sr += int32(img.Pix[p]) * wt
						sg += int32(img.Pix[p+1]) * wt
						sb += int32(img.Pix[p+2]) * wt
						sum += wt
					}
				}
				o := x * 4
				a := img.Pix[y*img.Stride+o+3]
				if sum == 0 {
					copy(d[o:o+4], img.Pix[y*img.Stride+o:y*img.Stride+o+4])
					continue
				}
				d[o], d[o+1], d[o+2], d[o+3] = uint8((sr+sum/2)/sum), uint8((sg+sum/2)/sum), uint8((sb+sum/2)/sum), a
			}
		}
	})
	return dst, err
}

// nonLocalMeans averages each pixel with those in a search window whose
// 3×3 surroundings look alike, so repeated texture is kept while noise
// averages out. A draft searches a smaller window.
func nonLocalMeans(ctx context.Context, img *image.RGBA, sigma float64, draft bool) (*image.RGBA, error) {
	const patch = 1
	search := 3
	if draft {
		search = 2
	}
	pad := search + patch
	plane, stride, err := lumaPlane(ctx, img, pad)
	if err != nil {
		return nil, err
	}
	// Weight by the mean squared difference of the patches, in steps of 1/4.
	h2 := sigma * sigma * 0.5
	var wt [1024]int32
	for i := range wt {
		wt[i] = int32(math.Round(256 * math.Exp(-float64(i)/4/h2)))
	}
	w, h := img.Rect.Dx(), img.Rect.Dy()
	dst := image.NewRGBA(img.Rect)
	err = Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			for x := range w {
				c := (y+pad)*stride + x + pad
				var sr, sg, sb, sum int32
				for dy := -search; dy <= search; dy++ {
					py := clampInt(y+dy, 0, h-1) * img.Stride
					for dx := -search; dx <= search; dx++ {
						q := c + dy*stride + dx
						var ssd int32
						for oy := -patch; oy <= patch; oy++ {
							a := plane[c+oy*stride-patch : c+oy*stride+patch+1]
							b := plane[q+oy*stride-patch : q+oy*stride+patch+1]
							for k := range a {
								e := int32(a[k]) - int32(b[k])
								ssd += e * e
							}
						}
						idx := ssd * 4 / 9
						if idx >= int32(len(wt)) {
							continue
						}
						k := wt[idx]
						if k == 0 {
							continue
						}
						p := py + clampInt(x+dx, 0, w-1)*4
						sr += int32(img.Pix[p]) * k
						sg += int32(img.Pix[p+1]) * k
						sb += int32(img.Pix[p+2]) * k
						sum += k
					}
				}
				o := x * 4
				d[o], d[o+1], d[o+2], d[o+3] = uint8((sr+sum/2)/sum), uint8((sg+sum/2)/sum), uint8((sb+sum/2)/sum), img.Pix[y*img.Stride+o+3]
			}
		}
	})
	return dst, err
}
