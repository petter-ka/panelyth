package imaging

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"math/rand"
	"os"
	"testing"
)

// The Stage 13 cases join the golden set (TestGoldenOperations) and the
// worker-count check (TestDeterministicAcrossWorkers).
func init() {
	for name, js := range map[string]string{
		"lighting-mid":     `[{"op":"lighting","p":{"exposure":0.5,"contrast":20,"shadows":30,"highlights":-20}}]`,
		"lighting-extreme": `[{"op":"lighting","p":{"exposure":-3,"brightness":100,"contrast":-100,"gamma":5,"highlights":100,"shadows":-100,"whites":100,"blacks":-100}}]`,
		"colors-mid":       `[{"op":"colors","p":{"saturation":25,"vibrance":40,"hue":30,"temperature":20,"tint":-10}}]`,
		"colors-balance":   `[{"op":"colors","p":{"saturation":-100,"hue":-180,"balance":{"shadows":[100,0,-100],"midtones":[0,50,0],"highlights":[-100,0,100]}}}]`,
		"levels-mid":       `[{"op":"levels","p":{"l":{"inBlack":20,"inWhite":230,"gamma":1.2,"outBlack":0,"outWhite":255},"r":{"inBlack":0,"inWhite":255,"gamma":0.8,"outBlack":10,"outWhite":240}}}]`,
		"levels-auto":      `[{"op":"levels","p":{"auto":{"clip":0.5,"mode":"rgb","gamma":true}}}]`,
		"curves-s":         `[{"op":"curves","p":{"l":[[0,0],[64,48],[192,208],[255,255]],"b":[[0,20],[255,235]]}}]`,
		"grayscale":        `[{"op":"grayscale","p":{}}]`,
		"grayscale-mixer":  `[{"op":"grayscale","p":{"method":"mixer","mix":[120,-20,0]}}]`,
		"grayscale-desat":  `[{"op":"grayscale","p":{"method":"desaturate"}}]`,
		"sepia":            `[{"op":"sepia","p":{"strength":80,"tone":40}}]`,
		"negative":         `[{"op":"negative","p":{}}]`,
		"negative-red":     `[{"op":"negative","p":{"channels":"r"}}]`,
		"swap-bgr":         `[{"op":"swapChannels","p":{"order":"bgr"}}]`,
		"replace-color":    `[{"op":"replaceColor","p":{"from":"#808080","to":"#ff0000","tolerance":30,"softness":40,"keepLuminance":true}}]`,
		"blur-gauss":       `[{"op":"blur","p":{"radius":3}}]`,
		"blur-small":       `[{"op":"blur","p":{"radius":0.8}}]`,
		"blur-box":         `[{"op":"blur","p":{"type":"box","radius":4}}]`,
		"blur-motion":      `[{"op":"blur","p":{"type":"motion","radius":9,"angle":30}}]`,
		"sharpen":          `[{"op":"sharpen","p":{"amount":150,"radius":1.5,"threshold":4}}]`,
		"denoise-fast":     `[{"op":"denoise","p":{"luminance":60,"color":50,"detail":30}}]`,
		"denoise-high":     `[{"op":"denoise","p":{"luminance":40,"quality":"high"}}]`,
		"reduce-16":        `[{"op":"reduceColors","p":{"count":16}}]`,
		"reduce-fs":        `[{"op":"reduceColors","p":{"count":8,"dither":"fs","keepTransparency":true}}]`,
		"reduce-ordered":   `[{"op":"reduceColors","p":{"count":32,"quantizer":"octree","dither":"ordered8"}}]`,
		"reduce-web":       `[{"op":"reduceColors","p":{"count":216,"quantizer":"web","dither":"ordered4"}}]`,
		"reduce-gray":      `[{"op":"reduceColors","p":{"count":4,"quantizer":"gray"}}]`,
		"point-chain":      `[{"op":"lighting","p":{"contrast":30}},{"op":"colors","p":{"saturation":40,"vibrance":-20}},{"op":"curves","p":{"l":[[0,10],[128,140],[255,245]]}},{"op":"sepia","p":{"strength":30}},{"op":"negative","p":{"channels":"g"}}]`,
	} {
		goldenCases[name] = js
	}
}

func same(a, b *image.RGBA) bool { return a.Rect == b.Rect && bytes.Equal(a.Pix, b.Pix) }

func TestIdentityParametersChangeNothing(t *testing.T) {
	for _, alpha := range []bool{false, true} {
		src := testImage(90, 60, alpha)
		before := hashOf(src)
		for _, js := range []string{
			`[{"op":"lighting","p":{}}]`,
			`[{"op":"lighting","p":{"gamma":1,"exposure":0}}]`,
			`[{"op":"colors","p":{}}]`,
			`[{"op":"colors","p":{"balance":{"shadows":[0,0,0],"midtones":[0,0,0],"highlights":[0,0,0]}}}]`,
			`[{"op":"levels","p":{}}]`,
			`[{"op":"levels","p":{"l":{"inBlack":0,"inWhite":255,"gamma":1,"outBlack":0,"outWhite":255}}}]`,
			`[{"op":"curves","p":{}}]`,
			`[{"op":"curves","p":{"l":[[0,0],[255,255]],"r":[[0,0],[100,100],[255,255]]}}]`,
			`[{"op":"sepia","p":{"strength":0}}]`,
			`[{"op":"swapChannels","p":{"order":"rgb"}}]`,
			`[{"op":"replaceColor","p":{"from":"#102030","to":"#102030","tolerance":50}}]`,
			`[{"op":"blur","p":{"radius":0}}]`,
			`[{"op":"blur","p":{"type":"motion","radius":1}}]`,
			`[{"op":"sharpen","p":{"amount":0,"radius":2}}]`,
			`[{"op":"denoise","p":{"luminance":0,"color":0}}]`,
		} {
			out := mustApply(t, src, edits(t, js))
			if !same(out, src) {
				t.Errorf("%s changed the picture (alpha %v)", js, alpha)
			}
		}
		if hashOf(src) != before {
			t.Fatal("the source was modified")
		}
	}
}

