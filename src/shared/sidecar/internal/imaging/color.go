package imaging

import (
	"context"
	"encoding/json"
	"image"
	"image/color"
	"math"
	"sort"
)

// The tone and color operations of the editor (Stage 13): lighting, colors,
// levels, curves, grayscale, sepia, negative, swapChannels and replaceColor.
// All are per-pixel (see point.go) and batch-capable. Parameters at their
// defaults change nothing: such a step has no stages and returns its input.

func init() {
	point := func(parse func(json.RawMessage) (pointStep, error)) OpInfo {
		return OpInfo{Version: 1, Batchable: true, Parse: func(raw json.RawMessage) (Step, error) {
			s, err := parse(raw)
			if err != nil {
				return nil, err
			}
			return s, nil
		}}
	}
	RegisterOp("lighting", point(parseLighting))
	RegisterOp("colors", point(parseColors))
	RegisterOp("levels", point(parseLevels))
	RegisterOp("curves", point(parseCurves))
	RegisterOp("grayscale", point(parseGrayscale))
	RegisterOp("sepia", point(parseSepia))
	RegisterOp("negative", point(parseNegative))
	RegisterOp("swapChannels", point(parseSwapChannels))
	RegisterOp("replaceColor", point(parseReplaceColor))
}

func inRange(v, lo, hi float64) bool { return v >= lo && v <= hi }

func to8(x float64) uint8 {
	return uint8(math.Round(math.Min(math.Max(x, 0), 1) * 255))
}

// curveLUT builds a table from a function of 0..1.
func curveLUT(f func(x float64) float64) *[256]uint8 {
	var t [256]uint8
	for v := range 256 {
		t[v] = to8(f(float64(v) / 255))
	}
	return &t
}

// --- lighting ---

type lightingStep struct {
	pointBase
	// Exposure in stops (-3..3); the others are -100..100, 0 = unchanged.
	Exposure   float64 `json:"exposure,omitempty"`
	Brightness float64 `json:"brightness,omitempty"`
	Contrast   float64 `json:"contrast,omitempty"`
	// Gamma 0.1..5; 0 or 1 = unchanged.
	Gamma      float64 `json:"gamma,omitempty"`
	Highlights float64 `json:"highlights,omitempty"`
	Shadows    float64 `json:"shadows,omitempty"`
	Whites     float64 `json:"whites,omitempty"`
	Blacks     float64 `json:"blacks,omitempty"`
}

func parseLighting(raw json.RawMessage) (pointStep, error) {
	s := &lightingStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if s.Gamma == 0 {
		s.Gamma = 1
	}
	if !inRange(s.Exposure, -3, 3) || !inRange(s.Gamma, 0.1, 5) {
		return nil, invalid("lighting: exposure is -3..3 stops, gamma 0.1..5")
	}
	for _, v := range []float64{s.Brightness, s.Contrast, s.Highlights, s.Shadows, s.Whites, s.Blacks} {
		if !inRange(v, -100, 100) {
			return nil, invalid("lighting values are -100..100")
		}
	}
	return s, nil
}

func (s *lightingStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	return applyPointStep(ctx, s, img, env)
}

// tone is the lighting curve of 0..1. The order is the one a photographer
// works in: exposure, the ends of the range, the shadow and highlight
// regions, then brightness, contrast and gamma over everything.
func (s *lightingStep) tone(x float64) float64 {
	x *= math.Pow(2, s.Exposure)
	lo := -s.Blacks / 100 * 0.2
	hi := 1 - s.Whites/100*0.2
	x = (x - lo) / (hi - lo)
	c := math.Min(math.Max(x, 0), 1)
	// Regions: shadows peak near a quarter, highlights near three quarters.
	x += s.Shadows / 100 * 0.6 * c * (1 - c) * (1 - c) * 2.5
	x += s.Highlights / 100 * 0.6 * c * c * (1 - c) * 2.5
	x += s.Brightness / 100 * 0.4
	k := 1 + s.Contrast/100
	if s.Contrast > 0 {
		k = 1 + s.Contrast/100*1.5
	}
	x = (x-0.5)*k + 0.5
	if s.Gamma != 1 {
		x = math.Pow(math.Min(math.Max(x, 0), 1), 1/s.Gamma)
	}
	return x
}

