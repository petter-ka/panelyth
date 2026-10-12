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
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := spans(c.left, c.right)
			if !slices.Equal(got, c.want) {
				t.Fatalf("spans %v, want %v", got, c.want)
			}
			// What is outside the spans is the same text on both sides.
			l, r := utf16.Encode([]rune(c.left)), utf16.Encode([]rune(c.right))
			if !slices.Equal(l[:got[0]], r[:got[2]]) || !slices.Equal(l[got[1]:], r[got[3]:]) {
				t.Errorf("the parts outside %v differ", got)
			}
		})
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
