package preview

import (
	"container/heap"
	"context"
	"sync"
)

// Priority orders work; lower is sooner (PERFORMANCE.md "Thumbnail prefetch").
type Priority int

const (
	PriorityVisible  Priority = 0
	PriorityOverscan Priority = 1
	PriorityForward  Priority = 2
	PriorityIdle     Priority = 3
)

// Task is one unit of scheduled work, deduplicated by Key.
type Task struct {
	Key     Key
	Payload any // opaque to the scheduler (the service's job)

	prio    Priority
	seq     uint64
	lane    string
	epoch   uint64
	index   int // heap position; -1 when not queued
	running bool
	waiters map[int64]struct{}
}

// Waiters returns the entry ids waiting for this task.
func (t *Task) Waiters() []int64 {
	out := make([]int64, 0, len(t.waiters))
	for id := range t.waiters {
		out = append(out, id)
	}
	return out
}

type taskHeap []*Task

func (h taskHeap) Len() int { return len(h) }
func (h taskHeap) Less(i, j int) bool {
	if h[i].prio != h[j].prio {
		return h[i].prio < h[j].prio
	}
	return h[i].seq < h[j].seq
}
func (h taskHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].index, h[j].index = i, j
}
func (h *taskHeap) Push(x any) {
	t := x.(*Task)
	t.index = len(*h)
	*h = append(*h, t)
}
func (h *taskHeap) Pop() any {
	old := *h
	t := old[len(old)-1]
	old[len(old)-1] = nil
	t.index = -1
	*h = old[:len(old)-1]
	return t
}

// Runner executes a task. It must honour ctx.
type Runner func(ctx context.Context, t *Task)

// SchedulerStats is a snapshot for tests and diagnostics.
type SchedulerStats struct {
	Queued, Running int
	Dropped         uint64 // removed as stale or evicted
	Joined          uint64 // requests coalesced into an existing task
}

// Scheduler is a bounded priority queue with a fixed worker pool. A request
// for a key already queued or running joins that task instead of creating
// another (request coalescing, CACHE-DESIGN.md). Each lane (e.g. the grid)
// has an epoch; a new epoch drops that lane's queued tasks that were not
// requested again, so fast scrolling never builds a backlog of invisible work.
type Scheduler struct {
	run       Runner
	maxQueued int

	mu     sync.Mutex
	cond   *sync.Cond
	queue  taskHeap
	byKey  map[Key]*Task
	seq    uint64
	lanes  map[string]uint64
	stats  SchedulerStats
	closed bool

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewScheduler starts workers goroutines.
func NewScheduler(workers, maxQueued int, run Runner) *Scheduler {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Scheduler{run: run, maxQueued: maxQueued, byKey: map[Key]*Task{}, lanes: map[string]uint64{}, ctx: ctx, cancel: cancel}
	s.cond = sync.NewCond(&s.mu)
	s.wg.Add(workers)
	for range workers {
		go s.worker()
	}
	return s
}

// Request is one entry wanting one key.
type Request struct {
	Key      Key
	EntryID  int64
	Priority Priority
	Payload  any
}

// Submit enqueues requests for lane at epoch. It returns how many were
// accepted (queued or joined) and how many were deferred because the queue
// is full of more important work; deferred items are re-requested by the
// renderer when they become visible again.
func (s *Scheduler) Submit(lane string, epoch uint64, reqs []Request) (accepted, deferred int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return 0, len(reqs)
	}
	if epoch > s.lanes[lane] {
		s.lanes[lane] = epoch
	}
	current := s.lanes[lane]
	for _, r := range reqs {
		if t := s.byKey[r.Key]; t != nil {
			s.stats.Joined++
			t.waiters[r.EntryID] = struct{}{}
			if t.lane == lane {
				t.epoch = max(t.epoch, current)
			}
			if r.Priority < t.prio {
				// Promoted tasks take their place in this request's order
				// (screen order), not their original, older position.
				s.seq++
				t.prio, t.seq = r.Priority, s.seq
				if t.index >= 0 {
					heap.Fix(&s.queue, t.index)
				}
			}
			accepted++
			continue
		}
		if len(s.queue) >= s.maxQueued && !s.evictWorseLocked(r.Priority) {
			deferred++
			continue
		}
		s.seq++
		t := &Task{Key: r.Key, Payload: r.Payload, prio: r.Priority, seq: s.seq, lane: lane, epoch: current,
			index: -1, waiters: map[int64]struct{}{r.EntryID: {}}}
		s.byKey[r.Key] = t
		heap.Push(&s.queue, t)
		accepted++
	}
	s.dropStaleLocked(lane, current)
	s.cond.Broadcast()
	return accepted, deferred
}

// dropStaleLocked removes queued (not running) tasks of lane from older epochs.
func (s *Scheduler) dropStaleLocked(lane string, epoch uint64) {
	for i := 0; i < len(s.queue); {
		t := s.queue[i]
		if t.lane == lane && t.epoch < epoch {
			heap.Remove(&s.queue, i)
			delete(s.byKey, t.Key)
			s.stats.Dropped++
			continue // the heap moved another task into i
		}
		i++
	}
}

// evictWorseLocked drops the lowest-priority queued task if it is less
// important than p, making room.
func (s *Scheduler) evictWorseLocked(p Priority) bool {
	worst := -1
	for i := range s.queue {
		if worst < 0 || s.queue.Less(worst, i) {
			worst = i
		}
	}
	if worst < 0 || s.queue[worst].prio <= p {
		return false
	}
	t := heap.Remove(&s.queue, worst).(*Task)
	delete(s.byKey, t.Key)
	s.stats.Dropped++
	return true
}

func (s *Scheduler) worker() {
	defer s.wg.Done()
	for {
		s.mu.Lock()
		for len(s.queue) == 0 && !s.closed {
			s.cond.Wait()
		}
		if s.closed {
			s.mu.Unlock()
			return
		}
		t := heap.Pop(&s.queue).(*Task)
		t.running = true
		s.stats.Running++
		s.mu.Unlock()

		s.run(s.ctx, t)

		s.mu.Lock()
		s.stats.Running--
		// A newer task for the same key may already be registered (a request
		// arrived after TakeWaiters); only remove our own entry.
		if s.byKey[t.Key] == t {
			delete(s.byKey, t.Key)
		}
		s.mu.Unlock()
	}
}

// TakeWaiters atomically removes the task from the dedup map and returns
// its waiters. Runners call it when publishing results, so a request that
// arrives afterwards starts a fresh task (and hits the cache).
func (s *Scheduler) TakeWaiters(t *Task) []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.byKey[t.Key] == t {
		delete(s.byKey, t.Key)
	}
	return t.Waiters()
}

// Stats returns a snapshot.
func (s *Scheduler) Stats() SchedulerStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.stats
	st.Queued = len(s.queue)
	return st
}

// Close cancels running work and stops the workers.
func (s *Scheduler) Close() {
	s.mu.Lock()
	s.closed = true
	s.cond.Broadcast()
	s.mu.Unlock()
	s.cancel()
	s.wg.Wait()
}
