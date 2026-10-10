package events

import (
	"sync"
	"testing"
	"time"
)

type sink struct {
	mu  sync.Mutex
	got []string
}

func (s *sink) emit(ch string, p any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.got = append(s.got, ch+":"+p.(string))
	return nil
}

func (s *sink) snapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.got...)
}

func TestLatestWinsPerKey(t *testing.T) {
	var s sink
	c := New(s.emit, 20*time.Millisecond)
	for i := range 1000 {
		c.Post("index.progress", "scan-1", string(rune('a'+i%26)))
	}
	c.Post("query.invalidated", "q-1", "v2")
	time.Sleep(60 * time.Millisecond)
	got := s.snapshot()
	if len(got) != 2 || got[0] != "index.progress:l" || got[1] != "query.invalidated:v2" {
		t.Fatalf("got %q", got)
	}
}

func TestCloseFlushesAndStops(t *testing.T) {
	var s sink
	c := New(s.emit, time.Hour)
	c.Post("a", "k", "1")
	c.Close()
	c.Post("a", "k", "2")
	if got := s.snapshot(); len(got) != 1 || got[0] != "a:1" {
		t.Fatalf("got %q", got)
	}
}

func TestAppendBatches(t *testing.T) {
	var mu sync.Mutex
	var sizes []int
	c := New(func(ch string, p any) error {
		mu.Lock()
		sizes = append(sizes, len(p.(Batch).Items))
		mu.Unlock()
		return nil
	}, 20*time.Millisecond)
	for i := range MaxBatch + 10 {
		c.Append("preview.ready", i)
	}
	time.Sleep(60 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(sizes) != 2 || sizes[0] != MaxBatch || sizes[1] != 10 {
		t.Fatalf("batches %v", sizes)
	}
}
