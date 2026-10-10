package media

import "testing"

func TestClassify(t *testing.T) {
	cases := []struct {
		name string
		kind Kind
		ext  string
		ok   bool
	}{
		{"IMG_0001.JPG", KindImage, "jpg", true},
		{"a.b.c.tiff", KindImage, "tiff", true},
		{"clip.MP4", KindVideo, "mp4", true},
		{"movie.webm", KindVideo, "webm", true},
		{"notes.txt", 0, "txt", false},
		{".jpg", 0, "", false},      // dot-file with no stem
		{"noext", 0, "", false},     // no extension
		{"trailing.", 0, "", false}, // empty extension
	}
	for _, c := range cases {
		kind, ext, ok := Classify(c.name)
		if ok != c.ok || ext != c.ext || (ok && kind != c.kind) {
			t.Errorf("%s: got (%v,%q,%v)", c.name, kind, ext, ok)
		}
	}
}

func TestKindRoundTrip(t *testing.T) {
	for _, k := range []Kind{KindDir, KindImage, KindVideo} {
		if got, ok := ParseKind(k.String()); !ok || got != k {
			t.Fatalf("%v", k)
		}
	}
	if _, ok := ParseKind("nope"); ok {
		t.Fatal("parsed unknown kind")
	}
}
