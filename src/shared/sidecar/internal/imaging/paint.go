package imaging

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"math"
	"strings"
	"sync"
	"unicode/utf8"
)

// Draw (Stage 15, ADR-0035): strokes and shapes the user puts on the
// picture. One operation is one drawing: a list of strokes painted in order
// onto a transparent layer that is then laid over the picture. Because the
// layer is rebuilt from the list, the eraser removes drawn ink and nothing
// else, and undo is a shorter list. Points are 0..1 of the picture and sizes
// percentages of its shorter edge, so a drawing replays at any resolution.

func init() {
	RegisterOp("draw", OpInfo{Version: 1, Parse: parseDraw})
	RegisterOp("clone", OpInfo{Version: 1, Parse: parseClone})
	RegisterOp("heal", OpInfo{Version: 1, Parse: parseHeal})
	RegisterOp("redeye", OpInfo{Version: 1, Parse: parseRedEye})
}

// Limits of drawn operations.
const (
	// MaxStrokes bounds the strokes of one drawing.
	MaxStrokes = 2000
	// MaxStrokePoints bounds the points of one stroke; an edit list holds at
	// most MaxListPoints in all (checked where the list is received).
	MaxStrokePoints = 20000
	MaxListPoints   = 100000
)

// Stroke is one thing drawn.
type Stroke struct {
	// Tool: brush, eraser, line, arrow, rect, ellipse, text or fill.
	Tool string `json:"tool"`
	// Color "#rrggbb" (black when absent); unused by the eraser.
	Color string `json:"color,omitempty"`
	// Size in percent of the shorter edge (0.05..50): the brush's diameter,
	// a line's width, the height of a line of text.
	Size float64 `json:"size,omitempty"`
	// Hardness 0..100 (100 when absent): how much of the brush is solid.
	Hardness *float64 `json:"hardness,omitempty"`
	// Opacity 0..100 (100 when absent).
	Opacity *float64 `json:"opacity,omitempty"`
	// Points are [x, y] or [x, y, pressure], 0..1 of the picture: the path
	// of a brush, the two ends of a line or the corners of a shape, the
	// place of a text (its top left) or of a fill.
	Points [][]float64 `json:"points"`
	// Filled: a rectangle or an ellipse is filled, not outlined.
	Filled bool `json:"filled,omitempty"`
	// Text, with its font (see watermark), for the text tool.
	Text   string `json:"text,omitempty"`
	Font   string `json:"font,omitempty"`
	Bold   bool   `json:"bold,omitempty"`
	Italic bool   `json:"italic,omitempty"`
	// Tolerance 0..100 of a fill: how different a color may be and still fill.
	Tolerance float64 `json:"tolerance,omitempty"`

	color             color.RGBA
	hardness, opacity float64
}

func (s *Stroke) validate() error {
	var need int
	switch s.Tool {
	case "brush", "eraser":
		need = 1
	case "line", "arrow", "rect", "ellipse":
		need = 2
	case "text", "fill":
		need = 1
	default:
		return invalid("draw tool %q", s.Tool)
	}
	if len(s.Points) < need || len(s.Points) > MaxStrokePoints {
		return invalid("draw: a %s has %d..%d points", s.Tool, need, MaxStrokePoints)
	}
	if need == 2 && len(s.Points) != 2 || (s.Tool == "text" || s.Tool == "fill") && len(s.Points) != 1 {
		return invalid("draw: a %s has exactly %d points", s.Tool, need)
	}
	for _, p := range s.Points {
		if len(p) < 2 || len(p) > 3 || !inRange(p[0], -1, 2) || !inRange(p[1], -1, 2) || (len(p) == 3 && !inRange(p[2], 0, 1)) {
			return invalid("draw: a point is [x, y] or [x, y, pressure] within -1..2")
		}
	}
	s.hardness, s.opacity = 100, 100
	if s.Hardness != nil {
		s.hardness = *s.Hardness
	}
	if s.Opacity != nil {
		s.opacity = *s.Opacity
	}
	if s.Tool != "fill" && !inRange(s.Size, 0.05, 50) {
		return invalid("draw: size is 0.05..50 percent")
	}
	if !inRange(s.hardness, 0, 100) || !inRange(s.opacity, 0, 100) || !inRange(s.Tolerance, 0, 100) {
		return invalid("draw: hardness, opacity and tolerance are 0..100")
	}
	if utf8.RuneCountInString(s.Text) > MaxTextChars || !utf8.ValidString(s.Text) || len(s.Font) > 128 {
		return invalid("draw: text is at most %d characters", MaxTextChars)
	}
	var err error
	s.color, err = colorOr(s.Color, "#000000")
	return err
}

