package imaging

import (
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"math"
	"os"
	"strings"
	"testing"

	"golang.org/x/image/font/sfnt"

	"panelyth/sidecar/internal/fonts"
)

// testRes gives the tests two assets (a logo with transparency and a
// striped texture), the built-in fonts and a few tokens.
type testRes struct{}

const (
	logoID    = "a1"
	textureID = "a2"
)

var testAssets = map[string]*image.RGBA{
	logoID: func() *image.RGBA {
		img := image.NewRGBA(image.Rect(0, 0, 64, 40))
		for y := range 40 {
			for x := range 64 {
				// A disc on a transparent ground, red to yellow.
				if math.Hypot(float64(x)-32, float64(y)-20) < 18 {
					img.SetRGBA(x, y, color.RGBA{R: 255, G: uint8(x * 4), A: 255})
				}
			}
		}
		return img
	}(),
	textureID: func() *image.RGBA {
		img := image.NewRGBA(image.Rect(0, 0, 32, 32))
		for y := range 32 {
			for x := range 32 {
				v := uint8(40)
				if (x/4+y/8)%2 == 0 {
					v = 220
				}
				img.SetRGBA(x, y, color.RGBA{R: v, G: v, B: v, A: 255})
			}
		}
		return img
	}(),
}

func (testRes) Asset(_ context.Context, id string) (*image.RGBA, error) {
	if img := testAssets[id]; img != nil {
		return img, nil
	}
	return nil, invalid("asset %q is not available", id)
}

func (testRes) Font(family string, bold, italic bool) (*sfnt.Font, error) {
	// Built-in fonts only: the goldens must not depend on the machine.
	return fonts.New().Font(family, bold, italic)
}

func (testRes) Token(name string) (string, bool) {
	v, ok := map[string]string{"name": "IMG_0412", "year": "2026", "exif.model": "Model X", "width": "700"}[name]
	return v, ok
}

// The Stage 14 cases join the golden set and the worker-count check.
func init() {
	for name, js := range map[string]string{
		"border-solid":       `[{"op":"border","p":{"width":4,"color":"#336699"}}]`,
		"border-px-inside":   `[{"op":"border","p":{"width":12,"unit":"px","inside":true,"color":"#ffcc00","opacity":70}}]`,
		"border-double":      `[{"op":"border","p":{"style":"double","width":6,"color":"#ffffff","color2":"#202020"}}]`,
		"border-bevel":       `[{"op":"border","p":{"style":"bevel","width":5,"color":"#808080"}}]`,
		"border-rounded":     `[{"op":"border","p":{"style":"rounded","width":3,"radius":12,"color":"#ffffff","background":"#102030"}}]`,
		"border-shadow":      `[{"op":"border","p":{"style":"shadow","width":1,"blur":4,"offset":2,"radius":5,"background":"#f0f0f0"}}]`,
		"border-polaroid":    `[{"op":"border","p":{"style":"polaroid","width":5,"blur":2,"offset":1}}]`,
		"mask-rounded":       `[{"op":"frameMask","p":{"shape":"rounded","inset":3,"radius":15,"feather":2}}]`,
		"mask-ellipse":       `[{"op":"frameMask","p":{"shape":"ellipse","feather":10,"background":"#ffffff"}}]`,
		"mask-circle-inv":    `[{"op":"frameMask","p":{"shape":"circle","inset":10,"invert":true,"background":"#000000"}}]`,
		"mask-feather":       `[{"op":"frameMask","p":{"shape":"feather","inset":5,"feather":20}}]`,
		"mask-vignette":      `[{"op":"frameMask","p":{"shape":"vignette","strength":70,"feather":30}}]`,
		"mask-custom":        `[{"op":"frameMask","p":{"shape":"custom","assetId":"a2","feather":1,"background":"#400000"}}]`,
		"watermark-text":     `[{"op":"watermark","p":{"text":"© {year} {name}","size":8,"opacity":60}}]`,
		"watermark-outline":  `[{"op":"watermark","p":{"text":"Proof\nПроба","size":14,"bold":true,"outline":6,"shadow":true,"anchor":"c","rotation":-20,"color":"#ffee88"}}]`,
		"watermark-tiled":    `[{"op":"watermark","p":{"text":"{exif.model}","size":5,"font":"Go Mono","tile":true,"spacing":60,"stagger":true,"rotation":30,"opacity":35,"blend":"screen"}}]`,
		"watermark-image":    `[{"op":"watermark","p":{"kind":"image","assetId":"a1","size":25,"anchor":"nw","margin":4,"opacity":80}}]`,
		"watermark-multiply": `[{"op":"watermark","p":{"kind":"image","assetId":"a1","size":40,"anchor":"e","blend":"multiply","rotation":90}}]`,
		"bump-picture":       `[{"op":"bump","p":{"height":60,"angle":135,"elevation":40,"smooth":1}}]`,
		"bump-colored":       `[{"op":"bump","p":{"height":40,"angle":45,"color":100}}]`,
		"bump-texture":       `[{"op":"bump","p":{"source":"texture","assetId":"a2","tile":true,"height":80,"color":70}}]`,
		"sketch-pencil":      `[{"op":"sketch","p":{"style":"pencil","detail":70,"strength":40,"paper":50}}]`,
		"sketch-ink":         `[{"op":"sketch","p":{"style":"ink","detail":40,"strength":60}}]`,
		"sketch-color":       `[{"op":"sketch","p":{"style":"color","detail":60,"strength":30,"color":80}}]`,
		"oil":                `[{"op":"oil","p":{"radius":4,"levels":16}}]`,
		"oil-wide":           `[{"op":"oil","p":{"radius":9,"levels":40}}]`,
		"lens-bulge":         `[{"op":"lens","p":{"mode":"bulge","amount":70,"cx":0.4,"cy":0.5,"radius":60,"soft":30}}]`,
		"lens-pinch":         `[{"op":"lens","p":{"mode":"pinch","amount":50,"radius":80}}]`,
		"lens-barrel":        `[{"op":"lens","p":{"mode":"barrel","amount":80}}]`,
		"lens-pincushion":    `[{"op":"lens","p":{"mode":"pincushion","amount":100,"cx":0.6,"cy":0.4}}]`,
		"obscure-blur":       `[{"op":"obscure","p":{"method":"blur","strength":60,"rect":{"x":0.2,"y":0.3,"w":0.4,"h":0.3},"feather":20}}]`,
		"obscure-pixelate":   `[{"op":"obscure","p":{"method":"pixelate","strength":40,"shape":"ellipse","rect":{"x":0.5,"y":0.1,"w":0.6,"h":0.5}}}]`,
		"obscure-mosaic":     `[{"op":"obscure","p":{"method":"mosaic","strength":80,"shape":"polygon","points":[[0.1,0.1],[0.6,0.2],[0.5,0.8],[0.2,0.6]],"feather":10}}]`,
		"obscure-invert":     `[{"op":"obscure","p":{"method":"blur","strength":30,"rect":{"x":0.3,"y":0.3,"w":0.4,"h":0.4},"invert":true}}]`,
		"effects-chain":      `[{"op":"frameMask","p":{"shape":"vignette","strength":40}},{"op":"watermark","p":{"text":"{name}","size":6}},{"op":"border","p":{"style":"polaroid","width":4}}]`,
	} {
		goldenCases[name] = js
	}
}

