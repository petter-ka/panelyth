package rpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"
)

// Handler processes one request. params is the raw "p" field.
type Handler func(ctx context.Context, params json.RawMessage) (any, error)

// Options configures a Server.
type Options struct {
	// MaxInFlight bounds concurrently executing requests. Requests beyond the
	// limit are rejected with BUSY instead of queueing without bound.
	MaxInFlight int
	// OutQueue bounds encoded frames waiting for the writer goroutine.
	OutQueue int
	// DrainTimeout bounds how long shutdown waits for in-flight handlers.
	DrainTimeout time.Duration
	Logger       *slog.Logger
}

// Server dispatches framed requests to registered handlers.
type Server struct {
	opts     Options
	log      *slog.Logger
	handlers map[string]Handler

	inflight chan struct{}
	wg       sync.WaitGroup

	mu      sync.Mutex
	cancels map[uint64]context.CancelFunc

	out        chan []byte
	stopWriter chan struct{}
	writerDone chan struct{}

	eventSeq atomic.Uint64
}

// NewServer creates a server with the given options; zero values get
// conservative defaults.
func NewServer(opts Options) *Server {
	if opts.MaxInFlight <= 0 {
		opts.MaxInFlight = 64
	}
	if opts.OutQueue <= 0 {
		opts.OutQueue = 256
	}
	if opts.DrainTimeout <= 0 {
		opts.DrainTimeout = 2 * time.Second
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	return &Server{
		opts:       opts,
		log:        opts.Logger,
		handlers:   make(map[string]Handler),
		inflight:   make(chan struct{}, opts.MaxInFlight),
		cancels:    make(map[uint64]context.CancelFunc),
		out:        make(chan []byte, opts.OutQueue),
		stopWriter: make(chan struct{}),
		writerDone: make(chan struct{}),
	}
}

// Handle registers a raw handler. Must be called before Serve.
func (s *Server) Handle(method string, h Handler) {
	if _, dup := s.handlers[method]; dup {
		panic("rpc: duplicate handler for " + method)
	}
	s.handlers[method] = h
}

// Register adds a typed handler. Params are decoded strictly: unknown fields
// are rejected so TypeScript/Go contract drift surfaces immediately.
func Register[P, R any](s *Server, method string, fn func(ctx context.Context, p P) (R, error)) {
	s.Handle(method, func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p P
		if len(raw) > 0 && !bytes.Equal(raw, []byte("null")) {
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.DisallowUnknownFields()
			if err := dec.Decode(&p); err != nil {
				return nil, NewError(CodeInvalidArgument, "invalid params: "+err.Error())
			}
		}
		return fn(ctx, p)
	})
}

// Serve writes hello, then reads frames from r until r reaches EOF or ctx is
// cancelled. It then cancels in-flight handlers, waits up to DrainTimeout,
// flushes pending output and returns. EOF on r is a normal shutdown signal:
// it means the Electron main process closed our stdin or died.
func (s *Server) Serve(ctx context.Context, r io.Reader, w io.Writer, hello Hello) error {
	hello.T = typeHello
	go s.writeLoop(w)

	if err := s.sendJSON(hello); err != nil {
		s.finish()
		return err
	}

	reqCtx, cancelAll := context.WithCancel(ctx)
	defer cancelAll()

	frames := make(chan []byte)
	readErr := make(chan error, 1)
	readerStop := make(chan struct{})
	defer close(readerStop)
	go s.readLoop(r, frames, readErr, readerStop)

	var result error
loop:
	for {
		select {
		case <-ctx.Done():
			s.log.Info("shutdown requested")
			break loop
		case err := <-readErr:
			if errors.Is(err, io.EOF) {
				s.log.Info("stdin closed; shutting down")
			} else {
				s.log.Error("read failed; shutting down", "err", err)
				result = err
			}
			break loop
		case payload := <-frames:
			s.dispatch(reqCtx, payload)
		}
	}

	cancelAll()
	s.drain()
	s.finish()
	return result
}

// readLoop copies frames so the reader's buffer can be reused.
// The goroutine may stay blocked in Read after Serve returns; that is
// harmless because the process exits, and stop prevents it from blocking on
// the frames channel in tests.
func (s *Server) readLoop(r io.Reader, frames chan<- []byte, readErr chan<- error, stop <-chan struct{}) {
	fr := NewFrameReader(r)
	for {
		payload, err := fr.ReadFrame()
		if err != nil {
			readErr <- err
			return
		}
		select {
		case frames <- bytes.Clone(payload):
		case <-stop:
			return
		}
	}
}

