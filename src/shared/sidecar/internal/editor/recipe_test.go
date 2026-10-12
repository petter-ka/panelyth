package editor

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"panelyth/sidecar/internal/imaging"
)

func recipe(t testing.TB, ops string, out Output) Recipe {
	t.Helper()
	return Recipe{Version: RecipeVersion, Ops: edits(t, ops), Output: out}
}

var plainOutput = Output{Format: "jpeg", Quality: 85, Metadata: imaging.MetaKeep, Destination: DestBeside, Conflict: ConflictKeepBoth}

func codes(ps []Problem) string {
	var s []string
	for _, p := range ps {
		s = append(s, strings.TrimRight(p.Code+":"+p.Op+":"+p.Detail, ":"))
	}
	return strings.Join(s, " ")
}

func TestRecipeProblems(t *testing.T) {
	ok := recipe(t, `[{"op":"resize","p":{"mode":"fit","w":800,"h":800}},{"op":"grayscale","p":{"method":"luminance"}}]`, plainOutput)
	if p := ok.Problems(func(string) bool { return false }); len(p) != 0 {
		t.Fatalf("a valid recipe has problems: %v", p)
	}
	with := func(change func(*Recipe)) Recipe {
		r := recipe(t, `[{"op":"flip","p":{"axis":"h"}}]`, plainOutput)
		change(&r)
		return r
	}
	many := `[` + strings.TrimSuffix(strings.Repeat(`{"op":"flip","p":{"axis":"h"}},`, MaxRecipeOps+1), ",") + `]`
	asset := strings.Repeat("ab", 16)
	marked := recipe(t, `[{"op":"watermark","p":{"kind":"image","assetId":"`+asset+`","size":10}}]`, plainOutput)
	cases := []struct {
		name string
		r    Recipe
		want string
	}{
		{"version", with(func(r *Recipe) { r.Version = 2 }), "version::2"},
		{"too many", recipe(t, many, plainOutput), "tooManyOps::64"},
		{"free-hand tools", recipe(t, `[{"op":"draw","p":{"strokes":[]}},{"op":"clone","p":{}},{"op":"heal","p":{}},{"op":"redeye","p":{}}]`, plainOutput),
			"notBatchable:draw notBatchable:clone notBatchable:heal notBatchable:redeye"},
		{"unknown operation", recipe(t, `[{"op":"exec","p":{"path":"C:\\Windows\\cmd.exe"}}]`, plainOutput), "invalidOp:exec:unknown operation"},
		{"asset not picked", marked, "missingAsset:watermark"},
		{"format", with(func(r *Recipe) { r.Output.Format = "webp" }), "format::webp"},
		{"quality", with(func(r *Recipe) { r.Output.Quality = 101 }), "quality::101"},
		{"metadata", with(func(r *Recipe) { r.Output.Metadata = "all" }), "metadata::all"},
		{"dpi", with(func(r *Recipe) { r.Output.DPI = -1 }), "dpi"},
		{"destination", with(func(r *Recipe) { r.Output.Destination = "C:\\out" }), "destination::C:\\out"},
		{"conflict", with(func(r *Recipe) { r.Output.Conflict = "ask" }), "conflict::ask"},
		{"replace keeps the format", with(func(r *Recipe) { r.Output.Destination = DestReplace }), "format::jpeg"},
		{"template is a name", with(func(r *Recipe) { r.Output.Template = "..\\{name}" }), "template::a name, not a path"},
		{"template characters", with(func(r *Recipe) { r.Output.Template = "{name}: {n:0}?" }), "template::characters a file name can't have"},
		{"template length", with(func(r *Recipe) { r.Output.Template = strings.Repeat("x", MaxTemplate+1) }), "template::too long"},
		{"unknown tokens", with(func(r *Recipe) { r.Output.Template = "{name}-{foo}-{n:3}-{exif.model}-{camera}" }), "unknownToken::foo unknownToken::camera"},
	}
	for _, c := range cases {
		if got := codes(c.r.Problems(func(string) bool { return false })); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
	// Parameters the operation does not have, or values outside its range.
	for _, ops := range []string{
		`[{"op":"flip","p":{"axis":"z"}}]`,
		`[{"op":"flip","p":{"axis":"h","file":"/etc/passwd"}}]`,
		`[{"op":"resize","p":{"mode":"fit","w":-5,"h":0}}]`,
		`[{"op":"flip","p":"h"}]`,
	} {
		p := recipe(t, ops, plainOutput).Problems(nil)
		if len(p) != 1 || p[0].Code != "invalidOp" || p[0].Detail == "" {
			t.Errorf("%s: %v", ops, p)
		}
	}
	// With the asset registered, or with no check, the recipe is fine.
	if p := marked.Problems(func(id string) bool { return id == asset }); len(p) != 0 {
		t.Errorf("registered asset: %v", p)
	}
	if p := marked.Problems(nil); len(p) != 0 {
		t.Errorf("no asset check: %v", p)
	}
	// Everything wrong at once is reported at once.
	all := with(func(r *Recipe) {
		r.Version, r.Output = 0, Output{Format: "x", Quality: -3, Metadata: "", DPI: 1e6, Destination: "", Conflict: "", Template: "{bad}"}
	})
	if got := len(all.Problems(nil)); got != 8 {
		t.Errorf("all problems: %d (%s)", got, codes(all.Problems(nil)))
	}
}

func TestParseRecipeIsStrict(t *testing.T) {
	good, _ := json.Marshal(recipe(t, `[{"op":"flip","p":{"axis":"h"}}]`, plainOutput))
	r, err := ParseRecipe(good)
	if err != nil || len(r.Ops) != 1 || r.Output.Format != "jpeg" {
		t.Fatalf("round trip: %+v %v", r, err)
	}
	refused := map[string]string{
		"not json":      `{"version":1,`,
		"unknown field": `{"version":1,"ops":[],"output":{"format":"keep"},"run":"calc.exe"}`,
		"a path in out": `{"version":1,"ops":[],"output":{"format":"keep","folder":"C:\\Windows"}}`,
		"wrong types":   `{"version":"1","ops":{},"output":[]}`,
		"an array":      `[1,2,3]`,
		"huge":          `{"version":1,"ops":[],"output":{"template":"` + strings.Repeat("a", MaxRecipeBytes) + `"}}`,
	}
	for name, raw := range refused {
		if r, err := ParseRecipe([]byte(raw)); err == nil {
			t.Errorf("%s: accepted %+v", name, r)
		}
	}
	// Read as data and then found wanting: nothing in it runs.
	nested := `{"version":1,"ops":[{"op":"flip","p":` + strings.Repeat(`{"a":`, 2000) + `1` + strings.Repeat(`}`, 2000) + `}],"output":{}}`
	for name, raw := range map[string]string{"deeply nested": nested, "empty output": `{"version":1,"ops":[],"output":{}}`} {
		r, err := ParseRecipe([]byte(raw))
		if err == nil && len(r.Problems(nil)) == 0 {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestNameTemplate(t *testing.T) {
	facts := map[string]string{"name": "IMG_0042", "ext": "jpg", "year": "2026", "date": "2026-10-12", "time": "09:30",
		"width": "4000", "height": "3000", "exif.model": "X/100 \"Pro\"", "folder": "Trip"}
	lookup := func(name string) (string, bool) { v, ok := facts[name]; return v, ok }
	cases := []struct {
		template, want string
	}{
		{"", "IMG_0042-edited.png"},
		{"{name}", "IMG_0042.png"},
		{"{NAME}_{n}", "IMG_0042_7.png"},
		{"{n:4}-{name}", "0007-IMG_0042.png"},
		{"{folder} {date} {width}x{height}", "Trip 2026-10-12 4000x3000.png"},
		// What a name can't hold becomes a dash; a missing EXIF tag is empty.
		{"{name} {exif.model}", "IMG_0042 X-100 -Pro-.png"},
		{"{name}{exif.lens}", "IMG_0042.png"},
		{"{time}", "09-30.png"},
		// Braces that are no token stay.
		{"{name} {} {a b}", "IMG_0042 {} {a b}.png"},
		// A template that gives this picture no name is an error.
		{"{exif.lens}", ""},
		{"  {name}. ", "IMG_0042.png"},
	}
	for _, c := range cases {
		got, err := (Output{Template: c.template, Destination: DestBeside}).Name(7, "png", lookup)
		if (err != nil) != (c.want == "") || got != c.want {
			t.Errorf("%q: got %q (%v), want %q", c.template, got, err, c.want)
		}
	}
	if got, _ := (Output{Destination: DestFolder}).Name(1, "jpg", lookup); got != "IMG_0042.jpg" {
		t.Errorf("folder default: %q", got)
	}
	needs := map[string]bool{"{name}-{n:3}": false, "{folder}_{filename}": false, "{name}-{width}": true,
		"{date}": true, "{exif.model}": true, "": false}
	for template, want := range needs {
		if got := (Output{Template: template}).NeedsFacts(); got != want {
			t.Errorf("NeedsFacts(%q) = %v", template, got)
		}
	}
}

func TestFactsReadThePictureOnlyWhenAsked(t *testing.T) {
	dir := t.TempDir()
	// The name comes from the path: the file need not even exist.
	gone := NewFacts(Source{Path: filepath.Join(dir, "Trip", "a b.JPG"), Ext: "jpg"})
	for name, want := range map[string]string{"name": "a b", "filename": "a b.JPG", "ext": "JPG", "folder": "Trip"} {
		if got, ok := gone.Token(name); !ok || got != want {
			t.Errorf("%s = %q, %v", name, got, ok)
		}
	}
	if _, ok := gone.Token("width"); ok {
		t.Error("a missing file has a width")
	}
	src := writeJPEG(t, dir, "p.jpg", 320, 200)
	f := NewFacts(src)
	if w, _ := f.Token("width"); w != "320" {
		t.Errorf("width %q", w)
	}
	if h, _ := f.Token("height"); h != "200" {
		t.Errorf("height %q", h)
	}
	if y, ok := f.Token("year"); !ok || len(y) != 4 {
		t.Errorf("year %q", y)
	}
	if _, ok := f.Token("exif.model"); ok {
		t.Error("a picture without EXIF has a model")
	}
}

func TestNamer(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "out")
	disk := map[string]bool{}
	src := func(name string) Source {
		return Source{Path: filepath.Join(dir, name), Ext: strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))}
	}
	namer := func(o Output, folder string) *Namer {
		nm := NewNamer(o, folder)
		nm.Exists = func(p string) bool { return disk[p] }
		return nm
	}
	next := func(nm *Namer, name, decoder string) Target {
		t.Helper()
		s := src(name)
		tg, err := nm.Next(s, decoder, NewFacts(s).Token)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return tg
	}
	base := func(tg Target) string { return filepath.Base(tg.Path) }

	// Beside the original, each picture's own format: WebP becomes PNG,
	// ".jpeg" stays ".jpeg".
	keep := namer(Output{Format: FormatKeep, Destination: DestBeside, Conflict: ConflictKeepBoth}, "")
	if tg := next(keep, "a.jpeg", "jpeg"); base(tg) != "a-edited.jpeg" || tg.Format != "jpeg" || filepath.Dir(tg.Path) != dir {
		t.Errorf("keep jpeg: %+v", tg)
	}
	if tg := next(keep, "b.webp", "webp"); base(tg) != "b-edited.png" || tg.Format != "png" {
		t.Errorf("keep webp: %+v", tg)
	}

	// Two pictures that become the same name: the second gets a number,
	// whatever is on disk.
	jpg := namer(Output{Format: "jpeg", Destination: DestFolder, Conflict: ConflictKeepBoth, Template: "{name}"}, out)
	a, b, c := next(jpg, "x.png", "png"), next(jpg, "x.gif", "gif"), next(jpg, "x.bmp", "bmp")
	if base(a) != "x.jpg" || base(b) != "x (2).jpg" || base(c) != "x (3).jpg" || filepath.Dir(a.Path) != out {
		t.Errorf("duplicates: %s %s %s", a.Path, base(b), base(c))
	}

	// The name is taken on disk.
	disk[filepath.Join(out, "y.jpg")] = true
	if tg := next(jpg, "y.png", "png"); base(tg) != "y (2).jpg" || tg.TrashDest {
		t.Errorf("keep both: %+v", tg)
	}
	skip := namer(Output{Format: "jpeg", Destination: DestFolder, Conflict: ConflictSkip, Template: "{name}"}, out)
	if tg := next(skip, "y.png", "png"); tg.Skip != "conflict" {
		t.Errorf("skip: %+v", tg)
	}
	if tg := next(skip, "z.png", "png"); tg.Skip != "" || base(tg) != "z.jpg" {
		t.Errorf("skip, free name: %+v", tg)
	}
	replace := namer(Output{Format: "jpeg", Destination: DestFolder, Conflict: ConflictReplace, Template: "{name}"}, out)
	if tg := next(replace, "y.png", "png"); base(tg) != "y.jpg" || !tg.TrashDest {
		t.Errorf("replace: %+v", tg)
	}
	// What the batch itself wrote is not replaced by its next picture.
	if tg := next(replace, "y.gif", "gif"); base(tg) != "y (2).jpg" || tg.TrashDest {
		t.Errorf("replace own result: %+v", tg)
	}

	// A result never lands on its original, or on another original.
	disk[filepath.Join(dir, "p.jpg")], disk[filepath.Join(dir, "q.jpg")] = true, true
	onto := namer(Output{Format: "jpeg", Destination: DestBeside, Conflict: ConflictReplace, Template: "{name}"}, "")
	onto.IsSource = func(key string) bool { return strings.HasSuffix(key, "/q.jpg") }
	if tg := next(onto, "p.jpg", "jpeg"); base(tg) != "p (2).jpg" || tg.TrashDest || tg.Replace {
		t.Errorf("own original: %+v", tg)
	}
	if tg := next(onto, "q.png", "png"); base(tg) != "q (2).jpg" || tg.TrashDest {
		t.Errorf("another original: %+v", tg)
	}

	// Replace: the original's own path and format; what can't be written is left out.
	rep := namer(Output{Format: FormatKeep, Destination: DestReplace, Conflict: ConflictKeepBoth}, "")
	if tg := next(rep, "p.jpg", "jpeg"); tg.Path != filepath.Join(dir, "p.jpg") || !tg.Replace || tg.Format != "jpeg" {
		t.Errorf("replace original: %+v", tg)
	}
	if tg := next(rep, "w.webp", "webp"); tg.Skip != "notWritable" {
		t.Errorf("replace webp: %+v", tg)
	}

	// {n} counts every picture handed in, skipped or not.
	count := namer(Output{Format: "png", Destination: DestFolder, Conflict: ConflictSkip, Template: "{n:3}"}, out)
	disk[filepath.Join(out, "002.png")] = true
	n1, n2, n3 := next(count, "a.png", "png"), next(count, "b.png", "png"), next(count, "c.png", "png")
	if base(n1) != "001.png" || n2.Skip != "conflict" || base(n3) != "003.png" {
		t.Errorf("numbers: %+v %+v %+v", n1, n2, n3)
	}
}

func TestBuiltinRecipes(t *testing.T) {
	sizes := map[string][2]int{
		"web1600": {1600, 1200}, "email1024": {1024, 768}, "thumb256": {256, 256},
		"print10x15": {1772, 1329}, "watermark": {4000, 3000}, "bwContrast": {4000, 3000},
	}
	seen := map[string]bool{}
	for _, b := range Builtins() {
		if seen[b.Key] || b.Name == "" {
			t.Errorf("%s: duplicate or unnamed", b.Key)
		}
		seen[b.Key] = true
		if p := b.Recipe.Problems(func(string) bool { return false }); len(p) != 0 {
			t.Errorf("%s: %v", b.Key, p)
		}
		w, h := b.Recipe.Ops.OutputSize(4000, 3000)
		if want, ok := sizes[b.Key]; !ok || w != want[0] || h != want[1] {
			t.Errorf("%s: 4000×3000 becomes %d×%d, documented %v", b.Key, w, h, want)
		}
		// A recipe is data that survives storage unchanged.
		raw, err := json.Marshal(b.Recipe)
		if err != nil {
			t.Fatal(err)
		}
		back, err := ParseRecipe(raw)
		if again, _ := json.Marshal(back); err != nil || string(again) != string(raw) {
			t.Errorf("%s: does not round-trip (%v)", b.Key, err)
		}
	}
	if len(seen) != len(sizes) {
		t.Errorf("%d built-in recipes, %d documented", len(seen), len(sizes))
	}
	// Small pictures are not enlarged by the web recipe.
	if w, h := Builtins()[0].Recipe.Ops.OutputSize(800, 600); w != 800 || h != 600 {
		t.Errorf("web1600 enlarges: %d×%d", w, h)
	}
	// The print recipe writes 300 dpi.
	prog, err := imaging.Compile(Builtins()[3].Recipe.Ops, 4000, 3000, imaging.DPI{X: 72, Y: 72})
	if err != nil || prog.DPI().X != 300 {
		t.Errorf("print dpi: %v", err)
	}
}
