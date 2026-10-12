package imaging

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"image"
	"image/color"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

var updateGolden = flag.Bool("update", false, "rewrite testdata/golden.json")

// testImage is a deterministic picture with detail in every direction; with
// alpha it has a transparent corner and a soft edge.
func testImage(w, h int, alpha bool) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			r := uint8((x*255)/max(w-1, 1) ^ (y * 7))
			g := uint8((y*255)/max(h-1, 1) ^ (x * 3))
			b := uint8((x*x + y*y*5) % 256)
			a := uint8(255)
			if alpha {
				a = uint8(min(255, (x+y)*510/max(w+h-2, 1)))
			}
			c := color.NRGBA{R: r, G: g, B: b, A: a}
			img.Set(x, y, c)
		}
	}
	return img
}

func edits(t testing.TB, js string) EditList {
	t.Helper()
	var e EditList
	if err := json.Unmarshal([]byte(js), &e); err != nil {
		t.Fatal(err)
	}
	return e
}

func hashOf(img *image.RGBA) string {
	h := sha256.New()
	fmt.Fprintf(h, "%dx%d|", img.Rect.Dx(), img.Rect.Dy())
	for y := range img.Rect.Dy() {
		h.Write(img.Pix[y*img.Stride : y*img.Stride+img.Rect.Dx()*4])
	}
	return hex.EncodeToString(h.Sum(nil)[:12])
}

func mustApply(t testing.TB, img *image.RGBA, e EditList) *image.RGBA {
	t.Helper()
	out, err := ApplyWith(context.Background(), img, e, testRes{})
	if err != nil {
		t.Fatalf("%v: %v", e, err)
	}
	return out
}

// goldenCases are compared exactly: the pipeline is deterministic, so a
// change of a hash is a change of an operation's output and needs a new
// operation Version.
var goldenCases = map[string]string{
	"rotate90":       `[{"op":"rotate","p":{"angle":90}}]`,
	"rotate-90":      `[{"op":"rotate","p":{"angle":-90}}]`,
	"rotate180":      `[{"op":"rotate","p":{"angle":180}}]`,
	"rotate7-expand": `[{"op":"rotate","p":{"angle":7.5,"mode":"expand","fill":"#336699"}}]`,
	"rotate7-crop":   `[{"op":"rotate","p":{"angle":7.5,"mode":"crop"}}]`,
	"rotate7-fill":   `[{"op":"rotate","p":{"angle":-33,"mode":"fill","fill":"#ffffff80"}}]`,
	"flip-h":         `[{"op":"flip","p":{"axis":"h"}}]`,
	"flip-v":         `[{"op":"flip","p":{"axis":"v"}}]`,
	"crop":           `[{"op":"crop","p":{"rect":{"x":0.1,"y":0.2,"w":0.5,"h":0.6}}}]`,
	"resize-lanczos": `[{"op":"resize","p":{"mode":"pixels","w":23,"h":17,"algo":"lanczos3"}}]`,
	"resize-catmull": `[{"op":"resize","p":{"mode":"pixels","w":23,"h":17,"algo":"catmull"}}]`,
	"resize-linear":  `[{"op":"resize","p":{"mode":"pixels","w":23,"h":17,"algo":"bilinear"}}]`,
	"resize-nearest": `[{"op":"resize","p":{"mode":"pixels","w":23,"h":17,"algo":"nearest"}}]`,
	"resize-up":      `[{"op":"resize","p":{"mode":"percent","w":250}}]`,
	"resize-fit":     `[{"op":"resize","p":{"mode":"fit","w":20,"h":20}}]`,
	"resize-fill":    `[{"op":"resize","p":{"mode":"fill","w":20,"h":20}}]`,
	"resize-print":   `[{"op":"resize","p":{"mode":"print","w":1,"h":0,"unit":"in","dpi":30}}]`,
	"canvas-grow":    `[{"op":"canvas","p":{"w":80,"h":60,"anchor":"se","fill":"#102030"}}]`,
	"canvas-edge":    `[{"op":"canvas","p":{"w":80,"h":60,"anchor":"c","fill":"edge"}}]`,
	"canvas-shrink":  `[{"op":"canvas","p":{"w":30,"h":0,"anchor":"n"}}]`,
	"dpi-resample":   `[{"op":"dpi","p":{"x":144,"resample":true}}]`,
	"chain":          `[{"op":"rotate","p":{"angle":3,"mode":"crop"}},{"op":"crop","p":{"rect":{"x":0,"y":0,"w":0.8,"h":0.8}}},{"op":"resize","p":{"mode":"fit","w":32,"h":32}},{"op":"flip","p":{"axis":"h"}}]`,
}

var goldenSources = map[string]func() *image.RGBA{
	"61x47":       func() *image.RGBA { return testImage(61, 47, false) },
	"61x47-alpha": func() *image.RGBA { return testImage(61, 47, true) },
	"1x1":         func() *image.RGBA { return testImage(1, 1, false) },
	"1x9":         func() *image.RGBA { return testImage(1, 9, true) },
	"9x1":         func() *image.RGBA { return testImage(9, 1, false) },
}

