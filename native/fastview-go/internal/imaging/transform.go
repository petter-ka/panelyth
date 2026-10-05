package imaging

import (
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"math"
	"sync"
)

// Image transforms and effects (ADR-0022). An EditList is a non-destructive,
// ordered list of operations applied after decode and orientation. It never
// writes to the source file: a future preview profile, export or "save as"
// renders the source through it. Its Key is part of the preview cache key
// (CACHE-DESIGN "transformVersion"), so an edited image never reuses an
// unedited preview.
//
// Stage 08 delivers the model, validation, size math and a pure-Go pipeline.
// Nothing in the product creates edit lists yet.

// EditListVersion changes whenever an operation's output changes for the
// same input; it is part of Key.
const EditListVersion = 1

// MaxEditOps bounds an edit list.
const MaxEditOps = 64

// OpKind names an operation.
type OpKind string

const (
	OpRotate OpKind = "rotate" // Degrees: 90, 180 or 270 clockwise
	OpFlip   OpKind = "flip"   // Axis: "h" (mirror left-right) or "v"
	OpCrop   OpKind = "crop"   // Rect: normalized to the image at that step
	OpResize OpKind = "resize" // MaxEdge: downscale only, never upscales
	OpEffect OpKind = "effect" // Effect: a registered effect with Params
)