func (s *lightingStep) Stages(context.Context, *image.RGBA, *Env) ([]pointStage, error) {
	if *s == (lightingStep{Gamma: 1}) {
		return nil, nil
	}
	return []pointStage{sameLUT(curveLUT(s.tone))}, nil
}

// --- colors ---

// Balance shifts a tonal region towards red, green or blue (-100..100 each).
type Balance struct {
	Shadows    [3]float64 `json:"shadows"`
	Midtones   [3]float64 `json:"midtones"`
	Highlights [3]float64 `json:"highlights"`
}

type colorsStep struct {
	pointBase
	Saturation  float64  `json:"saturation,omitempty"`
	Vibrance    float64  `json:"vibrance,omitempty"`
	Hue         float64  `json:"hue,omitempty"` // degrees, -180..180
	Temperature float64  `json:"temperature,omitempty"`
	Tint        float64  `json:"tint,omitempty"`
	Balance     *Balance `json:"balance,omitempty"`
}

func parseColors(raw json.RawMessage) (pointStep, error) {
	s := &colorsStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if !inRange(s.Hue, -180, 180) {
		return nil, invalid("hue is -180..180 degrees")
	}
	vals := []float64{s.Saturation, s.Vibrance, s.Temperature, s.Tint}
	if b := s.Balance; b != nil {
		vals = append(append(append(vals, b.Shadows[:]...), b.Midtones[:]...), b.Highlights[:]...)
	}
	for _, v := range vals {
		if !inRange(v, -100, 100) {
			return nil, invalid("color values are -100..100")
		}
	}
	return s, nil
}

func (s *colorsStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	return applyPointStep(ctx, s, img, env)
}

func (s *colorsStep) Stages(context.Context, *image.RGBA, *Env) ([]pointStage, error) {
	var stages []pointStage
	// White balance and color balance are per-channel curves.
	if s.Temperature != 0 || s.Tint != 0 || s.Balance != nil {
		t, ti := s.Temperature/100*0.3, s.Tint/100*0.3
		gains := [3]float64{1 + t, 1 - ti, 1 - t}
		var l [3][256]uint8
		for c := range 3 {
			l[c] = *curveLUT(func(x float64) float64 {
				y := x * gains[c]
				if b := s.Balance; b != nil {
					y += b.Shadows[c] / 100 * 0.25 * (1 - x) * (1 - x)
					y += b.Midtones[c] / 100 * 0.25 * 4 * x * (1 - x)
					y += b.Highlights[c] / 100 * 0.25 * x * x
				}
				return y
			})
		}
		stages = append(stages, lutStage(&l))
	}
	// Hue turns colors around the gray axis; saturation scales their
	// distance from it. Both are one matrix.
	if s.Hue != 0 || s.Saturation != 0 {
		stages = append(stages, matrixStage(hueSatMatrix(s.Hue, 1+s.Saturation/100)))
	}
	// Vibrance saturates the dull colors more than the vivid ones.
	if s.Vibrance != 0 {
		amount := s.Vibrance / 100
		stages = append(stages, pointStage{kind: stageFunc, fn: func(r, g, b uint8) (uint8, uint8, uint8) {
			mx, mn := max(r, g, b), min(r, g, b)
			k := int32(math.Round(amount * float64(255-int32(mx-mn)) / 255 * 256))
			if k == 0 {
				return r, g, b
			}
			l := int32(Luma(r, g, b))
			return clampByte(l + (int32(r)-l)*(256+k)/256), clampByte(l + (int32(g)-l)*(256+k)/256), clampByte(l + (int32(b)-l)*(256+k)/256)
		}})
	}
	return stages, nil
}

