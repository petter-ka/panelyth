// Package workpool provides a bounded worker pool: a fixed number of workers
// and a fixed-capacity queue. It never spawns a goroutine per job, and it
// reports saturation instead of growing without bound.
//
// Priorities and deduplication belong to the thumbnail scheduler (stage 02),
// which sits in front of a pool.
package workpool

import (
	"context"
	"errors"
	"sync"
)

var (
	// ErrQueueFull is returned by Submit when the queue is at capacity.
	ErrQueueFull = errors.New("workpool: queue full")
	// ErrClosed is returned when submitting to a closed pool.
	ErrClosed = errors.New("workpool: closed")
)

// Job receives the context it was submitted with. Jobs must honour
// cancellation for anything long-running.
type Job func(ctx context.Context)

type task struct {
	ctx context.Context
	fn  Job
}

// Pool is a bounded worker pool. The zero value is not usable; call New.
type Pool struct {
	mu     sync.RWMutex
	closed bool
	tasks  chan task
	wg     sync.WaitGroup
}

// New starts workers goroutines consuming a queue of queueSize pending jobs.
func New(workers, queueSize int) *Pool {
	if workers < 1 {
		workers = 1
	}
	if queueSize < 0 {
		queueSize = 0
	}
	p := &Pool{tasks: make(chan task, queueSize)}
	p.wg.Add(workers)
	for range workers {
		go p.work()
	}
	return p
}

func (p *Pool) work() {
	defer p.wg.Done()
	for t := range p.tasks {
		// A job cancelled while queued is skipped rather than started.
		if t.ctx.Err() != nil {
			continue
		}
		t.fn(t.ctx)
	}
}

// Submit enqueues fn without blocking. It returns ErrQueueFull when the pool
// is saturated so callers can apply backpressure or drop low-priority work.
func (p *Pool) Submit(ctx context.Context, fn Job) error {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed {
		return ErrClosed
	}
	select {
	case p.tasks <- task{ctx: ctx, fn: fn}:
		return nil
	default:
		return ErrQueueFull
	}
}

// SubmitWait enqueues fn, blocking until there is room or ctx is done.
func (p *Pool) SubmitWait(ctx context.Context, fn Job) error {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed {
		return ErrClosed
	}
	select {
	case p.tasks <- task{ctx: ctx, fn: fn}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Len reports the number of queued (not yet started) jobs.
func (p *Pool) Len() int { return len(p.tasks) }

// Cap reports the queue capacity.
func (p *Pool) Cap() int { return cap(p.tasks) }

// Close stops accepting jobs and waits for queued and running jobs to finish,
// or for ctx to be done. Jobs still running after ctx expires keep running;
// they are expected to observe their own contexts.
func (p *Pool) Close(ctx context.Context) error {
	p.mu.Lock()
	if !p.closed {
		p.closed = true
		close(p.tasks)
	}
	p.mu.Unlock()

	done := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
