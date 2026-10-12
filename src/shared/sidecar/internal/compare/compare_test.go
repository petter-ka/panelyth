package compare

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/index"
)

var ctx = context.Background()

var t0 = time.Date(2024, 3, 9, 12, 0, 0, 0, time.UTC)

// put writes a file with a date (seconds after t0).
func put(t testing.TB, root, rel, data string, sec int) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	at := t0.Add(time.Duration(sec) * time.Second)
	if err := os.Chtimes(p, at, at); err != nil {
		t.Fatal(err)
	}
}

func TestDateRules(t *testing.T) {
	s, h := int64(time.Second), int64(time.Hour)
	cases := []struct {
		name string
		o    Options
		a, b int64
		want int
	}{
		{"exact, equal", Options{}, 5 * s, 5 * s, 0},
		{"exact, a nanosecond newer", Options{}, 5*s + 1, 5 * s, 1},
		{"exact, older", Options{}, 4 * s, 5 * s, -1},
		{"two seconds for FAT", Options{Tolerance: 2 * time.Second}, 7 * s, 5 * s, 0},
		{"just beyond the tolerance", Options{Tolerance: 2 * time.Second}, 7*s + 1, 5 * s, 1},
		{"an hour apart without the DST option", Options{Tolerance: 2 * time.Second}, 5*s + h, 5 * s, 1},
		{"an hour apart with it", Options{DST: true}, 5*s + h, 5 * s, 0},
		{"an hour and two seconds, with tolerance", Options{DST: true, Tolerance: 2 * time.Second}, 5 * s, 7*s + h, 0},
		{"an hour less two seconds, with tolerance", Options{DST: true, Tolerance: 2 * time.Second}, 5*s + h - 2*s, 5 * s, 0},
		{"an hour and three seconds", Options{DST: true, Tolerance: 2 * time.Second}, 5 * s, 8*s + h, -1},
		{"two hours", Options{DST: true}, 5*s + 2*h, 5 * s, 1},
		{"dates ignored", Options{IgnoreDates: true}, 5 * s, 99 * h, 0},
	}
	for _, c := range cases {
		if got := c.o.cmpTime(c.a, c.b); got != c.want {
			t.Errorf("%s: %d, want %d", c.name, got, c.want)
		}
	}
	o := Options{Tolerance: 2 * time.Second}
	for _, c := range []struct {
		ls, lm, rs, rm int64
		want           State
	}{
		{10, 5 * s, 10, 6 * s, StateEqual},
		{10, 9 * s, 10, 5 * s, StateLeftNewer},
		{10, 5 * s, 99, 9 * s, StateRightNewer},
		{10, 5 * s, 11, 5 * s, StateDifferent},
	} {
		if got := o.classify(c.ls, c.lm, c.rs, c.rm); got != c.want {
			t.Errorf("classify %+v = %s", c, got)
		}
	}
	if got := (Options{IgnoreDates: true}).classify(10, 0, 10, 9*h); got != StateEqual {
		t.Errorf("ignoring dates: %s", got)
	}
}