func TestEffectsWithNothingToDoReturnThePicture(t *testing.T) {
	src := testImage(160, 120, true)
	for _, js := range []string{
		`[{"op":"border","p":{"width":0}}]`,
		`[{"op":"border","p":{"width":0,"inside":true}}]`,
		`[{"op":"watermark","p":{"text":"hidden","size":10,"opacity":0}}]`,
		`[{"op":"watermark","p":{"text":"","size":10}}]`,
		`[{"op":"bump","p":{"height":0}}]`,
		`[{"op":"lens","p":{"amount":0}}]`,
		`[{"op":"obscure","p":{"strength":50,"rect":{"x":1.2,"y":1.2,"w":0.3,"h":0.3}}}]`,
		`[{"op":"frameMask","p":{"shape":"feather"}}]`,
		`[{"op":"frameMask","p":{"shape":"vignette","strength":0}}]`,
	} {
		if !same(mustApply(t, src, edits(t, js)), src) {
			t.Errorf("%s changed the picture", js)
		}
	}
}

func TestBorderSizesAreRelative(t *testing.T) {
	for _, c := range []struct {
		js           string
		w, h         int
		wantW, wantH int
	}{
		{`{"width":5}`, 800, 600, 860, 660},
		{`{"width":5}`, 4000, 3000, 4300, 3300},
		{`{"width":5,"inside":true}`, 800, 600, 800, 600},
		{`{"width":20,"unit":"px"}`, 800, 600, 840, 640},
		{`{"style":"polaroid","width":5}`, 800, 600, 860, 600 + 30 + 120},
		{`{"style":"shadow","width":0,"blur":2,"offset":1}`, 1000, 600, 1000 + 2*30, 600 + 2*30},
		{`{"style":"rounded","width":0,"radius":10}`, 800, 600, 800, 600},
	} {
		w, h := edits(t, `[{"op":"border","p":`+c.js+`}]`).OutputSize(c.w, c.h)
		if w != c.wantW || h != c.wantH {
			t.Errorf("border %s on %d×%d: %d×%d, want %d×%d", c.js, c.w, c.h, w, h, c.wantW, c.wantH)
		}
	}
	// The frame has the picture's pixels inside and the color outside.
	src := testImage(200, 100, false)
	out := mustApply(t, src, edits(t, `[{"op":"border","p":{"width":10,"color":"#112233"}}]`))
	if got := out.RGBAAt(3, 50); got != (color.RGBA{0x11, 0x22, 0x33, 0xff}) {
		t.Errorf("frame color: %v", got)
	}
	if out.RGBAAt(10+17, 10+40) != src.RGBAAt(17, 40) || out.RGBAAt(10, 10) != src.RGBAAt(0, 0) || out.RGBAAt(209, 109) != src.RGBAAt(199, 99) {
		t.Error("the picture moved inside its frame")
	}
	// A double frame has the second color in its middle third.
	double := mustApply(t, src, edits(t, `[{"op":"border","p":{"style":"double","width":9,"color":"#ffffff","color2":"#ff0000"}}]`))
	if double.RGBAAt(1, 50) != (color.RGBA{255, 255, 255, 255}) || double.RGBAAt(4, 50) != (color.RGBA{255, 0, 0, 255}) || double.RGBAAt(7, 50) != (color.RGBA{255, 255, 255, 255}) {
		t.Errorf("double frame: %v %v %v", double.RGBAAt(1, 50), double.RGBAAt(4, 50), double.RGBAAt(7, 50))
	}
	// A bevel is lighter at the top left than at the bottom right.
	bevel := mustApply(t, src, edits(t, `[{"op":"border","p":{"style":"bevel","width":10,"color":"#808080"}}]`))
	if tl, br := bevel.RGBAAt(4, 50), bevel.RGBAAt(215, 50); tl.R <= 0x80 || br.R >= 0x80 {
		t.Errorf("bevel: top left %v, bottom right %v", tl, br)
	}
	// Rounded corners show the background; transparent when none is given.
	round := mustApply(t, src, edits(t, `[{"op":"border","p":{"style":"rounded","width":0,"radius":30}}]`))
	if round.RGBAAt(0, 0).A != 0 || round.RGBAAt(100, 50) != src.RGBAAt(100, 50) {
		t.Errorf("rounded corner: %v", round.RGBAAt(0, 0))
	}
	// A shadow is darker below right than above left of the picture.
	shadow := mustApply(t, src, edits(t, `[{"op":"border","p":{"style":"shadow","width":0,"blur":4,"offset":4,"background":"#ffffff"}}]`))
	sw, sh := shadow.Rect.Dx(), shadow.Rect.Dy()
	if a, b := shadow.RGBAAt(2, 2), shadow.RGBAAt(sw-8, sh-8); a.R <= b.R {
		t.Errorf("shadow: top left %v, bottom right %v", a, b)
	}
}

