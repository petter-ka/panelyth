package rpc

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
	"testing/iotest"
)

func TestFrameRoundTrip(t *testing.T) {
	payloads := [][]byte{[]byte(`{}`), []byte(`{"t":"req","id":1}`), bytes.Repeat([]byte("x"), 100_000), {}}
	var buf bytes.Buffer
	for _, p := range payloads {
		if err := WriteFrame(&buf, p); err != nil {
			t.Fatal(err)
		}
	}
	// OneByteReader forces every read to split, covering partial headers
	// and payloads.
	fr := NewFrameReader(iotest.OneByteReader(&buf))
	for i, want := range payloads {
		got, err := fr.ReadFrame()
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("frame %d: payload mismatch (len %d vs %d)", i, len(got), len(want))
		}
	}
	if _, err := fr.ReadFrame(); !errors.Is(err, io.EOF) {
		t.Fatalf("expected io.EOF at clean end, got %v", err)
	}
}

func TestFrameTruncatedPayload(t *testing.T) {
	var buf bytes.Buffer
	_ = WriteFrame(&buf, []byte(`{"t":"req"}`))
	truncated := buf.Bytes()[:buf.Len()-3]
	_, err := NewFrameReader(bytes.NewReader(truncated)).ReadFrame()
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("expected ErrUnexpectedEOF, got %v", err)
	}
}

func TestFrameOversizeRejected(t *testing.T) {
	hdr := binary.BigEndian.AppendUint32(nil, MaxFrameSize+1)
	_, err := NewFrameReader(bytes.NewReader(hdr)).ReadFrame()
	if !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("expected ErrFrameTooLarge, got %v", err)
	}
	if err := WriteFrame(io.Discard, make([]byte, MaxFrameSize+1)); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("expected write to reject oversize frame, got %v", err)
	}
}

func BenchmarkFrameRoundTrip(b *testing.B) {
	payload := bytes.Repeat([]byte(`{"t":"req","id":1,"m":"system.ping","p":{}}`), 1)
	var buf bytes.Buffer
	fr := NewFrameReader(&buf)
	b.ReportAllocs()
	b.SetBytes(int64(len(payload)))
	for b.Loop() {
		if err := WriteFrame(&buf, payload); err != nil {
			b.Fatal(err)
		}
		if _, err := fr.ReadFrame(); err != nil {
			b.Fatal(err)
		}
	}
}
