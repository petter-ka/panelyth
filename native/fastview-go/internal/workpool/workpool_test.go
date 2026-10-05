package workpool

import (
	"context"
	"errors"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

func TestRunsJobsWithBoundedConcurrency(t *testing.T) {
	const workers = 3
	p := New(workers, 100)
	var running, peak, done atomic.Int32
	for range 50 {
		if err := p.SubmitWait(context.Background(), func(context.Context) {
			n := running.Add(1)
			for {
				old := peak.Load()
				if n <= old || peak.CompareAndSwap(old, n) {
					break
				}
			}
			time.Sleep(time.Millisecond)
			running.Add(-1)
			done.Add(1)
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := p.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if done.Load() != 50 {
		t.Fatalf("expected 50 jobs, ran %d", done.Load())
	}
	if peak.Load() > workers {
		t.Fatalf("concurrency %d exceeded limit %d", peak.Load(), workers)
	}
}

func TestSubmitReportsQueueFull(t *testing.T) {
	p := New(1, 1)
	block := make(chan struct{})
	started := make(chan struct{})
	ctx := context.Background()
	if err := p.Submit(ctx, func(context.Context) { close(started); <-block }); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := p.Submit(ctx, func(context.Context) {}); err != nil {
		t.Fatalf("queue slot should be free: %v", err)
	}
	if err := p.Submit(ctx, func(context.Context) {}); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("want ErrQueueFull, got %v", err)
	}
	close(block)
	_ = p.Close(ctx)
}

func TestSubmitWaitHonoursContext(t *testing.T) {
	p := New(1, 0)
	block := make(chan struct{})
	started := make(chan struct{})
	_ = p.SubmitWait(context.Background(), func(context.Context) { close(started); <-block })
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := p.SubmitWait(ctx, func(context.Context) {}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want DeadlineExceeded, got %v", err)
	}
	close(block)
	_ = p.Close(context.Background())
}

func TestCancelledJobIsSkipped(t *testing.T) {
	p := New(1, 4)
	block := make(chan struct{})
	started := make(chan struct{})
	_ = p.SubmitWait(context.Background(), func(context.Context) { close(started); <-block })
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	var ran atomic.Bool
	_ = p.Submit(ctx, func(context.Context) { ran.Store(true) })
	cancel()
	close(block)
	_ = p.Close(context.Background())
	if ran.Load() {
		t.Fatal("job cancelled while queued must not run")
	}
}

func TestSubmitAfterClose(t *testing.T) {
	p := New(2, 2)
	_ = p.Close(context.Background())
	if err := p.Submit(context.Background(), func(context.Context) {}); !errors.Is(err, ErrClosed) {
		t.Fatalf("want ErrClosed, got %v", err)
	}
	if err := p.Close(context.Background()); err != nil {
		t.Fatalf("second Close must be a no-op: %v", err)
	}
}

func TestCloseTimeout(t *testing.T) {
	p := New(1, 0)
	block := make(chan struct{})
	started := make(chan struct{})
	_ = p.SubmitWait(context.Background(), func(context.Context) { close(started); <-block })
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := p.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want DeadlineExceeded, got %v", err)
	}
	close(block)
}

func TestNoGoroutineLeak(t *testing.T) {
	before := runtime.NumGoroutine()
	for range 20 {
		p := New(8, 16)
		for range 16 {
			_ = p.Submit(context.Background(), func(context.Context) {})
		}
		_ = p.Close(context.Background())
	}
	deadline := time.Now().Add(time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if after := runtime.NumGoroutine(); after > before {
		t.Fatalf("goroutines leaked: before %d after %d", before, after)
	}
}

func BenchmarkSubmit(b *testing.B) {
	p := New(runtime.NumCPU(), 1024)
	ctx := context.Background()
	b.ReportAllocs()
	for b.Loop() {
		_ = p.SubmitWait(ctx, func(context.Context) {})
	}
	_ = p.Close(ctx)
}