type drawStep struct {
	sameSize
	Strokes []Stroke `json:"strokes"`

	// keys[i] names the layer after strokes 0..i, or is empty from the
	// first stroke whose ink depends on more than the list (a fill looks at
	// the picture, a text token at its file).
	keys []string
}

// copyRGBA is a copy of img made in parallel bands.
func copyRGBA(ctx context.Context, img *image.RGBA) (*image.RGBA, error) {
	dst := image.NewRGBA(img.Rect)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	err := Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			copy(dst.Pix[y*dst.Stride:y*dst.Stride+w*4], img.Pix[y*img.Stride:y*img.Stride+w*4])
		}
	})
	return dst, err
}

// A drawing grows by a stroke at a time, and the stroke being drawn changes
// with every frame. The layer of the strokes before it is kept, so a frame
// paints one stroke, not all of them. Proxy sizes only: at full resolution
// a layer is hundreds of megabytes and is painted once.
const (
	layerCacheSize   = 2
	layerCachePixels = 8_000_000
)

type layerEntry struct {
	key   string
	layer *image.RGBA
	inked image.Rectangle
}

var (
	layerMu    sync.Mutex
	layerCache []layerEntry
)

func cachedLayer(key string) (*image.RGBA, image.Rectangle, bool) {
	layerMu.Lock()
	defer layerMu.Unlock()
	for i, e := range layerCache {
		if e.key == key {
			layerCache = append(append(layerCache[:i:i], layerCache[i+1:]...), e)
			return e.layer, e.inked, true
		}
	}
	return nil, image.Rectangle{}, false
}

func rememberLayer(key string, layer *image.RGBA, inked image.Rectangle) {
	layerMu.Lock()
	defer layerMu.Unlock()
	for i, e := range layerCache {
		if e.key == key {
			layerCache = append(layerCache[:i:i], layerCache[i+1:]...)
			break
		}
	}
	layerCache = append(layerCache, layerEntry{key, layer, inked})
	if len(layerCache) > layerCacheSize {
		layerCache = append([]layerEntry(nil), layerCache[len(layerCache)-layerCacheSize:]...)
	}
}

func parseDraw(raw json.RawMessage) (Step, error) {
	s := &drawStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if len(s.Strokes) > MaxStrokes {
		return nil, invalid("draw: at most %d strokes", MaxStrokes)
	}
	points := 0
	for i := range s.Strokes {
		if err := s.Strokes[i].validate(); err != nil {
			return nil, err
		}
		points += len(s.Strokes[i].Points)
	}
	if points > MaxListPoints {
		return nil, invalid("draw: at most %d points", MaxListPoints)
	}
	// A chain of hashes over the strokes, as far as their ink is the list's alone.
	s.keys = make([]string, len(s.Strokes))
	prev := ""
	for i := range s.Strokes {
		st := &s.Strokes[i]
		if st.Tool == "fill" || (st.Tool == "text" && strings.Contains(st.Text, "{")) {
			break
		}
		body, err := json.Marshal(st)
		if err != nil {
			break
		}
		sum := sha256.Sum256(append([]byte(prev), body...))
		prev = hex.EncodeToString(sum[:16])
		s.keys[i] = prev
	}
	return s, nil
}

// capsule is a segment of a path with a radius at each end, in working pixels.
type capsule struct {
	x0, y0, r0, x1, y1, r1 float64
	top, bottom            int // the rows it touches
}

