package imaging

import (
	"context"
	"encoding/json"
	"image"
	"math"
)

// Retouch (Stage 15): clone, heal and red-eye. Clone and heal read the
// picture as it is before the stroke (the step's input), so a stroke never
// smears itself; each stroke is its own operation.

// --- clone ---

type cloneStep struct {
	sameSize
	// Points is the painted path; Source is where its first point copies
	// from (0..1 of the picture). The source moves with the brush.
	Points [][]float64 `json:"points"`
	Source *[2]float64 `json:"source"`
	// Size in percent of the shorter edge (0.05..50), Hardness and Opacity
	// 0..100 (hardness 50 and opacity 100 when absent).
	Brush    float64  `json:"size"`
	Hardness *float64 `json:"hardness,omitempty"`
	Opacity  *float64 `json:"opacity,omitempty"`

	hardness, opacity float64
}

func validPath(points [][]float64) error {
	if len(points) < 1 || len(points) > MaxStrokePoints {
		return invalid("a stroke has 1..%d points", MaxStrokePoints)
	}
	for _, p := range points {
		if len(p) < 2 || len(p) > 3 || !inRange(p[0], -1, 2) || !inRange(p[1], -1, 2) || (len(p) == 3 && !inRange(p[2], 0, 1)) {
			return invalid("a point is [x, y] or [x, y, pressure] within -1..2")
		}
	}
	return nil
}

func parseClone(raw json.RawMessage) (Step, error) {
	s := &cloneStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if err := validPath(s.Points); err != nil {
		return nil, err
	}
	s.hardness, s.opacity = 50, 100
	if s.Hardness != nil {
		s.hardness = *s.Hardness
	}
	if s.Opacity != nil {
		s.opacity = *s.Opacity
	}
	if s.Source == nil {
		return nil, invalid("clone: a stroke needs a source")
	}
	if !inRange(s.Brush, 0.05, 50) || !inRange(s.hardness, 0, 100) || !inRange(s.opacity, 0, 100) ||
		!inRange(s.Source[0], -1, 2) || !inRange(s.Source[1], -1, 2) {
		return nil, invalid("clone: size 0.05..50, hardness and opacity 0..100, source within -1..2")
	}
	return s, nil
}

func (s *cloneStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	if s.opacity == 0 {
		return img, nil
	}
	img = toRGBA(img)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	radius := math.Max(s.Brush/100*shortEdge(env)/2, 0.5)
	m, err := capsuleMask(ctx, pathCapsules(s.Points, w, h, radius), w, h, s.hardness/100)
	if err != nil {
		return nil, err
	}
	if m.box.Empty() {
		return img, nil
	}
	// Whole pixels: a copy, not a resampling.
	ox := int(math.Round((s.Source[0] - s.Points[0][0]) * float64(w)))
	oy := int(math.Round((s.Source[1] - s.Points[0][1]) * float64(h)))
	a := int32(math.Round(s.opacity / 100 * 256))
	dst, err := copyRGBA(ctx, img)
	if err != nil {
		return nil, err
	}
	box := m.box
	err = Rows(ctx, box.Dx(), box.Dy(), func(ya, yb int) {
		for y := ya + box.Min.Y; y < yb+box.Min.Y; y++ {
			sy := clampInt(y+oy, 0, h-1)
			for x := box.Min.X; x < box.Max.X; x++ {
				cov := int32(m.at(x, y)) * a / 255
				if cov == 0 {
					continue
				}
				so := sy*img.Stride + clampInt(x+ox, 0, w-1)*4
				mixPix(dst.Pix[y*dst.Stride+x*4:y*dst.Stride+x*4+4], img.Pix[so:so+4], cov)
			}
		}
	})
	return dst, err
}

// --- heal ---

// maxHealPixels bounds the area one heal stroke works on.
const maxHealPixels = 2048 * 2048

type healStep struct {
	sameSize
	// Mode: "spot" finds clean texture nearby by itself; "brush" copies
	// from Source like the clone tool. Both blend the copy into the tones
	// around the stroke.
	Mode   string      `json:"mode,omitempty"`
	Points [][]float64 `json:"points"`
	Source *[2]float64 `json:"source,omitempty"`
	// Size in percent of the shorter edge (0.05..50).
	Brush float64 `json:"size"`
}

