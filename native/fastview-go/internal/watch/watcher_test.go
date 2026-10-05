package watch

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestBurstBecomesOneRelist(t *testing.T) {
	dir := t.TempDir()
	var calls atomic.Int32
	var last atomic.Int64
	w := New(slog.New(slog.DiscardHandler), func(id int64) { calls.Add(1); last.Store(id) }, 100*time.Millisecond, time.Second)
	defer w.Close()
	w.Watch(7, dir)
	for i := range 200 {
		_ = os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%d.jpg", i)), nil, 0o644)
	}
	time.Sleep(600 * time.Millisecond)
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
