package imaging

import (
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"math"
	"sort"
)

// Reducing and counting colors (Stage 13). reduceColors picks a palette
// (median cut, octree, the web cube or gray levels) and maps every pixel to
// it, with or without dithering; the picture stays RGBA here and is written
// indexed when it is saved as PNG or GIF (asPaletted). CountColors counts
// distinct colors exactly; Palette finds the dominant ones.

func init() {
	RegisterOp("reduceColors", OpInfo{Version: 1, Batchable: true, Parse: parseReduceColors})
}

// Colors are counted in a 5-bit-per-channel cube: 32,768 cells.
const (
	cubeBits  = 5
	cubeCells = 1 << (3 * cubeBits)
)

func cell(r, g, b uint8) int {
	return int(r>>3)<<10 | int(g>>3)<<5 | int(b>>3)
}

// cube is the histogram a palette is made from: per cell the pixel count
// and the sums of the true colors, so palette entries are exact means.
type cube struct {
	n          [cubeCells]uint32
	sr, sg, sb [cubeCells]uint64
	// transparent counts pixels with alpha below one half.
	transparent uint64
	pixels      uint64
}

// straight returns the visible color of a premultiplied pixel.
func straight(p []uint8) (r, g, b, a uint8) {
	a = p[3]
	if a == 0xFF || a == 0 {
		return p[0], p[1], p[2], a
	}
	return unmul(p[0], a), unmul(p[1], a), unmul(p[2], a), a
}

func buildCube(ctx context.Context, img *image.RGBA) (*cube, error) {
	c := &cube{}
	w, h := img.Rect.Dx(), img.Rect.Dy()
	for y := range h {
		if y&63 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		row := img.Pix[y*img.Stride : y*img.Stride+w*4]
		for i := 0; i < len(row); i += 4 {
			r, g, b, a := straight(row[i : i+4])
			if a < 0x80 {
				c.transparent++
				continue
			}
			k := cell(r, g, b)
			c.n[k]++
			c.sr[k] += uint64(r)
			c.sg[k] += uint64(g)
			c.sb[k] += uint64(b)
			c.pixels++
		}
	}
	return c, nil
}

type colorBox struct {
	cells []int32
	count uint64
}

// spread returns the channel (0 r, 1 g, 2 b) with the widest range of a box.
func (c *cube) spread(b *colorBox) (channel int, width int) {
	lo, hi := [3]int{31, 31, 31}, [3]int{0, 0, 0}
	for _, k := range b.cells {
		v := [3]int{int(k) >> 10, int(k) >> 5 & 31, int(k) & 31}
		for i := range 3 {
			lo[i], hi[i] = min(lo[i], v[i]), max(hi[i], v[i])
		}
	}
	// Green counts most for the eye, then red: ties go that way.
	for _, i := range []int{1, 0, 2} {
		if hi[i]-lo[i] > width {
			channel, width = i, hi[i]-lo[i]
		}
	}
	return channel, width
}

func (c *cube) mean(cells []int32) color.RGBA {
	var n, r, g, b uint64
	for _, k := range cells {
		n += uint64(c.n[k])
		r += c.sr[k]
		g += c.sg[k]
		b += c.sb[k]
	}
	if n == 0 {
		return color.RGBA{A: 0xFF}
	}
	return color.RGBA{uint8((r + n/2) / n), uint8((g + n/2) / n), uint8((b + n/2) / n), 0xFF}
}

// medianCut splits the box with the most pixels at the median of its widest
// channel until there are count boxes (or nothing left to split).
func (c *cube) medianCut(count int) []color.RGBA {
	all := &colorBox{}
	for k := range cubeCells {
		if c.n[k] > 0 {
			all.cells = append(all.cells, int32(k))
			all.count += uint64(c.n[k])
		}
	}
	if len(all.cells) == 0 {
		return nil
	}
	boxes := []*colorBox{all}
	for len(boxes) < count {
		// The box that costs most: many pixels spread over a wide range.
		// Splitting by pixel count alone spends the palette on the large
		// flat areas and leaves the rest coarse.
		pick, best, ch := -1, uint64(0), 0
		for i, b := range boxes {
			if len(b.cells) < 2 {
				continue
			}
			channel, width := c.spread(b)
			if score := b.count * uint64(width*width+1); pick < 0 || score > best {
				pick, best, ch = i, score, channel
			}
		}
		if pick < 0 {
			break
		}
		b := boxes[pick]
		shift := uint([3]int{10, 5, 0}[ch])
		sort.Slice(b.cells, func(i, j int) bool {
			vi, vj := b.cells[i]>>shift&31, b.cells[j]>>shift&31
			if vi != vj {
				return vi < vj
			}
			return b.cells[i] < b.cells[j]
		})
		var acc uint64
		cut := 1
		for i, k := range b.cells[:len(b.cells)-1] {
			acc += uint64(c.n[k])
			cut = i + 1
			if acc*2 >= b.count {
				break
			}
		}
		left := &colorBox{cells: b.cells[:cut:cut], count: acc}
		right := &colorBox{cells: b.cells[cut:], count: b.count - acc}
		boxes[pick] = left
		boxes = append(boxes, right)
	}
	pal := make([]color.RGBA, len(boxes))
	for i, b := range boxes {
		pal[i] = c.mean(b.cells)
	}
	return pal
}

