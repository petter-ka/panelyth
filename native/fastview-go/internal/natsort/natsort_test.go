package natsort

import (
	"slices"
	"testing"
)

func TestNaturalOrder(t *testing.T) {
	want := []string{
		"a.jpg",
		"IMG_2.jpg",
		"img_10.jpg",
		"IMG_10a.jpg",
		"IMG_100.jpg",
		"IMG_1000.jpg",
		"photo 9 (2).png",
		"photo 10 (1).png",
		"z0.jpg",
	}
	got := slices.Clone(want)
	slices.Reverse(got)
	slices.SortFunc(got, func(a, b string) int {
		ka, kb := Key(a), Key(b)
		switch {
		case ka < kb:
			return -1
		case ka > kb:
			return 1
		}
		return 0
	})
	if !slices.Equal(got, want) {
		t.Fatalf("got %q", got)
	}
}

func TestLeadingZerosEqual(t *testing.T) {
	if Key("x01") != Key("x1") {
		t.Fatal("leading zeros should not change the key")
	}
	if Key("x0") != Key("x000") {
		t.Fatal("zero run should normalize")
	}
}

func TestUnicodePreserved(t *testing.T) {
	if Key("Ärger 2") != "ärger 012" {
		t.Fatalf("got %q", Key("Ärger 2"))
	}
}

func BenchmarkKey(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		_ = Key("IMG_20240712_183455_0042.JPG")
	}
}
