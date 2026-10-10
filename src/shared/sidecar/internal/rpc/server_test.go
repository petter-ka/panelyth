package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"testing"
	"time"
)

// harness drives a Server over in-memory pipes.
type harness struct {
	t      *testing.T
	in     *io.PipeWriter
	frames chan map[string]any
	done   chan error
	cancel context.CancelFunc
}

func startServer(t *testing.T, opts Options, register func(*Server)) *harness {
	t.Helper()
	srv := NewServer(opts)
	register(srv)
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	h := &harness{t: t, in: inW, frames: make(chan map[string]any, 64), done: make(chan error, 1), cancel: cancel}
	go func() {
		err := srv.Serve(ctx, inR, outW, Hello{Protocol: ProtocolVersion, Version: "test"})
		_ = outW.Close()
		h.done <- err
	}()
	go func() {
		fr := NewFrameReader(outR)
		for {
			p, err := fr.ReadFrame()
			if err != nil {
				close(h.frames)
				return
			}
			var m map[string]any
			if err := json.Unmarshal(p, &m); err != nil {
				t.Errorf("bad frame from server: %v", err)
				continue
			}
			h.frames <- m
		}
	}()
	t.Cleanup(func() {
		cancel()
		_ = inW.Close()
	})
	if hello := h.next(); hello["t"] != "hello" {
		t.Fatalf("first frame must be hello, got %v", hello)
	}
	return h
}

func (h *harness) send(v any) {
	h.t.Helper()
	b, _ := json.Marshal(v)
	if err := WriteFrame(h.in, b); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) next() map[string]any {
	h.t.Helper()
	select {
	case f, ok := <-h.frames:
		if !ok {
			h.t.Fatal("output closed")
		}
		return f
	case <-time.After(2 * time.Second):
		h.t.Fatal("timed out waiting for frame")
	}
	return nil
}

func errCode(f map[string]any) string {
	e, _ := f["e"].(map[string]any)
	s, _ := e["code"].(string)
	return s
}

type echo struct {
	V int `json:"v"`
}

func TestRequestResponse(t *testing.T) {
	h := startServer(t, Options{}, func(s *Server) {
		Register(s, "test.echo", func(_ context.Context, p echo) (echo, error) { return p, nil })
	})
	h.send(map[string]any{"t": "req", "id": 7, "m": "test.echo", "p": map[string]any{"v": 42}})
	res := h.next()
	if res["t"] != "res" || res["id"] != float64(7) || res["ok"] != true {
		t.Fatalf("unexpected response %v", res)
	}
	if r := res["r"].(map[string]any); r["v"] != float64(42) {
		t.Fatalf("unexpected result %v", r)
	}
}

func TestErrorPaths(t *testing.T) {
	h := startServer(t, Options{}, func(s *Server) {
		Register(s, "test.echo", func(_ context.Context, p echo) (echo, error) { return p, nil })
		Register(s, "test.fail", func(context.Context, struct{}) (struct{}, error) {
			return struct{}{}, NewError(CodeNotFound, "nope")
		})
		Register(s, "test.panic", func(context.Context, struct{}) (struct{}, error) { panic("boom") })
		Register(s, "test.plain", func(context.Context, struct{}) (struct{}, error) {
			return struct{}{}, errors.New("plain")
		})
	})
	cases := []struct {
		name string
		req  map[string]any
		code string
	}{
		{"unknown method", map[string]any{"t": "req", "id": 1, "m": "nope"}, "METHOD_NOT_FOUND"},
		{"unknown field", map[string]any{"t": "req", "id": 2, "m": "test.echo", "p": map[string]any{"x": 1}}, "INVALID_ARGUMENT"},
		{"wrong type", map[string]any{"t": "req", "id": 3, "m": "test.echo", "p": map[string]any{"v": "s"}}, "INVALID_ARGUMENT"},
		{"typed error", map[string]any{"t": "req", "id": 4, "m": "test.fail"}, "NOT_FOUND"},
		{"panic recovered", map[string]any{"t": "req", "id": 5, "m": "test.panic"}, "INTERNAL"},
		{"plain error", map[string]any{"t": "req", "id": 6, "m": "test.plain"}, "INTERNAL"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h.send(c.req)
			res := h.next()
			if res["ok"] != false || errCode(res) != c.code {
				t.Fatalf("want %s, got %v", c.code, res)
			}
		})
	}
	// The server keeps serving after a panic.
	h.send(map[string]any{"t": "req", "id": 9, "m": "test.echo", "p": map[string]any{"v": 1}})
	if res := h.next(); res["ok"] != true {
		t.Fatalf("server unhealthy after errors: %v", res)
	}
}