// pathCapsules turns points into capsules of a base radius; pressure (0..1,
// 0.5 for a mouse) scales the radius between half and one and a half.
func pathCapsules(points [][]float64, w, h int, radius float64) []capsule {
	at := func(p []float64) (float64, float64, float64) {
		r := radius
		if len(p) == 3 {
			r = radius * (0.5 + p[2])
		}
		return p[0] * float64(w), p[1] * float64(h), math.Max(r, 0.35)
	}
	make1 := func(a, b []float64) capsule {
		c := capsule{}
		c.x0, c.y0, c.r0 = at(a)
		c.x1, c.y1, c.r1 = at(b)
		r := math.Max(c.r0, c.r1) + 1
		c.top = int(math.Floor(math.Min(c.y0, c.y1) - r))
		c.bottom = int(math.Ceil(math.Max(c.y0, c.y1) + r))
		return c
	}
	if len(points) == 1 {
		return []capsule{make1(points[0], points[0])}
	}
	out := make([]capsule, 0, len(points)-1)
	for i := 1; i < len(points); i++ {
		out = append(out, make1(points[i-1], points[i]))
	}
	return out
}

// strokeMask is the coverage of a set of capsules: for every pixel the most
// any capsule covers it (so a path does not darken where it crosses itself).
// hardness 0..1 is the solid part of the radius.
type strokeMask struct {
	box  image.Rectangle
	pix  []uint8
	full bool // every pixel of the box is covered (a fill of everything)
}

func (m *strokeMask) at(x, y int) uint8 {
	if !(image.Point{x, y}).In(m.box) {
		return 0
	}
	return m.pix[(y-m.box.Min.Y)*m.box.Dx()+x-m.box.Min.X]
}

func capsuleMask(ctx context.Context, caps []capsule, w, h int, hardness float64) (*strokeMask, error) {
	box := image.Rectangle{}
	for _, c := range caps {
		r := math.Max(c.r0, c.r1) + 1
		box = box.Union(image.Rect(int(math.Floor(math.Min(c.x0, c.x1)-r)), c.top,
			int(math.Ceil(math.Max(c.x0, c.x1)+r))+1, c.bottom+1))
	}
	box = box.Intersect(image.Rect(0, 0, w, h))
	m := &strokeMask{box: box}
	if box.Empty() {
		return m, ctx.Err()
	}
	bw, bh := box.Dx(), box.Dy()
	m.pix = make([]uint8, bw*bh)
	err := Rows(ctx, bw, bh, func(ya, yb int) {
		for i := range caps {
			c := &caps[i]
			y0, y1 := max(c.top-box.Min.Y, ya), min(c.bottom-box.Min.Y+1, yb)
			if y0 >= y1 {
				continue
			}
			r := math.Max(c.r0, c.r1) + 1
			x0 := max(int(math.Floor(math.Min(c.x0, c.x1)-r))-box.Min.X, 0)
			x1 := min(int(math.Ceil(math.Max(c.x0, c.x1)+r))+1-box.Min.X, bw)
			dx, dy := c.x1-c.x0, c.y1-c.y0
			len2 := dx*dx + dy*dy
			for y := y0; y < y1; y++ {
				row := m.pix[y*bw : y*bw+bw]
				py := float64(y+box.Min.Y) + 0.5 - c.y0
				for x := x0; x < x1; x++ {
					px := float64(x+box.Min.X) + 0.5 - c.x0
					t := 0.0
					if len2 > 0 {
						t = clamp01((px*dx + py*dy) / len2)
					}
					d := math.Hypot(px-t*dx, py-t*dy)
					r := c.r0 + t*(c.r1-c.r0)
					if d >= r+0.5 {
						continue
					}
					// Solid up to hardness·r, then falling to nothing at r;
					// a hard brush keeps a one-pixel anti-aliased rim.
					var a float64
					if soft := r * (1 - hardness); soft > 1 {
						a = smooth((r - d) / soft)
					} else {
						a = clamp01(r - d + 0.5)
					}
					if v := uint8(a*255 + 0.5); v > row[x] {
						row[x] = v
					}
				}
			}
		}
	})
	return m, err
}

