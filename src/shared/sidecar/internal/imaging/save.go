package imaging

import (
	"bufio"
	"context"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"os"

	"golang.org/x/image/bmp"
	"golang.org/x/image/tiff"
)

// Saving an edited picture (Stage 12, ADR-0035): JPEG, PNG, GIF (one
// frame), BMP and TIFF from the standard library and x/image, with the
// metadata and resolution the encoders leave out added around them.

// SaveFormats maps a save format to its file extension.
var SaveFormats = map[string]string{"jpeg": "jpg", "png": "png", "gif": "gif", "bmp": "bmp", "tiff": "tif"}

// Quality limits of a JPEG save.
const (
	MinQuality     = 1
	MaxQuality     = 100
	DefaultQuality = 92
)

// SaveOptions describe the file to write.
type SaveOptions struct {
	// Format is a key of SaveFormats.
	Format string
	// Quality is for JPEG (1..100).
	Quality int
	// Meta is what the file carries (see Metadata.For); its DPI is the
	// resolution written.
	Meta Metadata
}

// ctxWriter stops an encoder that has no cancellation of its own: its next
// write fails once ctx is done. It also counts the bytes for progress.
type ctxWriter struct {
	ctx      context.Context
	w        io.Writer
	progress func(n int)
}

func (c *ctxWriter) Write(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := c.w.Write(p)
	if c.progress != nil && n > 0 {
		c.progress(n)
	}
	return n, err
}

// EncodeTo writes img to w in o.Format. JPEG, GIF and BMP carry no transparency, so
// a picture with alpha is placed on white for them. progress, when set,
// receives the bytes written. A TIFF or BMP written to a file needs Finish
// afterwards for its resolution and profile.
func EncodeTo(ctx context.Context, w io.Writer, img *image.RGBA, o SaveOptions, progress func(n int)) error {
	cw := &ctxWriter{ctx: ctx, w: w, progress: progress}
	var err error
	switch o.Format {
	case "jpeg":
		q := o.Quality
		if q == 0 {
			q = DefaultQuality
		}
		if q < MinQuality || q > MaxQuality {
			return invalid("quality is %d..%d", MinQuality, MaxQuality)
		}
		if img, err = Flatten(ctx, img); err != nil {
			return err
		}
		err = jpeg.Encode(&injectWriter{w: cw, after: 2, inject: jpegSegments(o.Meta)}, img, &jpeg.Options{Quality: q})
	case "png":
		var src image.Image = img
		if pal := asPaletted(img); pal != nil {
			// At most 256 colors (after Reduce colors, or a drawing): indexed.
			src = pal
		} else if HasAlpha(img) {
			// The encoder's fast path for transparency takes straight alpha.
			if src, err = toNRGBA(ctx, img); err != nil {
				return err
			}
		}
		// Signature (8) and IHDR (25) come first; the chunks go after them.
		err = png.Encode(&injectWriter{w: cw, after: 33, inject: pngChunks(o.Meta)}, src)
	case "gif":
		// A picture of at most 256 colors keeps exactly those, and what is
		// fully transparent stays so; anything else is placed on white and
		// reduced by the encoder.
		if pal := asPaletted(img); pal != nil {
			err = gif.Encode(cw, pal, nil)
			break
		}
		if img, err = Flatten(ctx, img); err != nil {
			return err
		}
		err = gif.Encode(cw, img, &gif.Options{NumColors: 256})
	case "bmp":
		// 32-bit BMPs are read without their alpha by most programs.
		if img, err = Flatten(ctx, img); err != nil {
			return err
		}
		err = bmp.Encode(cw, img)
	case "tiff":
		err = tiff.Encode(cw, img, &tiff.Options{Compression: tiff.Deflate, Predictor: true})
	default:
		return invalid("save format %q", o.Format)
	}
	if cerr := ctx.Err(); cerr != nil {
		return cerr
	}
	return err
}

// Finish adds what EncodeTo could not write in one pass: the resolution and
// profile of a TIFF, the resolution of a BMP.
func Finish(f *os.File, o SaveOptions) error {
	switch o.Format {
	case "tiff":
		return patchTIFF(f, o.Meta.DPI, o.Meta.ICC)
	case "bmp":
		return patchBMP(f, o.Meta.DPI)
	}
	return nil
}

