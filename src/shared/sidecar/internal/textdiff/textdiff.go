package textdiff

import (
	"context"
	"hash/maphash"
	"os"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Limits of what a diff sends.
const (
	// MaxLineBytes is how much of a line a row carries; longer lines are cut.
	MaxLineBytes = 4096
	// MaxPageRows bounds one page.
	MaxPageRows = 500
	// MaxBlocks bounds the list of changed places sent for navigation.
	MaxBlocks = 10_000
	// spanBytes is the most one read fetches for a page's lines of one side.
	spanBytes = 4 << 20
)

// Diff is a finished comparison of two text files. It holds where their
// lines start and how they pair up, not their text.
type Diff struct {
	left, right *file
	runs        []run
	rows        int
	blocks      [][2]int
	changes     int
	identical   bool
}

// SideInfo describes one file of a diff.
type SideInfo struct {
	Size     int64
	Lines    int
	Encoding Encoding
}

// Info is the summary of a diff.
type Info struct {
	Left, Right SideInfo
	// Rows of the side-by-side view.
	Rows int
	// Changes is the number of changed places; Blocks lists the first
	// MaxBlocks of them as [first row, rows].
	Changes int
	Blocks  [][2]int
	// Identical: the files have the same bytes. Files without a changed line
	// can still differ in their line ends or their encoding.
	Identical bool
}

// Open compares two text files. It returns ErrBinary or ErrTooLarge when a
// file is not one a text diff takes.
func Open(ctx context.Context, left, right string) (*Diff, error) {
	l, lmark, err := probe(left)
	if err != nil {
		return nil, err
	}
	r, rmark, err := probe(right)
	if err != nil {
		return nil, err
	}
	seed := maphash.MakeSeed()
	// Files in different encodings are compared by their decoded text.
	decode := l.enc != r.enc
	lh, err := scan(ctx, l, lmark, seed, decode)
	if err != nil {
		return nil, err
	}
	rh, err := scan(ctx, r, rmark, seed, decode)
	if err != nil {
		return nil, err
	}
	// Lines as small numbers: equal text, equal number.
	ids := make(map[uint64]int32, len(lh))
	number := func(hashes []uint64) []int32 {
		out := make([]int32, len(hashes))
		for i, h := range hashes {
			id, ok := ids[h]
			if !ok {
				id = int32(len(ids))
				ids[h] = id
			}
			out[i] = id
		}
		return out
	}
	d := &differ{ctx: ctx, a: number(lh), b: number(rh), work: myersBudget}
	d.cntA, d.cntB, d.posB = make([]int32, len(ids)), make([]int32, len(ids)), make([]int32, len(ids))
	d.diff(0, len(d.a), 0, len(d.b))
	if d.canceled || ctx.Err() != nil {
		return nil, ctx.Err()
	}
	out := &Diff{left: l, right: r, runs: runs(d.matches, len(d.a), len(d.b)),
		identical: l.size == r.size && l.whole == r.whole}
	for i, rn := range out.runs {
		out.rows += int(rn.n)
		if rn.op == OpEqual {
			continue
		}
		if i > 0 && out.runs[i-1].op != OpEqual {
			if k := len(out.blocks) - 1; out.changes <= MaxBlocks {
				out.blocks[k][1] += int(rn.n)
			}
			continue
		}
		out.changes++
		if out.changes <= MaxBlocks {
			out.blocks = append(out.blocks, [2]int{int(rn.start), int(rn.n)})
		}
	}
	return out, nil
}

// Info returns the diff's summary.
func (d *Diff) Info() Info {
	blocks := d.blocks
	if blocks == nil {
		blocks = [][2]int{}
	}
	return Info{
		Left:  SideInfo{Size: d.left.size, Lines: d.left.lines(), Encoding: d.left.enc},
		Right: SideInfo{Size: d.right.size, Lines: d.right.lines(), Encoding: d.right.enc},
		Rows:  d.rows, Changes: d.changes, Blocks: blocks, Identical: d.identical,
	}
}

// Row is one row of the side-by-side view.
type Row struct {
	Op Op
	// L and R are line numbers from 1; 0 where a side has no line.
	L, R int
	// Left and Right are the lines' text without the line end. An equal
	// row carries its text once, in Left.
	Left, Right string
	// Cut: a line was longer than MaxLineBytes.
	Cut bool
	// Spans marks what differs inside a changed row (Stage C10.5): the words
	// and characters that changed, as groups of [left from, left to, right
	// from, right to] in UTF-16 units (the renderer's string positions), one
	// group per changed place. Nil for rows that are not changed.
	Spans []int
}

// maxSpanCells bounds the table that matches the words of two lines; a pair of
// lines with more words than that between their common start and end is
// marked as one stretch.
const maxSpanCells = 40_000

// trim returns where two strings differ once their common start and end are
// taken away, as byte offsets: both start at from, the left one ends at
// leftTo and the right one at rightTo. The cuts fall between characters,
// never inside one.
func trim(l, r string) (from, leftTo, rightTo int) {
	// The common start.
	for from < len(l) && from < len(r) {
		a, an := utf8.DecodeRuneInString(l[from:])
		b, bn := utf8.DecodeRuneInString(r[from:])
		if a != b || an != bn {
			break
		}
		from += an
	}
	// The common end, never reaching into the common start.
	leftTo, rightTo = len(l), len(r)
	for leftTo > from && rightTo > from {
		a, an := utf8.DecodeLastRuneInString(l[from:leftTo])
		b, bn := utf8.DecodeLastRuneInString(r[from:rightTo])
		if a != b || an != bn {
			break
		}
		leftTo -= an
		rightTo -= bn
	}
	return from, leftTo, rightTo
}

// tokens is a line cut into words (letters, digits, marks and "_"), runs of
// white space, and single other characters. Token i is text[b[i]:b[i+1]], and
// starts at UTF-16 unit u[i].
type tokens struct {
	text string
	b, u []int
	word []bool
}

func (t *tokens) n() int          { return len(t.word) }
func (t *tokens) at(i int) string { return t.text[t.b[i]:t.b[i+1]] }

const (
	kindWord = iota
	kindSpace
	kindOther
)

func tokenize(s string) *tokens {
	t := &tokens{text: s, b: []int{0}, u: []int{0}}
	u, kind := 0, -1
	closeAt := func(i int) {
		t.b = append(t.b, i)
		t.u = append(t.u, u)
		t.word = append(t.word, kind == kindWord)
	}
	for i, c := range s {
		k := kindOther
		switch {
		case unicode.IsLetter(c) || unicode.IsDigit(c) || unicode.IsMark(c) || c == '_':
			k = kindWord
		case unicode.IsSpace(c):
			k = kindSpace
		}
		if i > 0 && (k != kind || k == kindOther) {
			closeAt(i)
		}
		kind = k
		u++
		if c >= 0x10000 {
			u++
		}
	}
	if len(s) > 0 {
		closeAt(len(s))
	}
	return t
}

// spans returns where two lines differ, as groups of four numbers in UTF-16
// units: [left from, left to, right from, right to], one group per changed
// place, in order. The lines are compared word by word; a place where one word
// became another is narrowed to the characters that differ. Nil when the
// lines are the same text.
func spans(l, r string) []int {
	lt, rt := tokenize(l), tokenize(r)
	n, m := lt.n(), rt.n()
	// The common start and end, in tokens.
	p := 0
	for p < n && p < m && lt.at(p) == rt.at(p) {
		p++
	}
	ln, rn := n, m
	for ln > p && rn > p && lt.at(ln-1) == rt.at(rn-1) {
		ln--
		rn--
	}
	var out []int
	// A changed place: tokens [i0, i1) of the left line and [j0, j1) of the right.
	add := func(i0, i1, j0, j1 int) {
		if i1-i0 == 1 && j1-j0 == 1 && lt.word[i0] && rt.word[j0] {
			x, y := lt.at(i0), rt.at(j0)
			from, xe, ye := trim(x, y)
			out = append(out,
				lt.u[i0]+utf16Len(x[:from]), lt.u[i0]+utf16Len(x[:xe]),
				rt.u[j0]+utf16Len(y[:from]), rt.u[j0]+utf16Len(y[:ye]))
			return
		}
		out = append(out, lt.u[i0], lt.u[i1], rt.u[j0], rt.u[j1])
	}
	a, b := ln-p, rn-p // the tokens between the common start and end
	switch {
	case a == 0 && b == 0:
		return nil
	case a == 0 || b == 0 || a*b > maxSpanCells:
		add(p, ln, p, rn)
		return out
	}
	// lcs[i*w+j]: the most words the tails a[i:] and b[j:] have in common.
	w := b + 1
	lcs := make([]uint16, (a+1)*w)
	same := func(i, j int) bool { return lt.at(p+i) == rt.at(p+j) }
	for i := a - 1; i >= 0; i-- {
		for j := b - 1; j >= 0; j-- {
			switch {
			case same(i, j):
				lcs[i*w+j] = lcs[(i+1)*w+j+1] + 1
			case lcs[(i+1)*w+j] >= lcs[i*w+j+1]:
				lcs[i*w+j] = lcs[(i+1)*w+j]
			default:
				lcs[i*w+j] = lcs[i*w+j+1]
			}
		}
	}
	// Walk both lines; a stretch between two shared words is a changed place.
	i, j, hi, hj := 0, 0, -1, -1
	for i < a || j < b {
		if i < a && j < b && same(i, j) {
			if hi >= 0 {
				add(p+hi, p+i, p+hj, p+j)
				hi = -1
			}
			i++
			j++
			continue
		}
		if hi < 0 {
			hi, hj = i, j
		}
		if j >= b || (i < a && lcs[(i+1)*w+j] >= lcs[i*w+j+1]) {
			i++
		} else {
			j++
		}
	}
	if hi >= 0 {
		add(p+hi, p+a, p+hj, p+b)
	}
	return out
}

// utf16Len is the length of s in UTF-16 units.
func utf16Len(s string) int {
	n := 0
	for _, c := range s {
		n++
		if c >= 0x10000 {
			n++
		}
	}
	return n
}

// Page returns rows [offset, offset+limit).
func (d *Diff) Page(offset, limit int) ([]Row, error) {
	offset = min(max(offset, 0), d.rows)
	end := min(offset+min(max(limit, 0), MaxPageRows), d.rows)
	rows := make([]Row, 0, end-offset)
	if end == offset {
		return rows, nil
	}
	at, _ := slices.BinarySearchFunc(d.runs, int32(offset), func(r run, k int32) int {
		switch {
		case r.start+r.n <= k:
			return -1
		case r.start > k:
			return 1
		}
		return 0
	})
	var ll, rl []int // lines to read per side
	for k := offset; k < end; k++ {
		for int(d.runs[at].start+d.runs[at].n) <= k {
			at++
		}
		rn := d.runs[at]
		i := int32(k) - rn.start
		row := Row{Op: rn.op}
		if rn.op != OpAdded {
			row.L = int(rn.l+i) + 1
			ll = append(ll, row.L-1)
		}
		if rn.op != OpRemoved {
			row.R = int(rn.r+i) + 1
			if rn.op != OpEqual {
				rl = append(rl, row.R-1)
			}
		}
		rows = append(rows, row)
	}
	lt, err := d.left.text(ll)
	if err != nil {
		return nil, err
	}
	rt, err := d.right.text(rl)
	if err != nil {
		return nil, err
	}
	li, ri := 0, 0
	for k := range rows {
		row := &rows[k]
		if row.Op != OpAdded {
			row.Left, row.Cut = lt[li].s, lt[li].cut
			li++
		}
		if row.Op == OpChanged || row.Op == OpAdded {
			row.Right = rt[ri].s
			row.Cut = row.Cut || rt[ri].cut
			ri++
		}
		if row.Op == OpChanged {
			row.Spans = spans(row.Left, row.Right)
		}
	}
	return rows, nil
}

type line struct {
	s   string
	cut bool
}

// text reads the given lines (ascending). Lines close together come from
// one read; the file must be as it was when compared.
func (f *file) text(lines []int) ([]line, error) {
	out := make([]line, len(lines))
	if len(lines) == 0 {
		return out, nil
	}
	fh, err := os.Open(f.path)
	if err != nil {
		return nil, err
	}
	defer fh.Close()
	fi, err := fh.Stat()
	if err != nil {
		return nil, err
	}
	if fi.Size() != f.size || fi.ModTime().UnixNano() != f.mtimeNs {
		return nil, ErrChanged
	}
	dec := f.enc.decoder()
	decode := func(b []byte) line {
		unit := f.enc.unit()
		b = trimEnd(b, unit, f.enc == UTF16BE)
		cut := len(b) > MaxLineBytes
		if cut {
			b = b[:MaxLineBytes-MaxLineBytes%unit]
			// Not half a character at the cut.
			for f.enc == UTF8 && len(b) > 0 {
				if r, size := utf8.DecodeLastRune(b); r != utf8.RuneError || size != 1 {
					break
				}
				b = b[:len(b)-1]
			}
		}
		if dec != nil {
			if s, err := dec.Bytes(b); err == nil {
				return line{s: string(s), cut: cut}
			}
		}
		return line{s: strings.ToValidUTF8(string(b), string(utf8.RuneError)), cut: cut}
	}
	// Each line needs at most its first MaxLineBytes and its line end.
	need := func(i int) (lo, hi int64) {
		lo, hi = int64(f.starts[i]), int64(f.starts[i+1])
		return lo, min(hi, lo+MaxLineBytes+4)
	}
	for i := 0; i < len(lines); {
		lo, hi := need(lines[i])
		j := i + 1
		for j < len(lines) {
			_, h := need(lines[j])
			if h-lo > spanBytes {
				break
			}
			hi = h
			j++
		}
		buf := make([]byte, hi-lo)
		if _, err := fh.ReadAt(buf, lo); err != nil {
			return nil, ErrChanged
		}
		for ; i < j; i++ {
			a, b := need(lines[i])
			out[i] = decode(buf[a-lo : b-lo])
			if full := int64(f.starts[lines[i]+1]); b < full {
				out[i].cut = true
			}
		}
	}
	return out, nil
}

// trimEnd drops a line's "\n" and a "\r" before it.
func trimEnd(b []byte, unit int, be bool) []byte {
	is := func(c byte) bool {
		if len(b) < unit {
			return false
		}
		if unit == 1 {
			return b[len(b)-1] == c
		}
		lo, hi := b[len(b)-2], b[len(b)-1]
		if be {
			lo, hi = hi, lo
		}
		return lo == c && hi == 0
	}
	if is('\n') {
		b = b[:len(b)-unit]
	}
	if is('\r') {
		b = b[:len(b)-unit]
	}
	return b
}
