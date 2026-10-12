package imaging

import (
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"math"
	"math/rand"
	"os"
	"strings"
	"testing"
)

// The Stage 15 cases join the golden set and the worker-count check.
func init() {
	for name, js := range map[string]string{
		"draw-brush":   `[{"op":"draw","p":{"strokes":[{"tool":"brush","color":"#ff3300","size":6,"hardness":40,"points":[[0.1,0.2],[0.3,0.6],[0.6,0.3],[0.9,0.8]]}]}}]`,
		"draw-pen":     `[{"op":"draw","p":{"strokes":[{"tool":"brush","color":"#003366","size":5,"opacity":70,"points":[[0.1,0.5,0.1],[0.4,0.4,0.9],[0.8,0.6,0.3]]}]}}]`,
		"draw-eraser":  `[{"op":"draw","p":{"strokes":[{"tool":"rect","color":"#00aa00","size":3,"filled":true,"points":[[0.2,0.2],[0.8,0.8]]},{"tool":"eraser","size":10,"hardness":50,"points":[[0.1,0.5],[0.9,0.5]]}]}}]`,
		"draw-shapes":  `[{"op":"draw","p":{"strokes":[{"tool":"line","color":"#ffffff","size":2,"points":[[0.05,0.05],[0.95,0.3]]},{"tool":"arrow","color":"#ffee00","size":1.5,"points":[[0.1,0.9],[0.6,0.5]]},{"tool":"rect","color":"#ff00ff","size":1,"points":[[0.55,0.55],[0.9,0.9]]},{"tool":"ellipse","color":"#00ffff","size":2,"opacity":60,"points":[[0.3,0.1],[0.7,0.45]]},{"tool":"ellipse","color":"#000000","size":1,"filled":true,"points":[[0.05,0.6],[0.2,0.75]]}]}}]`,
		"draw-text":    `[{"op":"draw","p":{"strokes":[{"tool":"text","color":"#ffffff","size":10,"text":"Panelyth\n{name}","bold":true,"points":[[0.1,0.2]]}]}}]`,
		"draw-fill":    `[{"op":"draw","p":{"strokes":[{"tool":"ellipse","color":"#000000","size":1.5,"points":[[0.25,0.25],[0.75,0.75]]},{"tool":"fill","color":"#3399ff","opacity":80,"tolerance":35,"points":[[0.5,0.5]]}]}}]`,
		"clone":        `[{"op":"clone","p":{"size":14,"hardness":60,"source":[0.2,0.3],"points":[[0.6,0.5],[0.75,0.6],[0.8,0.75]]}}]`,
		"heal-spot":    `[{"op":"heal","p":{"size":8,"points":[[0.5,0.5]]}}]`,
		"heal-brush":   `[{"op":"heal","p":{"mode":"brush","size":7,"source":[0.3,0.3],"points":[[0.6,0.6],[0.7,0.65]]}}]`,
		"redeye-rect":  `[{"op":"redeye","p":{"rect":{"x":0.3,"y":0.3,"w":0.2,"h":0.25},"strength":90,"pupil":10}}]`,
		"redeye-auto":  `[{"op":"redeye","p":{"auto":true}}]`,
		"retouch-list": `[{"op":"clone","p":{"size":10,"source":[0.1,0.1],"points":[[0.5,0.5]]}},{"op":"draw","p":{"strokes":[{"tool":"brush","color":"#ffffff","size":3,"points":[[0.4,0.4],[0.6,0.6]]}]}},{"op":"heal","p":{"size":6,"points":[[0.55,0.55]]}}]`,
	} {
		goldenCases[name] = js
	}
}

func flat(w, h int, c color.RGBA) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = c.R, c.G, c.B, c.A
	}
	return img
}

var white = color.RGBA{255, 255, 255, 255}

func TestBrushHardnessOpacityAndCrossing(t *testing.T) {
	src := flat(400, 300, white)
	stroke := func(extra string) *image.RGBA {
		return mustApply(t, src, edits(t, `[{"op":"draw","p":{"strokes":[{"tool":"brush","color":"#000000","size":20,`+extra+`"points":[[0.2,0.5],[0.8,0.5]]}]}}]`))
	}
	// Size 20 % of 300 px: a brush 60 px wide, centred on y = 150.
	hard := stroke(`"hardness":100,`)
	if hard.RGBAAt(200, 150).R != 0 || hard.RGBAAt(200, 150-28).R != 0 || hard.RGBAAt(200, 150-32).R != 255 {
		t.Errorf("hard brush: %v %v %v", hard.RGBAAt(200, 150), hard.RGBAAt(200, 122), hard.RGBAAt(200, 118))
	}
	// A round end, not a square one.
	if hard.RGBAAt(80-28, 150).R != 0 || hard.RGBAAt(80-28, 150-28).R != 255 {
		t.Errorf("brush end: %v %v", hard.RGBAAt(52, 150), hard.RGBAAt(52, 122))
	}
	soft := stroke(`"hardness":0,`)
	centre, mid, rim := soft.RGBAAt(200, 150).R, soft.RGBAAt(200, 150-15).R, soft.RGBAAt(200, 150-27).R
	if !(centre < 10 && mid > 60 && mid < 200 && rim > 230) {
		t.Errorf("soft brush falls off as %d, %d, %d", centre, mid, rim)
	}
	// Opacity is the stroke's, however often it passes a point.
	half := stroke(`"opacity":50,"hardness":100,`)
	if v := half.RGBAAt(200, 150).R; v < 125 || v > 130 {
		t.Errorf("half opaque: %d", v)
	}
	cross := mustApply(t, src, edits(t, `[{"op":"draw","p":{"strokes":[{"tool":"brush","color":"#000000","size":10,"opacity":50,"points":[[0.2,0.2],[0.8,0.8],[0.8,0.2],[0.2,0.8]]}]}}]`))
	if a, b := cross.RGBAAt(200, 150).R, cross.RGBAAt(120, 90).R; a != b {
		t.Errorf("a stroke darkens where it crosses itself: %d against %d", a, b)
	}
	// Two strokes do add up.
	twice := mustApply(t, src, edits(t, `[{"op":"draw","p":{"strokes":[{"tool":"brush","color":"#000000","size":20,"opacity":50,"points":[[0.2,0.5],[0.8,0.5]]},{"tool":"brush","color":"#000000","size":20,"opacity":50,"points":[[0.5,0.2],[0.5,0.8]]}]}}]`))
	if v := twice.RGBAAt(200, 150).R; v < 60 || v > 68 {
		t.Errorf("two half opaque strokes: %d", v)
	}
	// Pressure widens the stroke: light at the start, heavy at the end.
	pen := mustApply(t, src, edits(t, `[{"op":"draw","p":{"strokes":[{"tool":"brush","color":"#000000","size":20,"points":[[0.2,0.5,0],[0.8,0.5,1]]}]}}]`))
	if pen.RGBAAt(100, 150-20).R != 255 || pen.RGBAAt(300, 150-35).R != 0 {
		t.Errorf("pressure: %v near the start, %v near the end", pen.RGBAAt(100, 130), pen.RGBAAt(300, 115))
	}
	// A single point is a dot.
	dot := mustApply(t, src, edits(t, `[{"op":"draw","p":{"strokes":[{"tool":"brush","color":"#ff0000","size":10,"points":[[0.5,0.5]]}]}}]`))
	if dot.RGBAAt(200, 150) != (color.RGBA{255, 0, 0, 255}) || dot.RGBAAt(200, 170) != white {
		t.Errorf("dot: %v %v", dot.RGBAAt(200, 150), dot.RGBAAt(200, 170))
	}
}