// hueSatMatrix turns hue by deg and scales saturation by sat, keeping
// luminance: L + sat·(cos·(I−L) + sin·S), where L projects a color onto
// gray and S is the skew that turns colors around the gray axis.
func hueSatMatrix(deg, sat float64) [3][4]float64 {
	sin, cos := math.Sincos(deg * math.Pi / 180)
	lum := [3]float64{0.213, 0.715, 0.072}
	skew := [3][3]float64{
		{-0.213, -0.715, 0.928},
		{0.143, 0.140, -0.283},
		{-0.787, 0.715, 0.072},
	}
	var m [3][4]float64
	for r := range 3 {
		for c := range 3 {
			rot := -lum[c]
			if r == c {
				rot++
			}
			m[r][c] = lum[c] + sat*(cos*rot+sin*skew[r][c])
		}
	}
	return m
}

// --- levels ---

// LevelsChannel maps an input range to an output range with a midtone gamma.
type LevelsChannel struct {
	InBlack  float64 `json:"inBlack"`
	InWhite  float64 `json:"inWhite"`
	Gamma    float64 `json:"gamma,omitempty"`
	OutBlack float64 `json:"outBlack"`
	OutWhite float64 `json:"outWhite"`
}

// LevelsAuto sets the input range from the picture: Clip percent of the
// pixels may be cut off at each end; "rgb" does it per channel (which also
// removes a color cast), "lum" for all three together. With Gamma the
// midtones are brought towards the middle.
type LevelsAuto struct {
	Clip  float64 `json:"clip"`
	Mode  string  `json:"mode"`
	Gamma bool    `json:"gamma,omitempty"`
}

type levelsStep struct {
	pointBase
	// L applies to all three channels, then R, G and B to their own.
	L    *LevelsChannel `json:"l,omitempty"`
	R    *LevelsChannel `json:"r,omitempty"`
	G    *LevelsChannel `json:"g,omitempty"`
	B    *LevelsChannel `json:"b,omitempty"`
	Auto *LevelsAuto    `json:"auto,omitempty"`
}

func parseLevels(raw json.RawMessage) (pointStep, error) {
	s := &levelsStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	for _, c := range []*LevelsChannel{s.L, s.R, s.G, s.B} {
		if c == nil {
			continue
		}
		if c.Gamma == 0 {
			c.Gamma = 1
		}
		if !inRange(c.InBlack, 0, 254) || !inRange(c.InWhite, 1, 255) || c.InWhite <= c.InBlack ||
			!inRange(c.Gamma, 0.1, 9.99) || !inRange(c.OutBlack, 0, 255) || !inRange(c.OutWhite, 0, 255) {
			return nil, invalid("levels are 0..255 with black below white, gamma 0.1..9.99")
		}
	}
	if a := s.Auto; a != nil {
		if !inRange(a.Clip, 0, 5) || (a.Mode != "rgb" && a.Mode != "lum") {
			return nil, invalid("auto levels clip 0..5 percent, per rgb or lum")
		}
	}
	return s, nil
}

func (s *levelsStep) NeedsInput() bool { return s.Auto != nil }

func (s *levelsStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	return applyPointStep(ctx, s, img, env)
}

func (c LevelsChannel) identity() bool {
	return c.InBlack == 0 && c.InWhite == 255 && c.Gamma == 1 && c.OutBlack == 0 && c.OutWhite == 255
}

func (c LevelsChannel) lut() *[256]uint8 {
	return curveLUT(func(x float64) float64 {
		v := (x*255 - c.InBlack) / (c.InWhite - c.InBlack)
		v = math.Pow(math.Min(math.Max(v, 0), 1), 1/c.Gamma)
		return (c.OutBlack + v*(c.OutWhite-c.OutBlack)) / 255
	})
}