// meanDiff is the mean absolute difference of two pictures of one size.
func meanDiff(t *testing.T, a, b *image.RGBA) float64 {
	t.Helper()
	if a.Rect != b.Rect {
		t.Fatalf("sizes differ: %v, %v", a.Rect, b.Rect)
	}
	var sum int64
	for i := range a.Pix {
		d := int64(a.Pix[i]) - int64(b.Pix[i])
		if d < 0 {
			d = -d
		}
		sum += d
	}
	return float64(sum) / float64(len(a.Pix))
}

// The proxy must show what the save will write: an effect on a quarter-size
// picture at Scale 0.25 looks like the full result scaled down.
func TestEffectsLookTheSameOnTheProxy(t *testing.T) {
	ctx := context.Background()
	full, err := Resample(ctx, testImage(200, 150, false), 1600, 1200, CatmullRom)
	if err != nil {
		t.Fatal(err)
	}
	small, _ := Resample(ctx, full, 400, 300, CatmullRom)
	for name, limit := range map[string]float64{
		"border-solid": 2, "border-rounded": 3, "border-shadow": 3, "border-polaroid": 3, "border-double": 3,
		"mask-rounded": 2, "mask-ellipse": 2, "mask-vignette": 2, "mask-feather": 2,
		"watermark-text": 3, "watermark-outline": 4, "watermark-image": 3, "watermark-tiled": 4,
		"lens-bulge": 3, "lens-barrel": 3, "obscure-blur": 3, "obscure-pixelate": 4, "obscure-mosaic": 5,
		"bump-colored": 6, "sketch-pencil": 12, "oil": 8,
	} {
		e := edits(t, goldenCases[name])
		p, err := Compile(e, 1600, 1200, DPI{})
		if err != nil {
			t.Fatal(name, err)
		}
		want, err := p.Run(ctx, full, 0, RunOptions{Scale: 1, Res: testRes{}})
		if err != nil {
			t.Fatal(name, err)
		}
		got, err := p.Run(ctx, small, 0, RunOptions{Scale: 0.25, Res: testRes{}})
		if err != nil {
			t.Fatal(name, err)
		}
		ow, oh := p.Size()
		if got.Rect.Dx() != scaled(ow, 0.25) || got.Rect.Dy() != scaled(oh, 0.25) {
			t.Errorf("%s: proxy result is %v for an output of %d×%d", name, got.Rect, ow, oh)
			continue
		}
		down, _ := Resample(ctx, want, got.Rect.Dx(), got.Rect.Dy(), CatmullRom)
		if d := meanDiff(t, got, down); d > limit {
			t.Errorf("%s: the proxy differs from the scaled full result by %.2f levels (limit %.0f)", name, d, limit)
		}
	}
}

func TestExpandTokens(t *testing.T) {
	lookup := testRes{}.Token
	for in, want := range map[string]string{
		"plain text":                "plain text",
		"{name}":                    "IMG_0412",
		"© {YEAR} {Name}.jpg":       "© 2026 IMG_0412.jpg",
		"{exif.model} / {exif.iso}": "Model X / {exif.iso}",
		"{unknown} stays":           "{unknown} stays",
		"a { b } c":                 "a { b } c",
		"{}":                        "{}",
		"{name":                     "{name",
		"{{name}}":                  "{IMG_0412}",
		"{na me}":                   "{na me}",
		"100 % {width}px":           "100 % 700px",
	} {
		if got := ExpandTokens(in, lookup); got != want {
			t.Errorf("ExpandTokens(%q) = %q, want %q", in, got, want)
		}
	}
	if got := ExpandTokens("{name}", nil); got != "{name}" {
		t.Errorf("without a lookup: %q", got)
	}
	long := strings.Repeat("x", 1000)
	got := ExpandTokens("{v}", func(string) (string, bool) { return long, true })
	if len(got) != MaxTokenValue {
		t.Errorf("a token value is not bounded: %d", len(got))
	}
}

func inked(mask *image.Alpha) (n int) {
	for _, v := range mask.Pix {
		if v > 127 {
			n++
		}
	}
	return n
}

