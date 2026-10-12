package watch

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var (
	viewer = Slot{App: "viewer"}
	left   = Slot{App: "commander", Lane: "left"}
	right  = Slot{App: "commander", Lane: "right"}
)

func TestBurstBecomesOneRelist(t *testing.T) {
	dir := t.TempDir()
	var calls atomic.Int32
	var last atomic.Int64
	// A quiet window well above any pause inside the burst: on CI runners
	// (Windows with Defender) 200 writes can stall for more than 100 ms, or
	// their events arrive in batches, and the test is about coalescing.
	w := New(slog.New(slog.DiscardHandler), func(id int64) { calls.Add(1); last.Store(id) }, 500*time.Millisecond, 5*time.Second)
	defer w.Close()
	w.Watch(viewer, 7, dir)
	for i := range 200 {
		_ = os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%d.jpg", i)), nil, 0o644)
	}
	time.Sleep(1500 * time.Millisecond)
	if n := calls.Load(); n != 1 {
		t.Fatalf("200 events should cause 1 re-listing, got %d", n)
	}
	if last.Load() != 7 {
		t.Fatalf("wrong dir id %d", last.Load())
	}
}

func TestMaxWaitUnderContinuousEvents(t *testing.T) {
	dir := t.TempDir()
	var calls atomic.Int32
	w := New(slog.New(slog.DiscardHandler), func(int64) { calls.Add(1) }, 100*time.Millisecond, 300*time.Millisecond)
	defer w.Close()
	w.Watch(viewer, 1, dir)
	stop := time.Now().Add(700 * time.Millisecond)
	for i := 0; time.Now().Before(stop); i++ {
		_ = os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%d.jpg", i)), nil, 0o644)
		time.Sleep(20 * time.Millisecond)
	}
	if n := calls.Load(); n < 1 {
		t.Fatal("continuous events must still trigger a re-listing within maxWait")
	}
}

func TestSwitchingFoldersStopsOldWatch(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	var got atomic.Int64
	w := New(slog.New(slog.DiscardHandler), func(id int64) { got.Store(id) }, 50*time.Millisecond, time.Second)
	defer w.Close()
	w.Watch(viewer, 1, a)
	w.Watch(viewer, 2, b) // the viewer's slot now holds b
	_ = os.WriteFile(filepath.Join(a, "x.jpg"), nil, 0o644)
	time.Sleep(200 * time.Millisecond)
	if got.Load() != 0 {
		t.Fatalf("event in unwatched folder triggered dir %d", got.Load())
	}
	_ = os.WriteFile(filepath.Join(b, "y.jpg"), nil, 0o644)
	time.Sleep(200 * time.Millisecond)
	if got.Load() != 2 {
		t.Fatalf("watched folder event not delivered: %d", got.Load())
	}
}

// The real backend end to end: the commander's panels are watched while it
// is on screen and silent while the viewer is; showing it again re-lists them.
func TestOnlyTheVisibleAppIsWatchedOnDisk(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	var mu sync.Mutex
	got := map[int64]int{}
	w := New(slog.New(slog.DiscardHandler), func(id int64) { mu.Lock(); got[id]++; mu.Unlock() }, 50*time.Millisecond, time.Second)
	defer w.Close()
	count := func(id int64) int { mu.Lock(); defer mu.Unlock(); return got[id] }

	w.Show("viewer")
	w.Watch(viewer, 1, a)
	w.Watch(left, 2, b)
	for _, d := range []string{a, b} {
		_ = os.WriteFile(filepath.Join(d, "x.jpg"), nil, 0o644)
	}
	time.Sleep(300 * time.Millisecond)
	if count(1) != 1 || count(2) != 0 {
		t.Fatalf("with the viewer on screen: %v (want its folder once, the panel's never)", got)
	}

	w.Show("commander") // the panel's folder changed while hidden
	time.Sleep(300 * time.Millisecond)
	if count(2) != 1 {
		t.Fatalf("the shown app's folder is re-listed once: %v", got)
	}
	_ = os.WriteFile(filepath.Join(a, "y.jpg"), nil, 0o644)
	_ = os.WriteFile(filepath.Join(b, "y.jpg"), nil, 0o644)
	time.Sleep(300 * time.Millisecond)
	if count(1) != 1 || count(2) != 2 {
		t.Fatalf("with the commander on screen: %v (want the panel's folder again, the viewer's not)", got)
	}
}

