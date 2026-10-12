package rename

import (
	"errors"
	"fmt"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

var shot = time.Date(2024, 3, 9, 7, 5, 2, 0, time.Local).UnixNano()

func compile(t *testing.T, s Spec) *Plan {
	t.Helper()
	if s.NameMask == "" && s.ExtMask == "" {
		s.NameMask, s.ExtMask = "[N]", "[E]"
	}
	if s.Digits == 0 {
		s.Digits = 1
	}
	if s.Step == 0 {
		s.Step = 1
	}
	p, err := Compile(s)
	if err != nil {
		t.Fatalf("compile %+v: %v", s, err)
	}
	return p
}

func TestPlaceholders(t *testing.T) {
	cases := []struct {
		name, ext string // masks
		file      string
		isDir     bool
		index     int
		want      string
	}{
		{"[N]", "[E]", "Holiday.JPG", false, 0, "Holiday.JPG"},
		{"[N]", "", "Holiday.JPG", false, 0, "Holiday"},
		{"[N]", "png", "Holiday.JPG", false, 0, "Holiday.png"},
		{"new [N]", "[E]", "a.b.txt", false, 0, "new a.b.txt"},
		// Ranges count characters, not bytes.
		{"[N2-5]", "[E]", "Holiday.jpg", false, 0, "olid.jpg"},
		{"[N2-]", "[E]", "Holiday.jpg", false, 0, "oliday.jpg"},
		{"[N3,2]", "[E]", "Holiday.jpg", false, 0, "li.jpg"},
		{"[N1]", "[E]", "Holiday.jpg", false, 0, "H.jpg"},
		{"[N2-3]", "[E]", "Árvíztűrő.txt", false, 0, "rv.txt"},
		{"[N5-9]x", "[E]", "abc.txt", false, 0, "x.txt"},
		{"[N]", "[E1-2]", "movie.mpeg", false, 0, "movie.mp"},
		{"[N]_[E]", "bak", "notes.txt", false, 0, "notes_txt.bak"},
		// Counters: the fields, or inline start, step and digits.
		{"[N]-[C]", "[E]", "a.txt", false, 4, "a-5.txt"},
		{"[C10+5:4]", "[E]", "a.txt", false, 2, "0020.txt"},
		{"[C:3]", "[E]", "a.txt", false, 0, "001.txt"},
		{"[C+10]", "[E]", "a.txt", false, 3, "31.txt"},
		{"[C5+-1:2]", "[E]", "a.txt", false, 7, "-02.txt"},
		// Dates come from the modification time.
		{"[Y]-[M]-[D] [h].[m].[s]", "[E]", "IMG_1.jpg", false, 0, "2024-03-09 07.05.02.jpg"},
		// Brackets and text around placeholders.
		{"[[][N][]]", "[E]", "a.txt", false, 0, "[a].txt"},
		{"a]b", "[E]", "x.txt", false, 0, "a]b.txt"},
		// Folders and names without an extension have none.
		{"[N]-[E]", "[E]", "Trip.2024", true, 0, "Trip.2024-"},
		{"[N]", "[E]", ".profile", false, 0, ".profile"},
		{"[N]", "[E]", "trailing.", false, 0, "trailing."},
	}
	for _, c := range cases {
		p := compile(t, Spec{NameMask: c.name, ExtMask: c.ext, Start: 1, Step: 1, Digits: 1})
		got := p.Name(Item{Name: c.file, IsDir: c.isDir, ModNs: shot}, c.index)
		if got != c.want {
			t.Errorf("%q + %q on %q: got %q, want %q", c.name, c.ext, c.file, got, c.want)
		}
	}
}

func TestBadMasks(t *testing.T) {
	for _, mask := range []string{"[N", "[]", "[X]", "[N0]", "[N5-2]", "[N2,]", "[Nx]", "[C1:0]", "[C1:11]", "[Cx]", "[YY]", "[n]", "[N-3]", "\xff[N]"} {
		_, err := Compile(Spec{NameMask: mask, ExtMask: "[E]", Step: 1, Digits: 1})
		var pe *PlanError
		if !errors.As(err, &pe) || pe.Field != "nameMask" || !errors.Is(err, ErrPlan) {
			t.Errorf("mask %q: got %v, want a nameMask error", mask, err)
		}
	}
	if _, err := Compile(Spec{NameMask: "[N]", ExtMask: "[E", Step: 1, Digits: 1}); err == nil {
		t.Error("an open extension mask compiled")
	} else if pe := (*PlanError)(nil); !errors.As(err, &pe) || pe.Field != "extMask" {
		t.Errorf("extension mask: %v", err)
	}
	bad := []Spec{
		{NameMask: strings.Repeat("a", MaxMask+1), Step: 1, Digits: 1},
		{NameMask: "[N]", Search: strings.Repeat("a", MaxMask+1), Step: 1, Digits: 1},
		{NameMask: "[N]", Step: 1, Digits: 0},
		{NameMask: "[N]", Step: 1, Digits: MaxDigits + 1},
		{NameMask: "[N]", Step: MaxStep + 1, Digits: 1},
		{NameMask: "[N]", Start: MaxStart + 1, Step: 1, Digits: 1},
		{NameMask: "[N]", Step: 1, Digits: 1, Case: "title"},
		{NameMask: "[N]", Step: 1, Digits: 1, Search: "(", Regex: true},
	}
	for _, s := range bad {
		if _, err := Compile(s); !errors.Is(err, ErrPlan) {
			t.Errorf("%+v compiled: %v", s, err)
		}
	}
	// The reason of a bad expression does not repeat the expression.
	_, err := Compile(Spec{NameMask: "[N]", Step: 1, Digits: 1, Search: "a(b", Regex: true})
	if err == nil || strings.Contains(err.Error(), "a(b") && strings.HasPrefix(err.Error(), "error parsing") {
		t.Errorf("regexp reason: %v", err)
	}
}

func TestSearchAndReplace(t *testing.T) {
	cases := []struct {
		s    Spec
		file string
		want string
	}{
		// Plain text ignores case unless told otherwise, and is not a pattern.
		{Spec{Search: "img", Replace: "photo"}, "IMG_0001.jpg", "photo_0001.jpg"},
		{Spec{Search: "img", Replace: "photo", MatchCase: true}, "IMG_0001.jpg", "IMG_0001.jpg"},
		{Spec{Search: ".", Replace: "_"}, "a.b.txt", "a_b_txt"},
		{Spec{Search: "a+", Replace: "$1"}, "a+b.txt", "$1b.txt"},
		{Spec{Search: " ", Replace: ""}, "my file name.txt", "myfilename.txt"},
		// Regular expressions (RE2) with groups.
		{Spec{Search: `^(\d{4})-(\d{2})`, Replace: "$2.$1", Regex: true}, "2024-03 notes.txt", "03.2024 notes.txt"},
		{Spec{Search: `IMG_0*(\d+)`, Replace: "pic${1}", Regex: true}, "img_0042.JPG", "pic42.JPG"},
		{Spec{Search: `[aeiou]`, Replace: "", Regex: true, MatchCase: true}, "Audio.txt", "Ad.txt"},
		{Spec{Search: `\.jpeg$`, Replace: ".jpg", Regex: true}, "a.JPEG", "a.jpg"},
		// It works on what the masks made.
		{Spec{NameMask: "[N]-[C]", ExtMask: "[E]", Search: "-", Replace: "_", Start: 7}, "a.txt", "a_7.txt"},
	}
	for _, c := range cases {
		got := compile(t, c.s).Name(Item{Name: c.file}, 0)
		if got != c.want {
			t.Errorf("%q → %q on %q: got %q, want %q", c.s.Search, c.s.Replace, c.file, got, c.want)
		}
	}
}

func TestCase(t *testing.T) {
	cases := []struct {
		c     Case
		file  string
		isDir bool
		want  string
	}{
		{CaseLower, "My FILE.TXT", false, "my file.txt"},
		{CaseUpper, "My file.txt", false, "MY FILE.TXT"},
		{CaseFirst, "mY sUMMER trip.JPG", false, "My summer trip.JPG"},
		{CaseWords, "mY sUMMER-trip_2 don't.JPG", false, "My Summer-Trip_2 Don't.JPG"},
		{CaseWords, "árvíz tűrő", true, "Árvíz Tűrő"},
		{CaseFirst, "_draft one.md", false, "_Draft one.md"},
		{CaseKeep, "As Is.TxT", false, "As Is.TxT"},
	}
	for _, c := range cases {
		got := compile(t, Spec{Case: c.c}).Name(Item{Name: c.file, IsDir: c.isDir}, 0)
		if got != c.want {
			t.Errorf("%s on %q: got %q, want %q", c.c, c.file, got, c.want)
		}
	}
}

// The viewer's syntax compiles to the same plan and keeps its rules.
func TestViewerPattern(t *testing.T) {
	cases := []struct {
		pattern, name string
		isDir         bool
		start, index  int
		want          string
	}{
		{"{name}", "a.jpg", false, 1, 0, "a.jpg"},
		{"Trip {n:000}", "IMG_1.JPG", false, 1, 6, "Trip 007.JPG"},
		{"{name}-{n}", "a.b.png", false, 10, 2, "a.b-12.png"},
		{"{n:00} {name} ", "x.mp4", false, 1, 0, "01 x.mp4"},
		{"Album {n}", "Folder.v2", true, 3, 0, "Album 3"},
	}
	for _, c := range cases {
		p, err := ParseViewer(c.pattern, c.start)
		if err != nil {
			t.Fatalf("%q: %v", c.pattern, err)
		}
		if got := p.Name(Item{Name: c.name, IsDir: c.isDir}, c.index); got != c.want {
			t.Errorf("%q on %q: got %q, want %q", c.pattern, c.name, got, c.want)
		}
	}
	for _, bad := range []string{"", "plain", "{name", "{x}", "{n:}", "{n:01}", "{n:00000000000}", strings.Repeat("a", 300) + "{n}"} {
		if _, err := ParseViewer(bad, 1); !errors.Is(err, ErrPlan) {
			t.Errorf("pattern %q was accepted", bad)
		}
	}
	if _, err := ParseViewer("{n}", -1); err == nil {
		t.Error("a negative start was accepted")
	}
}

func entriesOf(names ...string) []Entry {
	out := make([]Entry, len(names))
	for i, n := range names {
		out[i] = Entry{Item: Item{Name: n}, Dir: "/d/"}
	}
	return out
}

func existing(names ...string) func(int, string) bool {
	set := map[string]bool{}
	for _, n := range names {
		set[Key("/d/", n)] = true
	}
	return func(_ int, name string) bool { return set[Key("/d/", name)] }
}

func statuses(r Result) string {
	var b strings.Builder
	for _, o := range r.Outcomes {
		b.WriteString(map[Status]string{Renamed: "R", Unchanged: "U", Invalid: "I", Conflict: "C"}[o.Status])
	}
	return b.String()
}

func TestResolve(t *testing.T) {
	// A counter follows the order; everything is free.
	r := Resolve(compile(t, Spec{NameMask: "p[C:2]", ExtMask: "[E]", Start: 1}), entriesOf("b.jpg", "a.jpg", "c.png"), existing("b.jpg", "a.jpg", "c.png"))
	if statuses(r) != "RRR" || r.Outcomes[0].Name != "p01.jpg" || r.Outcomes[2].Name != "p03.png" || r.Renamed != 3 || len(r.Order) != 3 {
		t.Fatalf("plain batch: %s %+v", statuses(r), r)
	}
	// The same name twice in the batch: both are conflicts.
	r = Resolve(compile(t, Spec{NameMask: "same", ExtMask: "[E]"}), entriesOf("a.txt", "b.txt", "c.md"), existing())
	if statuses(r) != "CCR" || r.Outcomes[0].Reason != ReasonDuplicate || r.Conflicts != 2 {
		t.Fatalf("duplicates: %s %+v", statuses(r), r.Outcomes)
	}
	// A name an entry outside the batch has.
	r = Resolve(compile(t, Spec{Search: "a", Replace: "z"}), entriesOf("a.txt", "b.txt"), existing("a.txt", "b.txt", "z.txt"))
	if statuses(r) != "CU" || r.Outcomes[0].Reason != ReasonExists || r.Unchanged != 1 {
		t.Fatalf("existing: %s %+v", statuses(r), r.Outcomes)
	}
	// Invalid names say why.
	r = Resolve(compile(t, Spec{NameMask: "..", ExtMask: ""}), entriesOf("a.txt"), existing())
	if statuses(r) != "I" || r.Outcomes[0].Reason == "" || r.Invalid != 1 {
		t.Fatalf("invalid: %s %+v", statuses(r), r.Outcomes)
	}
}

// 1 → 2 → 3 with 3 free: every name is free when its turn comes, in the
// right order.
func TestResolveChain(t *testing.T) {
	plan := compile(t, Spec{NameMask: "f[C]", ExtMask: "", Start: 2})
	r := Resolve(plan, entriesOf("f1", "f2", "f3"), existing("f1", "f2", "f3"))
	if statuses(r) != "RRR" {
		t.Fatalf("chain: %s %+v", statuses(r), r.Outcomes)
	}
	if !slices.Equal(r.Order, []int{2, 1, 0}) {
		t.Fatalf("order %v: f3 must leave before f2 takes its name", r.Order)
	}
	// With f4 taken by an entry that stays, nothing in the chain can move.
	r = Resolve(plan, entriesOf("f1", "f2", "f3"), existing("f1", "f2", "f3", "f4"))
	if statuses(r) != "CCC" || len(r.Order) != 0 {
		t.Fatalf("blocked chain: %s", statuses(r))
	}
	for _, o := range r.Outcomes {
		if o.Reason != ReasonExists {
			t.Fatalf("blocked chain reasons: %+v", r.Outcomes)
		}
	}
	// The same when the last one's new name is invalid.
	r = Resolve(compile(t, Spec{NameMask: "f[C]", ExtMask: "", Start: 2, Search: "f4", Replace: ".."}), entriesOf("f1", "f2", "f3"), existing())
	if statuses(r) != "CCI" {
		t.Fatalf("chain behind an invalid name: %s", statuses(r))
	}
}

// table names entries from a fixed old → new list instead of masks.
func table(names map[string]string) func(Item, int) string {
	return func(it Item, _ int) string {
		if name, ok := names[it.Name]; ok {
			return name
		}
		return it.Name
	}
}

// Entries exchanging names cannot be applied without a third name.
func TestResolveCycle(t *testing.T) {
	r := resolve(table(map[string]string{"a": "b", "b": "a", "c": "d"}), entriesOf("a", "b", "c"), existing("a", "b", "c"))
	if statuses(r) != "CCR" || r.Outcomes[0].Reason != ReasonCycle || r.Outcomes[1].Reason != ReasonCycle {
		t.Fatalf("swap: %s %+v", statuses(r), r.Outcomes)
	}
	if !slices.Equal(r.Order, []int{2}) {
		t.Fatalf("swap order: %v", r.Order)
	}
	// A cycle of three beside a chain that ends in a free name.
	r = resolve(table(map[string]string{"a": "b", "b": "c", "c": "a", "x": "y", "w": "x"}),
		entriesOf("a", "b", "c", "w", "x"), existing("a", "b", "c", "w", "x"))
	if statuses(r) != "CCCRR" || !slices.Equal(r.Order, []int{4, 3}) {
		t.Fatalf("cycle of three: %s, order %v", statuses(r), r.Order)
	}
}

func TestResolveCaseOnly(t *testing.T) {
	r := Resolve(compile(t, Spec{Case: CaseUpper}), entriesOf("photo.jpg", "Other.jpg"), existing("photo.jpg", "Other.jpg"))
	if statuses(r) != "RR" || r.Outcomes[0].Name != "PHOTO.JPG" {
		t.Fatalf("case only: %s %+v", statuses(r), r.Outcomes)
	}
	// Where names differ by case, "A" is another entry's name.
	r = Resolve(compile(t, Spec{Case: CaseUpper}), entriesOf("a"), existing("a", "A"))
	want := "C"
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		want = "R" // one entry: it is its own name
	}
	if statuses(r) != want {
		t.Fatalf("case against an existing name: %s, want %s", statuses(r), want)
	}
	// Two entries that would differ by case only collide where case is ignored.
	r = Resolve(compile(t, Spec{Search: "x", Replace: "A", MatchCase: true}), entriesOf("x", "a"), existing("x", "a"))
	want = "RU"
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		want = "CU"
	}
	if statuses(r) != want {
		t.Fatalf("case collision: %s, want %s", statuses(r), want)
	}
}