// octree merges the cells of the cube bottom-up: at the deepest level the
// nodes with the fewest pixels are folded into their parents first, level
// by level, until at most count colors remain. Against median cut it keeps
// small but distinct colors longer.
func (c *cube) octree(count int) []color.RGBA {
	type node struct {
		cells  []int32
		count  uint64
		parent int32
		depth  int
		gone   bool
	}
	// A node per prefix of the cell's channel bits.
	index := map[uint32]int32{}
	nodes := []node{{parent: -1}}
	key := func(k int32, depth int) uint32 {
		shift := uint(cubeBits - depth)
		r, g, b := uint32(k)>>10>>shift, uint32(k)>>5&31>>shift, uint32(k)&31>>shift
		return uint32(depth)<<24 | r<<16 | g<<8 | b
	}
	leaves := 0
	for k := range int32(cubeCells) {
		if c.n[k] == 0 {
			continue
		}
		parent := int32(0)
		for depth := 1; depth <= cubeBits; depth++ {
			id := key(k, depth)
			at, ok := index[id]
			if !ok {
				at = int32(len(nodes))
				nodes = append(nodes, node{parent: parent, depth: depth})
				index[id] = at
			}
			parent = at
		}
		nodes[parent].cells = []int32{k}
		nodes[parent].count = uint64(c.n[k])
		leaves++
	}
	for depth := cubeBits; depth > 0 && leaves > count; depth-- {
		// The colors at this depth, smallest first; ties by position.
		var level []int32
		for i := range nodes {
			if !nodes[i].gone && nodes[i].depth == depth && len(nodes[i].cells) > 0 {
				level = append(level, int32(i))
			}
		}
		sort.Slice(level, func(a, b int) bool {
			if nodes[level[a]].count != nodes[level[b]].count {
				return nodes[level[a]].count < nodes[level[b]].count
			}
			return level[a] < level[b]
		})
		for _, i := range level {
			if leaves <= count {
				break
			}
			p := nodes[i].parent
			// A parent that holds colors already absorbs this one: one
			// color fewer. Otherwise the parent takes its place.
			if len(nodes[p].cells) > 0 {
				leaves--
			}
			nodes[p].cells = append(nodes[p].cells, nodes[i].cells...)
			nodes[p].count += nodes[i].count
			nodes[i].gone = true
		}
	}
	var pal []color.RGBA
	for i := range nodes {
		if !nodes[i].gone && len(nodes[i].cells) > 0 {
			pal = append(pal, c.mean(nodes[i].cells))
		}
	}
	return pal
}

// webPalette is the 6×6×6 cube of the "web-safe" colors.
func webPalette() []color.RGBA {
	pal := make([]color.RGBA, 0, 216)
	for r := range 6 {
		for g := range 6 {
			for b := range 6 {
				pal = append(pal, color.RGBA{uint8(r * 51), uint8(g * 51), uint8(b * 51), 0xFF})
			}
		}
	}
	return pal
}

func grayPalette(count int) []color.RGBA {
	pal := make([]color.RGBA, count)
	for i := range pal {
		v := uint8(math.Round(float64(i) * 255 / float64(max(count-1, 1))))
		pal[i] = color.RGBA{v, v, v, 0xFF}
	}
	return pal
}

// nearestTable maps every cell of the cube to the closest palette entry.
func nearestTable(pal []color.RGBA) *[cubeCells]uint8 {
	var t [cubeCells]uint8
	for k := range cubeCells {
		// The middle of the cell.
		r, g, b := int32(k>>10)<<3|4, int32(k>>5&31)<<3|4, int32(k&31)<<3|4
		best, bestD := 0, int32(math.MaxInt32)
		for i, p := range pal {
			dr, dg, db := r-int32(p.R), g-int32(p.G), b-int32(p.B)
			// Green differences are seen best, blue least.
			if d := 3*dr*dr + 4*dg*dg + 2*db*db; d < bestD {
				best, bestD = i, d
			}
		}
		t[k] = uint8(best)
	}
	return &t
}

