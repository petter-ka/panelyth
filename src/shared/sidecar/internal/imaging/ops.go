package imaging

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"math"
	"sync"
)

// Edit lists (ADR-0022, extended by ADR-0035). An EditList is a
// non-destructive, ordered list of registered operations with JSON
// parameters, applied after decode and orientation. It never writes to the
// source file: the editor renders a proxy through it while the user works,
// and a save renders the full image through the same code.
//
// Positions and sizes the user draws are normalized to the image at that
// step, and pixel sizes are meant at full resolution, so one list replays on
// a proxy (Scale < 1) and on the full image (Scale 1).

// EditListVersion changes whenever the model changes; each operation has its
// own Version for changes of its output. Both are part of Key.
const EditListVersion = 2

// Limits of an edit list (ADR-0035).
const (
	MaxEditOps = 512
	// MaxEditPixels bounds the image at every step of a list.
	MaxEditPixels = 100_000_000
	// MaxEditEdge bounds an edge (the JPEG limit).
	MaxEditEdge = 65535
)

// DPI is a resolution in pixels per inch; zero means unknown.
type DPI struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// DefaultDPI stands in for an unknown resolution when a size is derived
// from it.
const DefaultDPI = 72

// Or returns d, or DefaultDPI for an unknown resolution.
func (d DPI) Or() DPI {
	if d.X <= 0 || d.Y <= 0 {
		return DPI{DefaultDPI, DefaultDPI}
	}
	return d
}

// Op is one operation of an edit list.
type Op struct {
	Kind   string          `json:"op"`
	Params json.RawMessage `json:"p,omitempty"`
	// Off keeps the operation in the list without applying it (the eye in
	// the edit stack).
	Off bool `json:"off,omitempty"`
}

// EditList is applied in order.
type EditList []Op

// ErrInvalidEdit reports a malformed edit list.
var ErrInvalidEdit = errors.New("imaging: invalid edit")

// Env is what a step knows about the image it is given.
type Env struct {
	// OutW, OutH is the full-resolution size of the step's output and
	// TargetW, TargetH that size at the working scale. A step that resamples
	// produces exactly the target; one that only moves pixels (a quarter
	// turn, a flip) produces its natural size.
	OutW, OutH       int
	TargetW, TargetH int
	// InW, InH is the full-resolution size of the step's input.
	InW, InH int
	// Scale is working pixels per full-resolution pixel (1 when saving).
	Scale float64
	// DPI is the resolution of the step's input.
	DPI DPI
	// Draft asks for the fast variant while a control is dragged.
	Draft bool
	// Scratch: the input belongs to this run and may be modified in place.
	Scratch bool
	// Res gives assets, fonts and facts about the picture; nil when the run
	// has none (built-in fonts still work).
	Res Resources
}

// Step is a parsed operation. Steps are deterministic: the same input gives
// the same bytes for every worker count.
type Step interface {
	// Size is the full-resolution output size for a w×h input. It may
	// change the resolution.
	Size(w, h int, dpi *DPI) (int, int)
	// Apply returns the step's output. It must not modify img unless
	// env.Scratch is set; it may return img itself when nothing changes.
	Apply(ctx context.Context, img *image.RGBA, env *Env) (*image.RGBA, error)
}

// OpInfo registers an operation.
type OpInfo struct {
	// Version changes whenever the operation's output changes.
	Version int
	// Batchable: the operation needs no pointed position, so it can run over
	// other pictures (ADR-0036).
	Batchable bool
	// Parse validates the parameters.
	Parse func(params json.RawMessage) (Step, error)
}

var (
	opsMu sync.RWMutex
	ops   = map[string]OpInfo{}
)

// RegisterOp adds an operation under name (init time; panics on reuse).
func RegisterOp(name string, info OpInfo) {
	opsMu.Lock()
	defer opsMu.Unlock()
	if _, dup := ops[name]; dup || name == "" || info.Parse == nil {
		panic("imaging: operation registered twice: " + name)
	}
	ops[name] = info
}

func lookupOp(name string) (OpInfo, bool) {
	opsMu.RLock()
	defer opsMu.RUnlock()
	info, ok := ops[name]
	return info, ok
}

// OpNames lists the registered operations.
func OpNames() []string {
	opsMu.RLock()
	defer opsMu.RUnlock()
	names := make([]string, 0, len(ops))
	for n := range ops {
		names = append(names, n)
	}
	return names
}

