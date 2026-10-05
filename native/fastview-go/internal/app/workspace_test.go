package app

import (
	"slices"
	"testing"
)

func TestApplySelection(t *testing.T) {
	ids := []int64{10, 11, 12, 13, 14, 15}
	cases := []struct {
		name string
		sel  selectionWire
		want []int64
	}{
		{"ranges", selectionWire{Ranges: [][2]int{{0, 2}, {4, 6}}}, []int64{10, 11, 14, 15}},
		{"overlap dedup", selectionWire{Ranges: [][2]int{{0, 3}, {1, 4}}}, []int64{10, 11, 12, 13}},
		{"exclude wins", selectionWire{Ranges: [][2]int{{0, 6}}, Exclude: []int64{12, 14}, Include: []int64{14}}, []int64{10, 11, 13, 15}},
		{"include after ranges", selectionWire{Ranges: [][2]int{{5, 6}}, Include: []int64{10, 15}}, []int64{15, 10}},
		{"clamped past end", selectionWire{Ranges: [][2]int{{4, 1000}, {900, 1000}}}, []int64{14, 15}},
		{"empty", selectionWire{}, []int64{}},
	}
	for _, c := range cases {
		got, err := applySelection(ids, c.sel)
		if err != nil || !slices.Equal(got, c.want) {
			t.Errorf("%s: got %v %v want %v", c.name, got, err, c.want)
		}
	}
	for _, bad := range [][2]int{{-1, 2}, {3, 2}} {
		if _, err := applySelection(ids, selectionWire{Ranges: [][2]int{bad}}); err == nil {
			t.Errorf("range %v accepted", bad)
		}
	}
}

func TestRebase(t *testing.T) {
	// Old order 10..15; after a refresh 12 is gone and 20 was inserted.
	current := []int64{10, 20, 11, 13, 14, 15}
	got := rebase(current, []int64{10, 11, 12, 15}, 7, 3)
	if got.QueryID != 7 || got.Version != 3 || len(got.Include) != 0 || len(got.Exclude) != 0 {
		t.Fatalf("header %+v", got)
	}
	if want := [][2]int{{0, 1}, {2, 3}, {5, 6}}; !slices.Equal(got.Ranges, want) {
		t.Fatalf("ranges %v want %v", got.Ranges, want)
	}
	if all := rebase(current, current, 1, 1); !slices.Equal(all.Ranges, [][2]int{{0, 6}}) {
		t.Fatalf("select all stays one range: %v", all.Ranges)
	}
}

func TestValidExt(t *testing.T) {
	for _, ok := range []string{"jpg", "mp4", "jpeg"} {
		if !validExt(ok) {
			t.Errorf("%q rejected", ok)
		}
	}
	for _, bad := range []string{"", "JPG", ".jpg", "a b", "%", "verylongextension"} {
		if validExt(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}
