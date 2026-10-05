// Package events coalesces outgoing events: for each (channel, key) only the
// latest payload is sent, at most once per interval. Idle costs nothing:
// the flush timer only runs while something is pending.
package events

import (
	"sync"
	"time"
)

// EmitFunc sends one event (rpc.Server.Emit).
type EmitFunc func(channel string, payload any) error

type slot struct {
	channel string
	payload any
}

// Coalescer batches events. Safe for concurrent use.
type Coalescer struct {
	emit     EmitFunc
	interval time.Duration

	mu      sync.Mutex
	pending map[string]slot
	order   []string
	batches map[string][]any
	batchCh []string
	timer   *time.Timer
	closed  bool
}

// MaxBatch caps items per appended event so one event stays small.
const MaxBatch = 500

// Batch is the payload of an appended channel: {"items": [...]}.
type Batch struct {
	Items []any `json:"items"`
}

// New returns a coalescer that flushes at most once per interval.
func New(emit EmitFunc, interval time.Duration) *Coalescer {
	return &Coalescer{emit: emit, interval: interval, pending: map[string]slot{}, batches: map[string][]any{}}
}

// Post queues payload, replacing any pending payload with the same key.
func (c *Coalescer) Post(channel, key string, payload any) {
	id := channel + "\x00" + key
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	if _, exists := c.pending[id]; !exists {
		c.order = append(c.order, id)
	}
	c.pending[id] = slot{channel: channel, payload: payload}
	if c.timer == nil {
		c.timer = time.AfterFunc(c.interval, c.Flush)
	}
}

// Append queues item on a batching channel: everything appended within one
// interval is sent as one Batch event (split at MaxBatch items).
func (c *Coalescer) Append(channel string, item any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	if _, ok := c.batches[channel]; !ok {
		c.batchCh = append(c.batchCh, channel)
	}
	c.batches[channel] = append(c.batches[channel], item)
	if c.timer == nil {
		c.timer = time.AfterFunc(c.interval, c.Flush)
	}
}

// Flush sends everything pending now, in first-posted order.
func (c *Coalescer) Flush() {
	c.mu.Lock()
	order, pending := c.order, c.pending
	batchCh, batches := c.batchCh, c.batches
	c.order, c.pending, c.timer = nil, map[string]slot{}, nil
	c.batchCh, c.batches = nil, map[string][]any{}
	c.mu.Unlock()
	for _, id := range order {
		s := pending[id]
		_ = c.emit(s.channel, s.payload)
	}
	for _, ch := range batchCh {
		items := batches[ch]
		for lo := 0; lo < len(items); lo += MaxBatch {
			_ = c.emit(ch, Batch{Items: items[lo:min(lo+MaxBatch, len(items))]})
		}
	}
}

// Close flushes and stops accepting events.
func (c *Coalescer) Close() {
	c.mu.Lock()
	c.closed = true
	if c.timer != nil {
		c.timer.Stop()
	}
	c.mu.Unlock()
	c.Flush()
}