func TestDefaultActions(t *testing.T) {
	for _, c := range []struct {
		s         State
		sym, asym Action
	}{
		{StateEqual, ActionNone, ActionNone},
		{StateLeftNewer, ActionCopyRight, ActionCopyRight},
		{StateRightNewer, ActionCopyLeft, ActionCopyRight},
		{StateDifferent, ActionNone, ActionCopyRight},
		{StateLeftOnly, ActionCopyRight, ActionCopyRight},
		{StateRightOnly, ActionCopyLeft, ActionDeleteRight},
		{StateMismatch, ActionNone, ActionNone},
	} {
		if got := defaultAction(c.s, false); got != c.sym {
			t.Errorf("%s symmetric: %s", c.s, got)
		}
		if got := defaultAction(c.s, true); got != c.asym {
			t.Errorf("%s asymmetric: %s", c.s, got)
		}
		// Whatever a row starts with must be allowed for it.
		if !allowed(c.s, c.sym) || !allowed(c.s, c.asym) {
			t.Errorf("%s: its default is not allowed", c.s)
		}
	}
	// Deletes only ever apply to one-sided entries; copies need a source.
	for s := StateEqual; s <= StateMismatch; s++ {
		if allowed(s, ActionDeleteRight) != (s == StateRightOnly) || allowed(s, ActionDeleteLeft) != (s == StateLeftOnly) {
			t.Errorf("%s: delete", s)
		}
	}
	if allowed(StateRightOnly, ActionCopyRight) || allowed(StateLeftOnly, ActionCopyLeft) || allowed(StateMismatch, ActionCopyRight) {
		t.Error("a copy without its source, or over another kind of entry")
	}
	if a, ok := ParseAction("deleteRight"); !ok || a != ActionDeleteRight {
		t.Error("ParseAction")
	}
	if _, ok := ParseAction("format"); ok {
		t.Error("ParseAction accepts anything")
	}
}

func TestMarks(t *testing.T) {
	s := int64(time.Second)
	left := []Entry{
		{Key: "same.txt", Size: 5, MtimeNs: 10 * s},
		{Key: "newer-left.txt", Size: 5, MtimeNs: 20 * s},
		{Key: "newer-right.txt", Size: 5, MtimeNs: 10 * s},
		{Key: "size.txt", Size: 5, MtimeNs: 10 * s},
		{Key: "only-left.txt", Size: 1, MtimeNs: 10 * s},
		{Key: "sub", IsDir: true},
		{Key: "clash", Size: 1, MtimeNs: 10 * s}, // a folder of that name on the right
		{Key: "fat.txt", Size: 5, MtimeNs: 11 * s},
	}
	right := []Entry{
		{Key: "clash", IsDir: true},
		{Key: "size.txt", Size: 6, MtimeNs: 10 * s},
		{Key: "same.txt", Size: 5, MtimeNs: 10 * s},
		{Key: "newer-left.txt", Size: 5, MtimeNs: 10 * s},
		{Key: "newer-right.txt", Size: 9, MtimeNs: 30 * s},
		{Key: "only-right.txt", Size: 1, MtimeNs: 10 * s},
		{Key: "other", IsDir: true},
		{Key: "fat.txt", Size: 5, MtimeNs: 10 * s},
	}
	names := func(es []Entry, marks []bool) []string {
		var out []string
		for i, m := range marks {
			if m {
				out = append(out, es[i].Key)
			}
		}
		slices.Sort(out)
		return out
	}
	l, r := Marks(left, right, Options{Tolerance: 2 * time.Second})
	if got, want := names(left, l), []string{"clash", "newer-left.txt", "only-left.txt", "size.txt"}; !slices.Equal(got, want) {
		t.Errorf("left %v, want %v", got, want)
	}
	if got, want := names(right, r), []string{"newer-right.txt", "only-right.txt", "size.txt"}; !slices.Equal(got, want) {
		t.Errorf("right %v, want %v", got, want)
	}
	// Exact dates: the second apart counts.
	l, _ = Marks(left, right, Options{})
	if !slices.Contains(names(left, l), "fat.txt") {
		t.Error("exact dates: fat.txt is newer on the left")
	}
	// Dates ignored: only unique files and other sizes (on both sides).
	l, r = Marks(left, right, Options{IgnoreDates: true})
	if got, want := names(left, l), []string{"clash", "newer-right.txt", "only-left.txt", "size.txt"}; !slices.Equal(got, want) {
		t.Errorf("ignoring dates, left %v", got)
	}
	if got, want := names(right, r), []string{"newer-right.txt", "only-right.txt", "size.txt"}; !slices.Equal(got, want) {
		t.Errorf("ignoring dates, right %v", got)
	}
	if l, r := Marks(nil, nil, Options{}); len(l) != 0 || len(r) != 0 {
		t.Error("empty folders")
	}
}

