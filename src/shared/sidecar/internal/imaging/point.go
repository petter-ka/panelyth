package imaging

import (
	"context"
	"image"
)

// Per-pixel operations (Stage 13, ADR-0035 "Fusion"). A point step turns
// into stages: three lookup tables, a 3×3 matrix with an offset, or a
// function of one pixel. Consecutive point steps run as one pass over the
// image: every pixel goes through all their stages before the next pixel is
// touched, so a chain of tone and color tools costs one read and one write
// of the picture, and adjacent tables are folded into one. Each stage does
// the arithmetic it would do alone, so a fused chain gives the same bytes as
// the steps run one after another.
//
// Stages see straight (not premultiplied) 8-bit RGB; alpha is not theirs to
// change. A fully transparent pixel is left alone.

type stageKind uint8

const (
	stageLUT stageKind = iota
	stageMatrix
	stageFunc
)

// matrixBits is the fixed-point precision of a color matrix.
const matrixBits = 12

// pointStage is one per-pixel transformation.
type pointStage struct {
	kind stageKind
	// lut[c][v] is the new value of channel c.
	lut *[3][256]uint8
	// mat is rows of (r, g, b, offset) in matrixBits fixed point; the
	// offset is already scaled to 0..255.
	mat [12]int32
	fn  func(r, g, b uint8) (uint8, uint8, uint8)
}

// pointStep is a Step made of per-pixel stages. A step that needs to look at
// its input first (an automatic correction) reports NeedsInput: it starts a
// new pass, so it sees what the steps before it produced.
type pointStep interface {
	Step
	// Stages returns the step's stages for img (nil for a step that needs
	// no input). No stages means the step changes nothing.
	Stages(ctx context.Context, img *image.RGBA, env *Env) ([]pointStage, error)
	NeedsInput() bool
}

// pointBase gives a point step its Size and Apply.
type pointBase struct{}

func (pointBase) Size(w, h int, _ *DPI) (int, int) { return w, h }
func (pointBase) NeedsInput() bool                 { return false }

// applyPointStep runs one point step alone.
func applyPointStep(ctx context.Context, s pointStep, img *image.RGBA, env *Env) (*image.RGBA, error) {
	stages, err := s.Stages(ctx, img, env)
	if err != nil {
		return nil, err
	}
	return applyStages(ctx, img, stages, env.Scratch)
}

func lutStage(l *[3][256]uint8) pointStage { return pointStage{kind: stageLUT, lut: l} }

// sameLUT uses one table for the three channels.
func sameLUT(t *[256]uint8) pointStage {
	return pointStage{kind: stageLUT, lut: &[3][256]uint8{*t, *t, *t}}
}

// identityLUT reports whether a table changes nothing.
func identityLUT(l *[3][256]uint8) bool {
	for c := range 3 {
		for v := range 256 {
			if l[c][v] != uint8(v) {
				return false
			}
		}
	}
	return true
}

// matrixStage builds a matrix stage from rows of (r, g, b, offset), the
// offset in 0..1.
func matrixStage(m [3][4]float64) pointStage {
	var s pointStage
	s.kind = stageMatrix
	for r := range 3 {
		for c := range 3 {
			s.mat[r*4+c] = int32(roundHalf(m[r][c] * (1 << matrixBits)))
		}
		s.mat[r*4+3] = int32(roundHalf(m[r][3] * 255 * (1 << matrixBits)))
	}
	return s
}

func roundHalf(v float64) float64 {
	if v < 0 {
		return float64(int64(v - 0.5))
	}
	return float64(int64(v + 0.5))
}

// foldStages folds adjacent tables into one and drops tables that change
// nothing. Folding a table is exact: b[a[v]] is what the two would do.
func foldStages(stages []pointStage) []pointStage {
	out := make([]pointStage, 0, len(stages))
	for _, s := range stages {
		if s.kind == stageLUT {
			if identityLUT(s.lut) {
				continue
			}
			if n := len(out); n > 0 && out[n-1].kind == stageLUT {
				var folded [3][256]uint8
				for c := range 3 {
					for v := range 256 {
						folded[c][v] = s.lut[c][out[n-1].lut[c][v]]
					}
				}
				// Two tables that undo each other leave nothing to do.
				if identityLUT(&folded) {
					out = out[:n-1]
				} else {
					out[n-1] = lutStage(&folded)
				}
				continue
			}
		}
		out = append(out, s)
	}
	return out
}

func clampByte(v int32) uint8 {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v)
}

// runStages sends one straight pixel through the stages.
func runStages(stages []pointStage, r, g, b uint8) (uint8, uint8, uint8) {
	for i := range stages {
		s := &stages[i]
		switch s.kind {
		case stageLUT:
			r, g, b = s.lut[0][r], s.lut[1][g], s.lut[2][b]
		case stageMatrix:
			m := &s.mat
			const half = 1 << (matrixBits - 1)
			fr, fg, fb := int32(r), int32(g), int32(b)
			r = clampByte((m[0]*fr + m[1]*fg + m[2]*fb + m[3] + half) >> matrixBits)
			g = clampByte((m[4]*fr + m[5]*fg + m[6]*fb + m[7] + half) >> matrixBits)
			b = clampByte((m[8]*fr + m[9]*fg + m[10]*fb + m[11] + half) >> matrixBits)
		default:
			r, g, b = s.fn(r, g, b)
		}
	}
	return r, g, b
}

// applyStages runs the stages over img in one pass: in place when the image
// is this run's own (scratch), otherwise into a new image. No stages return
// img itself.
func applyStages(ctx context.Context, img *image.RGBA, stages []pointStage, scratch bool) (*image.RGBA, error) {
	stages = foldStages(stages)
	if len(stages) == 0 {
		return img, ctx.Err()
	}
	img = toRGBA(img)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	dst := img
	if !scratch {
		dst = image.NewRGBA(image.Rect(0, 0, w, h))
	}
	// A single table needs no per-pixel dispatch.
	var only *[3][256]uint8
	if len(stages) == 1 && stages[0].kind == stageLUT {
		only = stages[0].lut
	}
	err := Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			s := img.Pix[y*img.Stride : y*img.Stride+w*4]
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			for i := 0; i < len(s); i += 4 {
				r, g, b, a := s[i], s[i+1], s[i+2], s[i+3]
				switch a {
				case 0xFF:
					if only != nil {
						d[i], d[i+1], d[i+2], d[i+3] = only[0][r], only[1][g], only[2][b], a
						continue
					}
					r, g, b = runStages(stages, r, g, b)
				case 0:
					// Nothing to see, nothing to change.
				default:
					r, g, b = runStages(stages, unmul(r, a), unmul(g, a), unmul(b, a))
					r, g, b = mul(r, a), mul(g, a), mul(b, a)
				}
				d[i], d[i+1], d[i+2], d[i+3] = r, g, b, a
			}
		}
	})
	return dst, err
}
