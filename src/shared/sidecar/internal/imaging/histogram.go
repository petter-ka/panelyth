package imaging

import (
	"context"
	"image"
	"sync"
)

// Stats is the histogram of a rendered frame (ADR-0035): 256 bins for
// luminosity and each channel, and how many pixels are clipped. Fully
// transparent pixels are not counted.
type Stats struct {
	Lum [256]uint32 `json:"lum"`
	R   [256]uint32 `json:"r"`
	G   [256]uint32 `json:"g"`
	B   [256]uint32 `json:"b"`
	// Pixels is how many pixels were counted.
	Pixels uint32 `json:"pixels"`
	// ClipLow and ClipHigh count pixels with a channel at 0 or at 255.
	ClipLow  uint32 `json:"clipLow"`
	ClipHigh uint32 `json:"clipHigh"`
	// Mean is the average luminosity, 0..255.
	Mean float64 `json:"mean"`
}

// Luma is the Rec. 709 luminosity of an 8-bit color.
func Luma(r, g, b uint8) uint8 {
	return uint8((2126*uint32(r) + 7152*uint32(g) + 722*uint32(b) + 5000) / 10000)
}

// Histogram counts img in bands and adds the bands up as integers, so the
// result is the same for every worker count.
func Histogram(ctx context.Context, img *image.RGBA) (Stats, error) {
	img = toRGBA(img)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	var mu sync.Mutex
	var total Stats
	var lumSum uint64
	err := Rows(ctx, w, h, func(y0, y1 int) {
		var s Stats
		var sum uint64
		for y := y0; y < y1; y++ {
			row := img.Pix[y*img.Stride : y*img.Stride+w*4]
			for i := 0; i < len(row); i += 4 {
				r, g, b, a := row[i], row[i+1], row[i+2], row[i+3]
				if a == 0 {
					continue
				}
				if a != 0xFF { // stored premultiplied
					r, g, b = unmul(r, a), unmul(g, a), unmul(b, a)
				}
				l := Luma(r, g, b)
				s.R[r]++
				s.G[g]++
				s.B[b]++
				s.Lum[l]++
				sum += uint64(l)
				s.Pixels++
				if r == 0 || g == 0 || b == 0 {
					s.ClipLow++
				}
				if r == 0xFF || g == 0xFF || b == 0xFF {
					s.ClipHigh++
				}
			}
		}
		mu.Lock()
		for i := range 256 {
			total.Lum[i] += s.Lum[i]
			total.R[i] += s.R[i]
			total.G[i] += s.G[i]
			total.B[i] += s.B[i]
		}
		total.Pixels += s.Pixels
		total.ClipLow += s.ClipLow
		total.ClipHigh += s.ClipHigh
		lumSum += sum
		mu.Unlock()
	})
	if total.Pixels > 0 {
		total.Mean = float64(lumSum) / float64(total.Pixels)
	}
	return total, err
}

// unmul undoes premultiplication of one channel.
func unmul(c, a uint8) uint8 {
	return uint8(min((uint32(c)*255+uint32(a)/2)/uint32(a), 255))
}

// mul premultiplies one channel.
func mul(c, a uint8) uint8 {
	return uint8((uint32(c)*uint32(a) + 127) / 255)
}