func TestEqualFiles(t *testing.T) {
	dir := t.TempDir()
	big := strings.Repeat("0123456789abcdef", (streamBuffer+4096)/16)
	put(t, dir, "a", big, 0)
	put(t, dir, "same", big, 0)
	put(t, dir, "late", big[:streamBuffer+100]+"X"+big[streamBuffer+101:], 0)
	put(t, dir, "short", big[:streamBuffer+7], 0)
	put(t, dir, "empty", "", 0)
	path := func(n string) string { return filepath.Join(dir, n) }
	var seen int64
	eq, at, err := EqualFiles(ctx, path("a"), path("same"), &StreamOptions{Progress: func(n int64) { seen += n }})
	if err != nil || !eq || at != -1 || seen != int64(len(big)) {
		t.Errorf("same: %v %d %v, progress %d", eq, at, err, seen)
	}
	if eq, at, err := EqualFiles(ctx, path("a"), path("late"), nil); err != nil || eq || at != streamBuffer+100 {
		t.Errorf("a difference in the second buffer: %v %d %v", eq, at, err)
	}
	if eq, at, err := EqualFiles(ctx, path("a"), path("short"), nil); err != nil || eq || at != streamBuffer+7 {
		t.Errorf("a prefix: %v %d %v", eq, at, err)
	}
	if eq, at, err := EqualFiles(ctx, path("empty"), path("empty"), nil); err != nil || !eq || at != -1 {
		t.Errorf("empty files: %v %d %v", eq, at, err)
	}
	if eq, at, _ := EqualFiles(ctx, path("empty"), path("a"), nil); eq || at != 0 {
		t.Errorf("empty against data: %v %d", eq, at)
	}
	if _, _, err := EqualFiles(ctx, path("a"), path("missing"), nil); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("missing: %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, _, err := EqualFiles(cancelled, path("a"), path("same"), nil); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled: %v", err)
	}
	gateErr := errors.New("stop")
	if _, _, err := EqualFiles(ctx, path("a"), path("same"), &StreamOptions{Gate: func(context.Context) error { return gateErr }}); !errors.Is(err, gateErr) {
		t.Errorf("gate: %v", err)
	}
}