func TestCancelFrame(t *testing.T) {
	started := make(chan struct{})
	h := startServer(t, Options{}, func(s *Server) {
		Register(s, "test.block", func(ctx context.Context, _ struct{}) (struct{}, error) {
			close(started)
			<-ctx.Done()
			return struct{}{}, ctx.Err()
		})
	})
	h.send(map[string]any{"t": "req", "id": 1, "m": "test.block"})
	<-started
	h.send(map[string]any{"t": "cancel", "id": 1})
	if res := h.next(); errCode(res) != "CANCELLED" {
		t.Fatalf("want CANCELLED, got %v", res)
	}
}

func TestDeadline(t *testing.T) {
	h := startServer(t, Options{}, func(s *Server) {
		Register(s, "test.block", func(ctx context.Context, _ struct{}) (struct{}, error) {
			<-ctx.Done()
			return struct{}{}, ctx.Err()
		})
	})
	h.send(map[string]any{"t": "req", "id": 1, "m": "test.block", "deadlineMs": 20})
	if res := h.next(); errCode(res) != "TIMEOUT" {
		t.Fatalf("want TIMEOUT, got %v", res)
	}
}

func TestBusyAtInFlightLimit(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 2)
	h := startServer(t, Options{MaxInFlight: 2}, func(s *Server) {
		Register(s, "test.block", func(context.Context, struct{}) (struct{}, error) {
			entered <- struct{}{}
			<-release
			return struct{}{}, nil
		})
	})
	h.send(map[string]any{"t": "req", "id": 1, "m": "test.block"})
	h.send(map[string]any{"t": "req", "id": 2, "m": "test.block"})
	<-entered
	<-entered
	h.send(map[string]any{"t": "req", "id": 3, "m": "test.block"})
	res := h.next()
	if res["id"] != float64(3) || errCode(res) != "BUSY" {
		t.Fatalf("want BUSY for id 3, got %v", res)
	}
	if e := res["e"].(map[string]any); e["retryable"] != true {
		t.Fatalf("BUSY must be retryable: %v", e)
	}
	close(release)
	h.next()
	h.next()
}

func TestShutdownOnEOFDrainsInFlight(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{})
	h := startServer(t, Options{DrainTimeout: time.Second}, func(s *Server) {
		Register(s, "test.slow", func(ctx context.Context, _ struct{}) (string, error) {
			close(entered)
			select {
			case <-release:
				return "finished", nil
			case <-ctx.Done():
				return "", ctx.Err()
			}
		})
	})
	h.send(map[string]any{"t": "req", "id": 1, "m": "test.slow"})
	<-entered
	_ = h.in.Close() // EOF: Electron went away
	res := h.next()
	if errCode(res) != "CANCELLED" {
		t.Fatalf("in-flight request should be cancelled on shutdown, got %v", res)
	}
	select {
	case err := <-h.done:
		if err != nil {
			t.Fatalf("EOF must be a clean shutdown, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server did not stop after EOF")
	}
}

func TestEmitEvent(t *testing.T) {
	var srv *Server
	h := startServer(t, Options{}, func(s *Server) { srv = s })
	if err := srv.Emit("test.progress", map[string]int{"done": 3}); err != nil {
		t.Fatal(err)
	}
	evt := h.next()
	if evt["t"] != "evt" || evt["ch"] != "test.progress" || evt["seq"] != float64(1) {
		t.Fatalf("unexpected event %v", evt)
	}
}

func BenchmarkDispatchPing(b *testing.B) {
	srv := NewServer(Options{})
	Register(srv, "system.ping", func(context.Context, struct{}) (bool, error) { return true, nil })
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	go func() { _ = srv.Serve(context.Background(), inR, outW, Hello{}) }()
	fr := NewFrameReader(outR)
	if _, err := fr.ReadFrame(); err != nil { // hello
		b.Fatal(err)
	}
	req := []byte(`{"t":"req","id":1,"m":"system.ping","p":{}}`)
	b.ReportAllocs()
	for b.Loop() {
		if err := WriteFrame(inW, req); err != nil {
			b.Fatal(err)
		}
		if _, err := fr.ReadFrame(); err != nil {
			b.Fatal(err)
		}
	}
	_ = inW.Close()
}