func TestWatchDoesNotBlockWhileEventsFlow(t *testing.T) {
	a := t.TempDir()
	w := New(slog.New(slog.DiscardHandler), func(int64) {}, 50*time.Millisecond, time.Second)
	defer w.Close()
	w.Watch(viewer, 1, a)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
				_ = os.WriteFile(filepath.Join(a, "busy.log"), []byte{byte(i)}, 0o644)
			}
		}
	}()
	time.Sleep(50 * time.Millisecond)
	done := make(chan struct{})
	go func() {
		for i := range 20 {
			w.Watch(Slot{App: "commander", Lane: fmt.Sprint(i % 3)}, int64(10+i), t.TempDir())
			if i%5 == 4 {
				w.Show([]string{"viewer", "commander"}[i%2])
			}
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Watch blocked while the watched folder kept changing")
	}
}

// fakeBackend records the watch set and delivers events for watched folders
// only, as the OS does.
type fakeBackend struct {
	mu     sync.Mutex
	added  map[string]bool
	fail   map[string]bool
	adds   int
	events chan string
	errs   chan error
}

func newFake() *fakeBackend {
	return &fakeBackend{added: map[string]bool{}, fail: map[string]bool{}, events: make(chan string, 16), errs: make(chan error)}
}

func (f *fakeBackend) Add(dir string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.adds++
	if f.fail[dir] {
		return errors.New("no watch here")
	}
	f.added[dir] = true
	return nil
}

func (f *fakeBackend) Remove(dir string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.added, dir)
	return nil
}

func (f *fakeBackend) Close() error           { close(f.events); return nil }
func (f *fakeBackend) changed() <-chan string { return f.events }
func (f *fakeBackend) errors() <-chan error   { return f.errs }
func (f *fakeBackend) change(dir string) {
	f.mu.Lock()
	ok := f.added[dir]
	f.mu.Unlock()
	if ok {
		f.events <- dir
	}
}
func (f *fakeBackend) addCalls() int { f.mu.Lock(); defer f.mu.Unlock(); return f.adds }
func (f *fakeBackend) watching() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for d := range f.added {
		out = append(out, d)
	}
	slices.Sort(out)
	return out
}

type relists struct {
	mu  sync.Mutex
	ids []int64
}

func (r *relists) add(id int64) { r.mu.Lock(); r.ids = append(r.ids, id); r.mu.Unlock() }

// take returns the re-listings since the last call, once the quiet period
// (10 ms in these tests) is well over.
func (r *relists) take() []int64 {
	time.Sleep(80 * time.Millisecond)
	r.mu.Lock()
	defer r.mu.Unlock()
	out := slices.Clone(r.ids)
	slices.Sort(out)
	r.ids = nil
	return out
}

func fakeWatcher(t *testing.T) (*Watcher, *fakeBackend, *relists) {
	t.Helper()
	fb, r := newFake(), &relists{}
	w := newWatcher(slog.New(slog.DiscardHandler), r.add, 10*time.Millisecond, 100*time.Millisecond, fb)
	t.Cleanup(w.Close)
	return w, fb, r
}

func eq[T comparable](t *testing.T, what string, got, want []T) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("%s: got %v, want %v", what, got, want)
	}
}

func TestBeforeMainNamesAnAppEveryFolderIsWatched(t *testing.T) {
	w, fb, _ := fakeWatcher(t)
	w.Watch(viewer, 1, "/photos")
	w.Watch(left, 2, "/a")
	w.Watch(right, 3, "/b")
	eq(t, "watched", fb.watching(), []string{"/a", "/b", "/photos"})
}

func TestOnlyTheVisibleAppsSlotsAreWatched(t *testing.T) {
	w, fb, r := fakeWatcher(t)
	w.Show("viewer")
	w.Watch(viewer, 1, "/photos")
	w.Watch(left, 2, "/a")
	w.Watch(right, 3, "/b")
	w.Watch(Slot{Lane: "openwith"}, 4, "/downloads") // main's own: always
	eq(t, "viewer on screen", fb.watching(), []string{"/downloads", "/photos"})
	eq(t, "nothing re-listed by opening", r.take(), nil)

	w.Show("commander")
	eq(t, "commander on screen", fb.watching(), []string{"/a", "/b", "/downloads"})
	eq(t, "its panels are re-listed", r.take(), []int64{2, 3})

	w.Show("viewer")
	eq(t, "viewer again", fb.watching(), []string{"/downloads", "/photos"})
	eq(t, "its folder is re-listed", r.take(), []int64{1})

	// Naming the app that is on screen changes nothing (main repeats it
	// after a sidecar restart and on a click on the current app).
	w.Show("viewer")
	eq(t, "same app: nothing re-listed", r.take(), nil)
}