type reduceStep struct {
	sameSize
	// Count: 2..256 colors (the web cube has 216).
	Count int `json:"count"`
	// Quantizer: "median" (median cut), "octree", "web" or "gray".
	Quantizer string `json:"quantizer,omitempty"`
	// Dither: "none", "fs" (Floyd–Steinberg), "ordered4" or "ordered8".
	Dither string `json:"dither,omitempty"`
	// KeepTransparency keeps what is at least half transparent fully
	// transparent (one palette entry); otherwise the picture is placed on
	// white first.
	KeepTransparency bool `json:"keepTransparency,omitempty"`
}

func parseReduceColors(raw json.RawMessage) (Step, error) {
	s := &reduceStep{Count: 256}
	if err := decodeParams(raw, s); err != nil {
		return nil, err
	}
	if s.Quantizer == "" {
		s.Quantizer = "median"
	}
	if s.Dither == "" {
		s.Dither = "none"
	}
	if s.Count < 2 || s.Count > 256 {
		return nil, invalid("reduce colors to 2..256")
	}
	switch s.Quantizer {
	case "median", "octree", "web", "gray":
	default:
		return nil, invalid("quantizer %q", s.Quantizer)
	}
	switch s.Dither {
	case "none", "fs", "ordered4", "ordered8":
	default:
		return nil, invalid("dither %q", s.Dither)
	}
	return s, nil
}

var bayer4 = [16]int32{0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5}

// bayer8 is built from bayer4 by the usual recursion: each quadrant is
// 4·bayer4 plus the quadrant's own offset.
var bayer8 = func() (m [64]int32) {
	for y := range 8 {
		for x := range 8 {
			m[y*8+x] = 4*bayer4[(y%4)*4+x%4] + [4]int32{0, 2, 3, 1}[(y/4)*2+x/4]
		}
	}
	return m
}()

// palette is the palette this step uses for a picture's color cube.
// ReducePalette is the palette reduceColors would use for img.
func (s *reduceStep) palette(c *cube) []color.RGBA {
	count := s.Count
	if s.KeepTransparency && c.transparent > 0 {
		count = max(count-1, 1)
	}
	switch s.Quantizer {
	case "web":
		return webPalette()
	case "gray":
		return grayPalette(count)
	case "octree":
		return c.octree(count)
	}
	return c.medianCut(count)
}

func (s *reduceStep) Apply(ctx context.Context, img *image.RGBA, _ *Env) (*image.RGBA, error) {
	img = toRGBA(img)
	src := img
	if !s.KeepTransparency {
		var err error
		if src, err = Flatten(ctx, img); err != nil {
			return nil, err
		}
	}
	c, err := buildCube(ctx, src)
	if err != nil {
		return nil, err
	}
	pal := s.palette(c)
	if len(pal) == 0 {
		// Nothing visible: all transparent.
		return image.NewRGBA(img.Rect), nil
	}
	near := nearestTable(pal)
	w, h := src.Rect.Dx(), src.Rect.Dy()
	dst := image.NewRGBA(src.Rect)
	put := func(d []uint8, i int, p color.RGBA) { d[i], d[i+1], d[i+2], d[i+3] = p.R, p.G, p.B, 0xFF }
	if s.Dither == "fs" {
		// Error diffusion carries each pixel's error to the right and
		// down, so it runs in order, one row after the other.
		cur := make([]int32, (w+2)*3)
		next := make([]int32, (w+2)*3)
		for y := range h {
			if y&31 == 0 {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
			}
			row := src.Pix[y*src.Stride : y*src.Stride+w*4]
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			clear(next)
			for x := range w {
				i := x * 4
				r, g, b, a := straight(row[i : i+4])
				if a < 0x80 {
					continue
				}
				e := cur[(x+1)*3:]
				vr, vg, vb := clampByte(int32(r)+(e[0]+8)>>4), clampByte(int32(g)+(e[1]+8)>>4), clampByte(int32(b)+(e[2]+8)>>4)
				p := pal[near[cell(vr, vg, vb)]]
				put(d, i, p)
				for ch, diff := range [3]int32{int32(vr) - int32(p.R), int32(vg) - int32(p.G), int32(vb) - int32(p.B)} {
					cur[(x+2)*3+ch] += diff * 7
					next[x*3+ch] += diff * 3
					next[(x+1)*3+ch] += diff * 5
					next[(x+2)*3+ch] += diff
				}
			}
			cur, next = next, cur
		}
		return dst, nil
	}
	var matrix []int32
	var size int32
	switch s.Dither {
	case "ordered4":
		matrix, size = bayer4[:], 4
	case "ordered8":
		matrix, size = bayer8[:], 8
	}
	// The dither's strength is about one palette step per channel.
	spread := int32(math.Round(255 / math.Cbrt(float64(len(pal))) / 1.5))
	err = Rows(ctx, w, h, func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			row := src.Pix[y*src.Stride : y*src.Stride+w*4]
			d := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
			for x := range w {
				i := x * 4
				r, g, b, a := straight(row[i : i+4])
				if a < 0x80 {
					continue
				}
				if matrix != nil {
					cells := size * size
					t := (matrix[int32(y)%size*size+int32(x)%size]*2 + 1 - cells) * spread / (2 * cells)
					r, g, b = clampByte(int32(r)+t), clampByte(int32(g)+t), clampByte(int32(b)+t)
				}
				put(d, i, pal[near[cell(r, g, b)]])
			}
		}
	})
	return dst, err
}