func TestEraserRemovesInkOnly(t *testing.T) {
	src := testImage(300, 200, false)
	inked := `{"tool":"rect","color":"#00ff00","size":2,"filled":true,"points":[[0.1,0.1],[0.9,0.9]]}`
	erased := mustApply(t, src, edits(t, `[{"op":"draw","p":{"strokes":[`+inked+`,{"tool":"eraser","size":20,"points":[[0.3,0.5],[0.7,0.5]]}]}}]`))
	// Where the eraser went the picture is back, exactly; beside it the ink stays.
	if erased.RGBAAt(150, 100) != src.RGBAAt(150, 100) || erased.RGBAAt(120, 100) != src.RGBAAt(120, 100) {
		t.Errorf("erased: %v, picture %v", erased.RGBAAt(150, 100), src.RGBAAt(150, 100))
	}
	if erased.RGBAAt(150, 40) != (color.RGBA{0, 255, 0, 255}) {
		t.Errorf("ink beside the eraser: %v", erased.RGBAAt(150, 40))
	}
	// Outside the ink the eraser changes nothing: it never touches the picture.
	only := mustApply(t, src, edits(t, `[{"op":"draw","p":{"strokes":[{"tool":"eraser","size":30,"points":[[0.1,0.1],[0.9,0.9]]}]}}]`))
	if !same(only, src) {
		t.Error("an eraser alone changed the picture")
	}
	// Ink of an earlier operation is pixels by now: a later drawing's eraser leaves it.
	later := mustApply(t, src, edits(t, `[{"op":"draw","p":{"strokes":[`+inked+`]}},{"op":"draw","p":{"strokes":[{"tool":"eraser","size":20,"points":[[0.3,0.5],[0.7,0.5]]}]}}]`))
	if later.RGBAAt(150, 100) != (color.RGBA{0, 255, 0, 255}) {
		t.Errorf("an eraser reached into another drawing: %v", later.RGBAAt(150, 100))
	}
	// A half-strength eraser takes half the ink.
	halfway := mustApply(t, flat(300, 200, white), edits(t, `[{"op":"draw","p":{"strokes":[{"tool":"rect","color":"#000000","size":2,"filled":true,"points":[[0.1,0.1],[0.9,0.9]]},{"tool":"eraser","size":20,"opacity":50,"points":[[0.3,0.5],[0.7,0.5]]}]}}]`))
	if v := halfway.RGBAAt(150, 100).R; v < 122 || v > 132 {
		t.Errorf("half erased: %d", v)
	}
}

func TestShapesTextAndFill(t *testing.T) {
	src := flat(400, 300, white)
	one := func(stroke string) *image.RGBA {
		return mustApply(t, src, edits(t, `[{"op":"draw","p":{"strokes":[`+stroke+`]}}]`))
	}
	black := color.RGBA{0, 0, 0, 255}
	// A rectangle outline: its edge is inked, its inside is not; filled, both are.
	rect := one(`{"tool":"rect","size":2,"points":[[0.25,0.25],[0.75,0.75]]}`)
	if rect.RGBAAt(100, 150) != black || rect.RGBAAt(200, 150) != white || rect.RGBAAt(50, 150) != white {
		t.Errorf("rectangle outline: %v %v %v", rect.RGBAAt(100, 150), rect.RGBAAt(200, 150), rect.RGBAAt(50, 150))
	}
	// The corners may come in any order.
	if !same(rect, one(`{"tool":"rect","size":2,"points":[[0.75,0.75],[0.25,0.25]]}`)) {
		t.Error("a rectangle depends on the order of its corners")
	}
	filled := one(`{"tool":"ellipse","size":2,"filled":true,"points":[[0.25,0.25],[0.75,0.75]]}`)
	if filled.RGBAAt(200, 150) != black || filled.RGBAAt(105, 80) != white {
		t.Errorf("filled ellipse: %v %v", filled.RGBAAt(200, 150), filled.RGBAAt(105, 80))
	}
	// An arrow is longer on its head's side: ink beside the shaft near the end only.
	arrow := one(`{"tool":"arrow","size":2,"points":[[0.2,0.5],[0.8,0.5]]}`)
	if arrow.RGBAAt(200, 150) != black || arrow.RGBAAt(300, 141).R > 80 || arrow.RGBAAt(120, 141) != white {
		t.Errorf("arrow: shaft %v, head %v, tail side %v", arrow.RGBAAt(200, 150), arrow.RGBAAt(300, 141), arrow.RGBAAt(120, 141))
	}
	// Text is drawn where it is put, in its size.
	text := one(`{"tool":"text","size":20,"text":"MM","points":[[0.25,0.25]]}`)
	ink, box := 0, image.Rectangle{}
	for y := range 300 {
		for x := range 400 {
			if text.RGBAAt(x, y).R < 128 {
				ink++
				box = box.Union(image.Rect(x, y, x+1, y+1))
			}
		}
	}
	if ink < 500 || box.Min.X < 100 || box.Min.Y < 75 || box.Dy() < 30 || box.Dy() > 70 {
		t.Errorf("text: %d inked pixels in %v", ink, box)
	}
	if !same(one(`{"tool":"text","size":20,"text":"","points":[[0.25,0.25]]}`), src) {
		t.Error("an empty text drew something")
	}
	// A fill stops at a drawn outline and at the tolerance.
	ring := `{"tool":"ellipse","size":2,"points":[[0.25,0.25],[0.75,0.75]]}`
	in := one(ring + `,{"tool":"fill","color":"#ff0000","points":[[0.5,0.5]]}`)
	if in.RGBAAt(200, 150) != (color.RGBA{255, 0, 0, 255}) || in.RGBAAt(20, 20) != white {
		t.Errorf("fill inside the ring: %v, outside %v", in.RGBAAt(200, 150), in.RGBAAt(20, 20))
	}
	out := one(ring + `,{"tool":"fill","color":"#ff0000","points":[[0.05,0.05]]}`)
	if out.RGBAAt(200, 150) != white || out.RGBAAt(20, 20) != (color.RGBA{255, 0, 0, 255}) {
		t.Errorf("fill outside the ring: inside %v, outside %v", out.RGBAAt(200, 150), out.RGBAAt(20, 20))
	}
	// On a gradient the tolerance decides how far it goes.
	ramp := image.NewRGBA(image.Rect(0, 0, 256, 20))
	for y := range 20 {
		for x := range 256 {
			ramp.SetRGBA(x, y, color.RGBA{uint8(x), uint8(x), uint8(x), 255})
		}
	}
	reach := func(tolerance int) (n int) {
		got := mustApply(t, ramp, edits(t, fmt.Sprintf(`[{"op":"draw","p":{"strokes":[{"tool":"fill","color":"#ff0000","tolerance":%d,"points":[[0,0.5]]}]}}]`, tolerance)))
		for x := range 256 {
			if got.RGBAAt(x, 10).G == 0 {
				n++
			}
		}
		return n
	}
	if a, b, c := reach(0), reach(20), reach(100); a != 1 || b != 52 || c != 256 {
		t.Errorf("fill reached %d, %d and %d columns", a, b, c)
	}
	// A seed outside the picture fills nothing.
	if !same(one(`{"tool":"fill","color":"#ff0000","points":[[1.5,0.5]]}`), src) {
		t.Error("a fill from outside the picture")
	}
}