func TestFusedChainEqualsSequential(t *testing.T) {
	chains := []string{
		goldenCases["point-chain"],
		`[{"op":"levels","p":{"l":{"inBlack":10,"inWhite":240,"gamma":1.3,"outBlack":0,"outWhite":255}}},{"op":"curves","p":{"r":[[0,0],[80,120],[255,255]]}},{"op":"negative","p":{}},{"op":"lighting","p":{"exposure":1}}]`,
		`[{"op":"grayscale","p":{}},{"op":"sepia","p":{"strength":100}},{"op":"colors","p":{"hue":90,"saturation":50}},{"op":"swapChannels","p":{"order":"gbr"}}]`,
		// An automatic step in the middle looks at what came before it.
		`[{"op":"lighting","p":{"brightness":-30}},{"op":"levels","p":{"auto":{"clip":1,"mode":"lum"}}},{"op":"colors","p":{"vibrance":60}},{"op":"replaceColor","p":{"from":"#404040","to":"#00ff00","tolerance":20,"softness":20}}]`,
		// Geometry between point steps ends one pass and starts another.
		`[{"op":"negative","p":{}},{"op":"lighting","p":{"gamma":2}},{"op":"flip","p":{"axis":"h"}},{"op":"sepia","p":{"strength":50}},{"op":"curves","p":{"l":[[0,30],[255,200]]}}]`,
	}
	for _, alpha := range []bool{false, true} {
		src := testImage(123, 77, alpha)
		for i, js := range chains {
			e := edits(t, js)
			p, err := Compile(e, 123, 77, DPI{})
			if err != nil {
				t.Fatal(err)
			}
			fused, err := p.Run(context.Background(), src, 0, RunOptions{Scale: 1})
			if err != nil {
				t.Fatal(err)
			}
			// Keeping every image runs each step on its own.
			sequential, err := p.Run(context.Background(), src, 0, RunOptions{Scale: 1, Keep: func(int) bool { return true }})
			if err != nil {
				t.Fatal(err)
			}
			if !alpha {
				if !same(fused, sequential) {
					t.Errorf("chain %d: one pass differs from the steps run one by one", i)
				}
				continue
			}
			// Where a pixel is partly transparent, running the steps one by
			// one stores the color premultiplied between them and loses a
			// little each time; one pass does not. Opaque pixels are equal,
			// the others close.
			for o := 0; o < len(fused.Pix); o += 4 {
				a := fused.Pix[o+3]
				if a != sequential.Pix[o+3] {
					t.Fatalf("chain %d: alpha changed", i)
				}
				for c := range 3 {
					d := int(fused.Pix[o+c]) - int(sequential.Pix[o+c])
					if a == 255 && d != 0 || d > 8 || d < -8 {
						t.Fatalf("chain %d: byte %d differs by %d at alpha %d", i, o+c, d, a)
					}
				}
			}
		}
	}
}