// decodeParams reads an operation's parameters strictly: unknown fields are
// an error, so a typo never silently means "default".
func decodeParams(raw json.RawMessage, v any) error {
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		raw = []byte("{}")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidEdit, err)
	}
	return nil
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidEdit, fmt.Sprintf(format, args...))
}

// Program is a validated edit list bound to a source size: every step
// parsed, every intermediate size known, and a key per prefix for caches.
type Program struct {
	steps []Step
	keys  []string
	sizes [][2]int
	dpis  []DPI
	w, h  int
	dpi   DPI
}

// Compile validates e for a w×h source (after orientation). Operations that
// are switched off are left out. It fails with ErrInvalidEdit, or with
// ErrTooLarge when a step would exceed the editing limits.
func Compile(e EditList, w, h int, dpi DPI) (*Program, error) {
	if len(e) > MaxEditOps {
		return nil, invalid("more than %d operations", MaxEditOps)
	}
	if w < 1 || h < 1 {
		return nil, invalid("empty image")
	}
	p := &Program{w: w, h: h, dpi: dpi}
	key := ""
	for i, op := range e {
		if op.Off {
			continue
		}
		info, ok := lookupOp(op.Kind)
		if !ok {
			return nil, fmt.Errorf("%w (operation %d)", invalid("unknown operation %q", op.Kind), i)
		}
		step, err := info.Parse(op.Params)
		if err != nil {
			return nil, fmt.Errorf("%w (operation %d, %s)", err, i, op.Kind)
		}
		w, h = step.Size(w, h, &dpi)
		if w < 1 || h < 1 || w > MaxEditEdge || h > MaxEditEdge || int64(w)*int64(h) > MaxEditPixels {
			return nil, fmt.Errorf("%w: operation %d (%s) makes the picture %d×%d", ErrTooLarge, i, op.Kind, w, h)
		}
		key = chainKey(key, op, info.Version)
		p.steps = append(p.steps, step)
		p.keys = append(p.keys, key)
		p.sizes = append(p.sizes, [2]int{w, h})
		p.dpis = append(p.dpis, dpi)
	}
	return p, nil
}

// Len is the number of steps that run.
func (p *Program) Len() int { return len(p.steps) }

// Key identifies the result of the first n steps on this source size ("" for
// none). Equal keys mean equal pixels at the same working scale.
func (p *Program) Key(n int) string {
	if n <= 0 {
		return ""
	}
	return p.keys[n-1]
}

// SizeAt is the full-resolution size after the first n steps.
func (p *Program) SizeAt(n int) (int, int) {
	if n <= 0 {
		return p.w, p.h
	}
	return p.sizes[n-1][0], p.sizes[n-1][1]
}

// Size is the full-resolution output size.
func (p *Program) Size() (int, int) { return p.SizeAt(len(p.steps)) }

// DPI is the output resolution.
func (p *Program) DPI() DPI {
	if len(p.dpis) == 0 {
		return p.dpi
	}
	return p.dpis[len(p.dpis)-1]
}

// PeakEdge is the longest edge the image has at any step (full resolution),
// so a caller can pick a working scale that bounds every intermediate.
func (p *Program) PeakEdge() int {
	edge := max(p.w, p.h)
	for _, s := range p.sizes {
		edge = max(edge, s[0], s[1])
	}
	return edge
}

// RunOptions configure one run of a program.
type RunOptions struct {
	// Scale is working pixels per full-resolution pixel: 1 for a save, less
	// for a proxy.
	Scale float64
	Draft bool
	// Keep reports that the caller retains the image after n steps (a
	// checkpoint), so the next step must not modify it. Nil keeps none.
	Keep func(n int) bool
	// Each is called with the image after n steps. Per-pixel steps that
	// run as one pass report once, after the last of them.
	Each func(n int, img *image.RGBA)
	// Res gives the steps their assets, fonts and tokens (may be nil).
	Res Resources
}