// A drawing made on the proxy is the drawing the save makes.
func TestDrawnOperationsLookTheSameOnTheProxy(t *testing.T) {
	ctx := context.Background()
	full, err := Resample(ctx, testImage(200, 150, false), 1600, 1200, CatmullRom)
	if err != nil {
		t.Fatal(err)
	}
	small, _ := Resample(ctx, full, 400, 300, CatmullRom)
	for name, limit := range map[string]float64{
		"draw-brush": 2, "draw-pen": 2, "draw-eraser": 2, "draw-shapes": 3, "draw-text": 3,
		"clone": 5, "heal-brush": 4, "redeye-rect": 2,
	} {
		p, err := Compile(edits(t, goldenCases[name]), 1600, 1200, DPI{})
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
		down, _ := Resample(ctx, want, 400, 300, CatmullRom)
		if d := meanDiff(t, got, down); d > limit {
			t.Errorf("%s: the proxy differs from the scaled full result by %.2f levels (limit %.0f)", name, d, limit)
		}
	}
}

// The editor adds a stroke at a time and redraws the newest with every
// frame; the layer kept between frames must never show in the result.
func TestKeptLayerIsInvisible(t *testing.T) {
	src := testImage(320, 240, false)
	strokes := []string{
		`{"tool":"brush","color":"#ff0000","size":6,"hardness":30,"points":[[0.1,0.1],[0.9,0.9]]}`,
		`{"tool":"rect","color":"#0000ff","size":2,"filled":true,"points":[[0.3,0.3],[0.6,0.7]]}`,
		`{"tool":"eraser","size":12,"points":[[0.2,0.5],[0.8,0.5]]}`,
		`{"tool":"text","color":"#ffffff","size":12,"text":"ok","points":[[0.4,0.1]]}`,
		`{"tool":"ellipse","color":"#00ff00","size":3,"opacity":50,"points":[[0.5,0.5],[0.95,0.95]]}`,
		`{"tool":"brush","color":"#000000","size":3,"points":[[0.9,0.1],[0.1,0.9]]}`,
	}
	list := func(n int, last string) EditList {
		all := append(append([]string(nil), strokes[:n-1]...), last)
		return edits(t, `[{"op":"draw","p":{"strokes":[`+strings.Join(all, ",")+`]}}]`)
	}
	fresh := func(e EditList) string {
		layerMu.Lock()
		layerCache = nil
		layerMu.Unlock()
		return hashOf(mustApply(t, src, e))
	}
	for n := 1; n <= len(strokes); n++ {
		// The stroke being drawn: three frames of it, then as it is committed.
		for _, live := range []string{
			`{"tool":"brush","color":"#888888","size":4,"points":[[0.5,0.2],[0.52,0.3]]}`,
			`{"tool":"brush","color":"#888888","size":4,"points":[[0.5,0.2],[0.52,0.3],[0.6,0.5]]}`,
			strokes[n-1],
		} {
			e := list(n, live)
			want := fresh(e)
			// Now as the editor does it: with whatever the frames before left behind.
			if n > 1 {
				mustApply(t, src, list(n-1, strokes[n-2]))
				mustApply(t, src, list(n, `{"tool":"brush","size":1,"points":[[0.1,0.9]]}`))
			}
			if got := hashOf(mustApply(t, src, e)); got != want {
				t.Fatalf("%d strokes, last %s: the kept layer changed the result", n, live[:30])
			}
			// And again, from the layer of the whole drawing.
			if got := hashOf(mustApply(t, src, e)); got != want {
				t.Fatalf("%d strokes: a second render differs", n)
			}
		}
	}
	// A fill looks at the picture: from it on, nothing is kept.
	other := testImage(320, 240, true)
	fill := edits(t, `[{"op":"draw","p":{"strokes":[`+strokes[0]+`,{"tool":"fill","color":"#00ff00","tolerance":10,"points":[[0.9,0.1]]},`+strokes[5]+`]}}]`)
	a, b := hashOf(mustApply(t, src, fill)), hashOf(mustApply(t, other, fill))
	if a == b || a != fresh(fill) {
		t.Error("a drawing with a fill was kept across pictures")
	}
	// Another size is another layer.
	big := testImage(640, 480, false)
	e := list(3, strokes[2])
	mustApply(t, src, e)
	first := hashOf(mustApply(t, big, e))
	if first != func() string {
		layerMu.Lock()
		layerCache = nil
		layerMu.Unlock()
		return hashOf(mustApply(t, big, e))
	}() {
		t.Error("a layer of another size was used")
	}
}