func TestTextRendering(t *testing.T) {
	lib := fonts.New()
	regular, err := lib.Font("", false, false)
	if err != nil {
		t.Fatal(err)
	}
	bold, _ := lib.Font(fonts.Default, true, false)
	latin, err := textMask(regular, "Panelyth", 48, 2)
	if err != nil {
		t.Fatal(err)
	}
	if latin.Rect.Dy() < 48 || latin.Rect.Dy() > 80 || latin.Rect.Dx() < 150 || inked(latin) < 1500 {
		t.Errorf("latin text: %v, %d inked", latin.Rect, inked(latin))
	}
	// Bold has more ink; a larger size is larger; Cyrillic is drawn (not boxes of one width).
	heavy, _ := textMask(bold, "Panelyth", 48, 2)
	if inked(heavy) <= inked(latin) {
		t.Error("bold is not heavier than regular")
	}
	big, _ := textMask(regular, "Panelyth", 96, 2)
	if big.Rect.Dx() < latin.Rect.Dx()*19/10 {
		t.Errorf("twice the size is %d wide against %d", big.Rect.Dx(), latin.Rect.Dx())
	}
	wide, _ := textMask(regular, "Шшш", 48, 0)
	narrow, _ := textMask(regular, "ііі", 48, 0)
	if inked(wide) == 0 || wide.Rect.Dx() <= narrow.Rect.Dx() {
		t.Errorf("cyrillic widths: %d and %d", wide.Rect.Dx(), narrow.Rect.Dx())
	}
	// Lines stack; too many are cut off; a huge text is refused, not drawn.
	two, _ := textMask(regular, "one\ntwo", 48, 0)
	if two.Rect.Dy() < latin.Rect.Dy()*3/2 {
		t.Errorf("two lines are %d high", two.Rect.Dy())
	}
	if many, _ := textMask(regular, strings.Repeat("x\n", 100), 20, 0); many.Rect.Dy() > 20*2*maxTextLines {
		t.Errorf("%d lines were drawn", many.Rect.Dy()/20)
	}
	if _, err := textMask(regular, strings.Repeat("W", 1000), 4000, 0); !errors.Is(err, ErrInvalidEdit) {
		t.Errorf("a text of %d megapixels: %v", 1000*4000*4000/1_000_000, err)
	}
	// An unknown family draws with the default; the mono family is another font.
	fallback, err := lib.Font("No Such Family", false, false)
	if err != nil || fallback != regular {
		t.Errorf("fallback font: %v", err)
	}
	mono, _ := lib.Font(fonts.Mono, false, false)
	a, _ := textMask(mono, "iii", 40, 0)
	b, _ := textMask(mono, "WWW", 40, 0)
	if mono == regular || a.Rect.Dx() != b.Rect.Dx() {
		t.Errorf("mono widths: %d and %d", a.Rect.Dx(), b.Rect.Dx())
	}
}

func TestWatermarkPlacement(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 400, 300))
	for i := range src.Pix {
		src.Pix[i] = 255 // white, opaque
	}
	changed := func(js string) image.Rectangle {
		out := mustApply(t, src, edits(t, js))
		box := image.Rectangle{}
		for y := range 300 {
			for x := range 400 {
				if out.RGBAAt(x, y) != src.RGBAAt(x, y) {
					box = box.Union(image.Rect(x, y, x+1, y+1))
				}
			}
		}
		return box
	}
	// Each anchor puts the mark in its part of the picture, off the edge by the margin.
	se := changed(`[{"op":"watermark","p":{"text":"MARK","size":10,"color":"#000000","margin":5}}]`)
	nw := changed(`[{"op":"watermark","p":{"text":"MARK","size":10,"color":"#000000","margin":5,"anchor":"nw"}}]`)
	c := changed(`[{"op":"watermark","p":{"text":"MARK","size":10,"color":"#000000","anchor":"c"}}]`)
	if se.Empty() || se.Min.X < 200 || se.Min.Y < 150 || se.Max.X > 400-10 || se.Max.Y > 300-10 {
		t.Errorf("south east: %v", se)
	}
	if nw.Max.X > 200 || nw.Max.Y > 150 || nw.Min.X < 15 || nw.Min.Y < 15 {
		t.Errorf("north west: %v", nw)
	}
	if mid := c.Min.Add(c.Max).Div(2); mid.X < 190 || mid.X > 210 || mid.Y < 140 || mid.Y > 160 {
		t.Errorf("centre: %v", c)
	}
	// Tiling covers the picture; rotation by 90° makes the mark tall.
	tiled := changed(`[{"op":"watermark","p":{"text":"MARK","size":6,"color":"#000000","tile":true,"spacing":50}}]`)
	if tiled.Dx() < 350 || tiled.Dy() < 250 {
		t.Errorf("tiled: %v", tiled)
	}
	turned := changed(`[{"op":"watermark","p":{"text":"MARK","size":10,"color":"#000000","anchor":"c","rotation":90}}]`)
	if turned.Dy() <= turned.Dx() || c.Dx() <= c.Dy() {
		t.Errorf("turned: %v, flat: %v", turned, c)
	}
	// Opacity scales the change; an outline widens the mark.
	strong := mustApply(t, src, edits(t, `[{"op":"watermark","p":{"text":"MARK","size":20,"color":"#000000","anchor":"c"}}]`))
	weak := mustApply(t, src, edits(t, `[{"op":"watermark","p":{"text":"MARK","size":20,"color":"#000000","anchor":"c","opacity":25}}]`))
	if s, w := meanDiff(t, strong, src), meanDiff(t, weak, src); w < s*0.2 || w > s*0.3 {
		t.Errorf("opacity 25 changes %.3f against %.3f", w, s)
	}
	outlined := changed(`[{"op":"watermark","p":{"text":"MARK","size":10,"color":"#000000","anchor":"c","outline":15,"outlineColor":"#ff0000"}}]`)
	if outlined.Dx() <= c.Dx() {
		t.Errorf("outline: %v against %v", outlined, c)
	}
	// An image mark keeps its transparency: its corner changes nothing.
	logo := changed(`[{"op":"watermark","p":{"kind":"image","assetId":"a1","size":40,"anchor":"nw"}}]`)
	if logo.Empty() || logo.Min.X < 10 || logo.Min.Y < 3 {
		t.Errorf("logo: %v", logo)
	}
	// Multiply only darkens, screen only lightens.
	gray := image.NewRGBA(image.Rect(0, 0, 200, 150))
	for i := range gray.Pix {
		gray.Pix[i] = 128
		if i%4 == 3 {
			gray.Pix[i] = 255
		}
	}
	for blend, darker := range map[string]bool{"multiply": true, "screen": false} {
		out := mustApply(t, gray, edits(t, fmt.Sprintf(`[{"op":"watermark","p":{"kind":"image","assetId":"a1","size":80,"anchor":"c","blend":%q}}]`, blend)))
		for i := 0; i < len(out.Pix); i += 4 {
			if (darker && out.Pix[i] > 128) || (!darker && out.Pix[i] < 128) {
				t.Fatalf("%s moved a pixel the wrong way: %d", blend, out.Pix[i])
			}
		}
	}
}