func TestGoldenOperations(t *testing.T) {
	path := filepath.Join("testdata", "golden.json")
	want := map[string]string{}
	if b, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(b, &want); err != nil {
			t.Fatal(err)
		}
	}
	got := map[string]string{}
	for sname, src := range goldenSources {
		for cname, js := range goldenCases {
			img := src()
			before := hashOf(img)
			out := mustApply(t, img, edits(t, js))
			if hashOf(img) != before {
				t.Errorf("%s/%s modified its input", sname, cname)
			}
			w, h := edits(t, js).OutputSize(img.Rect.Dx(), img.Rect.Dy())
			if out.Rect.Dx() != w || out.Rect.Dy() != h {
				t.Errorf("%s/%s: OutputSize %dx%d, actual %v", sname, cname, w, h, out.Rect)
			}
			got[sname+"/"+cname] = hashOf(out)
		}
	}
	if *updateGolden {
		keys := make([]string, 0, len(got))
		for k := range got {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var b bytes.Buffer
		b.WriteString("{\n")
		for i, k := range keys {
			fmt.Fprintf(&b, "  %q: %q", k, got[k])
			if i < len(keys)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString("}\n")
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, b.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	for k, v := range got {
		if want[k] != v {
			t.Errorf("%s: got %s, golden %q (run with -update after bumping the operation's Version)", k, v, want[k])
		}
	}
}

func TestDeterministicAcrossWorkers(t *testing.T) {
	defer SetWorkers(0)
	src := testImage(700, 500, true)
	for name, js := range goldenCases {
		var first string
		for _, n := range []int{1, 2, 3, 8} {
			SetWorkers(n)
			h := hashOf(mustApply(t, src, edits(t, js)))
			if first == "" {
				first = h
			} else if h != first {
				t.Errorf("%s differs with %d workers", name, n)
			}
		}
	}
	SetWorkers(1)
	one, _ := Histogram(context.Background(), src)
	SetWorkers(8)
	eight, _ := Histogram(context.Background(), src)
	if one != eight {
		t.Error("histogram depends on the worker count")
	}
}

func TestQuarterTurnsAreExact(t *testing.T) {
	src := testImage(37, 23, true)
	for angle, orientation := range map[float64]int{90: 6, 180: 3, 270: 8, -90: 8, -180: 3, 360: 1, 0: 1} {
		out := mustApply(t, src, edits(t, fmt.Sprintf(`[{"op":"rotate","p":{"angle":%g,"mode":"crop"}}]`, angle)))
		want := Orient(src, orientation)
		if hashOf(out) != hashOf(want) {
			t.Errorf("rotate %g is not the exact pixel move", angle)
		}
	}
	// Four quarter turns and two flips are the identity.
	e := edits(t, `[{"op":"rotate","p":{"angle":90}},{"op":"rotate","p":{"angle":90}},{"op":"flip","p":{"axis":"h"}},{"op":"rotate","p":{"angle":90}},{"op":"rotate","p":{"angle":90}},{"op":"flip","p":{"axis":"h"}}]`)
	if hashOf(mustApply(t, src, e)) != hashOf(src) {
		t.Error("turns and flips do not compose to the identity")
	}
}

func TestRotateCropHasNoFill(t *testing.T) {
	// A white picture turned with a red fill: the largest inscribed
	// rectangle must not contain any of the fill, at any angle.
	src := image.NewRGBA(image.Rect(0, 0, 240, 135))
	for i := range src.Pix {
		src.Pix[i] = 0xFF
	}
	for _, angle := range []float64{0.3, 1, 7.5, 30, 44.9, 45, 60, 89.5, -12, 133} {
		for _, size := range [][2]int{{240, 135}, {135, 240}, {200, 200}} {
			img := image.NewRGBA(image.Rect(0, 0, size[0], size[1]))
			for i := range img.Pix {
				img.Pix[i] = 0xFF
			}
			out := mustApply(t, img, edits(t, fmt.Sprintf(`[{"op":"rotate","p":{"angle":%g,"mode":"crop","fill":"#ff0000"}}]`, angle)))
			for i, v := range out.Pix {
				if v != 0xFF {
					t.Fatalf("angle %g on %v: fill at byte %d of %v", angle, size, i, out.Rect)
				}
			}
			// The rectangle really is inside: its corners map into the source.
			sin, cos := math.Sincos(angle * math.Pi / 180)
			hw, hh := float64(out.Rect.Dx())/2, float64(out.Rect.Dy())/2
			for _, c := range [][2]float64{{-hw, -hh}, {hw, -hh}, {hw, hh}, {-hw, hh}} {
				sx, sy := cos*c[0]+sin*c[1], -sin*c[0]+cos*c[1]
				if math.Abs(sx) > float64(size[0])/2+1e-6 || math.Abs(sy) > float64(size[1])/2+1e-6 {
					t.Fatalf("angle %g on %v: corner %v leaves the source", angle, size, c)
				}
			}
		}
	}
}

func TestRotateExpandKeepsThePicture(t *testing.T) {
	src := testImage(64, 40, false)
	out := mustApply(t, src, edits(t, `[{"op":"rotate","p":{"angle":45,"mode":"expand","fill":"transparent"}}]`))
	if out.Rect.Dx() != 74 || out.Rect.Dy() != 74 {
		t.Fatalf("expand size %v", out.Rect)
	}
	// Corners are outside the turned picture, the center is opaque.
	if out.RGBAAt(0, 0).A != 0 || out.RGBAAt(73, 73).A != 0 || out.RGBAAt(37, 37).A != 0xFF {
		t.Fatal("expand did not fill the corners or lost the center")
	}
}

func TestOutputSizeMatchesActualSize(t *testing.T) {
	rng := rand.New(rand.NewSource(12))
	anchors := []string{"nw", "n", "ne", "w", "c", "e", "sw", "s", "se"}
	algos := []string{"lanczos3", "catmull", "bilinear", "nearest"}
	modes := []string{"expand", "crop", "fill"}
	for range 300 {
		w, h := 1+rng.Intn(90), 1+rng.Intn(90)
		var e EditList
		for range 1 + rng.Intn(4) {
			var op string
			switch rng.Intn(8) {
			case 0:
				op = fmt.Sprintf(`{"op":"rotate","p":{"angle":%g,"mode":%q}}`, float64(rng.Intn(720)-360)/2, modes[rng.Intn(3)])
			case 1:
				op = fmt.Sprintf(`{"op":"flip","p":{"axis":%q}}`, []string{"h", "v"}[rng.Intn(2)])
			case 2:
				x, y := rng.Float64()*0.6, rng.Float64()*0.6
				op = fmt.Sprintf(`{"op":"crop","p":{"rect":{"x":%g,"y":%g,"w":%g,"h":%g}}}`, x, y, 0.05+rng.Float64()*(0.95-x), 0.05+rng.Float64()*(0.95-y))
			case 3:
				op = fmt.Sprintf(`{"op":"resize","p":{"mode":"pixels","w":%d,"h":%d,"algo":%q,"noEnlarge":%v}}`, rng.Intn(120), 1+rng.Intn(120), algos[rng.Intn(4)], rng.Intn(2) == 0)
			case 4:
				op = fmt.Sprintf(`{"op":"resize","p":{"mode":%q,"w":%d,"h":%d,"noEnlarge":%v}}`, []string{"fit", "fill"}[rng.Intn(2)], 1+rng.Intn(120), 1+rng.Intn(120), rng.Intn(2) == 0)
			case 5:
				op = fmt.Sprintf(`{"op":"resize","p":{"mode":"percent","w":%d}}`, 1+rng.Intn(300))
			case 6:
				op = fmt.Sprintf(`{"op":"canvas","p":{"w":%d,"h":%d,"anchor":%q,"fill":%q}}`, rng.Intn(120), 1+rng.Intn(120), anchors[rng.Intn(9)], []string{"#fff", "edge", "transparent"}[rng.Intn(3)])
			case 7:
				op = fmt.Sprintf(`{"op":"dpi","p":{"x":%d,"resample":%v}}`, 36+rng.Intn(200), rng.Intn(2) == 0)
			}
			e = append(e, edits(t, "["+op+"]")...)
		}
		pw, ph := e.OutputSize(w, h)
		out, err := Apply(context.Background(), testImage(w, h, rng.Intn(2) == 0), e)
		if err != nil {
			t.Fatalf("%dx%d %v: %v", w, h, e, err)
		}
		if out.Rect.Dx() != pw || out.Rect.Dy() != ph {
			js, _ := json.Marshal(e)
			t.Fatalf("%dx%d %s: predicted %dx%d, got %v", w, h, js, pw, ph, out.Rect)
		}
	}
}

func TestResizeModes(t *testing.T) {
	sizes := map[string][2]int{
		`{"mode":"pixels","w":100,"h":0}`:                       {100, 50},
		`{"mode":"pixels","w":0,"h":100}`:                       {200, 100},
		`{"mode":"pixels","w":30,"h":90}`:                       {30, 90},
		`{"mode":"percent","w":50}`:                             {200, 100},
		`{"mode":"percent","w":50,"h":200}`:                     {200, 400},
		`{"mode":"fit","w":100,"h":100}`:                        {100, 50},
		`{"mode":"fit","w":1000,"h":1000}`:                      {1000, 500},
		`{"mode":"fit","w":1000,"h":1000,"noEnlarge":true}`:     {400, 200},
		`{"mode":"fill","w":100,"h":100}`:                       {100, 100},
		`{"mode":"fill","w":800,"h":100,"noEnlarge":true}`:      {400, 100},
		`{"mode":"print","w":2,"h":0,"unit":"in","dpi":150}`:    {300, 150},
		`{"mode":"print","w":2.54,"h":0,"unit":"cm","dpi":300}`: {300, 150},
		`{"mode":"pixels","w":800,"h":0,"noEnlarge":true}`:      {400, 200},
	}
	for p, want := range sizes {
		e := edits(t, `[{"op":"resize","p":`+p+`}]`)
		if w, h := e.OutputSize(400, 200); w != want[0] || h != want[1] {
			t.Errorf("%s: %dx%d, want %v", p, w, h, want)
		}
	}
	// Print size sets the resolution; dpi without resample only sets it.
	prog, err := Compile(edits(t, `[{"op":"resize","p":{"mode":"print","w":2,"h":0,"unit":"in","dpi":150}}]`), 400, 200, DPI{})
	if err != nil || prog.DPI() != (DPI{150, 150}) {
		t.Fatalf("print dpi %v %v", prog.DPI(), err)
	}
	prog, _ = Compile(edits(t, `[{"op":"dpi","p":{"x":300}}]`), 400, 200, DPI{72, 72})
	if w, h := prog.Size(); w != 400 || h != 200 || prog.DPI() != (DPI{300, 300}) {
		t.Fatalf("dpi metadata only: %dx%d %v", w, h, prog.DPI())
	}
	prog, _ = Compile(edits(t, `[{"op":"dpi","p":{"x":144,"resample":true}}]`), 400, 200, DPI{72, 72})
	if w, h := prog.Size(); w != 800 || h != 400 {
		t.Fatalf("dpi resample: %dx%d", w, h)
	}
	// Fill keeps the center: a left-red right-blue picture stays split.
	src := image.NewRGBA(image.Rect(0, 0, 200, 50))
	for y := range 50 {
		for x := range 200 {
			c := color.RGBA{0xFF, 0, 0, 0xFF}
			if x >= 100 {
				c = color.RGBA{0, 0, 0xFF, 0xFF}
			}
			src.SetRGBA(x, y, c)
		}
	}
	out := mustApply(t, src, edits(t, `[{"op":"resize","p":{"mode":"fill","w":50,"h":50}}]`))
	if out.RGBAAt(5, 25).R != 0xFF || out.RGBAAt(44, 25).B != 0xFF {
		t.Fatal("fill did not cut the overflow off centered")
	}
}

func TestCanvasAnchorsAndFill(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for i := range src.Pix {
		src.Pix[i] = 0xFF
	}
	out := mustApply(t, src, edits(t, `[{"op":"canvas","p":{"w":6,"h":4,"anchor":"se","fill":"#ff0000"}}]`))
	if out.RGBAAt(5, 3) != (color.RGBA{0xFF, 0xFF, 0xFF, 0xFF}) || out.RGBAAt(0, 0) != (color.RGBA{0xFF, 0, 0, 0xFF}) || out.RGBAAt(3, 3).G != 0 {
		t.Fatalf("anchor se: %v %v", out.RGBAAt(5, 3), out.RGBAAt(0, 0))
	}
	edge := mustApply(t, testImage(4, 4, false), edits(t, `[{"op":"canvas","p":{"w":8,"h":8,"fill":"edge"}}]`))
	base := testImage(4, 4, false)
	if edge.RGBAAt(0, 0) != base.RGBAAt(0, 0) || edge.RGBAAt(7, 7) != base.RGBAAt(3, 3) || edge.RGBAAt(2, 0) != base.RGBAAt(0, 0) {
		t.Fatal("edge fill does not repeat the border")
	}
	shrunk := mustApply(t, testImage(9, 9, false), edits(t, `[{"op":"canvas","p":{"w":3,"h":3,"anchor":"c"}}]`))
	if shrunk.RGBAAt(0, 0) != testImage(9, 9, false).RGBAAt(3, 3) {
		t.Fatal("shrinking the canvas does not keep the center")
	}
}

func TestInvalidEdits(t *testing.T) {
	bad := []string{
		`[{"op":"nope"}]`,
		`[{"op":"rotate","p":{"angle":1e9}}]`,
		`[{"op":"rotate","p":{"angle":3,"mode":"spin"}}]`,
		`[{"op":"rotate","p":{"angle":3,"fill":"red"}}]`,
		`[{"op":"rotate","p":{"angle":3,"extra":1}}]`,
		`[{"op":"flip","p":{"axis":"x"}}]`,
		`[{"op":"flip"}]`,
		`[{"op":"crop","p":{}}]`,
		`[{"op":"crop","p":{"rect":{"x":0.5,"y":0,"w":0.6,"h":1}}}]`,
		`[{"op":"crop","p":{"rect":{"x":0,"y":0,"w":0,"h":1}}}]`,
		`[{"op":"resize","p":{"mode":"pixels","w":0,"h":0}}]`,
		`[{"op":"resize","p":{"mode":"pixels","w":70000,"h":1}}]`,
		`[{"op":"resize","p":{"mode":"pixels","w":10.5,"h":1}}]`,
		`[{"op":"resize","p":{"mode":"pixels","w":-1,"h":1}}]`,
		`[{"op":"resize","p":{"mode":"fit","w":10,"h":0}}]`,
		`[{"op":"resize","p":{"mode":"print","w":10,"h":0,"unit":"ft","dpi":300}}]`,
		`[{"op":"resize","p":{"mode":"print","w":10,"h":0,"unit":"cm"}}]`,
		`[{"op":"resize","p":{"mode":"pixels","w":10,"h":10,"algo":"magic"}}]`,
		`[{"op":"resize","p":{"mode":"stretch","w":10,"h":10}}]`,
		`[{"op":"canvas","p":{"w":0,"h":0}}]`,
		`[{"op":"canvas","p":{"w":10,"h":10,"anchor":"middle"}}]`,
		`[{"op":"canvas","p":{"w":10,"h":10,"fill":"#12"}}]`,
		`[{"op":"dpi","p":{"x":0}}]`,
		`[{"op":"dpi","p":{"x":300,"y":20000}}]`,
		`[{"op":"dpi","p":"300"}]`,
	}
	for _, js := range bad {
		if err := edits(t, js).Validate(); !errors.Is(err, ErrInvalidEdit) {
			t.Errorf("%s: %v", js, err)
		}
	}
	long := make(EditList, MaxEditOps+1)
	for i := range long {
		long[i] = Op{Kind: "flip", Params: json.RawMessage(`{"axis":"h"}`)}
	}
	if err := long.Validate(); !errors.Is(err, ErrInvalidEdit) {
		t.Errorf("too many operations: %v", err)
	}
	// A list that would make the picture too large is refused before any
	// pixel work.
	if _, err := Compile(edits(t, `[{"op":"resize","p":{"mode":"pixels","w":60000,"h":60000}}]`), 100, 100, DPI{}); !errors.Is(err, ErrTooLarge) {
		t.Errorf("huge resize: %v", err)
	}
	if _, err := Compile(edits(t, `[{"op":"resize","p":{"mode":"percent","w":10000}}]`), 5000, 5000, DPI{}); !errors.Is(err, ErrTooLarge) {
		t.Errorf("huge percent: %v", err)
	}
}

func TestKeysAndSwitchedOffOperations(t *testing.T) {
	a := edits(t, `[{"op":"flip","p":{"axis":"h"}},{"op":"rotate","p":{"angle":90}}]`)
	b := edits(t, `[{"op":"flip","p":{ "axis" : "h" }},{"op":"rotate","p":{"angle":90}}]`)
	if a.Key() == "" || a.Key() != b.Key() {
		t.Fatal("whitespace changes the key")
	}
	c := edits(t, `[{"op":"flip","p":{"axis":"h"}},{"op":"rotate","p":{"angle":91}}]`)
	pa, _ := Compile(a, 10, 10, DPI{})
	pc, _ := Compile(c, 10, 10, DPI{})
	if pa.Key(1) != pc.Key(1) || pa.Key(2) == pc.Key(2) || pa.Key(0) != "" {
		t.Fatal("prefix keys do not follow the prefix")
	}
	off := edits(t, `[{"op":"flip","p":{"axis":"h"},"off":true},{"op":"rotate","p":{"angle":90}}]`)
	po, _ := Compile(off, 10, 20, DPI{})
	if po.Len() != 1 {
		t.Fatalf("a switched-off operation runs: %d steps", po.Len())
	}
	if (EditList{}).Key() != "" || edits(t, `[{"op":"flip","p":{"axis":"h"},"off":true}]`).Key() != "" {
		t.Fatal("an empty list has a key")
	}
	if !a.Batchable() {
		t.Fatal("geometry operations are batch-capable")
	}
}

func TestRunFromCheckpoint(t *testing.T) {
	src := testImage(120, 80, false)
	e := edits(t, goldenCases["chain"])
	p, err := Compile(e, 120, 80, DPI{})
	if err != nil {
		t.Fatal(err)
	}
	var kept []*image.RGBA
	full, err := p.Run(context.Background(), src, 0, RunOptions{Scale: 1,
		Keep: func(int) bool { return true },
		Each: func(_ int, img *image.RGBA) { kept = append(kept, img) }})
	if err != nil {
		t.Fatal(err)
	}
	hashes := make([]string, len(kept))
	for i, k := range kept {
		hashes[i] = hashOf(k)
	}
	for from := 1; from < p.Len(); from++ {
		out, err := p.Run(context.Background(), kept[from-1], from, RunOptions{Scale: 1})
		if err != nil {
			t.Fatal(err)
		}
		if hashOf(out) != hashOf(full) {
			t.Fatalf("resuming after %d steps gives another picture", from)
		}
	}
	// Kept images are never modified by later steps.
	for i, k := range kept {
		if hashOf(k) != hashes[i] {
			t.Fatalf("checkpoint %d was modified", i)
		}
	}
}

func TestProxyIsCloseToFinal(t *testing.T) {
	src := testImage(800, 600, false)
	// Blur the test pattern first so the comparison is about geometry, not
	// about aliasing of a synthetic texture.
	smooth, _ := Resample(context.Background(), src, 200, 150, Bilinear)
	src, _ = Resample(context.Background(), smooth, 800, 600, Bilinear)
	e := edits(t, `[{"op":"rotate","p":{"angle":12,"mode":"crop"}},{"op":"crop","p":{"rect":{"x":0.1,"y":0.1,"w":0.7,"h":0.8}}},{"op":"resize","p":{"mode":"fit","w":400,"h":400}},{"op":"canvas","p":{"w":500,"h":500,"fill":"#808080"}}]`)
	p, err := Compile(e, 800, 600, DPI{})
	if err != nil {
		t.Fatal(err)
	}
	final, err := p.Run(context.Background(), src, 0, RunOptions{Scale: 1})
	if err != nil {
		t.Fatal(err)
	}
	half, _ := Resample(context.Background(), src, 400, 300, Bilinear)
	proxy, err := p.Run(context.Background(), half, 0, RunOptions{Scale: 0.5, Draft: true})
	if err != nil {
		t.Fatal(err)
	}
	if proxy.Rect.Dx() != 250 || proxy.Rect.Dy() != 250 {
		t.Fatalf("proxy size %v", proxy.Rect)
	}
	down, _ := Resample(context.Background(), final, 250, 250, Bilinear)
	var diff int
	for i := range down.Pix {
		d := int(down.Pix[i]) - int(proxy.Pix[i])
		diff += max(d, -d)
	}
	if avg := float64(diff) / float64(len(down.Pix)); avg > 4 {
		t.Fatalf("proxy and final diverge: mean abs diff %.2f", avg)
	}
}

func TestCancelStopsARun(t *testing.T) {
	src := testImage(1200, 900, false)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Apply(ctx, src, edits(t, goldenCases["rotate7-expand"])); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled run: %v", err)
	}
	if _, err := Resample(ctx, src, 300, 200, Lanczos3); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled resample: %v", err)
	}
}