func TestCloneCopiesFromBeforeTheStroke(t *testing.T) {
	src := testImage(300, 200, false)
	// The source is 60 px left and 40 px up of the stroke.
	out := mustApply(t, src, edits(t, `[{"op":"clone","p":{"size":20,"hardness":100,"source":[0.3,0.3],"points":[[0.5,0.5],[0.6,0.5]]}}]`))
	for _, p := range [][2]int{{150, 100}, {165, 105}, {180, 95}} {
		if out.RGBAAt(p[0], p[1]) != src.RGBAAt(p[0]-60, p[1]-40) {
			t.Errorf("(%d,%d) is %v, its source %v", p[0], p[1], out.RGBAAt(p[0], p[1]), src.RGBAAt(p[0]-60, p[1]-40))
		}
	}
	if out.RGBAAt(150, 150) != src.RGBAAt(150, 150) || out.RGBAAt(90, 60) != src.RGBAAt(90, 60) {
		t.Error("the clone changed pixels outside its stroke, or its source")
	}
	// A stroke that paints over its own source copies what was there before
	// it began: no smear of the copy into the copy.
	near := mustApply(t, src, edits(t, `[{"op":"clone","p":{"size":30,"hardness":100,"source":[0.45,0.5],"points":[[0.5,0.5],[0.7,0.5]]}}]`))
	for x := 150; x <= 210; x += 15 {
		if near.RGBAAt(x, 100) != src.RGBAAt(x-15, 100) {
			t.Fatalf("(%d,100) is %v, the picture's (%d,100) is %v", x, near.RGBAAt(x, 100), x-15, src.RGBAAt(x-15, 100))
		}
	}
	// Half opaque: halfway between the two.
	half := mustApply(t, flat(300, 200, white), edits(t, `[{"op":"clone","p":{"size":20,"hardness":100,"opacity":50,"source":[0.3,0.3],"points":[[0.5,0.5]]}}]`))
	if half.RGBAAt(150, 100) != white {
		t.Errorf("cloning white onto white: %v", half.RGBAAt(150, 100))
	}
	// A source outside the picture repeats its border; nothing fails.
	edge := mustApply(t, src, edits(t, `[{"op":"clone","p":{"size":20,"source":[-0.5,-0.5],"points":[[0.5,0.5]]}}]`))
	if edge.Rect != src.Rect {
		t.Error("clone from outside the picture")
	}
}

// blemished is a picture with soft light and fine texture, and the same
// with a dark spot on it.
func blemished(w, h int, cx, cy, r float64) (clean, spotted *image.RGBA) {
	rnd := rand.New(rand.NewSource(7))
	clean = image.NewRGBA(image.Rect(0, 0, w, h))
	spotted = image.NewRGBA(clean.Rect)
	for y := range h {
		for x := range w {
			// Light from the left, darker to the right; grain on top.
			base := 200 - 80*float64(x)/float64(w) + 20*float64(y)/float64(h)
			v := base + float64(rnd.Intn(13)-6)
			c := color.RGBA{uint8(v), uint8(v * 0.85), uint8(v * 0.75), 255}
			clean.SetRGBA(x, y, c)
			if d := math.Hypot(float64(x)-cx, float64(y)-cy); d < r {
				k := 0.35 + 0.65*smooth(d/r)
				c = color.RGBA{uint8(float64(c.R) * k), uint8(float64(c.G) * k), uint8(float64(c.B) * k), 255}
			}
			spotted.SetRGBA(x, y, c)
		}
	}
	return clean, spotted
}

// errorIn is the mean absolute difference of two pictures inside a disc.
func errorIn(a, b *image.RGBA, cx, cy, r float64) float64 {
	var sum float64
	n := 0
	for y := int(cy - r); y <= int(cy+r); y++ {
		for x := int(cx - r); x <= int(cx+r); x++ {
			if math.Hypot(float64(x)-cx, float64(y)-cy) > r || !(image.Point{x, y}).In(a.Rect) {
				continue
			}
			p, q := a.RGBAAt(x, y), b.RGBAAt(x, y)
			sum += math.Abs(float64(p.R)-float64(q.R)) + math.Abs(float64(p.G)-float64(q.G)) + math.Abs(float64(p.B)-float64(q.B))
			n += 3
		}
	}
	return sum / float64(n)
}