// CountColors counts the distinct colors of the visible pixels exactly (a
// bit per 24-bit color) and reports whether any pixel is not opaque.
func CountColors(ctx context.Context, img *image.RGBA) (distinct int, hasAlpha bool, err error) {
	img = toRGBA(img)
	seen := make([]uint64, 1<<24/64)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	for y := range h {
		if y&63 == 0 {
			if err := ctx.Err(); err != nil {
				return 0, false, err
			}
		}
		row := img.Pix[y*img.Stride : y*img.Stride+w*4]
		for i := 0; i < len(row); i += 4 {
			r, g, b, a := straight(row[i : i+4])
			if a != 0xFF {
				hasAlpha = true
				if a == 0 {
					continue
				}
			}
			k := uint32(r)<<16 | uint32(g)<<8 | uint32(b)
			if bit := uint64(1) << (k & 63); seen[k>>6]&bit == 0 {
				seen[k>>6] |= bit
				distinct++
			}
		}
	}
	return distinct, hasAlpha, nil
}

// Swatch is a dominant color with the share of the picture it stands for.
type Swatch struct {
	Hex   string  `json:"hex"`
	Share float64 `json:"share"`
}

// MaxSwatches bounds a dominant palette.
const MaxSwatches = 32

// Palette returns up to count dominant colors of img (median cut), largest
// share first.
func Palette(ctx context.Context, img *image.RGBA, count int) ([]Swatch, error) {
	count = min(max(count, 1), MaxSwatches)
	c, err := buildCube(ctx, toRGBA(img))
	if err != nil {
		return nil, err
	}
	pal := c.medianCut(count)
	if len(pal) == 0 {
		return []Swatch{}, nil
	}
	near := nearestTable(pal)
	counts := make([]uint64, len(pal))
	for k := range cubeCells {
		counts[near[k]] += uint64(c.n[k])
	}
	out := make([]Swatch, 0, len(pal))
	for i, p := range pal {
		if counts[i] > 0 {
			out = append(out, Swatch{Hex: fmt.Sprintf("#%02x%02x%02x", p.R, p.G, p.B),
				Share: math.Round(float64(counts[i])/float64(c.pixels)*10000) / 10000})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Share != out[j].Share {
			return out[i].Share > out[j].Share
		}
		return out[i].Hex < out[j].Hex
	})
	return out, nil
}

// asPaletted returns img as an indexed image when it has at most 256
// distinct colors (transparent counts as one), otherwise nil. A photograph
// is told apart within its first rows.
func asPaletted(img *image.RGBA) *image.Paletted {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	index := map[uint32]uint8{}
	var pal color.Palette
	key := func(p []uint8) uint32 { return uint32(p[0])<<24 | uint32(p[1])<<16 | uint32(p[2])<<8 | uint32(p[3]) }
	for y := range h {
		row := img.Pix[y*img.Stride : y*img.Stride+w*4]
		for i := 0; i < len(row); i += 4 {
			if a := row[i+3]; a != 0 && a != 0xFF {
				return nil // partial transparency needs the full alpha channel
			}
			k := key(row[i : i+4])
			if _, ok := index[k]; ok {
				continue
			}
			if len(pal) == 256 {
				return nil
			}
			index[k] = uint8(len(pal))
			pal = append(pal, color.NRGBA{row[i], row[i+1], row[i+2], row[i+3]})
		}
	}
	out := image.NewPaletted(image.Rect(0, 0, w, h), pal)
	for y := range h {
		row := img.Pix[y*img.Stride : y*img.Stride+w*4]
		d := out.Pix[y*out.Stride : y*out.Stride+w]
		for x := range w {
			d[x] = index[key(row[x*4:x*4+4])]
		}
	}
	return out
}