func parseHeal(raw json.RawMessage) (Step, error) {
	s := &healStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	switch s.Mode {
	case "":
		s.Mode = "spot"
		fallthrough
	case "spot":
		if s.Source != nil {
			return nil, invalid("heal: a spot finds its own source")
		}
	case "brush":
		if s.Source == nil || !inRange(s.Source[0], -1, 2) || !inRange(s.Source[1], -1, 2) {
			return nil, invalid("heal: the brush needs a source within -1..2")
		}
	default:
		return nil, invalid("heal mode %q", s.Mode)
	}
	if err := validPath(s.Points); err != nil {
		return nil, err
	}
	if !inRange(s.Brush, 0.05, 50) {
		return nil, invalid("heal: size is 0.05..50 percent")
	}
	return s, nil
}

// blurFloat blurs a float plane in place with three box passes.
func blurFloat(ctx context.Context, plane []float32, w, h int, sigma float64) error {
	tmp := make([]float32, len(plane))
	line := func(src, dst []float32, step, n, r int) {
		win := float32(2*r + 1)
		var sum float32
		for i := -r; i <= r; i++ {
			sum += src[clampInt(i, 0, n-1)*step]
		}
		for i := range n {
			dst[i*step] = sum / win
			sum += src[clampInt(i+r+1, 0, n-1)*step] - src[clampInt(i-r, 0, n-1)*step]
		}
	}
	for _, r := range boxRadii(math.Max(sigma, 1)) {
		r := max(r, 1)
		if err := Rows(ctx, w, h, func(y0, y1 int) {
			for y := y0; y < y1; y++ {
				line(plane[y*w:y*w+w], tmp[y*w:y*w+w], 1, w, r)
			}
		}); err != nil {
			return err
		}
		if err := Rows(ctx, h, w, func(x0, x1 int) {
			for x := x0; x < x1; x++ {
				line(tmp[x:], plane[x:], w, h, r)
			}
		}); err != nil {
			return err
		}
	}
	return ctx.Err()
}

