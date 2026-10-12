package textdiff

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

var ctx = context.Background()

func writeFile(t testing.TB, dir, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func utf16le(s string, mark bool) []byte {
	var out []byte
	if mark {
		out = append(out, 0xFF, 0xFE)
	}
	for _, u := range utf16.Encode([]rune(s)) {
		out = append(out, byte(u), byte(u>>8))
	}
	return out
}

func utf16be(s string) []byte {
	out := []byte{0xFE, 0xFF}
	for _, u := range utf16.Encode([]rune(s)) {
		out = append(out, byte(u>>8), byte(u))
	}
	return out
}

// all pages through a diff and renders its rows: "= a", "~ a|b", "- a", "+ b".
func all(t testing.TB, d *Diff) []string {
	t.Helper()
	var out []string
	for off := 0; off < d.Info().Rows; off += 7 { // an odd page size crosses runs
		rows, err := d.Page(off, 7)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range rows {
			switch r.Op {
			case OpEqual:
				out = append(out, "= "+r.Left)
			case OpChanged:
				out = append(out, "~ "+r.Left+"|"+r.Right)
			case OpRemoved:
				out = append(out, "- "+r.Left)
			case OpAdded:
				out = append(out, "+ "+r.Right)
			}
		}
	}
	return out
}

func diffOf(t testing.TB, left, right []byte) *Diff {
	t.Helper()
	dir := t.TempDir()
	d, err := Open(ctx, writeFile(t, dir, "left.txt", left), writeFile(t, dir, "right.txt", right))
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestRows(t *testing.T) {
	cases := []struct {
		name        string
		left, right string
		want        []string
		changes     int
	}{
		{"identical", "a\nb\nc\n", "a\nb\nc\n", []string{"= a", "= b", "= c"}, 0},
		{"changed line", "a\nb\nc\n", "a\nB\nc\n", []string{"= a", "~ b|B", "= c"}, 1},
		{"added", "a\nc\n", "a\nb\nc\n", []string{"= a", "+ b", "= c"}, 1},
		{"removed", "a\nb\nc\n", "a\nc\n", []string{"= a", "- b", "= c"}, 1},
		{"added at the end, no final newline", "a\n", "a\nb", []string{"= a", "+ b"}, 1},
		{"removed at the start", "x\ny\na\n", "a\n", []string{"- x", "- y", "= a"}, 1},
		{"a block grows", "a\nb\nz\n", "a\nB\nC\nD\nz\n", []string{"= a", "~ b|B", "+ C", "+ D", "= z"}, 1},
		{"two places", "a\nb\nc\nd\ne\n", "a\nX\nc\nd\nY\n", []string{"= a", "~ b|X", "= c", "= d", "~ e|Y"}, 2},
		{"empty left", "", "a\nb\n", []string{"+ a", "+ b"}, 1},
		{"both empty", "", "", nil, 0},
		{"empty lines", "\n\na\n", "\na\n", []string{"= ", "- ", "= a"}, 1},
		// No line occurs once on both sides: the Myers search pairs them.
		{"repeated lines", "x\nx\ny\nx\n", "x\ny\ny\nx\n", []string{"= x", "~ x|y", "= y", "= x"}, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := diffOf(t, []byte(c.left), []byte(c.right))
			if got := all(t, d); !slices.Equal(got, c.want) {
				t.Errorf("rows %q, want %q", got, c.want)
			}
			in := d.Info()
			if in.Changes != c.changes || len(in.Blocks) != c.changes || in.Identical != (c.left == c.right) {
				t.Errorf("info %+v", in)
			}
		})
	}
}

func TestLineEndsAndEncodings(t *testing.T) {
	// CR LF against LF: no changed line, but not the same bytes.
	d := diffOf(t, []byte("a\r\nb\r\n"), []byte("a\nb\n"))
	if in := d.Info(); in.Changes != 0 || in.Identical || in.Left.Lines != 2 {
		t.Errorf("crlf: %+v", in)
	}
	if got := all(t, d); !slices.Equal(got, []string{"= a", "= b"}) {
		t.Errorf("crlf rows %q", got)
	}

	text := "első sor\nmásodik: ű\nthird\n"
	for name, right := range map[string][]byte{
		"utf-16le with a mark": utf16le(text, true),
		"utf-16le, no mark":    utf16le(text, false),
		"utf-16be":             utf16be(text),
		"utf-8 with a mark":    append([]byte{0xEF, 0xBB, 0xBF}, text...),
	} {
		d := diffOf(t, []byte(text), right)
		if in := d.Info(); in.Changes != 0 || in.Identical || in.Right.Lines != 3 {
			t.Errorf("%s: %+v", name, in)
		}
		if got := all(t, d); len(got) != 3 || got[1] != "= második: ű" {
			t.Errorf("%s: rows %q", name, got)
		}
	}
	// The right side's own text is decoded for changed rows.
	d = diffOf(t, []byte("a\nb\n"), utf16le("a\r\nű\r\n", true))
	if got := all(t, d); !slices.Equal(got, []string{"= a", "~ b|ű"}) {
		t.Errorf("utf-16 changed rows %q", got)
	}
	if d.Info().Right.Encoding != UTF16LE {
		t.Errorf("encoding %s", d.Info().Right.Encoding)
	}
	// Windows-1252 against UTF-8: é is one byte on the left.
	d = diffOf(t, []byte("caf\xe9\nx\n"), []byte("café\nx\n"))
	if in := d.Info(); in.Changes != 0 || in.Left.Encoding != Latin || in.Right.Encoding != UTF8 {
		t.Errorf("latin: %+v", in)
	}
	if got := all(t, d); got[0] != "= café" {
		t.Errorf("latin rows %q", got)
	}
}

func TestNotText(t *testing.T) {
	dir := t.TempDir()
	text := writeFile(t, dir, "a.txt", []byte("a\n"))
	bin := writeFile(t, dir, "a.bin", []byte{1, 2, 0, 3, 0, 0, 0, 7, 0xff, 0, 9})
	if _, err := Open(ctx, text, bin); !errors.Is(err, ErrBinary) {
		t.Errorf("binary: %v", err)
	}
	if _, err := Open(ctx, bin, text); !errors.Is(err, ErrBinary) {
		t.Errorf("binary on the left: %v", err)
	}
	big := writeFile(t, dir, "big.txt", nil)
	if err := os.Truncate(big, MaxBytes+1); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(ctx, text, big); !errors.Is(err, ErrTooLarge) {
		t.Errorf("too large: %v", err)
	}
	if _, err := Open(ctx, text, filepath.Join(dir, "missing")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("missing: %v", err)
	}
	if _, err := Open(ctx, text, dir); !errors.Is(err, ErrBinary) {
		t.Errorf("a folder: %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := Open(cancelled, text, text); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled: %v", err)
	}
}

func TestLongLinesAreCut(t *testing.T) {
	long := strings.Repeat("é", 5000) // 10,000 bytes
	d := diffOf(t, []byte("a\n"+long+"\nz\n"), []byte("a\n"+long+"!\nz\n"))
	rows, err := d.Page(0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 || rows[1].Op != OpChanged || !rows[1].Cut || rows[0].Cut || rows[2].Left != "z" {
		t.Fatalf("rows %+v", rows[0])
	}
	if n := len(rows[1].Left); n > MaxLineBytes || n < MaxLineBytes-4 || strings.ContainsRune(rows[1].Left, '�') {
		t.Errorf("cut line has %d bytes", n)
	}
}

func TestChangedFileIsRefused(t *testing.T) {
	dir := t.TempDir()
	l := writeFile(t, dir, "l.txt", []byte("a\nb\n"))
	r := writeFile(t, dir, "r.txt", []byte("a\nc\n"))
	d, err := Open(ctx, l, r)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r, []byte("a\nc\nd\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(r, time.Now().Add(time.Hour), time.Now().Add(time.Hour))
	if _, err := d.Page(0, 10); !errors.Is(err, ErrChanged) {
		t.Errorf("page of a changed file: %v", err)
	}
}

func TestPageBounds(t *testing.T) {
	d := diffOf(t, []byte("a\nb\nc\n"), []byte("a\nb\nc\n"))
	for _, c := range []struct{ off, limit, want int }{{0, 2, 2}, {2, 10, 1}, {3, 10, 0}, {-5, 1, 1}, {0, 0, 0}, {99, 5, 0}} {
		rows, err := d.Page(c.off, c.limit)
		if err != nil || len(rows) != c.want {
			t.Errorf("page(%d, %d): %d rows, %v", c.off, c.limit, len(rows), err)
		}
	}
}

// Whatever the input, the rows must rebuild both files, and equal rows must
// pair equal lines.
func TestRandomDiffsAreValid(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	for round := range 200 {
		alphabet := 2 + rng.IntN(30)
		gen := func(n int) []string {
			out := make([]string, n)
			for i := range out {
				out[i] = fmt.Sprintf("line %d", rng.IntN(alphabet))
			}
			return out
		}
		left := gen(rng.IntN(120))
		// The right side: the left one with random edits, or unrelated.
		right := slices.Clone(left)
		if round%5 == 0 {
			right = gen(rng.IntN(120))
		}
		for range rng.IntN(8) {
			at := rng.IntN(len(right) + 1)
			switch rng.IntN(3) {
			case 0:
				right = slices.Insert(right, at, fmt.Sprintf("new %d", rng.IntN(1000)))
			case 1:
				if at < len(right) {
					right = slices.Delete(right, at, at+1)
				}
			default:
				if at < len(right) {
					right[at] = fmt.Sprintf("line %d", rng.IntN(alphabet))
				}
			}
		}
		join := func(lines []string) []byte {
			if len(lines) == 0 {
				return nil
			}
			return []byte(strings.Join(lines, "\n") + "\n")
		}
		d := diffOf(t, join(left), join(right))
		var gotL, gotR []string
		for _, row := range all(t, d) {
			op, text := row[:1], row[2:]
			switch op {
			case "=":
				gotL, gotR = append(gotL, text), append(gotR, text)
			case "~":
				l, r, _ := strings.Cut(text, "|")
				if l == r {
					t.Fatalf("round %d: a changed row with equal sides %q", round, text)
				}
				gotL, gotR = append(gotL, l), append(gotR, r)
			case "-":
				gotL = append(gotL, text)
			case "+":
				gotR = append(gotR, text)
			}
		}
		if !slices.Equal(gotL, left) || !slices.Equal(gotR, right) {
			t.Fatalf("round %d: rows do not rebuild the files\nleft  %q\nright %q\nrows  %q", round, left, right, all(t, d))
		}
	}
}

// Two versions of a file with a few edits compare as those edits.
func TestFewChangesInManyLines(t *testing.T) {
	var left, right strings.Builder
	for i := range 20_000 {
		fmt.Fprintf(&left, "record %d of the file\n", i)
		switch {
		case i == 5000:
			fmt.Fprintf(&right, "record %d was edited\n", i)
		case i == 9000: // removed
		case i == 15000:
			fmt.Fprintf(&right, "record %d of the file\nan inserted line\n", i)
		default:
			fmt.Fprintf(&right, "record %d of the file\n", i)
		}
	}
	d := diffOf(t, []byte(left.String()), []byte(right.String()))
	in := d.Info()
	if in.Changes != 3 || in.Rows != 20_001 || in.Left.Lines != 20_000 || in.Right.Lines != 20_000 {
		t.Fatalf("info %+v", in)
	}
	if want := [][2]int{{5000, 1}, {9000, 1}, {15001, 1}}; !slices.Equal(in.Blocks, want) {
		t.Errorf("blocks %v, want %v", in.Blocks, want)
	}
	rows, _ := d.Page(15000, 2)
	if rows[0].Op != OpEqual || rows[0].L != 15001 || rows[0].R != 15000 || rows[1].Op != OpAdded || rows[1].Right != "an inserted line" {
		t.Errorf("rows %+v", rows)
	}
}

// Two unrelated files stay within the step budget and compare as replaced.
func TestUnrelatedFilesStayBounded(t *testing.T) {
	var left, right strings.Builder
	for i := range 60_000 {
		fmt.Fprintf(&left, "%d\n", i%7)
		fmt.Fprintf(&right, "%d\n", (i*3+1)%11)
	}
	start := time.Now()
	d := diffOf(t, []byte(left.String()), []byte(right.String()))
	if took := time.Since(start); took > 20*time.Second {
		t.Errorf("took %s", took)
	}
	if in := d.Info(); in.Rows < 60_000 || in.Left.Lines != 60_000 {
		t.Errorf("info %+v", in)
	}
}