// The heal fixtures and their bound: what the stage records as its quality gate.
func TestHealRemovesABlemish(t *testing.T) {
	var before, afterSpot, afterBrush, afterClone float64
	cases := []struct{ w, h, cx, cy, r float64 }{
		{400, 300, 200, 150, 14}, {400, 300, 90, 60, 9}, {400, 300, 330, 240, 18}, {600, 400, 300, 200, 25}, {300, 300, 150, 150, 6},
	}
	for _, c := range cases {
		clean, spotted := blemished(int(c.w), int(c.h), c.cx, c.cy, c.r)
		short := math.Min(c.w, c.h)
		size := 2.6 * c.r / short * 100
		at := fmt.Sprintf(`[%g,%g]`, c.cx/c.w, c.cy/c.h)
		spot := mustApply(t, spotted, edits(t, fmt.Sprintf(`[{"op":"heal","p":{"size":%g,"points":[%s]}}]`, size, at)))
		// The brush's source is far to the right, where the light is darker.
		source := fmt.Sprintf(`[%g,%g]`, math.Mod(c.cx/c.w+0.35, 0.9), c.cy/c.h)
		brush := mustApply(t, spotted, edits(t, fmt.Sprintf(`[{"op":"heal","p":{"mode":"brush","size":%g,"source":%s,"points":[%s]}}]`, size, source, at)))
		clone := mustApply(t, spotted, edits(t, fmt.Sprintf(`[{"op":"clone","p":{"size":%g,"hardness":60,"source":%s,"points":[%s]}}]`, size, source, at)))
		b, s, br, cl := errorIn(spotted, clean, c.cx, c.cy, c.r), errorIn(spot, clean, c.cx, c.cy, c.r),
			errorIn(brush, clean, c.cx, c.cy, c.r), errorIn(clone, clean, c.cx, c.cy, c.r)
		before, afterSpot, afterBrush, afterClone = before+b, afterSpot+s, afterBrush+br, afterClone+cl
		// Each fixture: the spot is gone to within the grain (±6 levels).
		if s > 8 || br > 8 {
			t.Errorf("blemish r=%g at (%g,%g): error %.1f before, %.1f after spot heal, %.1f after the heal brush", c.r, c.cx, c.cy, b, s, br)
		}
		// Outside the stroke nothing changed.
		if spot.RGBAAt(2, 2) != spotted.RGBAAt(2, 2) || brush.RGBAAt(int(c.w)-3, int(c.h)-3) != spotted.RGBAAt(int(c.w)-3, int(c.h)-3) {
			t.Error("heal changed pixels far from its stroke")
		}
	}
	n := float64(len(cases))
	t.Logf("mean error in the blemish (levels of 255): %.1f before; %.1f spot heal, %.1f heal brush, %.1f clone from the same source",
		before/n, afterSpot/n, afterBrush/n, afterClone/n)
	// The gate: heal takes at least four fifths of the error away, and beats
	// a plain clone from a differently lit source (it corrects the tone).
	if afterSpot > before/5 || afterBrush > before/5 {
		t.Errorf("heal leaves %.1f (spot) and %.1f (brush) of %.1f", afterSpot/n, afterBrush/n, before/n)
	}
	if afterBrush >= afterClone/2 {
		t.Errorf("the heal brush (%.1f) is no better than a clone (%.1f)", afterBrush/n, afterClone/n)
	}
}

func TestHealAlongAScratchAndItsLimits(t *testing.T) {
	// A scratch: a dark line across the textured picture, healed by a stroke along it.
	clean, scratched := blemished(400, 300, -100, -100, 1)
	for x := 100; x < 300; x++ {
		y := 150 + (x-100)/10
		for dy := -1; dy <= 1; dy++ {
			scratched.SetRGBA(x, y+dy, color.RGBA{30, 25, 20, 255})
		}
	}
	healed := mustApply(t, scratched, edits(t, `[{"op":"heal","p":{"size":4,"points":[[0.25,0.5],[0.5,0.5417],[0.75,0.5667]]}}]`))
	var before, after float64
	for x := 110; x < 290; x += 10 {
		y := float64(150 + (x-100)/10)
		before += errorIn(scratched, clean, float64(x), y, 2)
		after += errorIn(healed, clean, float64(x), y, 2)
	}
	if after > before/6 {
		t.Errorf("scratch: error %.1f before, %.1f after", before/18, after/18)
	}
	// Alpha is kept, colors stay within it.
	alpha := testImage(200, 150, true)
	out := mustApply(t, alpha, edits(t, `[{"op":"heal","p":{"size":20,"points":[[0.5,0.5]]}}]`))
	for i := 0; i < len(out.Pix); i += 4 {
		if out.Pix[i+3] != alpha.Pix[i+3] || out.Pix[i] > out.Pix[i+3] || out.Pix[i+1] > out.Pix[i+3] || out.Pix[i+2] > out.Pix[i+3] {
			t.Fatal("heal changed the alpha or made a color brighter than it")
		}
	}
	// One stroke heals a bounded area; a stroke across a huge picture is refused.
	big := image.NewRGBA(image.Rect(0, 0, 3000, 3000))
	if _, err := Apply(context.Background(), big, edits(t, `[{"op":"heal","p":{"size":50,"points":[[0.1,0.1],[0.9,0.9]]}}]`)); !errors.Is(err, ErrInvalidEdit) {
		t.Errorf("a heal stroke over 9 megapixels: %v", err)
	}
}

// eye paints a red pupil with a white catchlight on skin.
func eye(img *image.RGBA, cx, cy, r int) {
	for y := cy - r; y <= cy+r; y++ {
		for x := cx - r; x <= cx+r; x++ {
			if !(image.Point{x, y}).In(img.Rect) {
				continue
			}
			d := math.Hypot(float64(x-cx), float64(y-cy))
			switch {
			case d <= float64(r)/4 && x <= cx && y <= cy:
				img.SetRGBA(x-r/3, y-r/3, color.RGBA{252, 250, 248, 255})
			case d <= float64(r):
				img.SetRGBA(x, y, color.RGBA{215, 40, 45, 255})
			}
		}
	}
}

var skin = color.RGBA{214, 168, 140, 255}

func TestRedEyeFix(t *testing.T) {
	src := flat(400, 300, skin)
	eye(src, 200, 150, 12)
	// Lips beside the eye: red, but not in the box.
	for y := 220; y < 240; y++ {
		for x := 150; x < 250; x++ {
			src.SetRGBA(x, y, color.RGBA{180, 60, 70, 255})
		}
	}
	out := mustApply(t, src, edits(t, `[{"op":"redeye","p":{"rect":{"x":0.44,"y":0.4,"w":0.12,"h":0.2}}}]`))
	// The pupil is dark and no longer red.
	p := out.RGBAAt(206, 156)
	if p.R > 60 || int(p.R) > int(max(p.G, p.B))+25 {
		t.Errorf("pupil: %v", p)
	}
	// The catchlight, the skin and the lips are as they were.
	if out.RGBAAt(196, 146) != src.RGBAAt(196, 146) || src.RGBAAt(196, 146).R < 250 {
		t.Errorf("catchlight: %v (was %v)", out.RGBAAt(196, 146), src.RGBAAt(196, 146))
	}
	if out.RGBAAt(100, 100) != skin || out.RGBAAt(200, 230) != src.RGBAAt(200, 230) || out.RGBAAt(230, 150) != skin {
		t.Error("red-eye changed the skin or the lips")
	}
	// Strength scales it; a box over skin alone changes nothing.
	weak := mustApply(t, src, edits(t, `[{"op":"redeye","p":{"rect":{"x":0.44,"y":0.4,"w":0.12,"h":0.2},"strength":50}}]`))
	if w := weak.RGBAAt(206, 156).R; w <= p.R || w >= 215 {
		t.Errorf("half strength: %d between %d and 215", w, p.R)
	}
	if !same(mustApply(t, src, edits(t, `[{"op":"redeye","p":{"rect":{"x":0.05,"y":0.05,"w":0.2,"h":0.2}}}]`)), src) {
		t.Error("red-eye changed plain skin")
	}
	// Red clothing in the box is not a lit retina's red (it is not far above its green and blue).
	shirt := flat(200, 200, color.RGBA{170, 90, 90, 255})
	if d := meanDiff(t, mustApply(t, shirt, edits(t, `[{"op":"redeye","p":{"rect":{"x":0.2,"y":0.2,"w":0.6,"h":0.6}}}]`)), shirt); d > 0.5 {
		t.Errorf("dull red changed by %.2f", d)
	}
}

