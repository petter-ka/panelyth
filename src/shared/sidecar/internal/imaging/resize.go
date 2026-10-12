package imaging

import (
	"image"
	"image/color"
	"image/draw"

	xdraw "golang.org/x/image/draw"
)

// FitSize returns the size of (w,h) scaled to fit within maxEdge on the long
// side, never upscaling.
func FitSize(w, h, maxEdge int) (int, int) {
	if w <= maxEdge && h <= maxEdge {
		return w, h
	}
	if w >= h {
		return maxEdge, max(1, int(int64(h)*int64(maxEdge)/int64(w)))
	}
	return max(1, int(int64(w)*int64(maxEdge)/int64(h))), maxEdge
}

// Downscale returns src scaled to fit within maxEdge (stored orientation).
//
// Large reductions use an area-average box filter straight from the decoded
// representation (YCbCr planes for JPEG, so no full-size RGB conversion) down
// to twice the target, then Catmull-Rom to the target. Box first keeps it
// alias-free and O(source pixels); Catmull-Rom on the small intermediate
// keeps it sharp.
func Downscale(src image.Image, maxEdge int) *image.RGBA {
	b := src.Bounds()
	tw, th := FitSize(b.Dx(), b.Dy(), maxEdge)
	iw, ih := tw*2, th*2
	var mid *image.RGBA
	if iw < b.Dx() && ih < b.Dy() {
		// The plane-indexing fast path assumes an origin at (0,0), which is
		// what decoders produce; anything else takes the generic path.
		if s, ok := src.(*image.YCbCr); ok && s.Rect.Min == (image.Point{}) {
			mid = boxYCbCr(s, iw, ih)
		} else {
			mid = boxRGBA(toRGBA(src), iw, ih)
		}
	} else {
		mid = toRGBA(src)
	}
	if mid.Bounds().Dx() == tw && mid.Bounds().Dy() == th {
		return mid
	}
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), mid, mid.Bounds(), xdraw.Src, nil)
	return dst
}

// toRGBA converts any image to premultiplied RGBA (a no-op for *image.RGBA
// at origin).
func toRGBA(src image.Image) *image.RGBA {
	if r, ok := src.(*image.RGBA); ok && r.Rect.Min == (image.Point{}) {
		return r
	}
	b := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), src, b.Min, draw.Src)
	return dst
}

// span returns the source range [lo,hi) covered by destination index i when
// n source samples map onto m destination samples.
func span(i, n, m int) (int, int) {
	lo := i * n / m
	hi := (i + 1) * n / m
	if hi <= lo {
		hi = lo + 1
	}
	return lo, hi
}

func boxRGBA(src *image.RGBA, w, h int) *image.RGBA {
	sb := src.Bounds()
	sw, sh := sb.Dx(), sb.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		y0, y1 := span(y, sh, h)
		for x := range w {
			x0, x1 := span(x, sw, w)
			var r, g, bl, a uint64
			for sy := y0; sy < y1; sy++ {
				row := src.Pix[(sy)*src.Stride+x0*4 : (sy)*src.Stride+x1*4]
				for i := 0; i < len(row); i += 4 {
					r += uint64(row[i])
					g += uint64(row[i+1])
					bl += uint64(row[i+2])
					a += uint64(row[i+3])
				}
			}
			n := uint64((x1 - x0) * (y1 - y0))
			o := y*dst.Stride + x*4
			dst.Pix[o] = uint8(r / n)
			dst.Pix[o+1] = uint8(g / n)
			dst.Pix[o+2] = uint8(bl / n)
			dst.Pix[o+3] = uint8(a / n)
		}
	}
	return dst
}

// boxYCbCr averages luma and chroma on their own planes, then converts each
// output pixel once.
func boxYCbCr(src *image.YCbCr, w, h int) *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	boxYCbCrRows(src, dst, 0, h)
	return dst
}

// boxYCbCrRows fills the rows [ya, yb) of dst; rows are independent, so the
// editor's proxy runs them in parallel bands.
func boxYCbCrRows(src *image.YCbCr, dst *image.RGBA, ya, yb int) {
	w, h := dst.Rect.Dx(), dst.Rect.Dy()
	sb := src.Rect
	sw, sh := sb.Dx(), sb.Dy()
	cxShift, cyShift := chromaShift(src.SubsampleRatio)
	cw := (sb.Max.X+(1<<cxShift)-1)>>cxShift - sb.Min.X>>cxShift
	ch := (sb.Max.Y+(1<<cyShift)-1)>>cyShift - sb.Min.Y>>cyShift
	for y := ya; y < yb; y++ {
		y0, y1 := span(y, sh, h)
		cy0, cy1 := span(y, ch, h)
		for x := range w {
			x0, x1 := span(x, sw, w)
			cx0, cx1 := span(x, cw, w)
			var ys uint64
			for sy := y0; sy < y1; sy++ {
				row := src.Y[sy*src.YStride+x0 : sy*src.YStride+x1]
				for _, v := range row {
					ys += uint64(v)
				}
			}
			var cbs, crs uint64
			for sy := cy0; sy < cy1; sy++ {
				o := sy * src.CStride
				for _, v := range src.Cb[o+cx0 : o+cx1] {
					cbs += uint64(v)
				}
				for _, v := range src.Cr[o+cx0 : o+cx1] {
					crs += uint64(v)
				}
			}
			yn := uint64((x1 - x0) * (y1 - y0))
			cn := uint64((cx1 - cx0) * (cy1 - cy0))
			r, g, b := color.YCbCrToRGB(uint8(ys/yn), uint8(cbs/cn), uint8(crs/cn))
			o := y*dst.Stride + x*4
			dst.Pix[o], dst.Pix[o+1], dst.Pix[o+2], dst.Pix[o+3] = r, g, b, 0xFF
		}
	}
}

func chromaShift(r image.YCbCrSubsampleRatio) (int, int) {
	switch r {
	case image.YCbCrSubsampleRatio422:
		return 1, 0
	case image.YCbCrSubsampleRatio420:
		return 1, 1
	case image.YCbCrSubsampleRatio440:
		return 0, 1
	case image.YCbCrSubsampleRatio411:
		return 2, 0
	case image.YCbCrSubsampleRatio410:
		return 2, 1
	default:
		return 0, 0
	}
}

// Orient applies an EXIF orientation (1..8) to img.
func Orient(img *image.RGBA, orientation int) *image.RGBA {
	if orientation <= 1 || orientation > 8 {
		return img
	}
	w, h := img.Rect.Dx(), img.Rect.Dy()
	dw, dh := w, h
	if orientation >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := range h {
		for x := range w {
			var dx, dy int
			switch orientation {
			case 2: // mirror horizontal
				dx, dy = w-1-x, y
			case 3: // rotate 180
				dx, dy = w-1-x, h-1-y
			case 4: // mirror vertical
				dx, dy = x, h-1-y
			case 5: // transpose
				dx, dy = y, x
			case 6: // rotate 90 CW
				dx, dy = h-1-y, x
			case 7: // transverse
				dx, dy = h-1-y, w-1-x
			case 8: // rotate 90 CCW
				dx, dy = y, w-1-x
			}
			so := y*img.Stride + x*4
			do := dy*dst.Stride + dx*4
			copy(dst.Pix[do:do+4], img.Pix[so:so+4])
		}
	}
	return dst
}

// HasAlpha reports whether any pixel is not fully opaque.
func HasAlpha(img *image.RGBA) bool {
	for i := 3; i < len(img.Pix); i += 4 {
		if img.Pix[i] != 0xFF {
			return true
		}
	}
	return false
}