// shapeMask is the coverage of a rectangle or an ellipse between two corners:
// filled, or an outline of the given width.
func shapeMask(ctx context.Context, tool string, x0, y0, x1, y1, width float64, filled bool, w, h int) (*strokeMask, error) {
	if x0 > x1 {
		x0, x1 = x1, x0
	}
	if y0 > y1 {
		y0, y1 = y1, y0
	}
	half := width / 2
	box := image.Rect(int(math.Floor(x0-half))-1, int(math.Floor(y0-half))-1,
		int(math.Ceil(x1+half))+2, int(math.Ceil(y1+half))+2).Intersect(image.Rect(0, 0, w, h))
	m := &strokeMask{box: box}
	if box.Empty() {
		return m, ctx.Err()
	}
	bw, bh := box.Dx(), box.Dy()
	m.pix = make([]uint8, bw*bh)
	err := Rows(ctx, bw, bh, func(ya, yb int) {
		for y := ya; y < yb; y++ {
			cy := float64(y+box.Min.Y) + 0.5
			for x := range bw {
				cx := float64(x+box.Min.X) + 0.5
				var d float64
				if tool == "ellipse" {
					d = sdEllipse(cx, cy, (x0+x1)/2, (y0+y1)/2, math.Max((x1-x0)/2, 0.5), math.Max((y1-y0)/2, 0.5))
				} else {
					d = sdRoundRect(cx, cy, x0, y0, x1, y1, 0)
				}
				if !filled {
					d = math.Abs(d) - half
				}
				m.pix[y*bw+x] = uint8(clamp01(0.5-d)*255 + 0.5)
			}
		}
	})
	return m, err
}

// floodMask is the area a fill reaches from a seed: connected pixels whose
// color is within the tolerance of the seed's (scanline fill).
func floodMask(ctx context.Context, img *image.RGBA, sx, sy int, tolerance float64) (*strokeMask, error) {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	m := &strokeMask{box: img.Rect}
	if sx < 0 || sy < 0 || sx >= w || sy >= h {
		m.box = image.Rectangle{}
		return m, ctx.Err()
	}
	m.pix = make([]uint8, w*h)
	seed := img.Pix[sy*img.Stride+sx*4 : sy*img.Stride+sx*4+4]
	sr, sg, sb, sa := int32(seed[0]), int32(seed[1]), int32(seed[2]), int32(seed[3])
	// The largest channel difference a pixel may have.
	limit := int32(math.Round(tolerance / 100 * 255))
	match := func(x, y int) bool {
		if m.pix[y*w+x] != 0 {
			return false
		}
		p := img.Pix[y*img.Stride+x*4:]
		d := max(absInt32(int32(p[0])-sr), absInt32(int32(p[1])-sg), absInt32(int32(p[2])-sb), absInt32(int32(p[3])-sa))
		return d <= limit
	}
	type span struct{ x, y int }
	stack := []span{{sx, sy}}
	steps := 0
	for len(stack) > 0 {
		if steps++; steps&1023 == 0 && ctx.Err() != nil {
			return nil, ctx.Err()
		}
		s := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if !match(s.x, s.y) {
			continue
		}
		left, right := s.x, s.x
		for left > 0 && match(left-1, s.y) {
			left--
		}
		for right < w-1 && match(right+1, s.y) {
			right++
		}
		for x := left; x <= right; x++ {
			m.pix[s.y*w+x] = 255
		}
		for _, ny := range [2]int{s.y - 1, s.y + 1} {
			if ny < 0 || ny >= h {
				continue
			}
			for x := left; x <= right; x++ {
				if match(x, ny) {
					stack = append(stack, span{x, ny})
					// One seed per run of matching pixels.
					for x < right && match(x+1, ny) {
						x++
					}
				}
			}
		}
	}
	return m, ctx.Err()
}

func absInt32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