// The detection set: what the Stage 15 gate was measured on. It is
// synthetic (discs on skin tones), so it shows that the rules do what they
// say, not how they fare on photographs.
func TestRedEyeDetection(t *testing.T) {
	ctx := context.Background()
	rnd := rand.New(rand.NewSource(15))
	const scenes = 60
	found, eyesTotal, falseScenes := 0, 0, 0
	for range scenes {
		w, h := 640, 480
		img := flat(w, h, color.RGBA{uint8(190 + rnd.Intn(40)), uint8(150 + rnd.Intn(30)), uint8(120 + rnd.Intn(30)), 255})
		// One or two faces: a pair of pupils each, level within a few pixels.
		type pupil struct{ x, y, r int }
		var truth []pupil
		for range 1 + rnd.Intn(2) {
			r := 4 + rnd.Intn(10)
			// Eyes are seven to thirteen pupil widths apart.
			gap := (2*r + 1) * (7 + rnd.Intn(7))
			if gap > w-140 {
				continue
			}
			x, y := 60+rnd.Intn(w-120-gap), 60+rnd.Intn(h-120)
			tilt := rnd.Intn(2*r+1) - r
			ok := true
			for _, p := range truth {
				if absInt(p.y-y) < 6*(p.r+r) && absInt(p.x-x) < 30*(p.r+r) {
					ok = false
				}
			}
			if !ok {
				continue
			}
			eye(img, x, y, r)
			eye(img, x+gap, y+tilt, r+rnd.Intn(2))
			truth = append(truth, pupil{x, y, r}, pupil{x + gap, y + tilt, r})
		}
		eyes, err := DetectEyes(ctx, img)
		if err != nil {
			t.Fatal(err)
		}
		eyesTotal += len(truth)
		matched := 0
		for _, p := range truth {
			for _, e := range eyes {
				if cx, cy := (e.X+e.W/2)*float64(w), (e.Y+e.H/2)*float64(h); math.Hypot(cx-float64(p.x), cy-float64(p.y)) < float64(p.r) {
					matched++
					break
				}
			}
		}
		found += matched
		if len(eyes) > matched {
			falseScenes++
		}
	}
	// Negatives: red things that are not a pair of pupils.
	negatives := map[string]func(img *image.RGBA){
		"one red light":       func(img *image.RGBA) { eye(img, 300, 200, 10) },
		"lips":                func(img *image.RGBA) { fillEllipse(img, 320, 300, 60, 14, color.RGBA{190, 50, 60, 255}) },
		"red clothing":        func(img *image.RGBA) { fillEllipse(img, 320, 400, 200, 120, color.RGBA{200, 30, 40, 255}) },
		"sunset":              func(img *image.RGBA) { fillEllipse(img, 320, 100, 320, 90, color.RGBA{230, 90, 40, 255}) },
		"two sizes":           func(img *image.RGBA) { eye(img, 200, 200, 5); eye(img, 280, 200, 14) },
		"one above the other": func(img *image.RGBA) { eye(img, 300, 150, 9); eye(img, 303, 230, 9) },
		"far apart":           func(img *image.RGBA) { eye(img, 40, 200, 6); eye(img, 600, 205, 6) },
		"berries":             func(img *image.RGBA) { eye(img, 100, 100, 8); eye(img, 118, 104, 8); eye(img, 109, 120, 8) },
		"a red bar":           func(img *image.RGBA) { fillEllipse(img, 320, 240, 150, 6, color.RGBA{220, 30, 30, 255}) },
		"red squares far": func(img *image.RGBA) {
			fillEllipse(img, 100, 400, 40, 40, color.RGBA{220, 30, 30, 255})
			fillEllipse(img, 500, 400, 40, 40, color.RGBA{220, 30, 30, 255})
		},
	}
	falseNegatives := 0
	for name, paint := range negatives {
		img := flat(640, 480, skin)
		paint(img)
		eyes, _ := DetectEyes(ctx, img)
		if len(eyes) > 0 {
			falseNegatives++
			t.Logf("false positive on %q: %v", name, eyes)
		}
	}
	rate := float64(found) / float64(eyesTotal)
	t.Logf("synthetic set: %d of %d pupils found (%.0f %%), %d of %d positive scenes with an extra detection, %d of %d negatives detected",
		found, eyesTotal, rate*100, falseScenes, scenes, falseNegatives, len(negatives))
	// Taillight-like pairs are the known weakness: "berries" may pair up.
	if rate < 0.9 {
		t.Errorf("only %.0f %% of the pupils were found", rate*100)
	}
	if falseNegatives > 1 || falseScenes > scenes/20 {
		t.Errorf("false detections: %d negatives, %d scenes", falseNegatives, falseScenes)
	}
	// The auto variant fixes what the detection finds, and only that.
	img := flat(640, 480, skin)
	eye(img, 200, 200, 10)
	eye(img, 420, 204, 10)
	eye(img, 100, 420, 10) // alone
	fixed := mustApply(t, img, edits(t, `[{"op":"redeye","p":{"auto":true}}]`))
	if p := fixed.RGBAAt(204, 204); p.R > 70 {
		t.Errorf("auto left the first pupil red: %v", p)
	}
	if p := fixed.RGBAAt(424, 208); p.R > 70 {
		t.Errorf("auto left the second pupil red: %v", p)
	}
	if fixed.RGBAAt(104, 424) != img.RGBAAt(104, 424) {
		t.Error("auto changed a single red light")
	}
	if !same(mustApply(t, flat(100, 100, skin), edits(t, `[{"op":"redeye","p":{"auto":true}}]`)), flat(100, 100, skin)) {
		t.Error("auto changed a picture without eyes")
	}
}