// WriteFile encodes img into a new file at path and syncs it. On any
// failure, including cancellation, the file is removed.
func WriteFile(ctx context.Context, path string, img *image.RGBA, o SaveOptions, progress func(n int)) (err error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			_ = os.Remove(path)
		}
	}()
	bw := bufio.NewWriterSize(f, 256<<10)
	if err = EncodeTo(ctx, bw, img, o, progress); err != nil {
		return err
	}
	if err = bw.Flush(); err != nil {
		return err
	}
	if err = Finish(f, o); err != nil {
		return err
	}
	return f.Sync()
}

type countWriter struct{ n int64 }

func (c *countWriter) Write(p []byte) (int, error) {
	c.n += int64(len(p))
	return len(p), nil
}

// EncodedSize is the size img takes in o.Format, without writing a file.
func EncodedSize(ctx context.Context, img *image.RGBA, o SaveOptions) (int64, error) {
	var c countWriter
	if err := EncodeTo(ctx, &c, img, o, nil); err != nil {
		return 0, err
	}
	return c.n, nil
}

// Flatten places a picture with transparency on white. An opaque picture is
// returned as it is; otherwise the result is a new image.
func Flatten(ctx context.Context, img *image.RGBA) (*image.RGBA, error) {
	img = toRGBA(img)
	if !HasAlpha(img) {
		return img, nil
	}
	w, h := img.Rect.Dx(), img.Rect.Dy()
	dst := image.NewRGBA(img.Rect)
	err := Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			s := img.Pix[y*img.Stride : y*img.Stride+w*4]
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			for i := 0; i < len(s); i += 4 {
				// Premultiplied over white: c + (255 - a).
				inv := 0xFF - s[i+3]
				d[i], d[i+1], d[i+2], d[i+3] = s[i]+inv, s[i+1]+inv, s[i+2]+inv, 0xFF
			}
		}
	})
	return dst, err
}

// toNRGBA converts premultiplied to straight alpha.
func toNRGBA(ctx context.Context, img *image.RGBA) (*image.NRGBA, error) {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	err := Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			s := img.Pix[y*img.Stride : y*img.Stride+w*4]
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			for i := 0; i < len(s); i += 4 {
				a := s[i+3]
				switch a {
				case 0xFF:
					d[i], d[i+1], d[i+2], d[i+3] = s[i], s[i+1], s[i+2], a
				case 0:
				default:
					d[i], d[i+1], d[i+2], d[i+3] = unmul(s[i], a), unmul(s[i+1], a), unmul(s[i+2], a), a
				}
			}
		}
	})
	return dst, err
}

// DecodeOriented decodes the full image of p upright as premultiplied RGBA.
func DecodeOriented(ctx context.Context, p Probe) (*image.RGBA, error) {
	src, err := DecodeFile(p)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	rgba, err := convertRGBA(ctx, src)
	if err != nil {
		return nil, err
	}
	return orientRows(ctx, rgba, p.Orientation)
}

