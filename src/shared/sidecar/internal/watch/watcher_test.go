package watch

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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
	w.Watch(7, dir)
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
	w.Watch(1, dir)
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
	w.SetLimit(1)
	w.Watch(1, a)
	w.Watch(2, b)
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

func TestWatchesSeveralFoldersUpToTheLimit(t *testing.T) {
	a, b, c := t.TempDir(), t.TempDir(), t.TempDir()
	var mu sync.Mutex
	got := map[int64]int{}
	w := New(slog.New(slog.DiscardHandler), func(id int64) { mu.Lock(); got[id]++; mu.Unlock() }, 50*time.Millisecond, time.Second)
	defer w.Close()
	w.SetLimit(2)
	w.Watch(1, a)
	w.Watch(2, b)
	w.Watch(1, a) // a becomes the most recent; c then evicts b
	w.Watch(3, c)
	for _, d := range []string{a, b, c} {
		_ = os.WriteFile(filepath.Join(d, "x.jpg"), nil, 0o644)
	}
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if got[1] != 1 || got[3] != 1 || got[2] != 0 {
		t.Fatalf("re-listings per folder: %v (want 1 and 3 once, 2 never)", got)
	}
}

func TestWatchDoesNotBlockWhileEventsFlow(t *testing.T) {
	a := t.TempDir()
	w := New(slog.New(slog.DiscardHandler), func(int64) {}, 50*time.Millisecond, time.Second)
	defer w.Close()
	w.Watch(1, a)
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
			w.Watch(int64(10+i), t.TempDir())
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Watch blocked while the watched folder kept changing")
	}
}