func TestFrameMaskFallsOffSmoothly(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 300, 200))
	for i := range src.Pix {
		src.Pix[i] = 255
	}
	for _, shape := range []string{"ellipse", "circle", "rounded", "feather"} {
		out := mustApply(t, src, edits(t, fmt.Sprintf(`[{"op":"frameMask","p":{"shape":%q,"inset":5,"feather":25,"radius":20}}]`, shape)))
		// From the centre to the edge the alpha never rises.
		last := uint8(255)
		for x := 150; x < 300; x++ {
			a := out.RGBAAt(x, 100).A
			if a > last {
				t.Fatalf("%s: alpha rises from %d to %d at x=%d", shape, last, a, x)
			}
			last = a
		}
		if out.RGBAAt(150, 100).A != 255 || out.RGBAAt(299, 100).A != 0 {
			t.Errorf("%s: centre %d, edge %d", shape, out.RGBAAt(150, 100).A, out.RGBAAt(299, 100).A)
		}
	}
	// A vignette darkens the corners and leaves the centre.
	v := mustApply(t, src, edits(t, `[{"op":"frameMask","p":{"shape":"vignette","strength":100,"feather":20}}]`))
	if v.RGBAAt(150, 100) != (color.RGBA{255, 255, 255, 255}) || v.RGBAAt(1, 1).R > 20 || v.RGBAAt(1, 1).A != 255 {
		t.Errorf("vignette: centre %v, corner %v", v.RGBAAt(150, 100), v.RGBAAt(1, 1))
	}
	// A custom mask follows the asset's brightness; without the asset it is an error.
	c := mustApply(t, src, edits(t, `[{"op":"frameMask","p":{"shape":"custom","assetId":"a2"}}]`))
	light, dark := c.RGBAAt(10, 10).A, c.RGBAAt(50, 10).A
	if light < 200 || dark > 60 {
		t.Errorf("custom mask: %d where the texture is light, %d where it is dark", light, dark)
	}
	if _, err := Apply(context.Background(), src, edits(t, `[{"op":"frameMask","p":{"shape":"custom","assetId":"a2"}}]`)); !errors.Is(err, ErrInvalidEdit) {
		t.Errorf("a mask without its asset: %v", err)
	}
	if _, err := ApplyWith(context.Background(), src, edits(t, `[{"op":"watermark","p":{"kind":"image","assetId":"ffff","size":10}}]`), testRes{}); !errors.Is(err, ErrInvalidEdit) {
		t.Errorf("an unknown asset: %v", err)
	}
}

func TestLensEdgeCases(t *testing.T) {
	src := testImage(240, 180, false)
	// Outside the circle nothing moves; inside it does.
	out := mustApply(t, src, edits(t, `[{"op":"lens","p":{"mode":"bulge","amount":80,"cx":0.25,"cy":0.5,"radius":25}}]`))
	if out.RGBAAt(200, 90) != src.RGBAAt(200, 90) || out.RGBAAt(60, 5) != src.RGBAAt(60, 5) {
		t.Error("the lens moved pixels outside its circle")
	}
	if meanDiff(t, out, src) == 0 {
		t.Error("the lens changed nothing")
	}
	// A centre outside the picture is fine; so is a circle that misses it.
	for _, js := range []string{
		`{"mode":"bulge","amount":100,"cx":-1,"cy":-1,"radius":200}`,
		`{"mode":"pinch","amount":100,"cx":2,"cy":0.5,"radius":10}`,
		`{"mode":"barrel","amount":100,"cx":-0.5,"cy":1.5}`,
		`{"mode":"pincushion","amount":100,"cx":2,"cy":2}`,
	} {
		got := mustApply(t, src, edits(t, `[{"op":"lens","p":`+js+`}]`))
		if got.Rect != src.Rect {
			t.Errorf("%s: %v", js, got.Rect)
		}
	}
	miss := mustApply(t, src, edits(t, `[{"op":"lens","p":{"mode":"pinch","amount":100,"cx":2,"cy":0.5,"radius":10}}]`))
	if !same(miss, src) {
		t.Error("a circle outside the picture changed it")
	}
	// A bulge magnifies: a small square at the centre grows.
	flat := image.NewRGBA(image.Rect(0, 0, 200, 200))
	for y := 90; y < 110; y++ {
		for x := 90; x < 110; x++ {
			flat.SetRGBA(x, y, color.RGBA{255, 255, 255, 255})
		}
	}
	count := func(img *image.RGBA) (n int) {
		for i := 3; i < len(img.Pix); i += 4 {
			if img.Pix[i] > 127 {
				n++
			}
		}
		return n
	}
	bulge := mustApply(t, flat, edits(t, `[{"op":"lens","p":{"mode":"bulge","amount":60,"radius":50}}]`))
	pinch := mustApply(t, flat, edits(t, `[{"op":"lens","p":{"mode":"pinch","amount":60,"radius":50}}]`))
	if !(count(bulge) > count(flat)*3/2 && count(pinch) < count(flat)*2/3) {
		t.Errorf("square of %d pixels: bulge %d, pinch %d", count(flat), count(bulge), count(pinch))
	}
}