// AutoLevels derives the input ranges from a histogram (see LevelsAuto).
// It returns the channel for all three ("lum") or one per channel ("rgb").
func AutoLevels(h *Stats, a LevelsAuto) (l *LevelsChannel, rgb [3]*LevelsChannel) {
	ends := func(bins *[256]uint32) (float64, float64) {
		var total uint64
		for _, n := range bins {
			total += uint64(n)
		}
		cut := uint64(float64(total) * a.Clip / 100)
		lo, hi := 0, 255
		for acc := uint64(0); lo < 254; lo++ {
			if acc += uint64(bins[lo]); acc > cut {
				break
			}
		}
		for acc := uint64(0); hi > lo+1; hi-- {
			if acc += uint64(bins[hi]); acc > cut {
				break
			}
		}
		return float64(lo), float64(hi)
	}
	channel := func(bins *[256]uint32) *LevelsChannel {
		lo, hi := ends(bins)
		c := &LevelsChannel{InBlack: lo, InWhite: hi, Gamma: 1, OutBlack: 0, OutWhite: 255}
		if a.Gamma {
			// The median of the stretched range goes to the middle, gently.
			var total, acc uint64
			for v := int(lo); v <= int(hi); v++ {
				total += uint64(bins[v])
			}
			median := lo
			for v := int(lo); v <= int(hi); v++ {
				if acc += uint64(bins[v]); acc*2 >= total {
					median = float64(v)
					break
				}
			}
			if m := (median - lo) / (hi - lo); m > 0.02 && m < 0.98 {
				g := math.Log(m) / math.Log(0.5)
				c.Gamma = math.Round(math.Min(math.Max(g, 0.6), 1.6)*100) / 100
			}
		}
		return c
	}
	if a.Mode == "lum" {
		return channel(&h.Lum), rgb
	}
	return nil, [3]*LevelsChannel{channel(&h.R), channel(&h.G), channel(&h.B)}
}

func (s *levelsStep) Stages(ctx context.Context, img *image.RGBA, _ *Env) ([]pointStage, error) {
	l, rgb := s.L, [3]*LevelsChannel{s.R, s.G, s.B}
	if s.Auto != nil {
		stats, err := Histogram(ctx, img)
		if err != nil {
			return nil, err
		}
		l, rgb = AutoLevels(&stats, *s.Auto)
	}
	var t [3][256]uint8
	for c := range 3 {
		for v := range 256 {
			t[c][v] = uint8(v)
		}
	}
	if l != nil && !l.identity() {
		one := l.lut()
		t = [3][256]uint8{*one, *one, *one}
	}
	for c, ch := range rgb {
		if ch != nil && !ch.identity() {
			one := ch.lut()
			for v := range 256 {
				t[c][v] = one[t[c][v]]
			}
		}
	}
	if identityLUT(&t) {
		return nil, nil
	}
	return []pointStage{lutStage(&t)}, nil
}

// --- curves ---

// MaxCurvePoints bounds the control points of one curve.
const MaxCurvePoints = 16

type curvesStep struct {
	pointBase
	// Each curve is 2..16 points [in, out] in 0..255 with rising in.
	L [][2]float64 `json:"l,omitempty"`
	R [][2]float64 `json:"r,omitempty"`
	G [][2]float64 `json:"g,omitempty"`
	B [][2]float64 `json:"b,omitempty"`
}

func parseCurves(raw json.RawMessage) (pointStep, error) {
	s := &curvesStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	for _, pts := range [][][2]float64{s.L, s.R, s.G, s.B} {
		if pts == nil {
			continue
		}
		if len(pts) < 2 || len(pts) > MaxCurvePoints {
			return nil, invalid("a curve has 2..%d points", MaxCurvePoints)
		}
		for i, p := range pts {
			if !inRange(p[0], 0, 255) || !inRange(p[1], 0, 255) || (i > 0 && p[0] <= pts[i-1][0]) {
				return nil, invalid("curve points are 0..255 with rising input values")
			}
		}
	}
	return s, nil
}

func (s *curvesStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	return applyPointStep(ctx, s, img, env)
}

