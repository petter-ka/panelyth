package imaging

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
)

// Format of an encoded preview. Part of the cache contract (file extension).
type Format string

const (
	FormatJPEG Format = "jpg"
	FormatPNG  Format = "png"
)

// JPEGQuality balances size against decode speed in the renderer; changing it
// requires bumping the preview transform version.
const JPEGQuality = 82

var pngEncoder = png.Encoder{CompressionLevel: png.BestSpeed}

// Encode writes opaque previews as JPEG and previews with transparency as
// PNG (WebP output is deferred, ADR-0019).
func Encode(img *image.RGBA) ([]byte, Format, error) {
	var buf bytes.Buffer
	buf.Grow(img.Rect.Dx() * img.Rect.Dy() / 4)
	if HasAlpha(img) {
		if err := pngEncoder.Encode(&buf, img); err != nil {
			return nil, "", err
		}
		return buf.Bytes(), FormatPNG, nil
	}
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: JPEGQuality}); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), FormatJPEG, nil
}

// Rendered is a finished preview.
type Rendered struct {
	Data   []byte
	Format Format
	Width  int
	Height int
}

// Render decodes p fully, downscales to maxEdge, applies orientation and
// encodes. The caller has already reserved memory for p.Pixels().
func Render(p Probe, maxEdge int) (Rendered, error) {
	img, err := DecodeFile(p)
	if err != nil {
		return Rendered{}, err
	}
	small := Orient(Downscale(img, maxEdge), p.Orientation)
	data, format, err := Encode(small)
	if err != nil {
		return Rendered{}, err
	}
	return Rendered{Data: data, Format: format, Width: small.Rect.Dx(), Height: small.Rect.Dy()}, nil
}