func TestObscureChangesOnlyItsRegion(t *testing.T) {
	src := testImage(320, 240, false)
	inside := func(x, y int) bool { return x >= 96 && x < 224 && y >= 72 && y < 168 } // 0.3..0.7
	for _, method := range []string{"blur", "pixelate", "mosaic"} {
		out := mustApply(t, src, edits(t, fmt.Sprintf(`[{"op":"obscure","p":{"method":%q,"strength":70,"rect":{"x":0.3,"y":0.3,"w":0.4,"h":0.4}}}]`, method)))
		changed := 0
		for y := range 240 {
			for x := range 320 {
				if out.RGBAAt(x, y) == src.RGBAAt(x, y) {
					continue
				}
				if !inside(x, y) {
					t.Fatalf("%s changed (%d,%d) outside the region", method, x, y)
				}
				changed++
			}
		}
		if changed < 128*96*8/10 {
			t.Errorf("%s changed %d of %d pixels in the region", method, changed, 128*96)
		}
	}
	// Half outside the picture: the part inside is obscured, nothing fails.
	partial := mustApply(t, src, edits(t, `[{"op":"obscure","p":{"method":"pixelate","strength":50,"rect":{"x":0.8,"y":-0.5,"w":1,"h":1}}}]`))
	if partial.RGBAAt(300, 60) == src.RGBAAt(300, 60) || partial.RGBAAt(100, 200) != src.RGBAAt(100, 200) {
		t.Error("a region half outside the picture")
	}
	// An ellipse leaves the corners of its box; a polygon follows its points.
	ellipse := mustApply(t, src, edits(t, `[{"op":"obscure","p":{"method":"pixelate","strength":90,"shape":"ellipse","rect":{"x":0.25,"y":0.25,"w":0.5,"h":0.5}}}]`))
	if ellipse.RGBAAt(82, 62) != src.RGBAAt(82, 62) || ellipse.RGBAAt(160, 120) == src.RGBAAt(160, 120) {
		t.Error("ellipse region")
	}
	triangle := mustApply(t, src, edits(t, `[{"op":"obscure","p":{"method":"pixelate","strength":90,"shape":"polygon","points":[[0.1,0.1],[0.9,0.1],[0.1,0.9]]}}]`))
	if triangle.RGBAAt(60, 60) == src.RGBAAt(60, 60) || triangle.RGBAAt(280, 200) != src.RGBAAt(280, 200) {
		t.Error("polygon region")
	}
	// Inverted: the region is what stays.
	inv := mustApply(t, src, edits(t, `[{"op":"obscure","p":{"method":"pixelate","strength":60,"rect":{"x":0.3,"y":0.3,"w":0.4,"h":0.4},"invert":true}}]`))
	if inv.RGBAAt(160, 120) != src.RGBAAt(160, 120) || inv.RGBAAt(20, 20) == src.RGBAAt(20, 20) {
		t.Error("inverted region")
	}
	// A feather fades the effect out beyond the region: what was drawn stays
	// fully obscured, and just outside it the picture is partly changed.
	hard := mustApply(t, src, edits(t, `[{"op":"obscure","p":{"method":"pixelate","strength":100,"rect":{"x":0.3,"y":0.3,"w":0.4,"h":0.4}}}]`))
	softEdge := mustApply(t, src, edits(t, `[{"op":"obscure","p":{"method":"pixelate","strength":100,"rect":{"x":0.3,"y":0.3,"w":0.4,"h":0.4},"feather":60}}]`))
	for y := 72; y < 168; y++ {
		for x := 96; x < 224; x++ {
			if softEdge.RGBAAt(x, y) != hard.RGBAAt(x, y) {
				t.Fatalf("(%d,%d) inside the region is less obscured with a feather", x, y)
			}
		}
	}
	if hard.RGBAAt(90, 120) != src.RGBAAt(90, 120) || softEdge.RGBAAt(90, 120) == src.RGBAAt(90, 120) || softEdge.RGBAAt(40, 120) != src.RGBAAt(40, 120) {
		t.Error("the feather does not fade beyond the region")
	}
	// The original cannot be read back from what was obscured: the pixels are replaced, not marked.
	if meanDiff(t, hard, src) < 0.5 {
		t.Error("the strongest blur hardly changed the region")
	}
}

func TestBumpFollowsItsLight(t *testing.T) {
	// A flat picture has no relief: a gray relief of it is flat gray.
	flat := image.NewRGBA(image.Rect(0, 0, 80, 60))
	for i := range flat.Pix {
		flat.Pix[i] = 200
		if i%4 == 3 {
			flat.Pix[i] = 255
		}
	}
	out := mustApply(t, flat, edits(t, `[{"op":"bump","p":{"height":100}}]`))
	for i := 0; i < len(out.Pix); i += 4 {
		if out.Pix[i] != 128 || out.Pix[i+3] != 255 {
			t.Fatalf("flat relief: %v", out.Pix[i:i+4])
		}
	}
	colored := mustApply(t, flat, edits(t, `[{"op":"bump","p":{"height":100,"color":100}}]`))
	if !same(colored, flat) {
		t.Error("a flat picture lit in color changed")
	}
	// A bright bump in the middle, mirror symmetric: lit from the left it is
	// the mirror image of itself lit from the right.
	hill := image.NewRGBA(image.Rect(0, 0, 81, 61))
	for y := range 61 {
		for x := range 81 {
			v := uint8(255 * math.Exp(-(math.Pow(float64(x)-40, 2)+math.Pow(float64(y)-30, 2))/200))
			hill.SetRGBA(x, y, color.RGBA{v, v, v, 255})
		}
	}
	right := mustApply(t, hill, edits(t, `[{"op":"bump","p":{"height":80,"angle":0,"elevation":30}}]`))
	left := mustApply(t, hill, edits(t, `[{"op":"bump","p":{"height":80,"angle":180,"elevation":30}}]`))
	for y := range 61 {
		for x := range 81 {
			a, b := right.RGBAAt(x, y), left.RGBAAt(80-x, y)
			if d := int(a.R) - int(b.R); d < -1 || d > 1 {
				t.Fatalf("(%d,%d): %d lit from the right, %d mirrored from the left", x, y, a.R, b.R)
			}
		}
	}
	// The side facing the light is brighter.
	if right.RGBAAt(50, 30).R <= right.RGBAAt(30, 30).R {
		t.Errorf("lit from the right: %d on the right slope, %d on the left", right.RGBAAt(50, 30).R, right.RGBAAt(30, 30).R)
	}
}