func TestPointTables(t *testing.T) {
	// Negative is exact; twice is the identity and folds away entirely.
	src := testImage(40, 30, false)
	neg := mustApply(t, src, edits(t, `[{"op":"negative","p":{}}]`))
	for i := 0; i < len(src.Pix); i += 4 {
		if neg.Pix[i] != 255-src.Pix[i] || neg.Pix[i+1] != 255-src.Pix[i+1] || neg.Pix[i+2] != 255-src.Pix[i+2] || neg.Pix[i+3] != src.Pix[i+3] {
			t.Fatalf("negative at byte %d", i)
		}
	}
	twice := mustApply(t, src, edits(t, `[{"op":"negative","p":{}},{"op":"negative","p":{}}]`))
	if twice != src {
		t.Fatal("two negatives did not fold into nothing")
	}
	// Levels: the input range maps onto the output range.
	c := LevelsChannel{InBlack: 50, InWhite: 200, Gamma: 1, OutBlack: 10, OutWhite: 240}
	lut := c.lut()
	if lut[0] != 10 || lut[50] != 10 || lut[200] != 240 || lut[255] != 240 || lut[125] != 125 {
		t.Fatalf("levels table: %d %d %d %d %d", lut[0], lut[50], lut[125], lut[200], lut[255])
	}
	// A gamma above 1 lightens the midtones and leaves the ends.
	g := LevelsChannel{InBlack: 0, InWhite: 255, Gamma: 2, OutBlack: 0, OutWhite: 255}.lut()
	if g[0] != 0 || g[255] != 255 || g[64] != 128 {
		t.Fatalf("gamma 2: %d %d %d", g[0], g[64], g[255])
	}
	// Stretching a range and squeezing it back returns the values inside it.
	out := LevelsChannel{InBlack: 40, InWhite: 215, Gamma: 1, OutBlack: 0, OutWhite: 255}.lut()
	back := LevelsChannel{InBlack: 0, InWhite: 255, Gamma: 1, OutBlack: 40, OutWhite: 215}.lut()
	for v := 40; v <= 215; v++ {
		if d := int(back[out[v]]) - v; d > 1 || d < -1 {
			t.Fatalf("levels round trip at %d: %d", v, back[out[v]])
		}
	}
	// Swapping red and blue moves the values exactly.
	swapped := mustApply(t, src, edits(t, `[{"op":"swapChannels","p":{"order":"bgr"}}]`))
	for i := 0; i < len(src.Pix); i += 4 {
		if swapped.Pix[i] != src.Pix[i+2] || swapped.Pix[i+2] != src.Pix[i] || swapped.Pix[i+1] != src.Pix[i+1] {
			t.Fatalf("swap at byte %d", i)
		}
	}
	// Grayscale gives equal channels; full desaturation in Colors too.
	for _, js := range []string{`[{"op":"grayscale","p":{}}]`, `[{"op":"grayscale","p":{"method":"average"}}]`, `[{"op":"colors","p":{"saturation":-100}}]`} {
		gray := mustApply(t, src, edits(t, js))
		for i := 0; i < len(gray.Pix); i += 4 {
			if d := int(gray.Pix[i]) - int(gray.Pix[i+1]); d > 1 || d < -1 || gray.Pix[i+1] != gray.Pix[i+2] && js != `[{"op":"colors","p":{"saturation":-100}}]` {
				t.Fatalf("%s: not gray at byte %d: %v", js, i, gray.Pix[i:i+3])
			}
		}
	}
	// Three hue turns of 120° come back to where they started. (Only for
	// colors that stay in range on the way: a turned primary is cut off.)
	muted := mustApply(t, src, edits(t, `[{"op":"colors","p":{"saturation":-75}},{"op":"lighting","p":{"contrast":-40}}]`))
	turned := mustApply(t, muted, edits(t, `[{"op":"colors","p":{"hue":120}},{"op":"colors","p":{"hue":120}},{"op":"colors","p":{"hue":120}}]`))
	var worst int
	for i := range muted.Pix {
		d := int(turned.Pix[i]) - int(muted.Pix[i])
		worst = max(worst, d, -d)
	}
	if worst > 3 {
		t.Fatalf("three hue turns of 120° are off by %d", worst)
	}
	// A turn keeps the brightness.
	once := mustApply(t, muted, edits(t, `[{"op":"colors","p":{"hue":90}}]`))
	for i := 0; i < len(muted.Pix); i += 4 {
		a, b := Luma(muted.Pix[i], muted.Pix[i+1], muted.Pix[i+2]), Luma(once.Pix[i], once.Pix[i+1], once.Pix[i+2])
		if d := int(a) - int(b); d > 2 || d < -2 {
			t.Fatalf("a hue turn changed the luminance from %d to %d", a, b)
		}
	}
}

func TestCurveIsMonotoneAndExact(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for range 500 {
		n := 2 + rng.Intn(MaxCurvePoints-1)
		xs := rng.Perm(256)[:n]
		ys := make([]int, n)
		for i := range ys {
			ys[i] = rng.Intn(256)
		}
		// Rising in both, so the curve must rise too.
		sortInts(xs)
		sortInts(ys)
		pts := make([][2]float64, n)
		for i := range pts {
			pts[i] = [2]float64{float64(xs[i]), float64(ys[i])}
		}
		lut := CurveLUT(pts)
		for i, p := range pts {
			if int(lut[int(p[0])]) != ys[i] {
				t.Fatalf("the curve misses point %v: %d", p, lut[int(p[0])])
			}
		}
		for v := 1; v < 256; v++ {
			if lut[v] < lut[v-1] {
				t.Fatalf("not monotone at %d for %v", v, pts)
			}
		}
		// Flat before the first point and after the last.
		if lut[0] != uint8(ys[0]) || lut[255] != uint8(ys[n-1]) {
			t.Fatalf("ends: %d %d for %v", lut[0], lut[255], pts)
		}
	}
	id := CurveLUT([][2]float64{{0, 0}, {255, 255}})
	for v := range 256 {
		if id[v] != uint8(v) {
			t.Fatalf("the straight line is not the identity at %d", v)
		}
	}
}

func sortInts(a []int) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j-1] > a[j]; j-- {
			a[j-1], a[j] = a[j], a[j-1]
		}
	}
}