// Run applies the steps after the first `from` to img, which must be the
// result of those first steps at o.Scale (the source itself for from = 0).
// img is never modified.
func (p *Program) Run(ctx context.Context, img *image.RGBA, from int, o RunOptions) (*image.RGBA, error) {
	if o.Scale <= 0 {
		o.Scale = 1
	}
	img = toRGBA(img)
	scratch := false
	kept := func(n int) bool { return o.Keep != nil && o.Keep(n) }
	envAt := func(i int) Env {
		env := Env{OutW: p.sizes[i][0], OutH: p.sizes[i][1], Scale: o.Scale, Draft: o.Draft, DPI: p.dpi, Res: o.Res}
		if i > 0 {
			env.DPI = p.dpis[i-1]
		}
		env.TargetW, env.TargetH = scaled(env.OutW, o.Scale), scaled(env.OutH, o.Scale)
		env.InW, env.InH = p.SizeAt(i)
		return env
	}
	for i := from; i < len(p.steps); i++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		env := envAt(i)
		env.Scratch = scratch
		var out *image.RGBA
		var err error
		if ps, ok := p.steps[i].(pointStep); ok {
			// Per-pixel steps that follow each other run as one pass, up to
			// an image the caller keeps or a step that must see its input.
			var stages []pointStage
			if stages, err = ps.Stages(ctx, img, &env); err != nil {
				return nil, err
			}
			for i+1 < len(p.steps) && !kept(i+1) {
				next, ok := p.steps[i+1].(pointStep)
				if !ok || next.NeedsInput() {
					break
				}
				nextEnv := envAt(i + 1)
				more, err := next.Stages(ctx, nil, &nextEnv)
				if err != nil {
					return nil, err
				}
				stages = append(stages, more...)
				i++
			}
			out, err = applyStages(ctx, img, stages, scratch)
		} else {
			out, err = p.steps[i].Apply(ctx, img, &env)
		}
		if err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		// A step that returned its input leaves the ownership as it was.
		if out != img {
			scratch = true
		}
		if kept(i + 1) {
			scratch = false
		}
		img = out
		if o.Each != nil {
			o.Each(i+1, img)
		}
	}
	return img, nil
}

func scaled(n int, scale float64) int {
	if scale == 1 {
		return n
	}
	return max(1, int(math.Round(float64(n)*scale)))
}

// Validate checks every operation (for any source size).
func (e EditList) Validate() error {
	if len(e) > MaxEditOps {
		return invalid("more than %d operations", MaxEditOps)
	}
	for i, op := range e {
		info, ok := lookupOp(op.Kind)
		if !ok {
			return fmt.Errorf("%w (operation %d)", invalid("unknown operation %q", op.Kind), i)
		}
		if _, err := info.Parse(op.Params); err != nil {
			return fmt.Errorf("%w (operation %d, %s)", err, i, op.Kind)
		}
	}
	return nil
}

// KnownOp reports whether an operation is registered.
func KnownOp(name string) bool {
	_, ok := lookupOp(name)
	return ok
}

// Batchable reports whether every operation can run over other pictures.
func (e EditList) Batchable() bool {
	for _, op := range e {
		if info, ok := lookupOp(op.Kind); !ok || !info.Batchable {
			return false
		}
	}
	return true
}

// chainKey extends the key of a prefix by one operation.
func chainKey(prev string, op Op, version int) string {
	var compact bytes.Buffer
	if json.Compact(&compact, op.Params) != nil {
		compact.Reset()
	}
	sum := sha256.Sum256(fmt.Appendf(nil, "%s|%s|%d|%s", prev, op.Kind, version, compact.Bytes()))
	return hex.EncodeToString(sum[:16])
}

// Key is the cache-key form: empty for no edits, otherwise the model
// version and the key of the whole list.
func (e EditList) Key() string {
	key, n := "", 0
	for _, op := range e {
		if op.Off {
			continue
		}
		info, _ := lookupOp(op.Kind)
		key = chainKey(key, op, info.Version)
		n++
	}
	if n == 0 {
		return ""
	}
	return fmt.Sprintf("edit%d:%s", EditListVersion, key)
}

// OutputSize predicts the result size for a w×h input (after orientation)
// without touching pixels. An invalid list leaves the size as it is.
func (e EditList) OutputSize(w, h int) (int, int) {
	p, err := Compile(e, w, h, DPI{})
	if err != nil {
		return w, h
	}
	return p.Size()
}

// Apply runs the list over img (already decoded and oriented) at full
// resolution. img is not modified.
func Apply(ctx context.Context, img *image.RGBA, e EditList) (*image.RGBA, error) {
	return ApplyWith(ctx, img, e, nil)
}

// ApplyWith is Apply with the assets, fonts and tokens the list refers to.
func ApplyWith(ctx context.Context, img *image.RGBA, e EditList, res Resources) (*image.RGBA, error) {
	img = toRGBA(img)
	p, err := Compile(e, img.Rect.Dx(), img.Rect.Dy(), DPI{})
	if err != nil {
		return nil, err
	}
	return p.Run(ctx, img, 0, RunOptions{Scale: 1, Res: res})
}