// Names collide per folder only.
func TestResolveFolders(t *testing.T) {
	ents := []Entry{{Item: Item{Name: "a.txt"}, Dir: "/one/"}, {Item: Item{Name: "b.txt"}, Dir: "/two/"}}
	r := Resolve(compile(t, Spec{NameMask: "same", ExtMask: "[E]"}), ents, func(int, string) bool { return false })
	if statuses(r) != "RR" {
		t.Fatalf("two folders: %s", statuses(r))
	}
	r = Resolve(compile(t, Spec{NameMask: "same", ExtMask: "[E]"}), ents, func(i int, name string) bool { return i == 1 && name == "same.txt" })
	if statuses(r) != "RC" {
		t.Fatalf("taken in one folder: %s", statuses(r))
	}
}

func BenchmarkResolve10k(b *testing.B) {
	ents := make([]Entry, 10_000)
	set := make(map[string]bool, len(ents))
	for i := range ents {
		ents[i] = Entry{Item: Item{Name: fmt.Sprintf("IMG_%05d.jpg", i), ModNs: shot}, Dir: "/photos/"}
		set[Key("/photos/", ents[i].Name)] = true
	}
	p, err := Compile(Spec{NameMask: "[Y]-[M]-[D] [N4-] [C:5]", ExtMask: "[E]", Search: `_0*(\d)`, Replace: "#$1", Regex: true, Case: CaseWords, Start: 1, Step: 1, Digits: 1})
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if r := Resolve(p, ents, func(i int, name string) bool { return set[Key(ents[i].Dir, name)] }); r.Renamed != len(ents) {
			b.Fatalf("renamed %d", r.Renamed)
		}
	}
}