// Rect is a crop rectangle in 0..1 coordinates of the current image.
type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// Op is one operation. Only the fields of its Kind are set.
type Op struct {
	Kind    OpKind          `json:"op"`
	Degrees int             `json:"deg,omitempty"`
	Axis    string          `json:"axis,omitempty"`
	Rect    *Rect           `json:"rect,omitempty"`
	MaxEdge int             `json:"maxEdge,omitempty"`
	Effect  string          `json:"effect,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// EditList is applied in order.
type EditList []Op

// ErrInvalidEdit reports a malformed edit list.
var ErrInvalidEdit = errors.New("imaging: invalid edit")

// Effect is a pixel operation that keeps the image size (adjustments,
// filters). Implementations must be deterministic and safe for concurrent
// use; Apply may modify img in place and return it.
type Effect interface {
	Validate(params json.RawMessage) error
	Apply(img *image.RGBA, params json.RawMessage) (*image.RGBA, error)
}

var (
	effectsMu sync.RWMutex
	effects   = map[string]Effect{"grayscale": grayscale{}}
)

// RegisterEffect adds an effect under name (init time; panics on reuse).
func RegisterEffect(name string, e Effect) {
	effectsMu.Lock()
	defer effectsMu.Unlock()
	if _, dup := effects[name]; dup || name == "" {
		panic("imaging: effect registered twice: " + name)
	}
	effects[name] = e
}

func lookupEffect(name string) (Effect, bool) {
	effectsMu.RLock()
	defer effectsMu.RUnlock()
	e, ok := effects[name]
	return e, ok
}

// Validate checks every operation.
func (e EditList) Validate() error {
	if len(e) > MaxEditOps {
		return fmt.Errorf("%w: more than %d operations", ErrInvalidEdit, MaxEditOps)
	}
	for i, op := range e {
		if err := op.validate(); err != nil {
			return fmt.Errorf("%w (operation %d)", err, i)
		}
	}
	return nil
}

func (op Op) validate() error {
	switch op.Kind {
	case OpRotate:
		if op.Degrees != 90 && op.Degrees != 180 && op.Degrees != 270 {
			return fmt.Errorf("%w: rotate by 90, 180 or 270", ErrInvalidEdit)
		}
	case OpFlip:
		if op.Axis != "h" && op.Axis != "v" {
			return fmt.Errorf("%w: flip axis is h or v", ErrInvalidEdit)
		}
	case OpCrop:
		r := op.Rect
		if r == nil || !(r.X >= 0 && r.Y >= 0 && r.W > 0 && r.H > 0 && r.X+r.W <= 1+1e-9 && r.Y+r.H <= 1+1e-9) {
			return fmt.Errorf("%w: crop rectangle outside the image", ErrInvalidEdit)
		}
	case OpResize:
		if op.MaxEdge < 1 || op.MaxEdge > 65535 {
			return fmt.Errorf("%w: resize edge out of range", ErrInvalidEdit)
		}
	case OpEffect:
		eff, ok := lookupEffect(op.Effect)
		if !ok {
			return fmt.Errorf("%w: unknown effect %q", ErrInvalidEdit, op.Effect)
		}
		if err := eff.Validate(op.Params); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidEdit, err)
		}
	default:
		return fmt.Errorf("%w: unknown operation %q", ErrInvalidEdit, op.Kind)
	}
	return nil
}

// Key is the cache-key form: empty for no edits, otherwise the version and
// the canonical JSON of the list (struct field order is fixed).
func (e EditList) Key() string {
	if len(e) == 0 {
		return ""
	}
	b, _ := json.Marshal(e)
	return fmt.Sprintf("edit%d:%s", EditListVersion, b)
}

// OutputSize predicts the result size for a w×h input (after orientation)
// without touching pixels, so layouts and memory budgets can use it.
func (e EditList) OutputSize(w, h int) (int, int) {
	for _, op := range e {
		switch op.Kind {
		case OpRotate:
			if op.Degrees != 180 {
				w, h = h, w
			}
		case OpCrop:
			r := cropRect(w, h, *op.Rect)
			w, h = r.Dx(), r.Dy()
		case OpResize:
			w, h = FitSize(w, h, op.MaxEdge)
		}
	}
	return w, h
}

// cropRect converts a normalized rectangle to pixels, at least 1×1.
func cropRect(w, h int, r Rect) image.Rectangle {
	x0 := int(math.Floor(r.X * float64(w)))
	y0 := int(math.Floor(r.Y * float64(h)))
	x1 := int(math.Ceil((r.X + r.W) * float64(w)))
	y1 := int(math.Ceil((r.Y + r.H) * float64(h)))
	x0, y0 = min(max(x0, 0), w-1), min(max(y0, 0), h-1)
	x1, y1 = min(max(x1, x0+1), w), min(max(y1, y0+1), h)
	return image.Rect(x0, y0, x1, y1)
}

// Apply runs the list over img (already decoded and oriented). Validate
// first; Apply trusts its input.
func Apply(img *image.RGBA, e EditList) (*image.RGBA, error) {
	img = toRGBA(img) // the operations below assume an origin at (0,0)
	for _, op := range e {
		switch op.Kind {
		case OpRotate:
			img = Orient(img, map[int]int{90: 6, 180: 3, 270: 8}[op.Degrees])
		case OpFlip:
			if op.Axis == "h" {
				img = Orient(img, 2)
			} else {
				img = Orient(img, 4)
			}
		case OpCrop:
			b := img.Bounds()
			r := cropRect(b.Dx(), b.Dy(), *op.Rect)
			// Always copy: the result must not pin (or share) the larger buffer.
			dst := image.NewRGBA(image.Rect(0, 0, r.Dx(), r.Dy()))
			draw.Draw(dst, dst.Bounds(), img, r.Min, draw.Src)
			img = dst
		case OpResize:
			img = Downscale(img, op.MaxEdge)
		case OpEffect:
			eff, ok := lookupEffect(op.Effect)
			if !ok {
				return nil, fmt.Errorf("%w: unknown effect %q", ErrInvalidEdit, op.Effect)
			}
			var err error
			if img, err = eff.Apply(img, op.Params); err != nil {
				return nil, err
			}
		}
	}
	return img, nil
}

// grayscale is the reference effect: luminance (Rec. 709), alpha kept. It
// takes no parameters.
type grayscale struct{}

func (grayscale) Validate(params json.RawMessage) error {
	if len(params) > 0 && string(params) != "null" && string(params) != "{}" {
		return errors.New("grayscale takes no parameters")
	}
	return nil
}

func (grayscale) Apply(img *image.RGBA, _ json.RawMessage) (*image.RGBA, error) {
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		row := img.Pix[img.PixOffset(b.Min.X, y):img.PixOffset(b.Max.X, y)]
		for i := 0; i+3 < len(row); i += 4 {
			l := uint8((2126*uint32(row[i]) + 7152*uint32(row[i+1]) + 722*uint32(row[i+2]) + 5000) / 10000)
			row[i], row[i+1], row[i+2] = l, l, l
		}
	}
	return img, nil
}
