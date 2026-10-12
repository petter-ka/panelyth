package textdiff

import (
	"context"
	"slices"
)

// Op says how the two sides of a row relate.
type Op uint8

const (
	// OpEqual: the same line on both sides.
	OpEqual Op = iota
	// OpChanged: a line on each side, and they differ.
	OpChanged
	// OpRemoved: a line on the left only.
	OpRemoved
	// OpAdded: a line on the right only.
	OpAdded
)

var opNames = [...]string{"equal", "changed", "removed", "added"}

func (o Op) String() string { return opNames[o] }

// run is a stretch of rows of one kind: n lines from l on the left and from
// r on the right (only one of them for removed and added lines).
type run struct {
	op    Op
	l, r  int32
	n     int32
	start int32 // its first row
}

// match is a stretch of n equal lines, a[i:i+n] and b[j:j+n].
type match struct{ i, j, n int32 }

// differ finds the lines two sequences share, in order. Lines are small
// integers (equal lines have equal numbers).
//
// It is a patience diff: lines that occur exactly once on both sides are
// taken as anchors (their longest common order), and the stretches between
// anchors are compared the same way. A stretch without anchors goes to a
// bounded Myers search; when that would cost too much, the stretch counts
// as replaced. The result is always a valid comparison, and a minimal one
// for the usual case of a few changes between two versions of a file.
type differ struct {
	ctx      context.Context
	a, b     []int32
	matches  []match
	cntA     []int32
	cntB     []int32
	posB     []int32
	work     int // steps left for Myers searches
	canceled bool
}

// myersBudget bounds the steps spent in Myers searches per diff, and
// myersDepth the edits one search looks for (its memory grows with the
// square of it).
const (
	myersBudget = 64 << 20
	myersDepth  = 1024
)

func (d *differ) add(i, j, n int) {
	if n == 0 {
		return
	}
	if k := len(d.matches) - 1; k >= 0 {
		if m := &d.matches[k]; int(m.i+m.n) == i && int(m.j+m.n) == j {
			m.n += int32(n)
			return
		}
	}
	d.matches = append(d.matches, match{int32(i), int32(j), int32(n)})
}

func (d *differ) diff(a0, a1, b0, b1 int) {
	if d.canceled {
		return
	}
	// Common start and end.
	p := 0
	for a0+p < a1 && b0+p < b1 && d.a[a0+p] == d.b[b0+p] {
		p++
	}
	d.add(a0, b0, p)
	a0, b0 = a0+p, b0+p
	s := 0
	for a1-s > a0 && b1-s > b0 && d.a[a1-s-1] == d.b[b1-s-1] {
		s++
	}
	a1, b1 = a1-s, b1-s
	defer d.add(a1, b1, s)
	if a0 == a1 || b0 == b1 {
		return
	}
	if a1-a0+b1-b0 > 4096 && d.ctx.Err() != nil {
		d.canceled = true
		return
	}

	// Anchors: lines that occur once in each stretch.
	for i := a0; i < a1; i++ {
		d.cntA[d.a[i]]++
	}
	for j := b0; j < b1; j++ {
		d.cntB[d.b[j]]++
		d.posB[d.b[j]] = int32(j)
	}
	var cand []match // i, j of each candidate
	for i := a0; i < a1; i++ {
		if id := d.a[i]; d.cntA[id] == 1 && d.cntB[id] == 1 {
			cand = append(cand, match{i: int32(i), j: d.posB[id]})
		}
	}
	for i := a0; i < a1; i++ {
		d.cntA[d.a[i]] = 0
	}
	for j := b0; j < b1; j++ {
		d.cntB[d.b[j]] = 0
	}
	anchors := increasing(cand)
	if len(anchors) == 0 {
		d.myers(a0, a1, b0, b1)
		return
	}
	pi, pj := a0, b0
	for _, an := range anchors {
		d.diff(pi, int(an.i), pj, int(an.j))
		d.add(int(an.i), int(an.j), 1)
		pi, pj = int(an.i)+1, int(an.j)+1
	}
	d.diff(pi, a1, pj, b1)
}