func fillEllipse(img *image.RGBA, cx, cy, rx, ry int, c color.RGBA) {
	for y := cy - ry; y <= cy+ry; y++ {
		for x := cx - rx; x <= cx+rx; x++ {
			dx, dy := float64(x-cx)/float64(rx), float64(y-cy)/float64(ry)
			if dx*dx+dy*dy <= 1 && (image.Point{x, y}).In(img.Rect) {
				img.SetRGBA(x, y, c)
			}
		}
	}
}

func TestSimplifyPath(t *testing.T) {
	// A straight line is its two ends.
	var line [][]float64
	for i := range 200 {
		line = append(line, []float64{float64(i) / 199, float64(i) / 199 * 0.5})
	}
	if got := SimplifyPath(line, 0.001); len(got) != 2 || got[0][0] != 0 || got[1][0] != 1 {
		t.Errorf("a straight line kept %d points", len(got))
	}
	// A wavy path keeps far fewer points, and none of the dropped ones is
	// farther than the tolerance from what is left.
	var wave [][]float64
	for i := range 2000 {
		x := float64(i) / 1999
		wave = append(wave, []float64{x, 0.5 + 0.2*math.Sin(x*20), 0.5})
	}
	const tolerance = 0.002
	got := SimplifyPath(wave, tolerance)
	if len(got) > 200 || len(got) < 20 {
		t.Errorf("the wave kept %d of 2000 points", len(got))
	}
	for _, p := range wave {
		best := math.Inf(1)
		for i := 1; i < len(got); i++ {
			ax, ay := got[i-1][0], got[i-1][1]
			dx, dy := got[i][0]-ax, got[i][1]-ay
			u := clamp01(((p[0]-ax)*dx + (p[1]-ay)*dy) / (dx*dx + dy*dy))
			best = math.Min(best, math.Hypot(p[0]-ax-u*dx, p[1]-ay-u*dy))
		}
		if best > tolerance*1.0001 {
			t.Fatalf("a point is %.5f from the simplified path", best)
		}
	}
	// Pressure travels with its point; short paths and no tolerance are left alone.
	if len(got[0]) != 3 || got[0][2] != 0.5 {
		t.Errorf("first point: %v", got[0])
	}
	if two := SimplifyPath(wave[:2], 1); len(two) != 2 {
		t.Error("two points")
	}
	if all := SimplifyPath(wave, 0); len(all) != 2000 {
		t.Error("zero tolerance dropped points")
	}
}

func TestInvalidDrawnOperations(t *testing.T) {
	long := strings.Repeat("[0.5,0.5],", MaxStrokePoints) + "[0.5,0.5]"
	many := strings.Repeat(`{"tool":"brush","size":1,"points":[[0.5,0.5]]},`, MaxStrokes) + `{"tool":"brush","size":1,"points":[[0.5,0.5]]}`
	for _, js := range []string{
		`{"op":"draw","p":{"strokes":[{"tool":"spray","size":5,"points":[[0.5,0.5]]}]}}`,
		`{"op":"draw","p":{"strokes":[{"tool":"brush","size":5,"points":[]}]}}`,
		`{"op":"draw","p":{"strokes":[{"tool":"brush","size":0,"points":[[0.5,0.5]]}]}}`,
		`{"op":"draw","p":{"strokes":[{"tool":"brush","size":60,"points":[[0.5,0.5]]}]}}`,
		`{"op":"draw","p":{"strokes":[{"tool":"brush","size":5,"points":[[0.5]]}]}}`,
		`{"op":"draw","p":{"strokes":[{"tool":"brush","size":5,"points":[[0.5,0.5,2]]}]}}`,
		`{"op":"draw","p":{"strokes":[{"tool":"brush","size":5,"points":[[5,0.5]]}]}}`,
		`{"op":"draw","p":{"strokes":[{"tool":"brush","size":5,"color":"red","points":[[0.5,0.5]]}]}}`,
		`{"op":"draw","p":{"strokes":[{"tool":"brush","size":5,"opacity":101,"points":[[0.5,0.5]]}]}}`,
		`{"op":"draw","p":{"strokes":[{"tool":"line","size":5,"points":[[0.5,0.5]]}]}}`,
		`{"op":"draw","p":{"strokes":[{"tool":"rect","size":5,"points":[[0,0],[1,1],[0.5,0.5]]}]}}`,
		`{"op":"draw","p":{"strokes":[{"tool":"text","size":5,"text":"a","points":[[0,0],[1,1]]}]}}`,
		`{"op":"draw","p":{"strokes":[{"tool":"fill","tolerance":120,"points":[[0.5,0.5]]}]}}`,
		`{"op":"draw","p":{"strokes":[{"tool":"brush","size":5,"points":[` + long + `]}]}}`,
		`{"op":"draw","p":{"strokes":[` + many + `]}}`,
		`{"op":"draw","p":{"strokes":[{"tool":"brush","size":5,"points":[[0.5,0.5]],"path":"x"}]}}`,
		`{"op":"clone","p":{"size":5,"points":[[0.5,0.5]]}}`,
		`{"op":"clone","p":{"size":5,"source":[9,0],"points":[[0.5,0.5]]}}`,
		`{"op":"clone","p":{"size":5,"source":[0.1,0.1],"points":[]}}`,
		`{"op":"clone","p":{"size":0,"source":[0.1,0.1],"points":[[0.5,0.5]]}}`,
		`{"op":"heal","p":{"size":5,"mode":"brush","points":[[0.5,0.5]]}}`,
		`{"op":"heal","p":{"size":5,"source":[0.1,0.1],"points":[[0.5,0.5]]}}`,
		`{"op":"heal","p":{"size":5,"mode":"magic","points":[[0.5,0.5]]}}`,
		`{"op":"heal","p":{"size":70,"points":[[0.5,0.5]]}}`,
		`{"op":"redeye","p":{}}`,
		`{"op":"redeye","p":{"auto":true,"rect":{"x":0,"y":0,"w":0.1,"h":0.1}}}`,
		`{"op":"redeye","p":{"rect":{"x":0,"y":0,"w":0,"h":0.1}}}`,
		`{"op":"redeye","p":{"rect":{"x":0,"y":0,"w":0.1,"h":0.1},"strength":150}}`,
		`{"op":"redeye","p":{"rect":{"x":0,"y":0,"w":0.1,"h":0.1},"pupil":80}}`,
	} {
		if err := edits(t, "["+js+"]").Validate(); !errors.Is(err, ErrInvalidEdit) {
			t.Errorf("%s: %v", js[:min(len(js), 90)], err)
		}
	}
	// The user points at pixels of one picture: none of these runs over others.
	for _, name := range []string{"draw", "clone", "heal", "redeye"} {
		if info, ok := lookupOp(name); !ok || info.Batchable {
			t.Errorf("%s is batchable", name)
		}
	}
	if edits(t, goldenCases["retouch-list"]).Batchable() {
		t.Error("a list with strokes is batchable")
	}
	// An empty drawing is nothing.
	src := testImage(40, 30, false)
	if !same(mustApply(t, src, edits(t, `[{"op":"draw","p":{"strokes":[]}}]`)), src) {
		t.Error("an empty drawing changed the picture")
	}
}

func TestDrawnOperationsCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	src := testImage(600, 400, false)
	for _, name := range []string{"draw-brush", "draw-shapes", "draw-fill", "clone", "heal-spot", "redeye-auto"} {
		if _, err := ApplyWith(ctx, src, edits(t, goldenCases[name]), testRes{}); !errors.Is(err, context.Canceled) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// --- benchmarks (BENCH_STAGE=15) ---

// wavyStroke is a path of n points across the picture.
func wavyStroke(n int) string {
	var b strings.Builder
	for i := range n {
		x := 0.05 + 0.9*float64(i)/float64(n-1)
		fmt.Fprintf(&b, "[%.4f,%.4f]", x, 0.5+0.35*math.Sin(x*40))
		if i < n-1 {
			b.WriteByte(',')
		}
	}
	return b.String()
}

func BenchmarkDrawAndRetouch(b *testing.B) {
	ctx := context.Background()
	run := func(name string, src *image.RGBA, js string, scale float64) {
		w, h := int(float64(src.Rect.Dx())/scale+0.5), int(float64(src.Rect.Dy())/scale+0.5)
		p, err := Compile(edits(b, js), w, h, DPI{})
		if err != nil {
			b.Fatal(err)
		}
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				if _, err := p.Run(ctx, src, 0, RunOptions{Scale: scale, Res: testRes{}}); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
	proxy := benchImage(b, 1800, 1200)
	// A brush of 50 px on the 2 MP proxy: 50/1200 of the shorter edge.
	brush := fmt.Sprintf(`{"tool":"brush","color":"#ff0000","size":%.3f,"hardness":50,"points":[%%s]}`, 50.0/1200*100)
	run("2MP/brush-50px-200pt", proxy, `[{"op":"draw","p":{"strokes":[`+fmt.Sprintf(brush, wavyStroke(200))+`]}}]`, 1)
	run("2MP/brush-50px-20pt", proxy, `[{"op":"draw","p":{"strokes":[`+fmt.Sprintf(brush, wavyStroke(20))+`]}}]`, 1)
	var many []string
	for range 50 {
		many = append(many, fmt.Sprintf(brush, wavyStroke(100)))
	}
	run("2MP/draw-50-strokes", proxy, `[{"op":"draw","p":{"strokes":[`+strings.Join(many, ",")+`]}}]`, 1)
	// The 50th stroke while it is drawn: it differs from frame to frame.
	{
		var frames [2]*Program
		for i := range frames {
			last := fmt.Sprintf(brush, wavyStroke(100+i))
			p, err := Compile(edits(b, `[{"op":"draw","p":{"strokes":[`+strings.Join(many[:49], ",")+","+last+`]}}]`), 1800, 1200, DPI{})
			if err != nil {
				b.Fatal(err)
			}
			frames[i] = p
		}
		b.Run("2MP/draw-50th-stroke-live", func(b *testing.B) {
			b.ReportAllocs()
			i := 0
			for b.Loop() {
				if _, err := frames[i&1].Run(ctx, proxy, 0, RunOptions{Scale: 1, Res: testRes{}}); err != nil {
					b.Fatal(err)
				}
				i++
			}
		})
	}
	run("2MP/shapes-and-text", proxy, goldenCases["draw-shapes"], 1)
	run("2MP/fill", proxy, goldenCases["draw-fill"], 1)
	run("2MP/clone-stroke", proxy, `[{"op":"clone","p":{"size":4.2,"source":[0.2,0.2],"points":[`+wavyStroke(40)+`]}}]`, 1)
	// Heal regions of 256 and 128 pixels: the stroke's box.
	run("2MP/heal-brush-256", proxy, `[{"op":"heal","p":{"mode":"brush","size":8,"source":[0.2,0.2],"points":[[0.5,0.5],[0.56,0.56]]}}]`, 1)
	run("2MP/heal-spot-128", proxy, `[{"op":"heal","p":{"size":7,"points":[[0.5,0.5]]}}]`, 1)
	run("2MP/redeye-auto-scan", proxy, `[{"op":"redeye","p":{"auto":true}}]`, 1)
	b.Run("2MP/detect-eyes", func(b *testing.B) {
		for b.Loop() {
			if _, err := DetectEyes(ctx, proxy); err != nil {
				b.Fatal(err)
			}
		}
	})
	if os.Getenv("BENCH_LARGE") == "" {
		b.Log("set BENCH_LARGE=1 to add the 24 MP cases")
		return
	}
	full := benchImage(b, 6000, 4000)
	run("24MP/replay-5000pt-stroke", full, `[{"op":"draw","p":{"strokes":[`+fmt.Sprintf(brush, wavyStroke(5000))+`]}}]`, 1)
	run("24MP/redeye-click", full, `[{"op":"redeye","p":{"rect":{"x":0.48,"y":0.47,"w":0.04,"h":0.06}}}]`, 1)
	run("24MP/clone-stroke", full, `[{"op":"clone","p":{"size":4.2,"source":[0.2,0.2],"points":[`+wavyStroke(40)+`]}}]`, 1)
	run("24MP/heal-spot", full, `[{"op":"heal","p":{"size":3,"points":[[0.5,0.5]]}}]`, 1)
}
