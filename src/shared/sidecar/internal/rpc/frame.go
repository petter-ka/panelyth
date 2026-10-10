// Package rpc implements the Panelyth control-plane protocol between the
// Electron main process and the Go sidecar: length-prefixed JSON frames on
// stdin/stdout (see decisions/ADR-0002 and ADR-0012).
package rpc

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// MaxFrameSize bounds a single frame payload. Larger frames are a protocol
// error; hot-path payloads are expected to be orders of magnitude smaller.
const MaxFrameSize = 4 << 20

const headerSize = 4

// ErrFrameTooLarge is returned when a frame header announces a payload larger
// than MaxFrameSize.
var ErrFrameTooLarge = errors.New("rpc: frame exceeds maximum size")

// FrameReader reads length-prefixed frames. It reuses its buffer, so the
// returned slice is only valid until the next call to ReadFrame.
type FrameReader struct {
	r   *bufio.Reader
	hdr [headerSize]byte
	buf []byte
}

// NewFrameReader wraps r with buffering.
func NewFrameReader(r io.Reader) *FrameReader {
	return &FrameReader{r: bufio.NewReaderSize(r, 64<<10)}
}

// ReadFrame returns the next payload. It returns io.EOF only on a clean
// end-of-stream between frames; a stream that ends mid-frame yields
// io.ErrUnexpectedEOF.
func (fr *FrameReader) ReadFrame() ([]byte, error) {
	if _, err := io.ReadFull(fr.r, fr.hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(fr.hdr[:])
	if n > MaxFrameSize {
		return nil, fmt.Errorf("%w: %d bytes", ErrFrameTooLarge, n)
	}
	if cap(fr.buf) < int(n) {
		fr.buf = make([]byte, n)
	}
	fr.buf = fr.buf[:n]
	if _, err := io.ReadFull(fr.r, fr.buf); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, io.ErrUnexpectedEOF
		}
		return nil, err
	}
	return fr.buf, nil
}

// AppendFrame appends the frame header and payload to dst.
func AppendFrame(dst, payload []byte) ([]byte, error) {
	if len(payload) > MaxFrameSize {
		return dst, fmt.Errorf("%w: %d bytes", ErrFrameTooLarge, len(payload))
	}
	dst = binary.BigEndian.AppendUint32(dst, uint32(len(payload)))
	return append(dst, payload...), nil
}

// WriteFrame writes a single frame to w.
func WriteFrame(w io.Writer, payload []byte) error {
	frame, err := AppendFrame(make([]byte, 0, headerSize+len(payload)), payload)
	if err != nil {
		return err
	}
	_, err = w.Write(frame)
	return err
}