func TestAutoLevels(t *testing.T) {
	// A picture using 60..180 only: auto stretches exactly that range.
	var h Stats
	for v := 60; v <= 180; v++ {
		h.Lum[v], h.R[v], h.G[v], h.B[v] = 100, 100, 100, 100
	}
	l, _ := AutoLevels(&h, LevelsAuto{Clip: 0, Mode: "lum"})
	if l.InBlack != 60 || l.InWhite != 180 || l.Gamma != 1 {
		t.Fatalf("auto: %+v", l)
	}
	// One stray pixel at each end is ignored with a clip.
	h.Lum[0], h.Lum[255] = 1, 1
	l, _ = AutoLevels(&h, LevelsAuto{Clip: 0.5, Mode: "lum"})
	if l.InBlack != 60 || l.InWhite != 180 {
		t.Fatalf("auto with clip: %+v", l)
	}
	if l, _ = AutoLevels(&h, LevelsAuto{Clip: 0, Mode: "lum"}); l.InBlack != 0 || l.InWhite != 255 {
		t.Fatalf("auto without clip sees the stray pixels: %+v", l)
	}
	// Per channel: a cast is removed because each channel gets its own range.
	var cast Stats
	for v := 0; v <= 200; v++ {
		cast.R[v] = 10
	}
	for v := 30; v <= 255; v++ {
		cast.G[v], cast.B[v] = 10, 10
	}
	_, rgb := AutoLevels(&cast, LevelsAuto{Clip: 0, Mode: "rgb"})
	if rgb[0].InWhite != 200 || rgb[1].InBlack != 30 || rgb[2].InBlack != 30 || rgb[0].InBlack != 0 {
		t.Fatalf("per channel: %+v %+v %+v", rgb[0], rgb[1], rgb[2])
	}
	// Dark midtones get a gamma above 1, within limits.
	var dark Stats
	for v := range 256 {
		dark.Lum[v] = uint32(256 - v)
	}
	dark.Lum[20] = 100_000
	l, _ = AutoLevels(&dark, LevelsAuto{Clip: 0, Mode: "lum", Gamma: true})
	if l.Gamma <= 1 || l.Gamma > 1.6 {
		t.Fatalf("auto gamma for a dark picture: %v", l.Gamma)
	}
	// On a real picture auto levels fills the range.
	src := mustApply(t, testImage(120, 80, false), edits(t, `[{"op":"levels","p":{"l":{"inBlack":0,"inWhite":255,"gamma":1,"outBlack":70,"outWhite":170}}}]`))
	out := mustApply(t, src, edits(t, `[{"op":"levels","p":{"auto":{"clip":0,"mode":"lum"}}}]`))
	stats, _ := Histogram(context.Background(), out)
	lo, hi := 0, 255
	for stats.Lum[lo] == 0 {
		lo++
	}
	for stats.Lum[hi] == 0 {
		hi--
	}
	if lo > 4 || hi < 251 {
		t.Fatalf("auto levels left the range %d..%d", lo, hi)
	}
}

func TestReplaceColor(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 1))
	img.SetRGBA(0, 0, color.RGBA{200, 30, 30, 255})
	img.SetRGBA(1, 0, color.RGBA{201, 30, 30, 255})
	img.SetRGBA(2, 0, color.RGBA{30, 30, 200, 255})
	img.SetRGBA(3, 0, color.RGBA{100, 15, 15, 128}) // the first color, half transparent
	exact := mustApply(t, img, edits(t, `[{"op":"replaceColor","p":{"from":"#c81e1e","to":"#00ff00","tolerance":0}}]`))
	if exact.RGBAAt(0, 0) != (color.RGBA{0, 255, 0, 255}) {
		t.Fatalf("the exact color was not replaced: %v", exact.RGBAAt(0, 0))
	}
	// Tolerance 0 matches that color only: its neighbour by one level stays.
	if exact.RGBAAt(1, 0) != img.RGBAAt(1, 0) || exact.RGBAAt(2, 0) != img.RGBAAt(2, 0) {
		t.Fatal("tolerance 0 replaced another color")
	}
	// Alpha is kept and the color under it replaced. A partly transparent
	// pixel is stored premultiplied, so its color is known to a level or
	// two only: it needs that much tolerance.
	near := mustApply(t, img, edits(t, `[{"op":"replaceColor","p":{"from":"#c81e1e","to":"#00ff00","tolerance":1}}]`))
	if got := near.RGBAAt(3, 0); got.A != 128 || got.G < 120 || got.R > 4 {
		t.Fatalf("half transparent match: %v", got)
	}
	if got := exact.RGBAAt(3, 0); got.A != 128 {
		t.Fatalf("alpha changed: %v", got)
	}
	wide := mustApply(t, img, edits(t, `[{"op":"replaceColor","p":{"from":"#c81e1e","to":"#00ff00","tolerance":10,"softness":10}}]`))
	if wide.RGBAAt(1, 0) != (color.RGBA{0, 255, 0, 255}) || wide.RGBAAt(2, 0) != img.RGBAAt(2, 0) {
		t.Fatalf("tolerance: %v %v", wide.RGBAAt(1, 0), wide.RGBAAt(2, 0))
	}
	// Keeping the luminance keeps shading: a darker match gives a darker result.
	shade := image.NewRGBA(image.Rect(0, 0, 2, 1))
	shade.SetRGBA(0, 0, color.RGBA{200, 40, 40, 255})
	shade.SetRGBA(1, 0, color.RGBA{120, 20, 20, 255})
	kept := mustApply(t, shade, edits(t, `[{"op":"replaceColor","p":{"from":"#c82828","to":"#2060c0","tolerance":60,"keepLuminance":true}}]`))
	if a, b := kept.RGBAAt(0, 0), kept.RGBAAt(1, 0); Luma(a.R, a.G, a.B) <= Luma(b.R, b.G, b.B) || a.B <= a.R {
		t.Fatalf("keep luminance: %v %v", a, b)
	}
}