// arrowHead adds the two barbs of an arrow at the end of a line.
func arrowHead(points [][]float64, w, h int, radius float64) []capsule {
	x0, y0 := points[0][0]*float64(w), points[0][1]*float64(h)
	x1, y1 := points[1][0]*float64(w), points[1][1]*float64(h)
	length := math.Hypot(x1-x0, y1-y0)
	if length < 1 {
		return nil
	}
	// Barbs of five line widths (at most half the line), 28° off the shaft.
	barb := math.Min(radius*10, length/2)
	angle := math.Atan2(y0-y1, x0-x1)
	var out []capsule
	for _, turn := range [2]float64{0.49, -0.49} {
		bx, by := x1+barb*math.Cos(angle+turn), y1+barb*math.Sin(angle+turn)
		c := capsule{x0: x1, y0: y1, r0: radius, x1: bx, y1: by, r1: radius}
		c.top = int(math.Floor(math.Min(y1, by) - radius - 1))
		c.bottom = int(math.Ceil(math.Max(y1, by) + radius + 1))
		out = append(out, c)
	}
	return out
}

// mask builds a stroke's coverage at the working size. flat is the picture
// with the layer so far, which a fill looks at.
func (s *Stroke) mask(ctx context.Context, env *Env, w, h int, flat func() (*image.RGBA, error)) (*strokeMask, error) {
	short := shortEdge(env)
	width := math.Max(s.Size/100*short, 0.7)
	fw, fh := float64(w), float64(h)
	switch s.Tool {
	case "brush", "eraser":
		return capsuleMask(ctx, pathCapsules(s.Points, w, h, width/2), w, h, s.hardness/100)
	case "line":
		return capsuleMask(ctx, pathCapsules(s.Points, w, h, width/2), w, h, 1)
	case "arrow":
		caps := append(pathCapsules(s.Points[:2], w, h, width/2), arrowHead(s.Points, w, h, width/2)...)
		return capsuleMask(ctx, caps, w, h, 1)
	case "rect", "ellipse":
		a, b := s.Points[0], s.Points[1]
		return shapeMask(ctx, s.Tool, a[0]*fw, a[1]*fh, b[0]*fw, b[1]*fh, width, s.Filled, w, h)
	case "text":
		if s.Text == "" {
			return &strokeMask{}, nil
		}
		f, err := env.font(s.Font, s.Bold, s.Italic)
		if err != nil {
			return nil, err
		}
		text := s.Text
		if env.Res != nil {
			text = ExpandTokens(text, env.Res.Token)
		}
		letters, err := textMask(f, text, width, 0)
		if err != nil {
			return nil, err
		}
		x0, y0 := int(math.Round(s.Points[0][0]*fw)), int(math.Round(s.Points[0][1]*fh))
		return &strokeMask{box: image.Rect(x0, y0, x0+letters.Rect.Dx(), y0+letters.Rect.Dy()), pix: letters.Pix}, nil
	}
	// fill
	base, err := flat()
	if err != nil {
		return nil, err
	}
	return floodMask(ctx, base, int(s.Points[0][0]*fw), int(s.Points[0][1]*fh), s.Tolerance)
}

