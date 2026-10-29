package textdiff

import (
	"slices"
	"testing"
	"unicode/utf16"
)

// Stage C10.5: what differs inside a changed line.
func TestSpans(t *testing.T) {
	cases := []struct {
		name        string
		left, right string
		want        []int
	}{
		{"one word", "the quick fox", "the slow fox", []int{4, 9, 4, 8}},
		{"added in the middle", "ab", "aXb", []int{1, 1, 1, 2}},
		{"removed at the end", "abc", "ab", []int{2, 3, 2, 2}},
		{"nothing in common", "abc", "xyz", []int{0, 3, 0, 3}},
		{"one is empty", "", "new", []int{0, 0, 0, 3}},
		// The common end never reaches into the common start.
		{"repeated letters", "aaa", "aa", []int{2, 3, 2, 2}},
		{"accents are whole characters", "café au lait", "cafe au lait", []int{3, 4, 3, 4}},
		// Outside the BMP a character is two UTF-16 units.
		{"after an emoji", "😀 one", "😀 two", []int{3, 6, 3, 6}},
		{"an emoji changes", "a😀b", "a😁b", []int{1, 3, 1, 3}},
		// Several places in one line: each is marked, what lies between is not.
		{"two words change", "the quick brown fox", "the slow brown cat", []int{4, 9, 4, 8, 16, 19, 15, 18}},
		{"a word is added", "one three", "one two three", []int{4, 4, 4, 8}},
		{"a word is removed", "one two three", "one three", []int{4, 8, 4, 4}},
		{"a changed character", "color: red;", "colour: red;", []int{4, 4, 4, 5}},
		{"punctuation", "f(a, b)", "f(a; b)", []int{3, 4, 3, 4}},
		{"words swap", "red green", "green red", []int{0, 4, 0, 0, 9, 9, 5, 9}},
		{"white space", "a  b", "a b", []int{1, 3, 1, 2}},
		{"the same text", "same", "same", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := spans(c.left, c.right)
			if !slices.Equal(got, c.want) {
				t.Fatalf("spans %v, want %v", got, c.want)
			}
			// What is outside the spans is the same text on both sides.
			l, r := utf16.Encode([]rune(c.left)), utf16.Encode([]rune(c.right))
			var lo, ro []uint16
			lp, rp := 0, 0
			for k := 0; k+3 < len(got); k += 4 {
				lo, ro = append(lo, l[lp:got[k]]...), append(ro, r[rp:got[k+2]]...)
				lp, rp = got[k+1], got[k+3]
			}
			lo, ro = append(lo, l[lp:]...), append(ro, r[rp:]...)
			if !slices.Equal(lo, ro) {
				t.Errorf("the parts outside %v differ: %q and %q", got, utf16.Decode(lo), utf16.Decode(ro))
			}
		})
	}
}

// A line with more words than the table takes is marked as one stretch.
func TestSpansOfLongLines(t *testing.T) {
	var l, r []byte
	for range 500 {
		l = append(l, "aa bb "...)
		r = append(r, "cc dd "...)
	}
	got := spans(string(l), string(r))
	// The line end they share is not part of it.
	if want := []int{0, len(l) - 1, 0, len(r) - 1}; !slices.Equal(got, want) {
		t.Errorf("spans %v, want %v", got, want)
	}
}

func TestPageMarksChangedRowsOnly(t *testing.T) {
	d := diffOf(t, []byte("same\nalpha beta\ngone\n"), []byte("same\nalpha gamma\n"))
	rows, err := d.Page(0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 {
		t.Fatalf("rows %+v", rows)
	}
	if rows[0].Spans != nil || rows[2].Spans != nil {
		t.Errorf("an equal or a one-sided row has spans: %+v", rows)
	}
	// "alpha " starts both and "a" ends both: "bet" against "gamm".
	if want := []int{6, 9, 6, 10}; !slices.Equal(rows[1].Spans, want) {
		t.Errorf("spans %v, want %v", rows[1].Spans, want)
	}
}