// CurveLUT interpolates control points with a monotone cubic (PCHIP,
// Fritsch–Carlson): the curve passes through every point and never
// overshoots between two of them. Before the first and after the last point
// it is flat.
func CurveLUT(pts [][2]float64) *[256]uint8 {
	n := len(pts)
	var t [256]uint8
	if n < 2 {
		for v := range t {
			t[v] = uint8(v)
		}
		return &t
	}
	// Secant slopes, then tangents limited so each interval stays monotone.
	d := make([]float64, n-1)
	for i := range d {
		d[i] = (pts[i+1][1] - pts[i][1]) / (pts[i+1][0] - pts[i][0])
	}
	m := make([]float64, n)
	m[0], m[n-1] = d[0], d[n-2]
	for i := 1; i < n-1; i++ {
		if d[i-1]*d[i] <= 0 {
			m[i] = 0
			continue
		}
		// Weighted harmonic mean of the neighbouring slopes.
		h0, h1 := pts[i][0]-pts[i-1][0], pts[i+1][0]-pts[i][0]
		w0, w1 := 2*h1+h0, h1+2*h0
		m[i] = (w0 + w1) / (w0/d[i-1] + w1/d[i])
	}
	for i := range d {
		if d[i] == 0 {
			m[i], m[i+1] = 0, 0
			continue
		}
		a, b := m[i]/d[i], m[i+1]/d[i]
		if s := a*a + b*b; s > 9 {
			k := 3 / math.Sqrt(s)
			m[i], m[i+1] = k*a*d[i], k*b*d[i]
		}
	}
	seg := 0
	for v := range t {
		x := float64(v)
		switch {
		case x <= pts[0][0]:
			t[v] = to8(pts[0][1] / 255)
			continue
		case x >= pts[n-1][0]:
			t[v] = to8(pts[n-1][1] / 255)
			continue
		}
		for x > pts[seg+1][0] {
			seg++
		}
		h := pts[seg+1][0] - pts[seg][0]
		u := (x - pts[seg][0]) / h
		u2, u3 := u*u, u*u*u
		y := (2*u3-3*u2+1)*pts[seg][1] + (u3-2*u2+u)*h*m[seg] + (-2*u3+3*u2)*pts[seg+1][1] + (u3-u2)*h*m[seg+1]
		t[v] = to8(y / 255)
	}
	return &t
}

func (s *curvesStep) Stages(context.Context, *image.RGBA, *Env) ([]pointStage, error) {
	var t [3][256]uint8
	for c := range 3 {
		for v := range 256 {
			t[c][v] = uint8(v)
		}
	}
	if s.L != nil {
		one := CurveLUT(s.L)
		t = [3][256]uint8{*one, *one, *one}
	}
	for c, pts := range [][][2]float64{s.R, s.G, s.B} {
		if pts != nil {
			one := CurveLUT(pts)
			for v := range 256 {
				t[c][v] = one[t[c][v]]
			}
		}
	}
	if identityLUT(&t) {
		return nil, nil
	}
	return []pointStage{lutStage(&t)}, nil
}

// --- grayscale, sepia, negative, swapChannels ---

type grayscaleStep struct {
	pointBase
	// Method: "luminance" (Rec. 709), "average", "desaturate" (the middle of
	// the largest and smallest channel) or "mixer" (Mix percent of R, G, B).
	Method string      `json:"method,omitempty"`
	Mix    *[3]float64 `json:"mix,omitempty"`
}

func parseGrayscale(raw json.RawMessage) (pointStep, error) {
	s := &grayscaleStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	switch s.Method {
	case "":
		s.Method = "luminance"
	case "luminance", "average", "desaturate":
	case "mixer":
		if s.Mix == nil || !inRange(s.Mix[0], -200, 200) || !inRange(s.Mix[1], -200, 200) || !inRange(s.Mix[2], -200, 200) {
			return nil, invalid("the channel mixer takes three values of -200..200 percent")
		}
	default:
		return nil, invalid("grayscale method %q", s.Method)
	}
	return s, nil
}

func (s *grayscaleStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	return applyPointStep(ctx, s, img, env)
}