func (s *drawStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	if len(s.Strokes) == 0 {
		return img, nil
	}
	img = toRGBA(img)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	// The layer the strokes are painted on, and where it has ink. It starts
	// from the kept layer of all strokes but the last, when there is one.
	var layer *image.RGBA
	inked := image.Rectangle{}
	first := 0
	cacheable := w*h <= layerCachePixels
	cacheKey := func(i int) string {
		if !cacheable || i < 0 || s.keys[i] == "" {
			return ""
		}
		return fmt.Sprintf("%s|%dx%d|%g", s.keys[i], w, h, env.Scale)
	}
	for _, upTo := range [2]int{len(s.Strokes) - 1, len(s.Strokes) - 2} {
		key := cacheKey(upTo)
		if key == "" {
			continue
		}
		if kept, box, ok := cachedLayer(key); ok {
			var err error
			if layer, err = copyRGBA(ctx, kept); err != nil {
				return nil, err
			}
			inked, first = box, upTo+1
			break
		}
	}
	if layer == nil {
		layer = image.NewRGBA(img.Rect)
	}
	compose := func(dst *image.RGBA, box image.Rectangle) error {
		return Rows(ctx, box.Dx(), box.Dy(), func(ya, yb int) {
			for y := ya + box.Min.Y; y < yb+box.Min.Y; y++ {
				d := dst.Pix[y*dst.Stride+box.Min.X*4 : y*dst.Stride+box.Max.X*4]
				l := layer.Pix[y*layer.Stride+box.Min.X*4 : y*layer.Stride+box.Max.X*4]
				for i := 0; i < len(d); i += 4 {
					if l[i+3] != 0 {
						overPix(d[i:i+4], l[i:i+4], 256)
					}
				}
			}
		})
	}
	flat := func() (*image.RGBA, error) {
		out, err := copyRGBA(ctx, img)
		if err != nil || inked.Empty() {
			return out, err
		}
		return out, compose(out, inked)
	}
	for i := first; i < len(s.Strokes); i++ {
		st := &s.Strokes[i]
		// Before the last stroke: this layer is what the next frame starts from.
		if i == len(s.Strokes)-1 && i > 0 && i > first {
			if key := cacheKey(i - 1); key != "" {
				kept, err := copyRGBA(ctx, layer)
				if err != nil {
					return nil, err
				}
				rememberLayer(key, kept, inked)
			}
		}
		if st.opacity == 0 {
			continue
		}
		m, err := st.mask(ctx, env, w, h, flat)
		if err != nil {
			return nil, err
		}
		box := m.box.Intersect(img.Rect)
		if box.Empty() {
			continue
		}
		a := int32(math.Round(st.opacity / 100 * 256))
		erase := st.Tool == "eraser"
		if err := Rows(ctx, box.Dx(), box.Dy(), func(ya, yb int) {
			for y := ya + box.Min.Y; y < yb+box.Min.Y; y++ {
				l := layer.Pix[y*layer.Stride:]
				for x := box.Min.X; x < box.Max.X; x++ {
					cov := int32(m.at(x, y)) * a / 255
					if cov == 0 {
						continue
					}
					o := l[x*4 : x*4+4]
					if erase {
						// The ink goes; the picture under the layer was never touched.
						keep := 256 - cov
						o[0], o[1], o[2], o[3] = uint8(int32(o[0])*keep>>8), uint8(int32(o[1])*keep>>8),
							uint8(int32(o[2])*keep>>8), uint8(int32(o[3])*keep>>8)
						continue
					}
					overColor(o, st.color, cov)
				}
			}
		}); err != nil {
			return nil, err
		}
		if !erase {
			inked = inked.Union(box)
		}
	}
	if inked.Empty() {
		return img, ctx.Err()
	}
	dst := img
	if !env.Scratch {
		var err error
		if dst, err = copyRGBA(ctx, img); err != nil {
			return nil, err
		}
	}
	if err := compose(dst, inked); err != nil {
		return nil, err
	}
	// The whole drawing: what the next stroke starts from once this one is done.
	if key := cacheKey(len(s.Strokes) - 1); key != "" && first < len(s.Strokes) {
		rememberLayer(key, layer, inked)
	}
	return dst, nil
}

// SimplifyPath drops points of a path that lie within tolerance (in the
// path's own units) of the line through their neighbours
// (Ramer–Douglas–Peucker), so a long stroke stays small. The ends stay.
func SimplifyPath(points [][]float64, tolerance float64) [][]float64 {
	if len(points) < 3 || tolerance <= 0 {
		return points
	}
	keep := make([]bool, len(points))
	keep[0], keep[len(points)-1] = true, true
	type span struct{ a, b int }
	stack := []span{{0, len(points) - 1}}
	for len(stack) > 0 {
		s := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		ax, ay := points[s.a][0], points[s.a][1]
		dx, dy := points[s.b][0]-ax, points[s.b][1]-ay
		len2 := dx*dx + dy*dy
		worst, at := 0.0, -1
		for i := s.a + 1; i < s.b; i++ {
			px, py := points[i][0]-ax, points[i][1]-ay
			t := 0.0
			if len2 > 0 {
				t = clamp01((px*dx + py*dy) / len2)
			}
			if d := math.Hypot(px-t*dx, py-t*dy); d > worst {
				worst, at = d, i
			}
		}
		if at >= 0 && worst > tolerance {
			keep[at] = true
			stack = append(stack, span{s.a, at}, span{at, s.b})
		}
	}
	out := make([][]float64, 0, len(points))
	for i, p := range points {
		if keep[i] {
			out = append(out, p)
		}
	}
	return out
}
