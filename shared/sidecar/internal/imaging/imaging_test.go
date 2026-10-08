package imaging

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"panelyth/sidecar/internal/fixture"
)

func writeFile(t *testing.T, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func encodeJPEG(t testing.TB, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, fixture.Pattern(w, h, 1), &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestFitSize(t *testing.T) {
	cases := [][5]int{
		{4000, 3000, 384, 384, 288},
		{3000, 4000, 384, 288, 384},
		{100, 50, 384, 100, 50}, // never upscale
		{10000, 1, 384, 384, 1}, // never zero
	}
	for _, c := range cases {
		w, h := FitSize(c[0], c[1], c[2])
		if w != c[3] || h != c[4] {
			t.Errorf("FitSize(%d,%d,%d) = %d,%d", c[0], c[1], c[2], w, h)
		}
	}
}

func TestRenderJPEG(t *testing.T) {
	reg := DefaultRegistry()
	p := writeFile(t, "a.jpg", encodeJPEG(t, 1600, 1200))
	probe, err := reg.ProbeFile(p, "jpg")
	if err != nil {
		t.Fatal(err)
	}
	if probe.Width != 1600 || probe.Height != 1200 || probe.Orientation != 1 {
		t.Fatalf("probe %+v", probe)
	}
	r, err := Render(probe, 384)
	if err != nil {
		t.Fatal(err)
	}
	if r.Format != FormatJPEG || r.Width != 384 || r.Height != 288 {
		t.Fatalf("rendered %s %dx%d", r.Format, r.Width, r.Height)
	}
	img, err := jpeg.Decode(bytes.NewReader(r.Data))
	if err != nil || img.Bounds().Dx() != 384 {
		t.Fatalf("output not a valid 384px JPEG: %v", err)
	}
}

func TestEXIFOrientationRotatesPreview(t *testing.T) {
	reg := DefaultRegistry()
	data := fixture.WithEXIFOrientation(encodeJPEG(t, 800, 400), 6)
	p := writeFile(t, "r.jpg", data)
	probe, err := reg.ProbeFile(p, "jpg")
	if err != nil {
		t.Fatal(err)
	}
	if probe.Orientation != 6 {
		t.Fatalf("orientation %d", probe.Orientation)
	}
	if w, h := probe.DisplaySize(); w != 400 || h != 800 {
		t.Fatalf("display size %dx%d", w, h)
	}
	r, err := Render(probe, 200)
	if err != nil {
		t.Fatal(err)
	}
	if r.Width != 100 || r.Height != 200 {
		t.Fatalf("rotated preview %dx%d, want 100x200", r.Width, r.Height)
	}
}

func TestOrientMapsCorners(t *testing.T) {
	// 2x1 image: red at (0,0), blue at (1,0).
	src := image.NewRGBA(image.Rect(0, 0, 2, 1))
	src.Pix = []byte{255, 0, 0, 255, 0, 0, 255, 255}
	want := map[int][2]int{ // orientation -> position of red in output
		2: {1, 0}, 3: {1, 0}, 4: {0, 0}, 5: {0, 0}, 6: {0, 0}, 7: {0, 1}, 8: {0, 1},
	}
	for o, pos := range want {
		dst := Orient(src, o)
		if c := dst.RGBAAt(pos[0], pos[1]); c.R != 255 {
			t.Errorf("orientation %d: red not at %v (%v)", o, pos, c)
		}
	}
}

func TestPNGWithAlphaStaysPNG(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 500, 500))
	for i := range img.Pix {
		img.Pix[i] = 128
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	p := writeFile(t, "a.png", buf.Bytes())
	reg := DefaultRegistry()
	probe, err := reg.ProbeFile(p, "png")
	if err != nil {
		t.Fatal(err)
	}
	r, err := Render(probe, 100)
	if err != nil {
		t.Fatal(err)
	}
	if r.Format != FormatPNG {
		t.Fatalf("alpha preview encoded as %s", r.Format)
	}
}

func TestFailures(t *testing.T) {
	reg := DefaultRegistry()
	if _, err := reg.ProbeFile(writeFile(t, "x.heic", []byte("x")), "heic"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("unsupported ext: %v", err)
	}
	if _, err := reg.ProbeFile(writeFile(t, "c.jpg", []byte("not a jpeg at all")), "jpg"); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("garbage: %v", err)
	}
	full := encodeJPEG(t, 640, 480)
	truncated := writeFile(t, "t.jpg", full[:len(full)/2])
	probe, err := reg.ProbeFile(truncated, "jpg")
	if err != nil {
		t.Fatalf("header of truncated file should probe: %v", err)
	}
	if _, err := Render(probe, 100); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("truncated: %v", err)
	}
	// A PNG header claiming 20000x20000 (400 MP) is refused before decoding.
	var hdr bytes.Buffer
	_ = png.Encode(&hdr, image.NewGray(image.Rect(0, 0, 1, 1)))
	b := hdr.Bytes()
	binary.BigEndian.PutUint32(b[16:], 20000)
	binary.BigEndian.PutUint32(b[20:], 20000)
	binary.BigEndian.PutUint32(b[29:], crc32.ChecksumIEEE(b[12:29])) // IHDR CRC
	if _, err := reg.ProbeFile(writeFile(t, "huge.png", b), "png"); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("huge: %v", err)
	}
}

func TestDownscaleMatchesGenericPath(t *testing.T) {
	// The YCbCr fast path and the generic RGBA path should agree closely.
	data := encodeJPEG(t, 1200, 800)
	img, _ := jpeg.Decode(bytes.NewReader(data))
	fast := Downscale(img, 150)
	slow := Downscale(toRGBA(img), 150)
	if fast.Rect != slow.Rect {
		t.Fatalf("size mismatch %v %v", fast.Rect, slow.Rect)
	}
	var diff int
	for i := range fast.Pix {
		d := int(fast.Pix[i]) - int(slow.Pix[i])
		diff += max(d, -d)
	}
	if avg := float64(diff) / float64(len(fast.Pix)); avg > 3 {
		t.Fatalf("paths diverge: mean abs diff %.2f", avg)
	}
}

func BenchmarkRender12MP(b *testing.B) {
	p := filepath.Join(b.TempDir(), "big.jpg")
	_ = os.WriteFile(p, encodeJPEG(b, 4000, 3000), 0o644)
	reg := DefaultRegistry()
	probe, err := reg.ProbeFile(p, "jpg")
	if err != nil {
		b.Fatal(err)
	}
	for _, edge := range []int{192, 384, 768} {
		b.Run("edge"+string(rune('0'+edge/100))+"xx", func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				if _, err := Render(probe, edge); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkProbe(b *testing.B) {
	p := filepath.Join(b.TempDir(), "big.jpg")
	_ = os.WriteFile(p, encodeJPEG(b, 4000, 3000), 0o644)
	reg := DefaultRegistry()
	b.ReportAllocs()
	for b.Loop() {
		if _, err := reg.ProbeFile(p, "jpg"); err != nil {
			b.Fatal(err)
		}
	}
}