func grayMatrix(w [3]float64) [3][4]float64 {
	return [3][4]float64{{w[0], w[1], w[2], 0}, {w[0], w[1], w[2], 0}, {w[0], w[1], w[2], 0}}
}

func (s *grayscaleStep) Stages(context.Context, *image.RGBA, *Env) ([]pointStage, error) {
	switch s.Method {
	case "average":
		return []pointStage{matrixStage(grayMatrix([3]float64{1.0 / 3, 1.0 / 3, 1.0 / 3}))}, nil
	case "mixer":
		return []pointStage{matrixStage(grayMatrix([3]float64{s.Mix[0] / 100, s.Mix[1] / 100, s.Mix[2] / 100}))}, nil
	case "desaturate":
		return []pointStage{{kind: stageFunc, fn: func(r, g, b uint8) (uint8, uint8, uint8) {
			l := uint8((uint16(max(r, g, b)) + uint16(min(r, g, b)) + 1) / 2)
			return l, l, l
		}}}, nil
	}
	return []pointStage{{kind: stageFunc, fn: func(r, g, b uint8) (uint8, uint8, uint8) {
		l := Luma(r, g, b)
		return l, l, l
	}}}, nil
}

type sepiaStep struct {
	pointBase
	// Strength 0..100; Tone -100 (cool) .. 100 (warm).
	Strength float64 `json:"strength"`
	Tone     float64 `json:"tone,omitempty"`
}

func parseSepia(raw json.RawMessage) (pointStep, error) {
	s := &sepiaStep{Strength: 100}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if !inRange(s.Strength, 0, 100) || !inRange(s.Tone, -100, 100) {
		return nil, invalid("sepia strength is 0..100, tone -100..100")
	}
	return s, nil
}

func (s *sepiaStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	return applyPointStep(ctx, s, img, env)
}

func (s *sepiaStep) Stages(context.Context, *image.RGBA, *Env) ([]pointStage, error) {
	if s.Strength == 0 {
		return nil, nil
	}
	k, t := s.Strength/100, s.Tone/100*0.12
	sepia := [3][3]float64{{0.393, 0.769, 0.189}, {0.349, 0.686, 0.168}, {0.272, 0.534, 0.131}}
	gain := [3]float64{1 + t, 1, 1 - t}
	var m [3][4]float64
	for r := range 3 {
		for c := range 3 {
			id := 0.0
			if r == c {
				id = 1
			}
			m[r][c] = id*(1-k) + sepia[r][c]*gain[r]*k
		}
	}
	return []pointStage{matrixStage(m)}, nil
}

type negativeStep struct {
	pointBase
	// Channels to invert: any of "r", "g", "b"; empty means all three.
	Channels string `json:"channels,omitempty"`
}

func parseNegative(raw json.RawMessage) (pointStep, error) {
	s := &negativeStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if s.Channels == "" {
		s.Channels = "rgb"
	}
	if len(s.Channels) > 3 {
		return nil, invalid("negative channels are r, g and b")
	}
	for _, c := range s.Channels {
		if c != 'r' && c != 'g' && c != 'b' {
			return nil, invalid("negative channels are r, g and b")
		}
	}
	return s, nil
}

func (s *negativeStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	return applyPointStep(ctx, s, img, env)
}

func (s *negativeStep) Stages(context.Context, *image.RGBA, *Env) ([]pointStage, error) {
	var t [3][256]uint8
	for c, name := range "rgb" {
		invert := false
		for _, ch := range s.Channels {
			invert = invert || ch == name
		}
		for v := range 256 {
			t[c][v] = uint8(v)
			if invert {
				t[c][v] = uint8(255 - v)
			}
		}
	}
	return []pointStage{lutStage(&t)}, nil
}

type swapChannelsStep struct {
	pointBase
	// Order names where red, green and blue come from: "bgr" swaps red and blue.
	Order string `json:"order"`
}