func TestSketchAndOilOnFlatAndEdges(t *testing.T) {
	// Half black, half white: a sketch draws the border and leaves the rest paper.
	half := image.NewRGBA(image.Rect(0, 0, 120, 80))
	for y := range 80 {
		for x := range 120 {
			v := uint8(40)
			if x >= 60 {
				v = 230
			}
			half.SetRGBA(x, y, color.RGBA{v, v, v, 255})
		}
	}
	pencil := mustApply(t, half, edits(t, `[{"op":"sketch","p":{"style":"pencil","detail":80,"strength":50}}]`))
	if far, near := pencil.RGBAAt(110, 40).R, pencil.RGBAAt(58, 40).R; far < 240 || near > far-40 {
		t.Errorf("pencil: %d far from the edge, %d on its dark side", far, near)
	}
	ink := mustApply(t, half, edits(t, `[{"op":"sketch","p":{"style":"ink","detail":80,"strength":50}}]`))
	// Ink is nearly two-tone: few pixels in between.
	between := 0
	for i := 0; i < len(ink.Pix); i += 4 {
		if v := ink.Pix[i]; v > 30 && v < 225 {
			between++
		}
	}
	if between > 120*80/10 {
		t.Errorf("ink: %d of %d pixels are neither dark nor light", between, 120*80)
	}
	paper := mustApply(t, half, edits(t, `[{"op":"sketch","p":{"style":"pencil","paper":100}}]`))
	if p := paper.RGBAAt(110, 40); !(p.R > p.G && p.G > p.B) {
		t.Errorf("paper tone: %v", p)
	}
	colorful := mustApply(t, testImage(120, 80, false), edits(t, `[{"op":"sketch","p":{"style":"color","color":100}}]`))
	plain := mustApply(t, testImage(120, 80, false), edits(t, `[{"op":"sketch","p":{"style":"pencil"}}]`))
	spread := func(img *image.RGBA) (n int) {
		for i := 0; i < len(img.Pix); i += 4 {
			n += int(max(img.Pix[i], img.Pix[i+1], img.Pix[i+2])) - int(min(img.Pix[i], img.Pix[i+1], img.Pix[i+2]))
		}
		return n
	}
	if spread(plain) != 0 || spread(colorful) == 0 {
		t.Errorf("color in the sketches: pencil %d, color %d", spread(plain), spread(colorful))
	}
	// Oil paint leaves flat areas alone and keeps the alpha.
	oil := mustApply(t, half, edits(t, `[{"op":"oil","p":{"radius":5}}]`))
	if oil.RGBAAt(20, 40) != half.RGBAAt(20, 40) || oil.RGBAAt(100, 40) != half.RGBAAt(100, 40) {
		t.Error("oil paint changed a flat area")
	}
	alpha := testImage(90, 70, true)
	painted := mustApply(t, alpha, edits(t, `[{"op":"oil","p":{"radius":2}}]`))
	for i := 0; i < len(painted.Pix); i += 4 {
		if painted.Pix[i] > painted.Pix[i+3] || painted.Pix[i+1] > painted.Pix[i+3] || painted.Pix[i+2] > painted.Pix[i+3] {
			t.Fatal("oil paint made a color brighter than its alpha")
		}
	}
	// The colors of the result are averages of the source's: fewer distinct ones.
	srcColors, _, _ := CountColors(context.Background(), testImage(200, 150, false))
	oilColors, _, _ := CountColors(context.Background(), mustApply(t, testImage(200, 150, false), edits(t, `[{"op":"oil","p":{"radius":6,"levels":8}}]`)))
	if oilColors >= srcColors {
		t.Errorf("oil paint: %d colors from %d", oilColors, srcColors)
	}
}

