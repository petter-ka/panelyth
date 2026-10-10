package preview

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func key(n byte) Key { var k Key; k[0] = n; return k }

type recorder struct {
	mu    sync.Mutex
	order []byte
	runs  atomic.Int32
	gate  chan struct{}
}

func (r *recorder) run(s **Scheduler) Runner {
	return func(ctx context.Context, t *Task) {
		if r.gate != nil {
			<-r.gate
		}
		r.runs.Add(1)
		r.mu.Lock()
		r.order = append(r.order, t.Key[0])
		r.mu.Unlock()
		(*s).TakeWaiters(t)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timeout")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestIdenticalRequestsCoalesce(t *testing.T) {
	var s *Scheduler
	r := &recorder{gate: make(chan struct{})}
	s = NewScheduler(4, 100, r.run(&s))
	defer s.Close()
	for i := range 10 {
		s.Submit("grid", 1, []Request{{Key: key(7), EntryID: int64(i), Priority: PriorityVisible}})
	}
	close(r.gate)
	waitFor(t, func() bool { return r.runs.Load() == 1 && s.Stats().Running == 0 })
	time.Sleep(20 * time.Millisecond)
	if n := r.runs.Load(); n != 1 {
		t.Fatalf("10 identical requests ran %d decodes", n)
	}
	if j := s.Stats().Joined; j != 9 {
		t.Fatalf("joined %d, want 9", j)
	}
}

func TestPriorityOrder(t *testing.T) {
	var s *Scheduler
	r := &recorder{gate: make(chan struct{})}
	s = NewScheduler(1, 100, r.run(&s))
	defer s.Close()
	// Occupy the single worker, then queue mixed priorities.
	s.Submit("grid", 1, []Request{{Key: key(99), Priority: PriorityVisible}})
	waitFor(t, func() bool { return s.Stats().Running == 1 })
	s.Submit("grid", 1, []Request{
		{Key: key(3), Priority: PriorityIdle},
		{Key: key(2), Priority: PriorityForward},
		{Key: key(1), Priority: PriorityVisible},
		{Key: key(4), Priority: PriorityVisible},
	})
	// Re-requesting an idle task as visible promotes it.
	s.Submit("grid", 1, []Request{{Key: key(3), Priority: PriorityVisible}})
	close(r.gate)
	waitFor(t, func() bool { return r.runs.Load() == 5 })
	r.mu.Lock()
	defer r.mu.Unlock()
	want := []byte{99, 1, 4, 3, 2}
	for i := range want {
		if r.order[i] != want[i] {
			t.Fatalf("order %v, want %v", r.order, want)
		}
	}
}

func TestNewEpochDropsStaleQueuedWork(t *testing.T) {
	var s *Scheduler
	r := &recorder{gate: make(chan struct{})}
	s = NewScheduler(1, 1000, r.run(&s))
	defer s.Close()
	s.Submit("grid", 1, []Request{{Key: key(1)}})
	waitFor(t, func() bool { return s.Stats().Running == 1 })
	// The user scrolls: epoch 2 queues 10..19, epoch 3 wants only 15 and 30.
	var reqs []Request
	for i := byte(10); i < 20; i++ {
		reqs = append(reqs, Request{Key: key(i)})
	}
	s.Submit("grid", 2, reqs)
	s.Submit("other", 1, []Request{{Key: key(50)}})
	s.Submit("grid", 3, []Request{{Key: key(15)}, {Key: key(30)}})
	if q := s.Stats().Queued; q != 3 {
		t.Fatalf("queued %d, want 3 (15, 30, and the other lane's 50)", q)
	}
	close(r.gate)
	waitFor(t, func() bool { return r.runs.Load() == 4 })
	time.Sleep(20 * time.Millisecond)
	if r.runs.Load() != 4 {
		t.Fatalf("stale work ran: %v", r.order)
	}
}

func TestQueueBound(t *testing.T) {
	var s *Scheduler
	r := &recorder{gate: make(chan struct{})}
	s = NewScheduler(1, 3, r.run(&s))
	defer func() { close(r.gate); s.Close() }()
	s.Submit("grid", 1, []Request{{Key: key(0)}})
	waitFor(t, func() bool { return s.Stats().Running == 1 })
	acc, def := s.Submit("grid", 1, []Request{
		{Key: key(1), Priority: PriorityIdle},
		{Key: key(2), Priority: PriorityIdle},
		{Key: key(3), Priority: PriorityIdle},
		{Key: key(4), Priority: PriorityIdle}, // full: deferred
		{Key: key(5), Priority: PriorityVisible},
	})
	if acc != 4 || def != 1 {
		t.Fatalf("accepted %d deferred %d", acc, def)
	}
	if st := s.Stats(); st.Queued != 3 || st.Dropped != 1 {
		t.Fatalf("stats %+v", st)
	}
}

func TestRequestAfterCompletionStartsFreshTask(t *testing.T) {
	var s *Scheduler
	r := &recorder{}
	s = NewScheduler(2, 10, r.run(&s))
	defer s.Close()
	s.Submit("grid", 1, []Request{{Key: key(1)}})
	waitFor(t, func() bool { return r.runs.Load() == 1 && s.Stats().Running == 0 })
	s.Submit("grid", 1, []Request{{Key: key(1)}})
	waitFor(t, func() bool { return r.runs.Load() == 2 })
}
