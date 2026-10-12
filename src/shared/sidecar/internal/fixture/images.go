package fixture

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
)

// ImageSpec describes a folder of real, decodable images.
type ImageSpec struct {
	Count  int
	Width  int
	Height int
	// PNGAlphaEvery makes every n-th image a PNG with transparency (0 = none).
	PNGAlphaEvery int
	// RotatedEvery tags every n-th JPEG with EXIF orientation 6 (0 = none).
	RotatedEvery int
}

// GenerateImages writes deterministic photo-like images. Like Generate it is
// a no-op when the marker matches.
func GenerateImages(root string, spec ImageSpec) error {
	marker := filepath.Join(root, ".panelyth-fixture")
	want := fmt.Sprintf("images %+v", spec)
	if cached(root, marker, want) {
		return nil
	}
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	for i := range spec.Count {
		img := Pattern(spec.Width, spec.Height, i)
		var buf bytes.Buffer
		name := fmt.Sprintf("photo_%04d.jpg", i)
		switch {
		case spec.PNGAlphaEvery > 0 && i%spec.PNGAlphaEvery == spec.PNGAlphaEvery-1:
			name = fmt.Sprintf("overlay_%04d.png", i)
			if err := png.Encode(&buf, withAlpha(img)); err != nil {
				return err
			}
		default:
			if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
				return err
			}
			if spec.RotatedEvery > 0 && i%spec.RotatedEvery == spec.RotatedEvery-1 {
				b := WithEXIFOrientation(buf.Bytes(), 6)
				buf.Reset()
				buf.Write(b)
			}
		}
		p := filepath.Join(root, name)
		if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
			return err
		}
		if err := os.Chtimes(p, baseTime, baseTime); err != nil {
			return err
		}
	}
	return seal(root, marker, want)
}

// Pattern draws a smooth gradient with seed-dependent blocks: photographic
// enough for JPEG timing to be realistic, and different per image.
func Pattern(w, h, seed int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			r := uint8((x*255/max(w-1, 1) + seed*37) % 256)
			g := uint8((y*255/max(h-1, 1) + seed*11) % 256)
			b := uint8(((x/64+y/64)*23 + seed*53) % 256)
			o := y*img.Stride + x*4
			img.Pix[o], img.Pix[o+1], img.Pix[o+2], img.Pix[o+3] = r, g, b, 0xFF
		}
	}
	return img
}

func withAlpha(src *image.RGBA) *image.NRGBA {
	b := src.Bounds()
	dst := image.NewNRGBA(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			c := src.RGBAAt(x, y)
			a := uint8(255)
			if x < b.Dx()/2 {
				a = 64
			}
			dst.SetNRGBA(x, y, color.NRGBA{c.R, c.G, c.B, a})
		}
	}
	return dst
}

// WithEXIFOrientation inserts an APP1 EXIF segment carrying only the
// Orientation tag right after the JPEG SOI marker.
func WithEXIFOrientation(jpg []byte, orientation uint16) []byte {
	tiffData := make([]byte, 0, 26)
	tiffData = append(tiffData, 'M', 'M', 0, 42)
	tiffData = binary.BigEndian.AppendUint32(tiffData, 8) // IFD0 offset
	tiffData = binary.BigEndian.AppendUint16(tiffData, 1) // one entry
	tiffData = binary.BigEndian.AppendUint16(tiffData, 0x0112)
	tiffData = binary.BigEndian.AppendUint16(tiffData, 3) // SHORT
	tiffData = binary.BigEndian.AppendUint32(tiffData, 1)
	tiffData = binary.BigEndian.AppendUint16(tiffData, orientation)
	tiffData = append(tiffData, 0, 0)       // value padding
	tiffData = append(tiffData, 0, 0, 0, 0) // next IFD
	payload := append([]byte("Exif\x00\x00"), tiffData...)
	seg := []byte{0xFF, 0xE1}
	seg = binary.BigEndian.AppendUint16(seg, uint16(len(payload)+2))
	seg = append(seg, payload...)
	out := make([]byte, 0, len(jpg)+len(seg))
	out = append(out, jpg[:2]...)
	out = append(out, seg...)
	return append(out, jpg[2:]...)
}