func TestAFolderBothAppsShowStaysWatchedAndIsNotRelisted(t *testing.T) {
	w, fb, r := fakeWatcher(t)
	w.Show("viewer")
	w.Watch(viewer, 1, "/photos")
	w.Watch(left, 1, "/photos") // carried over to the commander's panel
	w.Watch(right, 2, "/other")
	adds := fb.addCalls()

	w.Show("commander")
	eq(t, "watched", fb.watching(), []string{"/other", "/photos"})
	eq(t, "only the folder that was not watched", r.take(), []int64{2})
	if fb.addCalls() != adds+1 {
		t.Fatalf("/photos was watched all along and must not be added again: %d adds", fb.addCalls()-adds)
	}
}

func TestASlotHoldsOneFolder(t *testing.T) {
	w, fb, _ := fakeWatcher(t)
	w.Show("commander")
	w.Watch(left, 1, "/a")
	w.Watch(left, 2, "/b")
	w.Watch(right, 3, "/c")
	eq(t, "watched", fb.watching(), []string{"/b", "/c"})
	// Both panels on one folder, then one moves on: the folder stays watched.
	w.Watch(right, 2, "/b")
	w.Watch(left, 4, "/d")
	eq(t, "watched", fb.watching(), []string{"/b", "/d"})
}

func TestAnAppHoldsAtMostMaxLanesSlots(t *testing.T) {
	w, fb, _ := fakeWatcher(t)
	w.Show("commander")
	w.Watch(viewer, 99, "/photos") // another app's slot is never the one dropped
	for i := range MaxLanes + 2 {
		w.Watch(Slot{App: "commander", Lane: fmt.Sprint("lane", i)}, int64(i+1), fmt.Sprint("/d", i))
	}
	eq(t, "the oldest lanes are dropped", fb.watching(), []string{"/d2", "/d3", "/d4", "/d5"})
	w.Show("viewer")
	eq(t, "the viewer kept its slot", fb.watching(), []string{"/photos"})
}

func TestEventsOfAHiddenAppAreDropped(t *testing.T) {
	w, fb, r := fakeWatcher(t)
	w.Show("commander")
	w.Watch(left, 2, "/a")
	fb.change("/a")
	w.Show("viewer") // before the quiet period ended: the pending re-listing goes
	eq(t, "no re-listing for a hidden app", r.take(), nil)

	w.Show("commander")
	eq(t, "one re-listing when shown", r.take(), []int64{2})
	fb.change("/a")
	eq(t, "and events again", r.take(), []int64{2})
}

// The usual switch: the app being shown opens the folder carried over from
// the other app at once, so its old folder is not listed for nothing.
func TestAFolderLeftRightAfterTheShowIsNotRelisted(t *testing.T) {
	w, fb, r := fakeWatcher(t)
	w.Show("commander")
	w.Watch(viewer, 1, "/old")
	w.Watch(left, 2, "/work")

	w.Show("viewer")
	w.Watch(viewer, 3, "/carried") // within the quiet period
	eq(t, "the folder it left is not re-listed, the one it opened was just listed", r.take(), nil)
	eq(t, "watched", fb.watching(), []string{"/carried"})
}

func TestAFolderThatCannotBeWatchedIsNotRetriedButIsRelistedOnShow(t *testing.T) {
	w, fb, r := fakeWatcher(t)
	fb.fail["/share"] = true
	w.Show("commander")
	w.Watch(left, 5, "/share")
	w.Watch(right, 6, "/b")
	w.Watch(right, 7, "/c")
	if n := fb.addCalls(); n != 3 {
		t.Fatalf("the failed folder is added once, not with every sync: %d adds", n)
	}
	eq(t, "watched", fb.watching(), []string{"/c"})

	w.Show("viewer")
	w.Show("commander")
	// No watch tells us about it, so it is out of date like the others.
	eq(t, "re-listed on show", r.take(), []int64{5, 7})

	// Left and opened again: a new attempt.
	fb.fail["/share"] = false
	w.Watch(left, 8, "/elsewhere")
	w.Watch(left, 5, "/share")
	eq(t, "watched", fb.watching(), []string{"/c", "/share"})
}

func TestWithoutAnOSWatcherNothingHappens(t *testing.T) {
	r := &relists{}
	w := newWatcher(slog.New(slog.DiscardHandler), r.add, time.Millisecond, time.Millisecond, nil)
	w.Watch(viewer, 1, "/photos")
	w.Show("commander")
	w.Show("viewer")
	w.Close()
	eq(t, "no re-listing", r.take(), nil)
}