// increasing returns the longest stretch of candidates (ordered by i) whose
// j also increase: patience sorting.
func increasing(cand []match) []match {
	if len(cand) < 2 {
		return cand
	}
	tails := make([]int32, 0, 64) // index into cand of the last element of a run of each length
	prev := make([]int32, len(cand))
	for k, c := range cand {
		at, _ := slices.BinarySearchFunc(tails, c.j, func(t, j int32) int { return int(cand[t].j - j) })
		prev[k] = -1
		if at > 0 {
			prev[k] = tails[at-1]
		}
		if at == len(tails) {
			tails = append(tails, int32(k))
		} else {
			tails[at] = int32(k)
		}
	}
	out := make([]match, len(tails))
	for k, at := tails[len(tails)-1], len(tails)-1; k >= 0; k, at = prev[k], at-1 {
		out[at] = cand[k]
	}
	return out
}

// myers is the greedy shortest-edit search on a stretch without anchors,
// within the diff's step budget; beyond it the stretch stays unmatched.
func (d *differ) myers(a0, a1, b0, b1 int) {
	n, m := a1-a0, b1-b0
	limit := min(n+m, myersDepth)
	off := limit + 1
	v := make([]int32, 2*limit+3)
	var trace [][]int32
	found := -1
search:
	for D := 0; D <= limit && d.work > 0; D++ {
		// The state before this step: what the way back reads.
		trace = append(trace, slices.Clone(v[off-D-1:off+D+2]))
		steps := 2*D + 3
		for k := -D; k <= D; k += 2 {
			var x int32
			if k == -D || (k != D && v[off+k-1] < v[off+k+1]) {
				x = v[off+k+1]
			} else {
				x = v[off+k-1] + 1
			}
			y := x - int32(k)
			for int(x) < n && int(y) < m && d.a[a0+int(x)] == d.b[b0+int(y)] {
				x++
				y++
				steps++
			}
			v[off+k] = x
			if int(x) >= n && int(y) >= m {
				found = D
				break search
			}
		}
		d.work -= steps
	}
	if found < 0 {
		return
	}
	// Walk back, collecting the diagonals.
	var back []match
	x, y := int32(n), int32(m)
	for D := found; D > 0; D-- {
		prev := trace[D] // v[k] is prev[k+D+1]
		k := int(x - y)
		pk := k - 1
		if k == -D || (k != D && prev[k-1+D+1] < prev[k+1+D+1]) {
			pk = k + 1
		}
		px := prev[pk+D+1]
		py := px - int32(pk)
		for x > px && y > py {
			x--
			y--
			back = append(back, match{i: int32(a0) + x, j: int32(b0) + y})
		}
		x, y = px, py
	}
	for x > 0 && y > 0 {
		x--
		y--
		back = append(back, match{i: int32(a0) + x, j: int32(b0) + y})
	}
	for k := len(back) - 1; k >= 0; k-- {
		d.add(int(back[k].i), int(back[k].j), 1)
	}
}

// runs turns the matches into the rows of a side-by-side view: between two
// stretches of equal lines, lines pair up as changed as far as both sides
// have some, and the rest are removed or added.
func runs(matches []match, n, m int) []run {
	var out []run
	var start int32
	push := func(op Op, l, r, count int32) {
		if count <= 0 {
			return
		}
		out = append(out, run{op: op, l: l, r: r, n: count, start: start})
		start += count
	}
	var pi, pj int32
	gap := func(i, j int32) {
		dl, dr := i-pi, j-pj
		c := min(dl, dr)
		push(OpChanged, pi, pj, c)
		push(OpRemoved, pi+c, pj+c, dl-c)
		push(OpAdded, pi+c, pj+c, dr-c)
	}
	for _, mt := range matches {
		gap(mt.i, mt.j)
		push(OpEqual, mt.i, mt.j, mt.n)
		pi, pj = mt.i+mt.n, mt.j+mt.n
	}
	gap(int32(n), int32(m))
	return out
}