func parseSwapChannels(raw json.RawMessage) (pointStep, error) {
	s := &swapChannelsStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	sorted := []byte(s.Order)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	if string(sorted) != "bgr" {
		return nil, invalid("channel order is a permutation of rgb")
	}
	return s, nil
}

func (s *swapChannelsStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	return applyPointStep(ctx, s, img, env)
}

func (s *swapChannelsStep) Stages(context.Context, *image.RGBA, *Env) ([]pointStage, error) {
	if s.Order == "rgb" {
		return nil, nil
	}
	var m [3][4]float64
	for out, name := range s.Order {
		m[out][map[rune]int{'r': 0, 'g': 1, 'b': 2}[name]] = 1
	}
	return []pointStage{matrixStage(m)}, nil
}

// --- replaceColor ---

type replaceColorStep struct {
	pointBase
	From string `json:"from"`
	To   string `json:"to"`
	// Tolerance 0..100: how far a color may be from From and still be
	// replaced fully (0 = that exact color only). Softness 0..100: the
	// width of the fade beyond it.
	Tolerance float64 `json:"tolerance"`
	Softness  float64 `json:"softness,omitempty"`
	// KeepLuminance keeps each pixel's own brightness, so shading survives.
	KeepLuminance bool `json:"keepLuminance,omitempty"`

	from, to color.RGBA
}

func parseReplaceColor(raw json.RawMessage) (pointStep, error) {
	s := &replaceColorStep{}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	var err error
	if s.from, err = ParseColor(s.From); err != nil {
		return nil, err
	}
	if s.to, err = ParseColor(s.To); err != nil {
		return nil, err
	}
	if s.from.A != 0xFF || s.to.A != 0xFF {
		return nil, invalid("replace color takes opaque colors")
	}
	if !inRange(s.Tolerance, 0, 100) || !inRange(s.Softness, 0, 100) {
		return nil, invalid("tolerance and softness are 0..100")
	}
	return s, nil
}

func (s *replaceColorStep) Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error) {
	return applyPointStep(ctx, s, img, env)
}

// maxColorDistance is the largest distance between two colors: black to white.
const maxColorDistance = 441.673 // sqrt(3·255²)

// MatchWeight is how much of a pixel is replaced, 0..256: all of it within
// the tolerance, fading to nothing over the softness.
func (s *replaceColorStep) matchWeight(r, g, b uint8) int32 {
	dr, dg, db := int32(r)-int32(s.from.R), int32(g)-int32(s.from.G), int32(b)-int32(s.from.B)
	d2 := dr*dr + dg*dg + db*db
	if d2 == 0 {
		return 256
	}
	tol := s.Tolerance / 100 * maxColorDistance / 2
	if tol == 0 {
		return 0
	}
	d := math.Sqrt(float64(d2))
	if d <= tol {
		return 256
	}
	soft := s.Softness / 100 * maxColorDistance / 2
	if soft == 0 || d >= tol+soft {
		return 0
	}
	return int32(math.Round((1 - (d-tol)/soft) * 256))
}

func (s *replaceColorStep) Stages(context.Context, *image.RGBA, *Env) ([]pointStage, error) {
	if s.from == s.to {
		return nil, nil
	}
	toLuma := int32(Luma(s.to.R, s.to.G, s.to.B))
	return []pointStage{{kind: stageFunc, fn: func(r, g, b uint8) (uint8, uint8, uint8) {
		w := s.matchWeight(r, g, b)
		if w == 0 {
			return r, g, b
		}
		tr, tg, tb := int32(s.to.R), int32(s.to.G), int32(s.to.B)
		if s.KeepLuminance {
			shift := int32(Luma(r, g, b)) - toLuma
			tr, tg, tb = int32(clampByte(tr+shift)), int32(clampByte(tg+shift)), int32(clampByte(tb+shift))
		}
		return uint8((int32(r)*(256-w) + tr*w + 128) >> 8), uint8((int32(g)*(256-w) + tg*w + 128) >> 8), uint8((int32(b)*(256-w) + tb*w + 128) >> 8)
	}}}, nil
}