func (s *Server) dispatch(ctx context.Context, payload []byte) {
	var msg inbound
	if err := json.Unmarshal(payload, &msg); err != nil {
		s.log.Warn("malformed frame", "err", err)
		return
	}
	switch msg.T {
	case typeCancel:
		s.mu.Lock()
		cancel := s.cancels[msg.ID]
		s.mu.Unlock()
		if cancel != nil {
			cancel()
		}
	case typeRequest:
		s.startRequest(ctx, msg)
	default:
		s.log.Warn("unknown frame type", "t", msg.T)
	}
}

func (s *Server) startRequest(ctx context.Context, msg inbound) {
	h, ok := s.handlers[msg.M]
	if !ok {
		s.respondErr(msg.ID, NewError(CodeMethodNotFound, "unknown method "+msg.M))
		return
	}
	select {
	case s.inflight <- struct{}{}:
	default:
		s.respondErr(msg.ID, NewError(CodeBusy, "too many in-flight requests"))
		return
	}

	var reqCtx context.Context
	var cancel context.CancelFunc
	if msg.DeadlineMs > 0 {
		reqCtx, cancel = context.WithTimeout(ctx, time.Duration(msg.DeadlineMs)*time.Millisecond)
	} else {
		reqCtx, cancel = context.WithCancel(ctx)
	}
	s.mu.Lock()
	s.cancels[msg.ID] = cancel
	s.mu.Unlock()

	s.wg.Add(1)
	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.cancels, msg.ID)
			s.mu.Unlock()
			cancel()
			<-s.inflight
			s.wg.Done()
		}()
		result, err := s.invoke(reqCtx, msg.M, h, msg.P)
		if err != nil {
			s.respondErr(msg.ID, toError(err))
			return
		}
		if err := s.sendJSON(responseOK{T: typeResponse, ID: msg.ID, OK: true, R: result}); err != nil {
			s.respondErr(msg.ID, toError(err))
		}
	}()
}

func (s *Server) invoke(ctx context.Context, method string, h Handler, params json.RawMessage) (result any, err error) {
	defer func() {
		if p := recover(); p != nil {
			s.log.Error("handler panic", "method", method, "panic", fmt.Sprint(p), "stack", string(debug.Stack()))
			err = NewError(CodeInternal, "internal error")
		}
	}()
	return h(ctx, params)
}

func (s *Server) respondErr(id uint64, e *Error) {
	if err := s.sendJSON(responseErr{T: typeResponse, ID: id, OK: false, E: e}); err != nil {
		s.log.Error("failed to send error response", "id", id, "err", err)
	}
}

// Emit sends an event frame. Producers are responsible for coalescing: emit
// batches, never one event per file.
func (s *Server) Emit(channel string, payload any) error {
	return s.sendJSON(eventFrame{T: typeEvent, Ch: channel, Seq: s.eventSeq.Add(1), P: payload})
}

func (s *Server) sendJSON(v any) error {
	payload, err := json.Marshal(v)
	if err != nil {
		return err
	}
	frame, err := AppendFrame(make([]byte, 0, headerSize+len(payload)), payload)
	if err != nil {
		return err
	}
	select {
	case s.out <- frame:
		return nil
	case <-s.writerDone:
		return errors.New("rpc: writer closed")
	}
}

// writeLoop is the only goroutine that touches w. It flushes whenever the
// queue is momentarily empty, so bursts are coalesced into fewer syscalls.
func (s *Server) writeLoop(w io.Writer) {
	defer close(s.writerDone)
	bw := bufio.NewWriterSize(w, 64<<10)
	write := func(frame []byte) bool {
		if _, err := bw.Write(frame); err != nil {
			s.log.Error("write failed", "err", err)
			return false
		}
		return true
	}
	for {
		select {
		case frame := <-s.out:
			if !write(frame) {
				return
			}
			if len(s.out) == 0 {
				if err := bw.Flush(); err != nil {
					s.log.Error("flush failed", "err", err)
					return
				}
			}
		case <-s.stopWriter:
			for {
				select {
				case frame := <-s.out:
					if !write(frame) {
						return
					}
				default:
					_ = bw.Flush()
					return
				}
			}
		}
	}
}

func (s *Server) drain() {
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(s.opts.DrainTimeout):
		s.log.Warn("drain timeout; abandoning in-flight handlers")
	}
}

func (s *Server) finish() {
	close(s.stopWriter)
	<-s.writerDone
}