func TestHistogram(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 1))
	img.SetRGBA(0, 0, color.RGBA{0, 0, 0, 0xFF})
	img.SetRGBA(1, 0, color.RGBA{0xFF, 0xFF, 0xFF, 0xFF})
	img.SetRGBA(2, 0, color.RGBA{0x40, 0x40, 0x40, 0x80}) // premultiplied half-transparent gray 0x80
	// the last pixel stays fully transparent and is not counted
	s, err := Histogram(context.Background(), img)
	if err != nil {
		t.Fatal(err)
	}
	if s.Pixels != 3 || s.ClipLow != 1 || s.ClipHigh != 1 || s.Lum[0] != 1 || s.Lum[255] != 1 || s.R[0x80] != 1 {
		t.Fatalf("histogram %+v", struct{ P, L, H uint32 }{s.Pixels, s.ClipLow, s.ClipHigh})
	}
	if math.Abs(s.Mean-(0+255+128)/3.0) > 0.5 {
		t.Fatalf("mean %v", s.Mean)
	}
}

func TestParseColor(t *testing.T) {
	for in, want := range map[string]color.RGBA{
		"":            {},
		"transparent": {},
		"#fff":        {0xFF, 0xFF, 0xFF, 0xFF},
		"#102030":     {0x10, 0x20, 0x30, 0xFF},
		"#ff000080":   {0x80, 0, 0, 0x80},
	} {
		if got, err := ParseColor(in); err != nil || got != want {
			t.Errorf("%q: %v %v", in, got, err)
		}
	}
	for _, in := range []string{"red", "#12", "#gggggg", "123456", "#1234567"} {
		if _, err := ParseColor(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
}

// --- EXIF ---

type tEntry struct {
	tag, typ uint16
	count    uint32
	data     []byte // value bytes, in the block's byte order
	ptr      *tIFD  // the value is the offset of this directory
	blob     []byte // the value is the offset of these bytes
}

type tIFD struct {
	entries []tEntry
	next    *tIFD
	off     uint32
}

// buildTIFF lays directories out after the header and values after them.
func buildTIFF(bo binary.ByteOrder, ifds ...*tIFD) []byte {
	off := uint32(8)
	for _, d := range ifds {
		d.off = off
		off += 2 + uint32(len(d.entries))*12 + 4
	}
	var data bytes.Buffer
	place := func(b []byte) uint32 {
		at := off + uint32(data.Len())
		data.Write(b)
		if data.Len()&1 == 1 {
			data.WriteByte(0)
		}
		return at
	}
	out := make([]byte, 8, 1024)
	if bo == binary.LittleEndian {
		copy(out, "II")
	} else {
		copy(out, "MM")
	}
	bo.PutUint16(out[2:], 42)
	bo.PutUint32(out[4:], 8)
	for _, d := range ifds {
		var n [2]byte
		bo.PutUint16(n[:], uint16(len(d.entries)))
		out = append(out, n[:]...)
		for _, e := range d.entries {
			var b [12]byte
			bo.PutUint16(b[:], e.tag)
			bo.PutUint16(b[2:], e.typ)
			bo.PutUint32(b[4:], e.count)
			switch {
			case e.ptr != nil:
				bo.PutUint32(b[8:], e.ptr.off)
			case e.blob != nil:
				bo.PutUint32(b[8:], place(e.blob))
			case len(e.data) > 4:
				bo.PutUint32(b[8:], place(e.data))
			default:
				copy(b[8:], e.data)
			}
			out = append(out, b[:]...)
		}
		var next [4]byte
		if d.next != nil {
			bo.PutUint32(next[:], d.next.off)
		}
		out = append(out, next[:]...)
	}
	return append(out, data.Bytes()...)
}

func u16(bo binary.ByteOrder, v uint16) []byte {
	b := make([]byte, 2)
	bo.PutUint16(b, v)
	return b
}

func u32(bo binary.ByteOrder, v uint32) []byte {
	b := make([]byte, 4)
	bo.PutUint32(b, v)
	return b
}

func rat(bo binary.ByteOrder, pairs ...uint32) []byte {
	b := make([]byte, 4*len(pairs))
	for i, v := range pairs {
		bo.PutUint32(b[i*4:], v)
	}
	return b
}

var thumbBytes = bytes.Repeat([]byte{0xAB}, 64)

// sampleExif is a camera-like EXIF block with a GPS directory and a
// thumbnail.
func sampleExif(bo binary.ByteOrder) []byte {
	exif := &tIFD{entries: []tEntry{
		{tag: 0x829A, typ: 5, count: 1, data: rat(bo, 1, 250)},
		{tag: 0x829D, typ: 5, count: 1, data: rat(bo, 28, 10)},
		{tag: 0x8822, typ: 3, count: 1, data: u16(bo, 3)},
		{tag: 0x8827, typ: 3, count: 1, data: u16(bo, 400)},
		{tag: 0x9003, typ: 2, count: 20, data: []byte("2026:10:11 09:30:00\x00")},
		{tag: 0x9204, typ: 10, count: 1, data: rat(bo, uint32(0xFFFFFFFF), 3)}, // -1/3
		{tag: 0x9209, typ: 3, count: 1, data: u16(bo, 1)},
		{tag: 0x920A, typ: 5, count: 1, data: rat(bo, 50, 1)},
		{tag: 0xA002, typ: 4, count: 1, data: u32(bo, 6000)},
		{tag: 0xA003, typ: 4, count: 1, data: u32(bo, 4000)},
		{tag: 0xA434, typ: 2, count: 13, data: []byte("RF 50mm F1.8\x00")},
	}}
	gps := &tIFD{entries: []tEntry{
		{tag: 1, typ: 2, count: 2, data: []byte("N\x00")},
		{tag: 2, typ: 5, count: 3, data: rat(bo, 47, 1, 29, 1, 528, 10)},
		{tag: 3, typ: 2, count: 2, data: []byte("E\x00")},
		{tag: 4, typ: 5, count: 3, data: rat(bo, 19, 1, 2, 1, 240, 10)},
		{tag: 6, typ: 5, count: 1, data: rat(bo, 1205, 10)},
	}}
	thumb := &tIFD{entries: []tEntry{
		{tag: 0x0201, typ: 4, count: 1, blob: thumbBytes},
		{tag: 0x0202, typ: 4, count: 1, data: u32(bo, uint32(len(thumbBytes)))},
	}}
	ifd0 := &tIFD{next: thumb, entries: []tEntry{
		{tag: 0x010F, typ: 2, count: 9, data: []byte("Panelyth\x00")},
		{tag: 0x0110, typ: 2, count: 8, data: []byte("Model X\x00")},
		{tag: 0x0112, typ: 3, count: 1, data: u16(bo, 6)},
		{tag: 0x011A, typ: 5, count: 1, data: rat(bo, 300, 1)},
		{tag: 0x011B, typ: 5, count: 1, data: rat(bo, 300, 1)},
		{tag: 0x0128, typ: 3, count: 1, data: u16(bo, 2)},
		{tag: 0x0131, typ: 2, count: 5, data: []byte("Test\x00")},
		{tag: 0x8769, typ: 4, count: 1, ptr: exif},
		{tag: 0x8825, typ: 4, count: 1, ptr: gps},
	}}
	return buildTIFF(bo, ifd0, exif, gps, thumb)
}

func infoMap(groups []InfoGroup) map[string]string {
	m := map[string]string{}
	for _, g := range groups {
		for _, it := range g.Items {
			m[g.Name+"."+it.ID] = it.Value
		}
	}
	return m
}

func TestExifInfo(t *testing.T) {
	for _, bo := range []binary.ByteOrder{binary.LittleEndian, binary.BigEndian} {
		b := sampleExif(bo)
		got := infoMap(ExifInfo(bytes.NewReader(b), int64(len(b))))
		want := map[string]string{
			"camera.Make": "Panelyth", "camera.Model": "Model X", "software.Software": "Test",
			"exposure.ExposureTime": "1/250 s", "exposure.FNumber": "f/2.8", "exposure.ISO": "400",
			"exposure.ExposureBias": "-0.33 EV", "exposure.ExposureProgram": "aperturePriority", "exposure.Flash": "flashFired",
			"lens.FocalLength": "50 mm", "lens.LensModel": "RF 50mm F1.8",
			"date.DateTimeOriginal": "2026-10-11 09:30:00",
			"gps.GPSLatitude":       "47° 29′ 52.8″ N", "gps.GPSLongitude": "19° 2′ 24″ E", "gps.GPSAltitude": "120.5 m",
			"image.ExifImageSize": "6000 × 4000", "image.Resolution": "300 dpi",
		}
		for k, v := range want {
			if got[k] != v {
				t.Errorf("%v %s = %q, want %q", bo, k, got[k], v)
			}
		}
		if len(got) != len(want) {
			t.Errorf("%v: %d items, want %d: %v", bo, len(got), len(want), got)
		}
	}
}

func TestPatchExif(t *testing.T) {
	for _, bo := range []binary.ByteOrder{binary.LittleEndian, binary.BigEndian} {
		src := sampleExif(bo)
		keep := PatchExif(src, 1200, 800, DPI{144, 144}, false)
		if len(keep) != len(src) {
			t.Fatal("patching changed the length")
		}
		got := infoMap(ExifInfo(bytes.NewReader(keep), int64(len(keep))))
		if got["image.ExifImageSize"] != "1200 × 800" || got["image.Resolution"] != "144 dpi" || got["gps.GPSLatitude"] == "" || got["camera.Make"] != "Panelyth" {
			t.Fatalf("%v: patched tags %v", bo, got)
		}
		if jpegOrientationOf(keep) != 1 {
			t.Fatalf("%v: orientation not reset", bo)
		}
		if bytes.Contains(keep, thumbBytes[:16]) {
			t.Fatalf("%v: the stale thumbnail is still in the block", bo)
		}
		stripped := PatchExif(src, 1200, 800, DPI{}, true)
		got = infoMap(ExifInfo(bytes.NewReader(stripped), int64(len(stripped))))
		for k := range got {
			if len(k) > 4 && k[:4] == "gps." {
				t.Fatalf("%v: %s survived strip GPS", bo, k)
			}
		}
		// The coordinates themselves are gone, not just unlinked.
		if bytes.Contains(stripped, rat(bo, 47, 1, 29, 1)) || bytes.Contains(stripped, rat(bo, 19, 1, 2, 1)) {
			t.Fatalf("%v: GPS values still in the block", bo)
		}
		if got["camera.Make"] != "Panelyth" || got["exposure.ISO"] != "400" || got["image.Resolution"] != "300 dpi" {
			t.Fatalf("%v: strip GPS damaged other tags: %v", bo, got)
		}
	}
	if PatchExif([]byte("not exif"), 1, 1, DPI{}, true) != nil {
		t.Fatal("garbage was passed through")
	}
}

func jpegOrientationOf(exif []byte) int { return tiffOrientation(exif) }

func TestExifHostileInput(t *testing.T) {
	good := sampleExif(binary.LittleEndian)
	cases := map[string][]byte{
		"empty":     {},
		"header":    good[:8],
		"truncated": good[:len(good)/2],
		"cut-ifd":   good[:20],
	}
	// A directory that claims 65535 entries.
	huge := bytes.Clone(good)
	binary.LittleEndian.PutUint16(huge[8:], 0xFFFF)
	cases["huge-count"] = huge
	// A value with a huge count and an offset past the end.
	wild := bytes.Clone(good)
	binary.LittleEndian.PutUint32(wild[8+2+4:], 0xFFFFFFF0)
	binary.LittleEndian.PutUint32(wild[8+2+8:], 0xFFFFFF00)
	cases["wild-value"] = wild
	// The next-directory offset points back at the first directory, and the
	// EXIF pointer at itself.
	loop := bytes.Clone(good)
	binary.LittleEndian.PutUint32(loop[8+2+9*12:], 8)
	binary.LittleEndian.PutUint32(loop[8+2+7*12+8:], 8)
	cases["loop"] = loop
	for name, b := range cases {
		_ = ExifInfo(bytes.NewReader(b), int64(len(b)))
		_ = PatchExif(b, 10, 10, DPI{72, 72}, true)
		_ = name
	}
}

func FuzzExif(f *testing.F) {
	f.Add(sampleExif(binary.LittleEndian))
	f.Add(sampleExif(binary.BigEndian))
	f.Add([]byte("II*\x00\x08\x00\x00\x00\xff\xff"))
	f.Add([]byte("MM\x00*\x00\x00\x00\x08\x00\x01\x87\x69\x00\x04\x00\x00\x00\x01\x00\x00\x00\x08\x00\x00\x00\x08"))
	f.Fuzz(func(t *testing.T, b []byte) {
		if len(b) > 1<<16 {
			return
		}
		for _, g := range ExifInfo(bytes.NewReader(b), int64(len(b))) {
			for _, it := range g.Items {
				if len(it.Value) > maxTagString*4+64 {
					t.Fatalf("unbounded value for %s", it.ID)
				}
			}
		}
		if out := PatchExif(b, 100, 50, DPI{300, 300}, true); out != nil && len(out) != len(b) {
			t.Fatal("patch changed the length")
		}
	})
}