// noisy returns a smooth picture and the same with noise added.
func noisy(w, h int, amount float64) (clean, dirty *image.RGBA) {
	rng := rand.New(rand.NewSource(3))
	clean, dirty = image.NewRGBA(image.Rect(0, 0, w, h)), image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			// Smooth areas with one hard edge down the middle.
			base := [3]float64{60 + 80*float64(x)/float64(w), 120, 90 + 60*float64(y)/float64(h)}
			if x > w/2 {
				base = [3]float64{200, 180 - 60*float64(y)/float64(h), 70}
			}
			for c := range 3 {
				clean.Pix[y*clean.Stride+x*4+c] = uint8(base[c])
				dirty.Pix[y*dirty.Stride+x*4+c] = uint8(math.Min(math.Max(base[c]+rng.NormFloat64()*amount, 0), 255))
			}
			clean.Pix[y*clean.Stride+x*4+3], dirty.Pix[y*dirty.Stride+x*4+3] = 255, 255
		}
	}
	return clean, dirty
}

func psnr(a, b *image.RGBA) float64 {
	var sum float64
	n := 0
	for i := 0; i < len(a.Pix); i += 4 {
		for c := range 3 {
			d := float64(a.Pix[i+c]) - float64(b.Pix[i+c])
			sum += d * d
			n++
		}
	}
	return 10 * math.Log10(255*255/(sum/float64(n)))
}

func meanColor(img *image.RGBA) [3]float64 {
	var m [3]float64
	for i := 0; i < len(img.Pix); i += 4 {
		for c := range 3 {
			m[c] += float64(img.Pix[i+c])
		}
	}
	for c := range m {
		m[c] /= float64(len(img.Pix) / 4)
	}
	return m
}

func TestDenoise(t *testing.T) {
	clean, dirty := noisy(240, 160, 12)
	before := psnr(clean, dirty)
	for _, js := range []string{
		`[{"op":"denoise","p":{"luminance":70,"detail":20}}]`,
		`[{"op":"denoise","p":{"luminance":70,"color":60,"detail":20}}]`,
		`[{"op":"denoise","p":{"luminance":60,"quality":"high","detail":20}}]`,
	} {
		out := mustApply(t, dirty, edits(t, js))
		after := psnr(clean, out)
		if after < before+3 {
			t.Errorf("%s: PSNR %.1f dB, was %.1f dB", js, after, before)
		}
		// Less noise, the same colors.
		a, b := meanColor(dirty), meanColor(out)
		for c := range 3 {
			if math.Abs(a[c]-b[c]) > 1.5 {
				t.Errorf("%s: mean of channel %d moved from %.1f to %.1f", js, c, a[c], b[c])
			}
		}
		// The edge down the middle is still an edge.
		y := 80
		left, right := out.RGBAAt(100, y), out.RGBAAt(140, y)
		if int(right.R)-int(left.R) < 60 {
			t.Errorf("%s: the edge was smeared: %v %v", js, left, right)
		}
	}
}

func TestBlurAndSharpen(t *testing.T) {
	// A blur keeps the mean and spreads a point evenly around it.
	img := image.NewRGBA(image.Rect(0, 0, 41, 41))
	for i := 3; i < len(img.Pix); i += 4 {
		img.Pix[i] = 255
	}
	img.SetRGBA(20, 20, color.RGBA{255, 255, 255, 255})
	for _, js := range []string{`[{"op":"blur","p":{"radius":3}}]`, `[{"op":"blur","p":{"radius":1.2}}]`, `[{"op":"blur","p":{"type":"box","radius":3}}]`} {
		out := mustApply(t, img, edits(t, js))
		if out.RGBAAt(20, 20).R >= 255 || out.RGBAAt(20, 20).R == 0 {
			t.Errorf("%s: center %v", js, out.RGBAAt(20, 20))
		}
		for _, d := range []int{1, 2, 3} {
			if out.RGBAAt(20+d, 20) != out.RGBAAt(20-d, 20) || out.RGBAAt(20, 20+d) != out.RGBAAt(20, 20-d) {
				t.Errorf("%s: not symmetric at distance %d", js, d)
			}
		}
	}
	// A motion blur along x smears along x only.
	motion := mustApply(t, img, edits(t, `[{"op":"blur","p":{"type":"motion","radius":9,"angle":0}}]`))
	if motion.RGBAAt(24, 20).R == 0 || motion.RGBAAt(20, 22).R != 0 {
		t.Fatalf("motion blur: %v %v", motion.RGBAAt(24, 20), motion.RGBAAt(20, 22))
	}
	// Sharpening raises the contrast across an edge and leaves flat areas.
	edge := image.NewRGBA(image.Rect(0, 0, 40, 10))
	for y := range 10 {
		for x := range 40 {
			v := uint8(100)
			if x >= 20 {
				v = 150
			}
			edge.SetRGBA(x, y, color.RGBA{v, v, v, 255})
		}
	}
	sharp := mustApply(t, edge, edits(t, `[{"op":"sharpen","p":{"amount":200,"radius":2}}]`))
	if sharp.RGBAAt(19, 5).R >= 100 || sharp.RGBAAt(20, 5).R <= 150 || sharp.RGBAAt(5, 5).R != 100 || sharp.RGBAAt(35, 5).R != 150 {
		t.Fatalf("unsharp mask: %v %v %v %v", sharp.RGBAAt(5, 5), sharp.RGBAAt(19, 5), sharp.RGBAAt(20, 5), sharp.RGBAAt(35, 5))
	}
	// Below the threshold nothing is touched.
	if got := mustApply(t, edge, edits(t, `[{"op":"sharpen","p":{"amount":200,"radius":2,"threshold":60}}]`)); !same(got, edge) {
		t.Fatal("a difference under the threshold was sharpened")
	}
	// A radius is in full-picture pixels: at half scale half the radius.
	big := benchImageT(t, 400, 300)
	p, _ := Compile(edits(t, `[{"op":"blur","p":{"radius":8}}]`), 400, 300, DPI{})
	full, _ := p.Run(context.Background(), big, 0, RunOptions{Scale: 1})
	half, _ := Resample(context.Background(), big, 200, 150, Bilinear)
	proxy, _ := p.Run(context.Background(), half, 0, RunOptions{Scale: 0.5})
	down, _ := Resample(context.Background(), full, 200, 150, Bilinear)
	var diff int
	for i := range down.Pix {
		d := int(down.Pix[i]) - int(proxy.Pix[i])
		diff += max(d, -d)
	}
	if avg := float64(diff) / float64(len(down.Pix)); avg > 2 {
		t.Fatalf("a blur on the proxy differs from the final by %.2f levels on average", avg)
	}
}