// convertRGBA converts a decoded image to RGBA in parallel bands; the
// common decoder outputs have their own loops.
func convertRGBA(ctx context.Context, src image.Image) (*image.RGBA, error) {
	if r, ok := src.(*image.RGBA); ok && r.Rect.Min == (image.Point{}) {
		return r, nil
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	var err error
	switch s := src.(type) {
	case *image.YCbCr:
		err = Rows(ctx, w, h, func(y0, y1 int) {
			for y := y0; y < y1; y++ {
				d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
				yi := s.YOffset(b.Min.X, b.Min.Y+y)
				for x := 0; x < w; x++ {
					ci := s.COffset(b.Min.X+x, b.Min.Y+y)
					r, g, bl := ycbcrToRGB(s.Y[yi+x], s.Cb[ci], s.Cr[ci])
					d[x*4], d[x*4+1], d[x*4+2], d[x*4+3] = r, g, bl, 0xFF
				}
			}
		})
	case *image.NRGBA:
		err = Rows(ctx, w, h, func(y0, y1 int) {
			for y := y0; y < y1; y++ {
				d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
				so := s.PixOffset(b.Min.X, b.Min.Y+y)
				p := s.Pix[so : so+w*4]
				for i := 0; i < len(p); i += 4 {
					a := p[i+3]
					switch a {
					case 0xFF:
						d[i], d[i+1], d[i+2], d[i+3] = p[i], p[i+1], p[i+2], a
					case 0:
					default:
						d[i], d[i+1], d[i+2], d[i+3] = mul(p[i], a), mul(p[i+1], a), mul(p[i+2], a), a
					}
				}
			}
		})
	case *image.Gray:
		err = Rows(ctx, w, h, func(y0, y1 int) {
			for y := y0; y < y1; y++ {
				d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
				so := s.PixOffset(b.Min.X, b.Min.Y+y)
				for x, v := range s.Pix[so : so+w] {
					d[x*4], d[x*4+1], d[x*4+2], d[x*4+3] = v, v, v, 0xFF
				}
			}
		})
	default:
		// Paletted, 16-bit and CMYK images go through the color model,
		// which also reduces 16 bits to 8.
		err = Rows(ctx, w, h, func(y0, y1 int) {
			for y := y0; y < y1; y++ {
				d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
				for x := 0; x < w; x++ {
					r, g, bl, a := src.At(b.Min.X+x, b.Min.Y+y).RGBA()
					d[x*4], d[x*4+1], d[x*4+2], d[x*4+3] = uint8(r>>8), uint8(g>>8), uint8(bl>>8), uint8(a>>8)
				}
			}
		})
	}
	return dst, err
}

// ycbcrToRGB is color.YCbCrToRGB (JFIF), inlined for the hot loop.
func ycbcrToRGB(y, cb, cr uint8) (uint8, uint8, uint8) {
	yy1 := int32(y) * 0x10101
	cb1 := int32(cb) - 128
	cr1 := int32(cr) - 128
	r := yy1 + 91881*cr1
	if uint32(r)&0xff000000 == 0 {
		r >>= 16
	} else {
		r = ^(r >> 31)
	}
	g := yy1 - 22554*cb1 - 46802*cr1
	if uint32(g)&0xff000000 == 0 {
		g >>= 16
	} else {
		g = ^(g >> 31)
	}
	b := yy1 + 116130*cb1
	if uint32(b)&0xff000000 == 0 {
		b >>= 16
	} else {
		b = ^(b >> 31)
	}
	return uint8(r), uint8(g), uint8(b)
}

// FormatOf names the save format that matches a decoder family, or "" when
// the editor cannot write it (WebP, ADR-0019).
func FormatOf(decoder string) string {
	if _, ok := SaveFormats[decoder]; ok {
		return decoder
	}
	return ""
}

// OrientedProxy scales a decoded image down to fit maxEdge (never up) and
// turns it upright, in parallel bands. A JPEG reduced to less than half is
// averaged straight from its planes (the preview pipeline's box filter), so
// no full-size RGBA copy is made; anything else is converted and resampled.
func OrientedProxy(ctx context.Context, src image.Image, maxEdge, orientation int) (*image.RGBA, error) {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	tw, th := FitSize(w, h, maxEdge)
	var rgba *image.RGBA
	var err error
	if s, ok := src.(*image.YCbCr); ok && s.Rect.Min == (image.Point{}) && tw*2 < w && th*2 < h {
		rgba = image.NewRGBA(image.Rect(0, 0, tw*2, th*2))
		if err = Rows(ctx, tw*2, th*2, func(y0, y1 int) { boxYCbCrRows(s, rgba, y0, y1) }); err != nil {
			return nil, err
		}
	} else if rgba, err = convertRGBA(ctx, src); err != nil {
		return nil, err
	}
	if rgba.Rect.Dx() != tw || rgba.Rect.Dy() != th {
		if rgba, err = Resample(ctx, rgba, tw, th, CatmullRom); err != nil {
			return nil, err
		}
	}
	return orientRows(ctx, rgba, orientation)
}

// OnChecker places a picture with transparency on a light checkerboard, the
// way an editor shows what is transparent. An opaque picture is returned as
// it is; otherwise the result is a new, opaque image.
func OnChecker(ctx context.Context, img *image.RGBA, cell int) (*image.RGBA, error) {
	img = toRGBA(img)
	if !HasAlpha(img) {
		return img, nil
	}
	cell = max(cell, 1)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	dst := image.NewRGBA(img.Rect)
	err := Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			s := img.Pix[y*img.Stride : y*img.Stride+w*4]
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			for x := 0; x < w; x++ {
				i := x * 4
				a := s[i+3]
				if a == 0xFF {
					d[i], d[i+1], d[i+2], d[i+3] = s[i], s[i+1], s[i+2], 0xFF
					continue
				}
				bg := uint32(0xFF)
				if (x/cell+y/cell)&1 == 1 {
					bg = 0xD4
				}
				// Premultiplied over the background.
				under := uint8((bg*uint32(0xFF-a) + 127) / 255)
				d[i], d[i+1], d[i+2], d[i+3] = s[i]+under, s[i+1]+under, s[i+2]+under, 0xFF
			}
		}
	})
	return dst, err
}
