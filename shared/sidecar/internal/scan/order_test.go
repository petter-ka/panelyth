package scan

import (
	"slices"
	"testing"
)

// NTFS lists names by upper-cased runes; the scanner orders every chunk the
// same way, so ids match across filesystems.
func TestCompareUpperMatchesNTFSOrder(t *testing.T) {
	names := []string{"photo_0002.jpg", "IMG_0.jpg", "folder 1", "img_0.jpg", "Folder", "_x", "é.jpg", "E.jpg", "ab", "a"}
	slices.SortFunc(names, compareUpper)
	want := []string{"a", "ab", "E.jpg", "Folder", "folder 1", "IMG_0.jpg", "img_0.jpg", "photo_0002.jpg", "_x", "é.jpg"}
	if !slices.Equal(names, want) {
		t.Fatalf("order %q, want %q", names, want)
	}
}

func BenchmarkSortChunk(b *testing.B) {
	names := make([]string, 512)
	for i := range names {
		names[i] = string(rune('a'+i%26)) + "IMG_" + string(rune('0'+i%10)) + ".jpg"
	}
	buf := make([]string, len(names))
	b.ReportAllocs()
	for b.Loop() {
		copy(buf, names)
		slices.SortFunc(buf, compareUpper)
	}
}