// pair builds two trees with every kind of difference.
func pair(t testing.TB) (left, right string) {
	t.Helper()
	base := t.TempDir()
	left, right = filepath.Join(base, "left"), filepath.Join(base, "right")
	for _, root := range []string{left, right} {
		put(t, root, "same.txt", "same", 0)
		put(t, root, "sub/deep/equal.bin", "12345", 0)
	}
	put(t, left, "newer-left.txt", "left!!", 100)
	put(t, right, "newer-left.txt", "old", 0)
	put(t, left, "newer-right.txt", "old", 0)
	put(t, right, "newer-right.txt", "right!", 100)
	put(t, left, "size.txt", "12345", 0)
	put(t, right, "size.txt", "123456789", 0)
	// The same size and date, other bytes: only the content mode sees it.
	put(t, left, "content.bin", "AAAA", 0)
	put(t, right, "content.bin", "AAAB", 0)
	// The same bytes, another date.
	put(t, left, "touched.txt", "same bytes", 500)
	put(t, right, "touched.txt", "same bytes", 0)
	// One second apart: the same within the FAT tolerance.
	put(t, left, "fat.txt", "fat", 1)
	put(t, right, "fat.txt", "fat", 0)
	put(t, left, "only-left.txt", "l", 0)
	put(t, left, "new-folder/a.txt", "a", 0)
	put(t, left, "new-folder/inner/b.txt", "bb", 0)
	put(t, right, "only-right.txt", "r", 0)
	put(t, right, "sub/old/gone.txt", "gone", 0)
	if err := os.MkdirAll(filepath.Join(right, "empty-right"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A file on one side, a folder on the other.
	put(t, left, "clash", "file", 0)
	put(t, right, "clash/inside.txt", "x", 0)
	// Left out: an unfinished copy of an interrupted job.
	put(t, right, "."+"x.bin"+fileops.PartialSuffix, "partial", 0)
	return left, right
}

type harness struct {
	t  testing.TB
	m  *Manager
	mu sync.Mutex
	// progress events and session refreshes, as the sidecar would get them.
	events    []Progress
	refreshed []int64
}

func newHarness(t testing.TB) *harness {
	h := &harness{t: t}
	h.m = NewManager(Deps{
		Progress: func(p Progress) {
			h.mu.Lock()
			h.events = append(h.events, p)
			h.mu.Unlock()
		},
		Refresh: func(id int64) {
			h.mu.Lock()
			h.refreshed = append(h.refreshed, id)
			h.mu.Unlock()
		},
	})
	t.Cleanup(h.m.Shutdown)
	return h
}

// run compares and waits; session 77 lists the rows.
func (h *harness) run(spec Spec) *Result {
	h.t.Helper()
	res, err := h.m.Start(spec, func(*Result) (int64, error) { return 77, nil })
	if err != nil {
		h.t.Fatal(err)
	}
	h.m.Wait(res.ID())
	return res
}

func (h *harness) last() Progress {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.events[len(h.events)-1]
}

// table renders the shown rows: "dir/name state action".
func table(t testing.TB, res *Result) []string {
	t.Helper()
	ids, err := res.IDs(ctx, index.Descriptor{})
	if err != nil {
		t.Fatal(err)
	}
	items, _ := res.Items(ctx, ids)
	diffs := res.Diffs(ids)
	out := make([]string, len(ids))
	for i, id := range ids {
		d := diffs[id]
		name := items[i].Name
		if d.Dir != "" {
			name = d.Dir + "/" + name
		}
		if items[i].Kind.String() == "dir" {
			name += "/"
		}
		out[i] = name + " " + d.State.String() + " " + d.Action.String()
	}
	return out
}

func check(t *testing.T, got, want []string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Errorf("rows:\n  %s\nwant:\n  %s", strings.Join(got, "\n  "), strings.Join(want, "\n  "))
	}
}

func TestCompareTrees(t *testing.T) {
	left, right := pair(t)
	h := newHarness(t)
	res := h.run(Spec{Left: left, Right: right, Options: Options{Tolerance: 2 * time.Second}})
	// Equal rows are hidden by default; rows come folder by folder in
	// natural order, a folder's own entries before those of its subfolders.
	check(t, table(t, res), []string{
		"clash mismatch none",
		"empty-right/ rightOnly copyLeft",
		"new-folder/ leftOnly copyRight",
		"newer-left.txt leftNewer copyRight",
		"newer-right.txt rightNewer copyLeft",
		"only-left.txt leftOnly copyRight",
		"only-right.txt rightOnly copyLeft",
		"size.txt different none",
		"touched.txt leftNewer copyRight",
		"new-folder/a.txt leftOnly copyRight",
		"new-folder/inner/ leftOnly copyRight",
		"new-folder/inner/b.txt leftOnly copyRight",
		"sub/old/ rightOnly copyLeft",
		"sub/old/gone.txt rightOnly copyLeft",
	})
	p := h.last()
	if p.State != StateCompleted || p.Rows != 18 || p.Errors != 0 || p.Truncated || p.CompareID != res.ID() {
		t.Errorf("final progress %+v", p)
	}
	h.mu.Lock()
	if !slices.Contains(h.refreshed, 77) {
		t.Error("the session was not refreshed")
	}
	h.mu.Unlock()

	// Every row, with the equal ones.
	res.SetShow(ShowDefault | ShowEqual)
	all := table(t, res)
	for _, want := range []string{"same.txt equal none", "fat.txt equal none", "content.bin equal none", "sub/deep/equal.bin equal none"} {
		if !slices.Contains(all, want) {
			t.Errorf("missing %q", want)
		}
	}
	if len(all) != 18 {
		t.Errorf("%d rows", len(all))
	}

	// Sides of a row.
	ids, _ := res.IDs(ctx, index.Descriptor{})
	items, _ := res.Items(ctx, ids)
	diffs := res.Diffs(ids)
	for i, it := range items {
		d := diffs[it.ID]
		switch it.Name {
		case "newer-right.txt":
			if d.Left == nil || d.Right == nil || d.Left.Size != 3 || d.Right.Size != 6 || it.Size != 3 ||
				d.Right.MtimeNs-d.Left.MtimeNs != int64(100*time.Second) {
				t.Errorf("newer-right.txt: %+v %+v", d.Left, d.Right)
			}
		case "only-right.txt":
			if d.Left != nil || d.Right == nil || it.Size != 1 || it.Kind.String() != "file" {
				t.Errorf("only-right.txt: %+v", d)
			}
		case "equal.bin":
			if d.Dir != "sub/deep" {
				t.Errorf("dir %q", d.Dir)
			}
		}
		if !IsID(ids[i]) || ids[i] != it.ID {
			t.Errorf("id %d", ids[i])
		}
	}
	names, _ := res.Names(ctx)
	if n := names[ids[0]]; n.Name == "" {
		t.Error("names")
	}
}

func TestExactDatesAndIgnoredDates(t *testing.T) {
	left, right := pair(t)
	h := newHarness(t)
	res := h.run(Spec{Left: left, Right: right})
	if rows := table(t, res); !slices.Contains(rows, "fat.txt leftNewer copyRight") {
		t.Errorf("exact dates: %v", rows)
	}
	res = h.run(Spec{Left: left, Right: right, Options: Options{IgnoreDates: true}})
	check(t, table(t, res), []string{
		"clash mismatch none",
		"empty-right/ rightOnly copyLeft",
		"new-folder/ leftOnly copyRight",
		"newer-left.txt different none",
		"newer-right.txt different none",
		"only-left.txt leftOnly copyRight",
		"only-right.txt rightOnly copyLeft",
		"size.txt different none",
		"new-folder/a.txt leftOnly copyRight",
		"new-folder/inner/ leftOnly copyRight",
		"new-folder/inner/b.txt leftOnly copyRight",
		"sub/old/ rightOnly copyLeft",
		"sub/old/gone.txt rightOnly copyLeft",
	})
}

func TestCompareByContent(t *testing.T) {
	left, right := pair(t)
	h := newHarness(t)
	res := h.run(Spec{Left: left, Right: right, Content: true, Options: Options{Tolerance: 2 * time.Second}})
	rows := table(t, res)
	// The same size and date but other bytes: different, no direction.
	if !slices.Contains(rows, "content.bin different none") {
		t.Errorf("content.bin: %v", rows)
	}
	// The same bytes with another date are equal: nothing to copy.
	for _, r := range rows {
		if strings.HasPrefix(r, "touched.txt") {
			t.Errorf("touched.txt is listed: %s", r)
		}
	}
	p := h.last()
	if p.Phase != PhaseContent || p.Compared != 5 || p.Bytes == 0 || p.State != StateCompleted {
		t.Errorf("progress %+v", p)
	}
}

func TestAsymmetricMirror(t *testing.T) {
	left, right := pair(t)
	h := newHarness(t)
	res := h.run(Spec{Left: left, Right: right, Asymmetric: true, Options: Options{Tolerance: 2 * time.Second}})
	check(t, table(t, res), []string{
		"clash mismatch none",
		"empty-right/ rightOnly deleteRight",
		"new-folder/ leftOnly copyRight",
		"newer-left.txt leftNewer copyRight",
		"newer-right.txt rightNewer copyRight",
		"only-left.txt leftOnly copyRight",
		"only-right.txt rightOnly deleteRight",
		"size.txt different copyRight",
		"touched.txt leftNewer copyRight",
		"new-folder/a.txt leftOnly copyRight",
		"new-folder/inner/ leftOnly copyRight",
		"new-folder/inner/b.txt leftOnly copyRight",
		"sub/old/ rightOnly deleteRight",
		"sub/old/gone.txt rightOnly deleteRight",
	})
	s := res.Summary()
	if s.CopyRight.Files != 7 || s.CopyRight.Bytes != int64(6+3+5+10+1+1+2) || s.CopyLeft.Files != 0 || s.DeleteRight != 4 ||
		s.DeleteLeft != 0 || s.Folders != 2 || s.OverwriteNewer != 1 {
		t.Errorf("summary %+v", s)
	}
	if c := s.Counts; c.CopyRight != 9 || c.Delete != 4 || c.Equal != 4 || c.Different != 1 || c.CopyLeft != 0 {
		t.Errorf("counts %+v", c)
	}
}

func TestFilterDirectionsAndPlan(t *testing.T) {
	left, right := pair(t)
	h := newHarness(t)
	res := h.run(Spec{Left: left, Right: right, Options: Options{Tolerance: 2 * time.Second}})
	v1 := res.Summary().Version

	idOf := func(name string) int64 {
		t.Helper()
		res.mu.RLock()
		defer res.mu.RUnlock()
		for i := range res.rows {
			if res.rows[i].name == name {
				return rowID(res.id, i)
			}
		}
		t.Fatalf("no row %q", name)
		return 0
	}
	// A direction that needs a missing source is refused; so is deleting an
	// entry that exists on both sides.
	if n, err := res.SetAction([]int64{idOf("only-left.txt")}, ActionCopyLeft, false); err != nil || n != 0 {
		t.Errorf("copy left of a left-only file: %d, %v", n, err)
	}
	if n, _ := res.SetAction([]int64{idOf("size.txt"), idOf("same.txt")}, ActionDeleteRight, false); n != 0 {
		t.Errorf("deleting entries that exist on both sides: %d", n)
	}
	if n, _ := res.SetAction([]int64{idOf("clash")}, ActionCopyRight, false); n != 0 {
		t.Error("a file over a folder")
	}
	if res.Summary().Version != v1 {
		t.Error("refused changes made a new plan")
	}
	// Overrides: the size difference goes right, the newer right file is
	// left alone, the right-only file is deleted. Ids of other compares and
	// of files are ignored.
	n, err := res.SetAction([]int64{idOf("size.txt"), 12345, rowID(res.id+1, 0)}, ActionCopyRight, false)
	if err != nil || n != 1 {
		t.Fatalf("override: %d, %v", n, err)
	}
	_, _ = res.SetAction([]int64{idOf("newer-right.txt")}, ActionNone, false)
	_, _ = res.SetAction([]int64{idOf("only-right.txt")}, ActionDeleteRight, false)
	v2 := res.Summary().Version
	if v2 == v1 {
		t.Error("the plan's version did not change")
	}
	rows := table(t, res)
	for _, want := range []string{"size.txt different copyRight", "newer-right.txt rightNewer none", "only-right.txt rightOnly deleteRight"} {
		if !slices.Contains(rows, want) {
			t.Errorf("missing %q in %v", want, rows)
		}
	}
	s := res.Summary()
	if s.DeleteRight != 1 || s.CopyLeft.Files != 1 || s.CopyRight.Files != 6 || s.CopyRight.Bytes != 25 || s.Folders != 4 {
		t.Errorf("summary %+v", s)
	}

	// A plan must be the one the user saw.
	if _, err := res.Plan(v1); !errors.Is(err, ErrStalePlan) {
		t.Errorf("stale plan: %v", err)
	}
	plan, err := res.Plan(v2)
	if err != nil {
		t.Fatal(err)
	}
	var acts []string
	for _, it := range plan.Items {
		name := filepath.ToSlash(it.Rel)
		if it.IsDir {
			name += "/"
		}
		acts = append(acts, name+" "+it.Action.String())
	}
	check(t, acts, []string{
		"empty-right/ copyLeft",
		"new-folder/ copyRight",
		"newer-left.txt copyRight",
		"only-left.txt copyRight",
		"only-right.txt deleteRight",
		"size.txt copyRight",
		"touched.txt copyRight",
		"new-folder/a.txt copyRight",
		"new-folder/inner/ copyRight",
		"new-folder/inner/b.txt copyRight",
		"sub/old/ copyLeft",
		"sub/old/gone.txt copyLeft",
	})
	if plan.Left != left || plan.Right != right {
		t.Errorf("roots %q %q", plan.Left, plan.Right)
	}
	for _, it := range plan.Items {
		if it.Rel == "only-right.txt" && (it.Left != nil || it.Right == nil || it.Right.Size != 1) {
			t.Errorf("sides of only-right.txt: %+v %+v", it.Left, it.Right)
		}
	}

	// Rows the filter hides are not part of the plan: a sync does only what
	// the table shows.
	res.SetShow(ShowCopyRight)
	s = res.Summary()
	if s.DeleteRight != 0 || s.CopyLeft.Files != 0 || s.CopyRight.Files != 6 || s.Counts.Delete != 1 {
		t.Errorf("summary with deletes hidden %+v", s)
	}
	if _, err := res.Plan(v2); !errors.Is(err, ErrStalePlan) {
		t.Errorf("the plan from before the filter: %v", err)
	}
	plan, _ = res.Plan(s.Version)
	for _, it := range plan.Items {
		if it.Action != ActionCopyRight {
			t.Errorf("a hidden row is in the plan: %+v", it)
		}
	}
	if show, ok := ParseShow([]string{"copyRight", "delete"}); !ok || show != ShowCopyRight|ShowDelete {
		t.Error("ParseShow")
	}
	if _, ok := ParseShow([]string{"everything"}); ok {
		t.Error("ParseShow accepts anything")
	}

	// Reset restores the defaults.
	res.SetShow(ShowDefault)
	if n, _ := res.SetAction([]int64{idOf("size.txt"), idOf("only-right.txt"), idOf("same.txt")}, ActionNone, true); n != 2 {
		t.Errorf("reset changed %d rows", n)
	}
	if rows := table(t, res); !slices.Contains(rows, "only-right.txt rightOnly copyLeft") || !slices.Contains(rows, "size.txt different none") {
		t.Errorf("after reset: %v", rows)
	}
}

func TestUnreadableFoldersAreLeftOut(t *testing.T) {
	left, right := pair(t)
	spec := &Spec{Left: left, Right: right}
	var cnt counters
	// A folder that is said to be on both sides but cannot be read on one:
	// nothing of it is listed, so its other side never looks one-sided.
	res := comparePair(ctx, spec, task{rel: "new-folder", l: true, r: true}, &cnt)
	if res.err == nil || len(res.rows) != 0 || len(res.subs) != 0 || cnt.errors.Load() != 1 {
		t.Errorf("rows %d subs %d err %v", len(res.rows), len(res.subs), res.err)
	}
	// A root that cannot be read fails the compare.
	h := newHarness(t)
	r := h.run(Spec{Left: left, Right: filepath.Join(right, "missing")})
	if p := h.last(); p.State != StateFailed || r.Len() != 0 {
		t.Errorf("progress %+v", p)
	}
	if _, err := r.Plan(r.Summary().Version); !errors.Is(err, ErrRunning) {
		t.Errorf("a plan of a failed compare: %v", err)
	}
	if _, err := r.SetAction(nil, ActionNone, false); !errors.Is(err, ErrRunning) {
		t.Errorf("directions on a failed compare: %v", err)
	}
}

func TestLinksAreNotCompared(t *testing.T) {
	left, right := pair(t)
	if err := os.Symlink(filepath.Join(left, "same.txt"), filepath.Join(left, "link.txt")); err != nil {
		t.Skipf("links are not available here: %v", err)
	}
	_ = os.Symlink(filepath.Join(right, "sub"), filepath.Join(left, "link-dir"))
	h := newHarness(t)
	res := h.run(Spec{Left: left, Right: right, Asymmetric: true})
	for _, r := range table(t, res) {
		if strings.HasPrefix(r, "link") {
			t.Errorf("a link is listed: %s", r)
		}
	}
	if p := h.last(); p.Links != 2 {
		t.Errorf("links counted: %d", p.Links)
	}
}

func TestManagerLifecycle(t *testing.T) {
	left, right := pair(t)
	h := newHarness(t)
	res := h.run(Spec{Left: left, Right: right})
	if got, err := h.m.Result(res.ID()); err != nil || got != res {
		t.Errorf("Result: %v", err)
	}
	if h.m.OfSession(77) != res || h.m.OfSession(78) != nil {
		t.Error("OfSession")
	}
	if got := h.m.Sessions(res.ID()); !slices.Equal(got, []int64{77}) {
		t.Errorf("sessions %v", got)
	}
	if h.m.Cancel(res.ID()) {
		t.Error("cancelled a finished compare")
	}
	// Its last session closed: forgotten.
	h.m.Dropped(77)
	if _, err := h.m.Result(res.ID()); !errors.Is(err, ErrUnknown) {
		t.Errorf("after its session closed: %v", err)
	}
	// Close forgets at once.
	res = h.run(Spec{Left: left, Right: right})
	if !h.m.Close(res.ID()) || h.m.Close(res.ID()) {
		t.Error("Close")
	}
	if h.m.OfSession(77) != nil {
		t.Error("a closed compare still has a session")
	}
	// A session that fails to open cancels the compare.
	if _, err := h.m.Start(Spec{Left: left, Right: right}, func(*Result) (int64, error) { return 0, os.ErrClosed }); !errors.Is(err, os.ErrClosed) {
		t.Errorf("open error: %v", err)
	}
	// Only the newest compares are kept.
	var ids []int64
	for i := range MaxRuns + 2 {
		r, err := h.m.Start(Spec{Left: left, Right: right}, func(*Result) (int64, error) { return int64(100 + i), nil })
		if err != nil {
			t.Fatal(err)
		}
		h.m.Wait(r.ID())
		ids = append(ids, r.ID())
	}
	if _, err := h.m.Result(ids[0]); !errors.Is(err, ErrUnknown) {
		t.Error("the oldest compare was kept")
	}
	if _, err := h.m.Result(ids[len(ids)-1]); err != nil {
		t.Error("the newest compare was forgotten")
	}
}

func TestCancelStopsACompare(t *testing.T) {
	base := t.TempDir()
	left, right := filepath.Join(base, "l"), filepath.Join(base, "r")
	for d := range 200 {
		for f := range 10 {
			name := filepath.Join("d"+strings.Repeat("x", d%7), "sub"+string(rune('a'+d%26)), "f"+string(rune('a'+f))+".txt")
			put(t, left, name, "x", 0)
			put(t, right, name, "y", 0)
		}
	}
	h := newHarness(t)
	r2, err := h.m.Start(Spec{Left: left, Right: right, Content: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.m.Cancel(r2.ID())
	h.m.Wait(r2.ID())
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, p := range h.events {
		if p.CompareID == r2.ID() && p.State != StateRunning && p.State != StateCancelled && p.State != StateCompleted {
			t.Errorf("state %s", p.State)
		}
	}
	// A cancelled compare gives no plan.
	if _, err := r2.Plan(r2.Summary().Version); err == nil && h.events[len(h.events)-1].State == StateCancelled {
		t.Error("a plan of a cancelled compare")
	}
}

func TestIDs(t *testing.T) {
	id := rowID(7, 41)
	if c, r, ok := splitID(id); !ok || c != 7 || r != 41 || !IsID(id) {
		t.Errorf("split %d %d %v", c, r, ok)
	}
	if IsID(1<<50+5) || IsID(123) {
		t.Error("an index or archive id taken for a compare row")
	}
	if rowID(1<<30, MaxRows) >= 1<<53 {
		t.Error("ids must stay below 2^53")
	}
	if _, _, ok := splitID(IDBase + 7<<rowBits); ok {
		t.Error("row 0 of the id space is not a row")
	}
}