// spotSource picks where a spot heal copies from: among offsets around the
// stroke, the one whose surroundings look most like the stroke's own. The
// ring just outside the mask is compared with the same ring at the offset.
func spotSource(img *image.RGBA, m *strokeMask, radius float64) (int, int) {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	box := m.box
	ring := int(math.Max(radius*0.6, 3))
	grown := image.Rect(box.Min.X-ring, box.Min.Y-ring, box.Max.X+ring, box.Max.Y+ring).Intersect(img.Rect)
	// Ring pixels: around the mask, not in it; every other pixel is enough.
	type pt struct{ x, y int }
	var samples []pt
	for y := grown.Min.Y; y < grown.Max.Y; y += 2 {
		for x := grown.Min.X; x < grown.Max.X; x += 2 {
			if m.at(x, y) == 0 {
				samples = append(samples, pt{x, y})
			}
		}
	}
	if len(samples) == 0 {
		return int(2 * radius), 0
	}
	halfW, halfH := float64(box.Dx())/2, float64(box.Dy())/2
	bestX, bestY, best := 0, 0, math.Inf(1)
	for _, k := range [3]float64{1.25, 1.9, 2.8} {
		for dir := range 16 {
			sin, cos := math.Sincos(float64(dir) * math.Pi / 8)
			// Far enough that the copy does not overlap the stroke.
			reach := (math.Abs(cos)*halfW+math.Abs(sin)*halfH)*2 + radius
			ox, oy := int(math.Round(cos*reach*k)), int(math.Round(sin*reach*k))
			if (ox == 0 && oy == 0) || (absInt(ox) < box.Dx() && absInt(oy) < box.Dy()) {
				continue
			}
			var sum float64
			outside := 0
			for _, p := range samples {
				sx, sy := p.x+ox, p.y+oy
				if sx < 0 || sy < 0 || sx >= w || sy >= h {
					outside++
					continue
				}
				a := img.Pix[p.y*img.Stride+p.x*4:]
				b := img.Pix[sy*img.Stride+sx*4:]
				for c := range 3 {
					d := float64(a[c]) - float64(b[c])
					sum += d * d
				}
			}
			// A source that leaves the picture is no source.
			if outside*4 > len(samples) {
				continue
			}
			if score := sum / float64(len(samples)-outside); score < best {
				bestX, bestY, best = ox, oy, score
			}
		}
	}
	if math.IsInf(best, 1) {
		return int(2 * radius), 0
	}
	return bestX, bestY
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// Apply copies texture from the source and corrects its tone: the
// difference between the picture and the copy, taken around the stroke and
// spread smoothly across it, is added to the copy. So the texture is the
// source's and the light is the surroundings'.
func (s *healStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	img = toRGBA(img)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	radius := math.Max(s.Brush/100*shortEdge(env)/2, 1)
	m, err := capsuleMask(ctx, pathCapsules(s.Points, w, h, radius), w, h, 0.6)
	if err != nil {
		return nil, err
	}
	if m.box.Empty() {
		return img, nil
	}
	var ox, oy int
	if s.Mode == "brush" {
		ox = int(math.Round((s.Source[0] - s.Points[0][0]) * float64(w)))
		oy = int(math.Round((s.Source[1] - s.Points[0][1]) * float64(h)))
	} else {
		ox, oy = spotSource(img, m, radius)
	}
	// The stroke with room around it for the surroundings' tone.
	pad := int(math.Ceil(radius*1.5)) + 2
	box := image.Rect(m.box.Min.X-pad, m.box.Min.Y-pad, m.box.Max.X+pad, m.box.Max.Y+pad).Intersect(img.Rect)
	bw, bh := box.Dx(), box.Dy()
	if bw*bh > maxHealPixels {
		return nil, invalid("heal: the stroke covers too much at once; use shorter strokes")
	}
	// The weight of a pixel as surroundings, and per channel the weighted
	// difference between the picture and the copy.
	weight := make([]float32, bw*bh)
	var diff [3][]float32
	for c := range diff {
		diff[c] = make([]float32, bw*bh)
	}
	source := func(x, y int) []uint8 {
		so := clampInt(y+oy, 0, h-1)*img.Stride + clampInt(x+ox, 0, w-1)*4
		return img.Pix[so : so+4]
	}
	if err := Rows(ctx, bw, bh, func(ya, yb int) {
		for y := ya; y < yb; y++ {
			for x := range bw {
				px, py := x+box.Min.X, y+box.Min.Y
				wgt := float32(255-m.at(px, py)) / 255
				weight[y*bw+x] = wgt
				if wgt == 0 {
					continue
				}
				here := img.Pix[py*img.Stride+px*4:]
				there := source(px, py)
				for c := range 3 {
					diff[c][y*bw+x] = (float32(here[c]) - float32(there[c])) * wgt
				}
			}
		}
	}); err != nil {
		return nil, err
	}
	sigma := math.Max(radius*0.6, 1.5)
	if err := blurFloat(ctx, weight, bw, bh, sigma); err != nil {
		return nil, err
	}
	for c := range diff {
		if err := blurFloat(ctx, diff[c], bw, bh, sigma); err != nil {
			return nil, err
		}
	}
	dst, err := copyRGBA(ctx, img)
	if err != nil {
		return nil, err
	}
	err = Rows(ctx, m.box.Dx(), m.box.Dy(), func(ya, yb int) {
		for y := ya + m.box.Min.Y; y < yb+m.box.Min.Y; y++ {
			for x := m.box.Min.X; x < m.box.Max.X; x++ {
				cov := int32(m.at(x, y)) * 256 / 255
				if cov == 0 {
					continue
				}
				i := (y-box.Min.Y)*bw + x - box.Min.X
				there := source(x, y)
				o := dst.Pix[y*dst.Stride+x*4 : y*dst.Stride+x*4+4]
				alpha := o[3]
				var healed [4]uint8
				for c := range 3 {
					v := float32(there[c])
					if weight[i] > 1e-3 {
						v += diff[c][i] / weight[i]
					}
					healed[c] = uint8(min(max(v+0.5, 0), float32(alpha)))
				}
				healed[3] = alpha
				mixPix(o, healed[:], cov)
			}
		}
	})
	return dst, err
}

// --- red-eye ---

type redEyeStep struct {
	sameSize
	// Rect is the eye, 0..1 of the picture; with Auto the eyes are found in
	// the picture instead (for other pictures than the one it was set on).
	Rect *Rect `json:"rect,omitempty"`
	Auto bool  `json:"auto,omitempty"`
	// Strength 0..100 (100 when absent); Pupil -50..50 makes the corrected
	// area smaller or larger.
	Strength *float64 `json:"strength,omitempty"`
	Pupil    float64  `json:"pupil,omitempty"`

	strength float64
}

func parseRedEye(raw json.RawMessage) (Step, error) {
	s := &redEyeStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if s.Auto == (s.Rect != nil) {
		return nil, invalid("red-eye: either a rect or auto")
	}
	if s.Rect != nil {
		r := *s.Rect
		if !(r.W > 0 && r.H > 0) || !inRange(r.X, -1, 2) || !inRange(r.Y, -1, 2) || r.W > 1 || r.H > 1 {
			return nil, invalid("red-eye: the eye is outside the picture")
		}
	}
	s.strength = 100
	if s.Strength != nil {
		s.strength = *s.Strength
	}
	if !inRange(s.strength, 0, 100) || !inRange(s.Pupil, -50, 50) {
		return nil, invalid("red-eye: strength 0..100, pupil -50..50")
	}
	return s, nil
}

// redness says how much a pixel is the red of a lit retina, 0..1: red well
// above green and blue, and not dark. bias moves the bar (-0.5..0.5).
func redness(r, g, b uint8, bias float64) float64 {
	hi := float64(max(g, b))
	ratio := float64(r) / (hi + 8)
	return smooth((ratio-(1.75-0.6*bias))/0.5) * smooth((float64(r)-55)/50)
}

// fixEye takes the red out of the pupil inside box (working pixels): red
// falls to the level of green and blue, a little darker; a catchlight (bright
// in every channel) stays.
func fixEye(ctx context.Context, src, dst *image.RGBA, box image.Rectangle, strength, pupil float64, soften float64) error {
	box = box.Intersect(src.Rect)
	if box.Empty() || strength == 0 {
		return ctx.Err()
	}
	bw, bh := box.Dx(), box.Dy()
	mask := make([]uint8, bw*bh)
	cx, cy := float64(bw)/2, float64(bh)/2
	for y := range bh {
		p := src.Pix[(y+box.Min.Y)*src.Stride+box.Min.X*4:]
		for x := range bw {
			a := p[x*4+3]
			if a == 0 {
				continue
			}
			r, g, b := plain(p[x*4], a), plain(p[x*4+1], a), plain(p[x*4+2], a)
			if min(r, g, b) > 190 {
				continue // the catchlight
			}
			// Only inside the ellipse of the box, fading at its rim.
			in := clamp01(-sdEllipse(float64(x)+0.5, float64(y)+0.5, cx, cy, cx, cy)/2 + 0.5)
			mask[y*bw+x] = uint8(redness(r, g, b, pupil/100)*in*255 + 0.5)
		}
	}
	if err := blurPlane(ctx, mask, bw, bh, soften); err != nil {
		return err
	}
	k := strength / 100
	catchlight := func(p []uint8) bool {
		return p[3] != 0 && min(plain(p[0], p[3]), plain(p[1], p[3]), plain(p[2], p[3])) > 190
	}
	for y := range bh {
		s := src.Pix[(y+box.Min.Y)*src.Stride+box.Min.X*4:]
		d := dst.Pix[(y+box.Min.Y)*dst.Stride+box.Min.X*4:]
		for x := range bw {
			q := float64(mask[y*bw+x]) / 255 * k
			// The softened mask must not reach into the catchlight.
			if q == 0 || catchlight(s[x*4:x*4+4]) {
				continue
			}
			a := s[x*4+3]
			r, g, b := float64(plain(s[x*4], a)), float64(plain(s[x*4+1], a)), float64(plain(s[x*4+2], a))
			// The pupil: as dark as its green and blue, a little darker still.
			tone := (g + b) / 2 * 0.8
			out := [3]float64{r + (tone-r)*q, g * (1 - 0.1*q), b * (1 - 0.1*q)}
			for c := range 3 {
				d[x*4+c] = mul(uint8(math.Min(math.Max(out[c]+0.5, 0), 255)), a)
			}
		}
	}
	return ctx.Err()
}

func (s *redEyeStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	if s.strength == 0 {
		return img, nil
	}
	img = toRGBA(img)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	eyes := []Rect{}
	if s.Auto {
		var err error
		if eyes, err = DetectEyes(ctx, img); err != nil {
			return nil, err
		}
	} else {
		eyes = append(eyes, *s.Rect)
	}
	if len(eyes) == 0 {
		return img, nil
	}
	dst, err := copyRGBA(ctx, img)
	if err != nil {
		return nil, err
	}
	soften := math.Max(0.003*shortEdge(env), 0.6)
	for _, e := range eyes {
		box := image.Rect(int(math.Floor(e.X*float64(w))), int(math.Floor(e.Y*float64(h))),
			int(math.Ceil((e.X+e.W)*float64(w))), int(math.Ceil((e.Y+e.H)*float64(h))))
		if err := fixEye(ctx, img, dst, box, s.strength, s.Pupil, soften); err != nil {
			return nil, err
		}
	}
	return dst, nil
}

// MaxEyes bounds what a detection reports.
const MaxEyes = 32

// DetectEyes finds red pupils that come in pairs: two red, roughly round
// blobs of similar size, side by side at a distance eyes have. A single red
// blob (a light, a berry, a button) is left alone. The rects are 0..1 of the
// picture, each a little larger than its pupil.
func DetectEyes(ctx context.Context, img *image.RGBA) ([]Rect, error) {
	img = toRGBA(img)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	short := float64(min(w, h))
	// Candidates: clearly red and lit.
	red := make([]bool, w*h)
	if err := Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			p := img.Pix[y*img.Stride : y*img.Stride+w*4]
			for x := range w {
				a := p[x*4+3]
				if a < 128 {
					continue
				}
				r, g, b := plain(p[x*4], a), plain(p[x*4+1], a), plain(p[x*4+2], a)
				red[y*w+x] = float64(r) > 1.8*float64(max(g, b)) && r >= 80
			}
		}
	}); err != nil {
		return nil, err
	}
	type blob struct {
		x0, y0, x1, y1, area int
		used                 bool
	}
	minD, maxD := math.Max(3, 0.004*short), 0.08*short
	var blobs []blob
	seen := make([]bool, w*h)
	var stack []int
	for start := range red {
		if !red[start] || seen[start] {
			continue
		}
		if start&4095 == 0 && ctx.Err() != nil {
			return nil, ctx.Err()
		}
		b := blob{x0: w, y0: h}
		stack = append(stack[:0], start)
		seen[start] = true
		for len(stack) > 0 {
			i := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			x, y := i%w, i/w
			b.x0, b.y0, b.x1, b.y1 = min(b.x0, x), min(b.y0, y), max(b.x1, x), max(b.y1, y)
			b.area++
			for _, n := range [4]int{i - 1, i + 1, i - w, i + w} {
				if n < 0 || n >= w*h || seen[n] || !red[n] {
					continue
				}
				// No wrapping from one row's end to the next row's start.
				if (n == i-1 && x == 0) || (n == i+1 && x == w-1) {
					continue
				}
				seen[n] = true
				stack = append(stack, n)
			}
		}
		bw, bh := float64(b.x1-b.x0+1), float64(b.y1-b.y0+1)
		if bw < minD || bh < minD || bw > maxD || bh > maxD {
			continue
		}
		// Round: about as wide as high, and filling its box like a disc does.
		if ratio := bw / bh; ratio < 0.6 || ratio > 1.67 {
			continue
		}
		if float64(b.area) < 0.55*math.Pi/4*bw*bh {
			continue
		}
		blobs = append(blobs, b)
		if len(blobs) > 4096 {
			break
		}
	}
	// Pairs: similar size, level, and apart like eyes are.
	var eyes []Rect
	add := func(b blob) {
		bw, bh := float64(b.x1-b.x0+1), float64(b.y1-b.y0+1)
		cx, cy := float64(b.x0)+bw/2, float64(b.y0)+bh/2
		eyes = append(eyes, Rect{X: (cx - bw*0.9) / float64(w), Y: (cy - bh*0.9) / float64(h),
			W: bw * 1.8 / float64(w), H: bh * 1.8 / float64(h)})
	}
	for i := range blobs {
		if blobs[i].used {
			continue
		}
		a := blobs[i]
		ad := float64(a.x1-a.x0+a.y1-a.y0+2) / 2
		best, bestScore := -1, math.Inf(1)
		for j := i + 1; j < len(blobs); j++ {
			if blobs[j].used {
				continue
			}
			b := blobs[j]
			bd := float64(b.x1-b.x0+b.y1-b.y0+2) / 2
			size := math.Max(ad, bd) / math.Min(ad, bd)
			dx := float64(b.x0+b.x1-a.x0-a.x1) / 2
			dy := float64(b.y0+b.y1-a.y0-a.y1) / 2
			dist := math.Hypot(dx, dy)
			mean := (ad + bd) / 2
			// Eyes are about ten pupil widths apart.
			if size > 1.7 || dist < 4*mean || dist > 18*mean || math.Abs(dy) > 0.35*dist {
				continue
			}
			if score := size + math.Abs(dy)/dist; score < bestScore {
				best, bestScore = j, score
			}
		}
		if best >= 0 && len(eyes)+2 <= MaxEyes {
			blobs[i].used, blobs[best].used = true, true
			add(a)
			add(blobs[best])
		}
	}
	return eyes, ctx.Err()
}
