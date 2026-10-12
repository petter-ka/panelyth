package imaging

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"os"
	"path/filepath"
	"testing"
)

func sampleMeta() Metadata {
	return Metadata{
		Exif: sampleExif(binary.BigEndian),
		// Larger than one JPEG segment, so it is split and joined again.
		ICC:  bytes.Repeat([]byte("icc-profile-bytes."), 8000),
		XMP:  []byte(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>`),
		Text: []PNGChunk{{Type: "tEXt", Data: []byte("Comment\x00made by a test")}},
		DPI:  DPI{300, 300},
	}
}

func save(t *testing.T, name string, img *image.RGBA, o SaveOptions) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := WriteFile(context.Background(), path, img, o, nil); err != nil {
		t.Fatal(err)
	}
	return path
}

func decode(t *testing.T, path, ext string) (Probe, *image.RGBA) {
	t.Helper()
	probe, err := DefaultRegistry().ProbeFile(path, ext)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	img, err := DecodeOriented(context.Background(), probe)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return probe, img
}

func TestSaveFormatsRoundTrip(t *testing.T) {
	src := testImage(160, 90, false)
	for format, ext := range SaveFormats {
		o := SaveOptions{Format: format, Quality: 90, Meta: sampleMeta().For(MetaKeep, 160, 90, DPI{300, 300})}
		path := save(t, "out."+ext, src, o)
		probe, img := decode(t, path, ext)
		if probe.Width != 160 || probe.Height != 90 || probe.Orientation != 1 {
			t.Errorf("%s: decoded as %dx%d orientation %d", format, probe.Width, probe.Height, probe.Orientation)
		}
		if format == "png" || format == "bmp" || format == "tiff" {
			if hashOf(img) != hashOf(src) {
				t.Errorf("%s is not lossless", format)
			}
		}
		m, err := ReadMetadata(path, format)
		if err != nil {
			t.Fatal(err)
		}
		if format != "gif" && m.DPI != (DPI{300, 300}) {
			t.Errorf("%s: resolution %v", format, m.DPI)
		}
		if format != "gif" && format != "bmp" && !bytes.Equal(m.ICC, sampleMeta().ICC) {
			t.Errorf("%s: ICC profile lost (%d bytes)", format, len(m.ICC))
		}
		if format == "jpeg" || format == "png" {
			info := infoMap(ExifInfo(bytes.NewReader(m.Exif), int64(len(m.Exif))))
			if info["camera.Make"] != "Panelyth" || info["image.ExifImageSize"] != "160 × 90" || info["gps.GPSLatitude"] == "" {
				t.Errorf("%s: EXIF %v", format, info)
			}
			if tiffOrientation(m.Exif) != 1 {
				t.Errorf("%s: orientation not reset", format)
			}
			if !bytes.Equal(m.XMP, sampleMeta().XMP) {
				t.Errorf("%s: XMP lost", format)
			}
		}
		if format == "png" && (len(m.Text) != 1 || m.Text[0].Type != "tEXt") {
			t.Errorf("png text chunks: %v", m.Text)
		}
	}
}

func TestMetadataPolicies(t *testing.T) {
	m := sampleMeta()
	m.XMP = []byte(`<x:xmpmeta><exif:GPSLatitude>47,29.88N</exif:GPSLatitude></x:xmpmeta>`)
	strip := m.For(MetaStrip, 10, 10, DPI{96, 96})
	if strip.Exif != nil || strip.XMP != nil || strip.Text != nil || !bytes.Equal(strip.ICC, m.ICC) || strip.DPI.X != 96 {
		t.Fatal("strip keeps more than the profile and the resolution")
	}
	noGPS := m.For(MetaStripGPS, 10, 10, DPI{})
	if noGPS.XMP != nil {
		t.Fatal("an XMP packet with GPS tags survived strip GPS")
	}
	info := infoMap(ExifInfo(bytes.NewReader(noGPS.Exif), int64(len(noGPS.Exif))))
	if info["gps.GPSLatitude"] != "" || info["camera.Make"] == "" {
		t.Fatalf("strip GPS: %v", info)
	}
	path := save(t, "nogps.jpg", testImage(32, 32, false), SaveOptions{Format: "jpeg", Meta: noGPS})
	raw, _ := os.ReadFile(path)
	if bytes.Contains(raw, rat(binary.BigEndian, 47, 1, 29, 1)) {
		t.Fatal("coordinates written to the file")
	}
}

func TestAlphaIsKeptOrFlattened(t *testing.T) {
	src := testImage(40, 30, true)
	for _, format := range []string{"png", "tiff"} {
		_, img := decode(t, save(t, "a."+SaveFormats[format], src, SaveOptions{Format: format}), SaveFormats[format])
		if !HasAlpha(img) {
			t.Errorf("%s lost the transparency", format)
		}
		// Straight ↔ premultiplied conversion may be off by one.
		for i := range img.Pix {
			if d := int(img.Pix[i]) - int(src.Pix[i]); d > 2 || d < -2 {
				t.Errorf("%s: pixel byte %d differs by %d", format, i, d)
				break
			}
		}
	}
	for _, format := range []string{"jpeg", "bmp", "gif"} {
		ext := SaveFormats[format]
		_, img := decode(t, save(t, "a."+ext, src, SaveOptions{Format: format, Quality: 100}), ext)
		// The transparent corner becomes white, not black.
		if c := img.RGBAAt(0, 0); c.R < 240 || c.G < 240 || c.B < 240 || c.A != 0xFF {
			t.Fatalf("%s: transparent corner saved as %v", format, c)
		}
	}
	if hashOf(src) != hashOf(testImage(40, 30, true)) {
		t.Fatal("saving modified the picture")
	}
}

func TestSaveFailures(t *testing.T) {
	src := testImage(600, 400, false)
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	path := filepath.Join(dir, "cancelled.png")
	if err := WriteFile(ctx, path, src, SaveOptions{Format: "png"}, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled save: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a cancelled save left a file")
	}
	// Cancelled in the middle of the encoder's output.
	ctx, cancel = context.WithCancel(context.Background())
	written := 0
	err := WriteFile(ctx, path, src, SaveOptions{Format: "bmp"}, func(n int) {
		if written += n; written > 100_000 {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("save cancelled midway: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a save cancelled midway left a file")
	}
	for _, o := range []SaveOptions{{Format: "webp"}, {Format: "jpeg", Quality: 101}, {Format: "jpeg", Quality: -1}} {
		if err := WriteFile(context.Background(), path, src, o, nil); !errors.Is(err, ErrInvalidEdit) {
			t.Errorf("%+v: %v", o.Format, err)
		}
	}
	if err := WriteFile(context.Background(), filepath.Join(dir, "missing", "x.png"), src, SaveOptions{Format: "png"}, nil); err == nil {
		t.Fatal("a missing folder was not an error")
	}
}

func TestEncodedSizeMatchesFile(t *testing.T) {
	src := testImage(200, 150, false)
	o := SaveOptions{Format: "jpeg", Quality: 80, Meta: sampleMeta().For(MetaKeep, 200, 150, DPI{72, 72})}
	n, err := EncodedSize(context.Background(), src, o)
	if err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(save(t, "s.jpg", src, o))
	if fi.Size() != n {
		t.Fatalf("estimate %d, file %d", n, fi.Size())
	}
}

func TestReadMetadataFromForeignFiles(t *testing.T) {
	dir := t.TempDir()
	// Truncated and garbage files yield no metadata and no error but I/O's.
	for name, data := range map[string][]byte{
		"g.jpg": []byte("\xff\xd8\xff\xe1\xff\xffExif"), "g.png": []byte("\x89PNG\r\n\x1a\n\x00\x00\xff\xffiCCP"),
		"g.webp": []byte("RIFF\x10\x00\x00\x00WEBPICCP\xff\xff\xff\x7f"), "g.tif": []byte("II*\x00\xff\xff\xff\xff"), "g.bmp": []byte("BM"),
	} {
		p := filepath.Join(dir, name)
		_ = os.WriteFile(p, data, 0o644)
		format := map[string]string{".jpg": "jpeg", ".png": "png", "webp": "webp", ".tif": "tiff", ".bmp": "bmp"}[name[len(name)-4:]]
		m, err := ReadMetadata(p, format)
		if err != nil || m.Exif != nil || m.ICC != nil {
			t.Errorf("%s: %v %v", name, m, err)
		}
	}
	if _, err := ReadMetadata(filepath.Join(dir, "none.jpg"), "jpeg"); err == nil {
		t.Fatal("a missing file is an error")
	}
}

// --- benchmarks (BENCH_STAGE=12) ---

func benchImage(b *testing.B, w, h int) *image.RGBA {
	b.Helper()
	small := testImage(w/8, h/8, false)
	img, err := Resample(context.Background(), small, w, h, Bilinear)
	if err != nil {
		b.Fatal(err)
	}
	return img
}

func BenchmarkResample(b *testing.B) {
	src := benchImage(b, 2560, 1707) // the proxy
	for name, k := range KernelNames {
		b.Run(name+"/proxy-to-1280", func(b *testing.B) {
			b.SetBytes(int64(len(src.Pix)))
			for b.Loop() {
				if _, err := Resample(context.Background(), src, 1280, 853, k); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
	full := benchImage(b, 6000, 4000)
	b.Run("lanczos3/24MP-to-6MP", func(b *testing.B) {
		b.SetBytes(int64(len(full.Pix)))
		for b.Loop() {
			if _, err := Resample(context.Background(), full, 3000, 2000, Lanczos3); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkGeometry(b *testing.B) {
	for _, size := range []struct {
		name string
		w, h int
	}{{"2MP", 1800, 1200}, {"24MP", 6000, 4000}} {
		src := benchImage(b, size.w, size.h)
		for name, js := range map[string]string{
			"rotate90":   goldenCases["rotate90"],
			"rotateAny":  goldenCases["rotate7-expand"],
			"rotateCrop": goldenCases["rotate7-crop"],
			"flip":       goldenCases["flip-h"],
			"crop":       goldenCases["crop"],
			"canvas":     `[{"op":"canvas","p":{"w":7000,"h":5000,"fill":"#ffffff"}}]`,
		} {
			e := edits(b, js)
			b.Run(size.name+"/"+name, func(b *testing.B) {
				b.SetBytes(int64(len(src.Pix)))
				for b.Loop() {
					if _, err := Apply(context.Background(), src, e); err != nil {
						b.Fatal(err)
					}
				}
			})
		}
	}
}

func BenchmarkHistogram(b *testing.B) {
	src := benchImage(b, 1800, 1200)
	b.SetBytes(int64(len(src.Pix)))
	for b.Loop() {
		if _, err := Histogram(context.Background(), src); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkFrameEncode is spike (a) of Stage 12: what a frame costs to
// encode and how large it is, per delivery format.
func BenchmarkFrameEncode(b *testing.B) {
	for _, size := range []struct {
		name string
		w, h int
	}{{"2MP", 1800, 1200}, {"6MP", 3000, 2000}} {
		src := benchImage(b, size.w, size.h)
		for _, o := range []SaveOptions{{Format: "jpeg", Quality: 85}, {Format: "jpeg", Quality: 92}, {Format: "bmp"}} {
			name := size.name + "/" + o.Format
			if o.Quality > 0 {
				name += "-q" + string(rune('0'+o.Quality/10)) + string(rune('0'+o.Quality%10))
			}
			b.Run(name, func(b *testing.B) {
				var n int64
				for b.Loop() {
					var err error
					if n, err = EncodedSize(context.Background(), src, o); err != nil {
						b.Fatal(err)
					}
				}
				b.ReportMetric(float64(n)/1024, "KB")
			})
		}
		b.Run(size.name+"/png-fast", func(b *testing.B) {
			var buf bytes.Buffer
			for b.Loop() {
				buf.Reset()
				if err := pngEncoder.Encode(&buf, src); err != nil {
					b.Fatal(err)
				}
			}
			b.ReportMetric(float64(buf.Len())/1024, "KB")
		})
	}
}