func benchImageT(t testing.TB, w, h int) *image.RGBA {
	t.Helper()
	img, err := Resample(context.Background(), testImage(w/8, h/8, false), w, h, Bilinear)
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func distinctColors(img *image.RGBA) map[color.RGBA]int {
	m := map[color.RGBA]int{}
	for y := range img.Rect.Dy() {
		for x := range img.Rect.Dx() {
			m[img.RGBAAt(x, y)]++
		}
	}
	return m
}

func TestReduceColors(t *testing.T) {
	src := benchImageT(t, 320, 240)
	for _, quantizer := range []string{"median", "octree", "gray"} {
		for _, count := range []int{2, 5, 16, 64, 256} {
			for _, dither := range []string{"none", "fs", "ordered4", "ordered8"} {
				js := fmt.Sprintf(`[{"op":"reduceColors","p":{"count":%d,"quantizer":%q,"dither":%q}}]`, count, quantizer, dither)
				out := mustApply(t, src, edits(t, js))
				if n := len(distinctColors(out)); n > count || n < 2 {
					t.Fatalf("%s: %d colors", js, n)
				}
			}
		}
	}
	if n := len(distinctColors(mustApply(t, src, edits(t, `[{"op":"reduceColors","p":{"count":256,"quantizer":"web"}}]`)))); n > 216 {
		t.Fatalf("web palette: %d colors", n)
	}
	// More colors, less error; 256 median-cut colors are close to the picture.
	errOf := func(count int, dither string) float64 {
		out := mustApply(t, src, edits(t, fmt.Sprintf(`[{"op":"reduceColors","p":{"count":%d,"dither":%q}}]`, count, dither)))
		return psnr(src, out)
	}
	// More colors, less error. The test picture fills a whole surface of
	// the color cube, the hardest case; a palette made for it still beats
	// the fixed web cube of nearly as many colors.
	web := psnr(src, mustApply(t, src, edits(t, `[{"op":"reduceColors","p":{"count":256,"quantizer":"web"}}]`)))
	if e4, e64, e256 := errOf(4, "none"), errOf(64, "none"), errOf(256, "none"); !(e4 < e64 && e64 < e256) || e256 < web+1.5 || e256 < 26 {
		t.Fatalf("PSNR by color count: %.1f %.1f %.1f; web cube %.1f", e4, e64, e256, web)
	}
	if o := psnr(src, mustApply(t, src, edits(t, `[{"op":"reduceColors","p":{"count":256,"quantizer":"octree"}}]`))); o < web {
		t.Fatalf("octree with 256 colors (%.1f dB) is worse than the web cube (%.1f dB)", o, web)
	}
	// Dithering trades local error for the right average: the mean stays closer.
	plain := mustApply(t, src, edits(t, `[{"op":"reduceColors","p":{"count":4}}]`))
	dithered := mustApply(t, src, edits(t, `[{"op":"reduceColors","p":{"count":4,"dither":"fs"}}]`))
	want, p, d := meanColor(src), meanColor(plain), meanColor(dithered)
	var ep, ed float64
	for c := range 3 {
		ep += math.Abs(want[c] - p[c])
		ed += math.Abs(want[c] - d[c])
	}
	if ed > ep+0.5 {
		t.Fatalf("dithering moved the mean further: %.2f against %.2f", ed, ep)
	}
	// Transparency: kept as one entry, or the picture goes on white.
	alpha := testImage(64, 64, true)
	kept := mustApply(t, alpha, edits(t, `[{"op":"reduceColors","p":{"count":8,"keepTransparency":true}}]`))
	colors := distinctColors(kept)
	if len(colors) > 8 || colors[color.RGBA{}] == 0 {
		t.Fatalf("keep transparency: %d colors, %d transparent", len(colors), colors[color.RGBA{}])
	}
	for c := range colors {
		if c.A != 0 && c.A != 255 {
			t.Fatalf("a half-transparent color survived: %v", c)
		}
	}
	flat := mustApply(t, alpha, edits(t, `[{"op":"reduceColors","p":{"count":8}}]`))
	if HasAlpha(flat) {
		t.Fatal("without keepTransparency the result is not opaque")
	}
	// Saved as PNG the reduced picture is indexed, with that palette.
	var buf bytes.Buffer
	sixteen := mustApply(t, src, edits(t, `[{"op":"reduceColors","p":{"count":16,"dither":"fs"}}]`))
	if err := EncodeTo(context.Background(), &buf, sixteen, SaveOptions{Format: "png"}, nil); err != nil {
		t.Fatal(err)
	}
	decoded, err := png.Decode(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	pal, ok := decoded.(*image.Paletted)
	if !ok || len(pal.Palette) > 16 {
		t.Fatalf("saved PNG is %T with %d palette entries", decoded, len(pal.Palette))
	}
	back := toRGBA(decoded)
	if !same(back, sixteen) {
		t.Fatal("the indexed PNG does not hold the reduced picture")
	}
	// The same as GIF, transparent entry included.
	buf.Reset()
	if err := EncodeTo(context.Background(), &buf, kept, SaveOptions{Format: "gif"}, nil); err != nil {
		t.Fatal(err)
	}
	if g, err := DefaultRegistry().For("gif").Decode(bytes.NewReader(buf.Bytes())); err != nil || !same(toRGBA(g), kept) {
		t.Fatalf("GIF of a reduced picture with transparency: %v", err)
	}
}

func TestCountColorsIsExact(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	for range 20 {
		w, h := 1+rng.Intn(120), 1+rng.Intn(120)
		img := image.NewRGBA(image.Rect(0, 0, w, h))
		pool := make([]color.RGBA, 1+rng.Intn(400))
		for i := range pool {
			pool[i] = color.RGBA{uint8(rng.Intn(256)), uint8(rng.Intn(256)), uint8(rng.Intn(256)), 255}
		}
		naive := map[color.RGBA]bool{}
		for y := range h {
			for x := range w {
				c := pool[rng.Intn(len(pool))]
				img.SetRGBA(x, y, c)
				naive[c] = true
			}
		}
		got, alpha, err := CountColors(context.Background(), img)
		if err != nil || got != len(naive) || alpha {
			t.Fatalf("%dx%d: counted %d, a map says %d (alpha %v, %v)", w, h, got, len(naive), alpha, err)
		}
	}
	// Transparent pixels are not colors; partly transparent ones count by
	// their visible color.
	img := image.NewRGBA(image.Rect(0, 0, 3, 1))
	img.SetRGBA(0, 0, color.RGBA{255, 0, 0, 255})
	img.SetRGBA(1, 0, color.RGBA{128, 0, 0, 128}) // red again, half transparent
	n, alpha, _ := CountColors(context.Background(), img)
	if n != 1 || !alpha {
		t.Fatalf("with transparency: %d colors, alpha %v", n, alpha)
	}
	// The dominant palette: shares add up, the largest comes first.
	two := image.NewRGBA(image.Rect(0, 0, 10, 10))
	for y := range 10 {
		for x := range 10 {
			c := color.RGBA{250, 250, 250, 255}
			if y < 3 {
				c = color.RGBA{10, 20, 200, 255}
			}
			two.SetRGBA(x, y, c)
		}
	}
	swatches, err := Palette(context.Background(), two, 8)
	if err != nil || len(swatches) != 2 || swatches[0].Hex != "#fafafa" || swatches[0].Share != 0.7 || swatches[1].Hex != "#0a14c8" || swatches[1].Share != 0.3 {
		t.Fatalf("palette: %+v %v", swatches, err)
	}
	if s, _ := Palette(context.Background(), image.NewRGBA(image.Rect(0, 0, 4, 4)), 8); len(s) != 0 {
		t.Fatalf("palette of a transparent picture: %v", s)
	}
}

func TestInvalidColorEdits(t *testing.T) {
	for _, js := range []string{
		`[{"op":"lighting","p":{"exposure":4}}]`,
		`[{"op":"lighting","p":{"gamma":0.01}}]`,
		`[{"op":"lighting","p":{"contrast":101}}]`,
		`[{"op":"lighting","p":{"glow":1}}]`,
		`[{"op":"colors","p":{"hue":181}}]`,
		`[{"op":"colors","p":{"balance":{"shadows":[0,0,101],"midtones":[0,0,0],"highlights":[0,0,0]}}}]`,
		`[{"op":"levels","p":{"l":{"inBlack":200,"inWhite":100,"outBlack":0,"outWhite":255}}}]`,
		`[{"op":"levels","p":{"l":{"inBlack":0,"inWhite":255,"gamma":20,"outBlack":0,"outWhite":255}}}]`,
		`[{"op":"levels","p":{"auto":{"clip":50,"mode":"lum"}}}]`,
		`[{"op":"levels","p":{"auto":{"clip":1,"mode":"hsv"}}}]`,
		`[{"op":"curves","p":{"l":[[0,0]]}}]`,
		`[{"op":"curves","p":{"l":[[10,0],[10,255]]}}]`,
		`[{"op":"curves","p":{"l":[[0,0],[300,255]]}}]`,
		`[{"op":"curves","p":{"l":[[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16]]}}]`,
		`[{"op":"grayscale","p":{"method":"mixer"}}]`,
		`[{"op":"grayscale","p":{"method":"sepia"}}]`,
		`[{"op":"sepia","p":{"strength":120}}]`,
		`[{"op":"negative","p":{"channels":"rgbx"}}]`,
		`[{"op":"negative","p":{"channels":"a"}}]`,
		`[{"op":"swapChannels","p":{"order":"rrb"}}]`,
		`[{"op":"swapChannels","p":{}}]`,
		`[{"op":"replaceColor","p":{"from":"red","to":"#000000","tolerance":10}}]`,
		`[{"op":"replaceColor","p":{"from":"#ff000080","to":"#000000","tolerance":10}}]`,
		`[{"op":"replaceColor","p":{"from":"#ff0000","to":"#000000","tolerance":101}}]`,
		`[{"op":"blur","p":{"radius":101}}]`,
		`[{"op":"blur","p":{"type":"lens","radius":3}}]`,
		`[{"op":"sharpen","p":{"amount":600,"radius":1}}]`,
		`[{"op":"sharpen","p":{"amount":100,"radius":0}}]`,
		`[{"op":"denoise","p":{"luminance":101}}]`,
		`[{"op":"denoise","p":{"luminance":10,"quality":"ai"}}]`,
		`[{"op":"reduceColors","p":{"count":1}}]`,
		`[{"op":"reduceColors","p":{"count":257}}]`,
		`[{"op":"reduceColors","p":{"count":16,"quantizer":"kmeans"}}]`,
		`[{"op":"reduceColors","p":{"count":16,"dither":"blue"}}]`,
	} {
		if err := edits(t, js).Validate(); !errors.Is(err, ErrInvalidEdit) {
			t.Errorf("%s: %v", js, err)
		}
	}
	if !edits(t, goldenCases["point-chain"]).Batchable() || !edits(t, goldenCases["reduce-fs"]).Batchable() {
		t.Fatal("the color operations are batch-capable")
	}
}

func TestColorOperationsCancel(t *testing.T) {
	src := benchImageT(t, 1200, 800)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, name := range []string{"point-chain", "blur-gauss", "sharpen", "denoise-fast", "denoise-high", "reduce-fs", "reduce-16", "levels-auto"} {
		if _, err := Apply(ctx, src, edits(t, goldenCases[name])); !errors.Is(err, context.Canceled) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, _, err := CountColors(ctx, src); !errors.Is(err, context.Canceled) {
		t.Errorf("count colors: %v", err)
	}
}

// --- benchmarks (BENCH_STAGE=13) ---

func BenchmarkColorTools(b *testing.B) {
	if os.Getenv("BENCH_LARGE") == "" {
		b.Log("set BENCH_LARGE=1 to add the 24 MP cases")
	}
	sizes := []struct {
		name string
		w, h int
	}{{"2MP", 1800, 1200}}
	if os.Getenv("BENCH_LARGE") != "" {
		sizes = append(sizes, struct {
			name string
			w, h int
		}{"24MP", 6000, 4000})
	}
	for _, size := range sizes {
		src := benchImage(b, size.w, size.h)
		for name, js := range map[string]string{
			"fused-chain":    goldenCases["point-chain"],
			"one-table":      goldenCases["lighting-mid"],
			"gaussian-r10":   `[{"op":"blur","p":{"radius":10}}]`,
			"unsharp-r10":    `[{"op":"sharpen","p":{"amount":120,"radius":10}}]`,
			"bilateral":      `[{"op":"denoise","p":{"luminance":70,"color":40}}]`,
			"nlm":            `[{"op":"denoise","p":{"luminance":60,"quality":"high"}}]`,
			"median256-fs":   `[{"op":"reduceColors","p":{"count":256,"dither":"fs"}}]`,
			"median16-plain": `[{"op":"reduceColors","p":{"count":16}}]`,
		} {
			e := edits(b, js)
			p, err := Compile(e, size.w, size.h, DPI{})
			if err != nil {
				b.Fatal(err)
			}
			for _, draft := range []bool{false, true} {
				if draft && name != "bilateral" && name != "nlm" {
					continue
				}
				label := size.name + "/" + name
				if draft {
					label += "-draft"
				}
				b.Run(label, func(b *testing.B) {
					b.SetBytes(int64(len(src.Pix)))
					b.ReportAllocs()
					for b.Loop() {
						if _, err := p.Run(context.Background(), src, 0, RunOptions{Scale: 1, Draft: draft}); err != nil {
							b.Fatal(err)
						}
					}
				})
			}
		}
		b.Run(size.name+"/count-colors", func(b *testing.B) {
			b.SetBytes(int64(len(src.Pix)))
			for b.Loop() {
				if _, _, err := CountColors(context.Background(), src); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