func TestInvalidEffects(t *testing.T) {
	for _, js := range []string{
		`{"op":"border","p":{"width":51}}`,
		`{"op":"border","p":{"width":5,"unit":"cm"}}`,
		`{"op":"border","p":{"width":5000,"unit":"px"}}`,
		`{"op":"border","p":{"style":"dotted","width":5}}`,
		`{"op":"border","p":{"width":5,"color":"red"}}`,
		`{"op":"border","p":{"width":5,"opacity":120}}`,
		`{"op":"border","p":{"width":5,"blur":30}}`,
		`{"op":"frameMask","p":{"shape":"star"}}`,
		`{"op":"frameMask","p":{"shape":"custom"}}`,
		`{"op":"frameMask","p":{"shape":"custom","assetId":"../../etc/passwd"}}`,
		`{"op":"frameMask","p":{"shape":"ellipse","assetId":"a1"}}`,
		`{"op":"frameMask","p":{"inset":60}}`,
		`{"op":"watermark","p":{"text":"x","size":0}}`,
		`{"op":"watermark","p":{"text":"x","size":101}}`,
		`{"op":"watermark","p":{"kind":"image","size":10}}`,
		`{"op":"watermark","p":{"kind":"image","assetId":"A1","size":10}}`,
		`{"op":"watermark","p":{"text":"x","size":10,"assetId":"a1"}}`,
		`{"op":"watermark","p":{"text":"x","size":10,"anchor":"middle"}}`,
		`{"op":"watermark","p":{"text":"x","size":10,"blend":"overlay"}}`,
		`{"op":"watermark","p":{"text":"x","size":10,"rotation":200}}`,
		`{"op":"watermark","p":{"text":"x","size":10,"path":"C:\\logo.png"}}`,
		`{"op":"watermark","p":{"text":"` + strings.Repeat("x", MaxTextChars+1) + `","size":10}}`,
		`{"op":"bump","p":{"height":120}}`,
		`{"op":"bump","p":{"height":10,"source":"texture"}}`,
		`{"op":"bump","p":{"height":10,"elevation":0}}`,
		`{"op":"sketch","p":{"style":"charcoal"}}`,
		`{"op":"sketch","p":{"detail":101}}`,
		`{"op":"oil","p":{"radius":0}}`,
		`{"op":"oil","p":{"radius":13}}`,
		`{"op":"oil","p":{"radius":3,"levels":2}}`,
		`{"op":"lens","p":{"mode":"fisheye","amount":10}}`,
		`{"op":"lens","p":{"amount":10,"cx":5}}`,
		`{"op":"lens","p":{"amount":10,"radius":0}}`,
		`{"op":"obscure","p":{"strength":50}}`,
		`{"op":"obscure","p":{"strength":0,"rect":{"x":0,"y":0,"w":1,"h":1}}}`,
		`{"op":"obscure","p":{"strength":50,"rect":{"x":0,"y":0,"w":0,"h":1}}}`,
		`{"op":"obscure","p":{"strength":50,"rect":{"x":9,"y":0,"w":1,"h":1}}}`,
		`{"op":"obscure","p":{"strength":50,"shape":"polygon","points":[[0,0],[1,1]]}}`,
		`{"op":"obscure","p":{"strength":50,"shape":"polygon","points":[[0,0],[1,1],[5,0]]}}`,
		`{"op":"obscure","p":{"strength":50,"shape":"polygon","rect":{"x":0,"y":0,"w":1,"h":1},"points":[[0,0],[1,1],[1,0]]}}`,
		`{"op":"obscure","p":{"strength":50,"shape":"polygon","points":[` + strings.Repeat("[0.1,0.1],", MaxPolygonPoints) + `[0.2,0.2]]}}`,
		`{"op":"obscure","p":{"strength":50,"method":"scramble","rect":{"x":0,"y":0,"w":1,"h":1}}}`,
	} {
		if err := edits(t, "["+js+"]").Validate(); !errors.Is(err, ErrInvalidEdit) {
			t.Errorf("%s: %v", js[:min(len(js), 90)], err)
		}
	}
	// Every effect can run over other pictures.
	for _, name := range []string{"border", "frameMask", "watermark", "bump", "sketch", "oil", "lens", "obscure"} {
		if info, ok := lookupOp(name); !ok || !info.Batchable {
			t.Errorf("%s is not batchable", name)
		}
	}
	// A frame that would make the picture too large is refused before any pixel work.
	if _, err := Compile(edits(t, `[{"op":"border","p":{"width":4000,"unit":"px"}}]`), 9000, 9000, DPI{}); !errors.Is(err, ErrTooLarge) {
		t.Errorf("a 17,000 px frame: %v", err)
	}
}

func TestEffectsCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	src := testImage(600, 400, false)
	for _, name := range []string{"border-shadow", "mask-ellipse", "watermark-outline", "bump-picture", "sketch-pencil", "oil", "lens-bulge", "obscure-blur", "obscure-mosaic"} {
		if _, err := ApplyWith(ctx, src, edits(t, goldenCases[name]), testRes{}); !errors.Is(err, context.Canceled) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// --- benchmarks (BENCH_STAGE=14) ---

func BenchmarkEffects(b *testing.B) {
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
	ctx := context.Background()
	for _, size := range sizes {
		src := benchImage(b, size.w, size.h)
		for name, js := range map[string]string{
			"border-solid":    goldenCases["border-solid"],
			"border-shadow":   goldenCases["border-shadow"],
			"frame-ellipse":   goldenCases["mask-ellipse"],
			"frame-vignette":  goldenCases["mask-vignette"],
			"watermark-text":  goldenCases["watermark-text"],
			"watermark-tiled": goldenCases["watermark-tiled"],
			"watermark-image": goldenCases["watermark-image"],
			"bump":            goldenCases["bump-picture"],
			"sketch":          goldenCases["sketch-pencil"],
			"oil-r4":          `[{"op":"oil","p":{"radius":4}}]`,
			"oil-r12":         `[{"op":"oil","p":{"radius":12}}]`,
			"lens":            goldenCases["lens-bulge"],
			"lens-barrel":     goldenCases["lens-barrel"],
			"obscure-blur-25": `[{"op":"obscure","p":{"method":"blur","strength":60,"rect":{"x":0.25,"y":0.25,"w":0.5,"h":0.5}}}]`,
			"obscure-pixel":   `[{"op":"obscure","p":{"method":"pixelate","strength":60,"rect":{"x":0.25,"y":0.25,"w":0.5,"h":0.5}}}]`,
			"border+mark":     `[{"op":"watermark","p":{"text":"© {year} {name}","size":6,"opacity":60}},{"op":"border","p":{"width":3}}]`,
		} {
			p, err := Compile(edits(b, js), size.w, size.h, DPI{})
			if err != nil {
				b.Fatal(err)
			}
			for _, draft := range []bool{false, true} {
				if draft && name != "oil-r4" && name != "lens" {
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
						if _, err := p.Run(ctx, src, 0, RunOptions{Scale: 1, Draft: draft, Res: testRes{}}); err != nil {
							b.Fatal(err)
						}
					}
				})
			}
		}
	}
	// Laying out and drawing a line of text with a parsed font.
	f, err := fonts.New().Font("", false, false)
	if err != nil {
		b.Fatal(err)
	}
	b.Run("text-layout-48px", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			if _, err := textMask(f, "© 2026 Panelyth IMG_0412", 48, 2); err != nil {
				b.Fatal(err)
			}
		}
	})
}
