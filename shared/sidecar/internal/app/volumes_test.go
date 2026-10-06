package app

import (
	"context"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"
)

func TestVolumeMonitorEmitsOnChangeOnly(t *testing.T) {
	var sig atomic.Value
	sig.Store("C:\x00fixed\x00\n")
	var emitted atomic.Int32
	m := volumeMonitor{
		interval:  5 * time.Millisecond,
		signature: func() (string, error) { return sig.Load().(string), nil },
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m.start(ctx, func() { emitted.Add(1) }, slog.Default())
	m.start(ctx, func() { t.Error("second start must not run") }, slog.Default())

	time.Sleep(40 * time.Millisecond)
	if n := emitted.Load(); n != 0 {
		t.Fatalf("emitted %d times without a change", n)
	}
	sig.Store("C:\x00fixed\x00\nE:\x00removable\x00STICK\n")
	deadline := time.Now().Add(2 * time.Second)
	for emitted.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(40 * time.Millisecond)
	if n := emitted.Load(); n != 1 {
		t.Fatalf("emitted %d times for one change; want 1", n)
	}
	cancel()
}
