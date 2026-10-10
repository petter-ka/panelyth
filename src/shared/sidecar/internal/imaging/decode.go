// Package imaging turns source images into small preview images: probe,
// decode, downscale, orient, encode. Decoders sit behind an interface so
// AVIF/HEIF/RAW can be added without touching callers (ADR-0006). The MVP
// uses only the Go standard library and golang.org/x/image (ADR-0019).
package imaging

import (
	"bufio"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"os"

	"golang.org/x/image/bmp"
	"golang.org/x/image/tiff"
	"golang.org/x/image/webp"
)

var (
	// ErrUnsupported: no decoder for this format (or a format variant a decoder rejects).
	ErrUnsupported = errors.New("imaging: unsupported format")
	// ErrTooLarge: the image exceeds MaxPixels and is not decoded.
	ErrTooLarge = errors.New("imaging: image too large")
	// ErrCorrupt: the data could not be decoded.
	ErrCorrupt = errors.New("imaging: corrupt image")
)

// MaxPixels bounds a single decode (≈ 300 MB for YCbCr 4:2:0, 800 MB RGBA).
const MaxPixels = 200_000_000

// Decoder decodes one family of formats. Implementations must be safe for
// concurrent use.
type Decoder interface {
	Name() string
	CanDecode(ext string) bool
	Config(r io.Reader) (image.Config, error)
	Decode(r io.Reader) (image.Image, error)
}

type stdDecoder struct {
	name   string
	exts   []string
	config func(io.Reader) (image.Config, error)
	decode func(io.Reader) (image.Image, error)
}

func (d stdDecoder) Name() string { return d.name }
func (d stdDecoder) CanDecode(ext string) bool {
	for _, e := range d.exts {
		if e == ext {
			return true
		}
	}
	return false
}
func (d stdDecoder) Config(r io.Reader) (image.Config, error) { return d.config(r) }
func (d stdDecoder) Decode(r io.Reader) (image.Image, error)  { return d.decode(r) }

// Registry picks a decoder by extension.
type Registry struct{ decoders []Decoder }

// DefaultRegistry covers the BRS §6 image MVP formats.
func DefaultRegistry() *Registry {
	return &Registry{decoders: []Decoder{
		stdDecoder{"jpeg", []string{"jpg", "jpeg", "jpe", "jfif"}, jpeg.DecodeConfig, jpeg.Decode},
		stdDecoder{"png", []string{"png"}, png.DecodeConfig, png.Decode},
		stdDecoder{"gif", []string{"gif"}, gif.DecodeConfig, gif.Decode}, // first frame
		stdDecoder{"bmp", []string{"bmp"}, bmp.DecodeConfig, bmp.Decode},
		stdDecoder{"tiff", []string{"tif", "tiff"}, tiff.DecodeConfig, tiff.Decode},
		stdDecoder{"webp", []string{"webp"}, webp.DecodeConfig, webp.Decode},
	}}
}

// For returns the decoder for ext, or nil.
func (r *Registry) For(ext string) Decoder {
	for _, d := range r.decoders {
		if d.CanDecode(ext) {
			return d
		}
	}
	return nil
}

// Probe is the cheap first step: dimensions and orientation, no pixel decode.
type Probe struct {
	Path        string
	Decoder     Decoder
	Width       int // stored (pre-orientation) dimensions
	Height      int
	Orientation int // EXIF 1..8 (1 = as stored)
}

// Pixels is the decode cost used for memory budgeting.
func (p Probe) Pixels() int64 { return int64(p.Width) * int64(p.Height) }

// DisplaySize returns dimensions after applying orientation.
func (p Probe) DisplaySize() (w, h int) {
	if p.Orientation >= 5 {
		return p.Height, p.Width
	}
	return p.Width, p.Height
}

// ProbeFile reads the header of path.
func (r *Registry) ProbeFile(path, ext string) (Probe, error) {
	dec := r.For(ext)
	if dec == nil {
		return Probe{}, ErrUnsupported
	}
	f, err := os.Open(path)
	if err != nil {
		return Probe{}, err
	}
	defer f.Close()
	orientation := 1
	if dec.Name() == "jpeg" {
		orientation = readJPEGOrientation(f)
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return Probe{}, err
		}
	}
	cfg, err := safeConfig(dec, bufio.NewReaderSize(f, 32<<10))
	if err != nil {
		return Probe{}, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return Probe{}, fmt.Errorf("%w: empty image", ErrCorrupt)
	}
	if int64(cfg.Width)*int64(cfg.Height) > MaxPixels {
		return Probe{}, ErrTooLarge
	}
	return Probe{Path: path, Decoder: dec, Width: cfg.Width, Height: cfg.Height, Orientation: orientation}, nil
}

// DecodeFile decodes the full image. Decoders from the standard library and
// x/image can panic on hostile input; that is reported as ErrCorrupt.
func DecodeFile(p Probe) (image.Image, error) {
	f, err := os.Open(p.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return safeDecode(p.Decoder, bufio.NewReaderSize(f, 64<<10))
}

func safeConfig(d Decoder, r io.Reader) (cfg image.Config, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("%w: %v", ErrCorrupt, p)
		}
	}()
	cfg, err = d.Config(r)
	if err != nil {
		return cfg, classify(err)
	}
	return cfg, nil
}

func safeDecode(d Decoder, r io.Reader) (img image.Image, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("%w: %v", ErrCorrupt, p)
		}
	}()
	img, err = d.Decode(r)
	if err != nil {
		return nil, classify(err)
	}
	return img, nil
}

// classify maps decoder errors: format variants a decoder does not implement
// (12-bit JPEG, exotic TIFF compression) are "unsupported"; everything else,
// including truncation, is "corrupt".
func classify(err error) error {
	switch err.(type) {
	case jpeg.UnsupportedError, png.UnsupportedError, tiff.UnsupportedError:
		return fmt.Errorf("%w: %v", ErrUnsupported, err)
	}
	return fmt.Errorf("%w: %v", ErrCorrupt, err)
}
