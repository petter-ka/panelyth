package compare

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"sync"
)

// StreamOptions are the hooks of a streamed comparison.
type StreamOptions struct {
	// Progress receives the bytes compared since its previous call.
	Progress func(n int64)
	// Gate is a pause point: it blocks while a job is paused.
	Gate func(ctx context.Context) error
}

const streamBuffer = 1 << 20

var streamPool = sync.Pool{New: func() any { b := make([]byte, streamBuffer); return &b }}

// EqualFiles reads two files side by side with two pooled buffers and
// reports whether their bytes are the same. at is the offset of the first
// difference (the shorter file's size when one is a prefix of the other),
// or -1 when they are equal.
func EqualFiles(ctx context.Context, a, b string, o *StreamOptions) (equal bool, at int64, err error) {
	fa, err := os.Open(a)
	if err != nil {
		return false, 0, err
	}
	defer fa.Close()
	fb, err := os.Open(b)
	if err != nil {
		return false, 0, err
	}
	defer fb.Close()
	pa, pb := streamPool.Get().(*[]byte), streamPool.Get().(*[]byte)
	defer streamPool.Put(pa)
	defer streamPool.Put(pb)
	ba, bb := *pa, *pb
	var off int64
	for {
		if o != nil && o.Gate != nil {
			if err := o.Gate(ctx); err != nil {
				return false, 0, err
			}
		} else if err := ctx.Err(); err != nil {
			return false, 0, err
		}
		na, ea := io.ReadFull(fa, ba)
		nb, eb := io.ReadFull(fb, bb)
		if ea != nil && !errors.Is(ea, io.EOF) && !errors.Is(ea, io.ErrUnexpectedEOF) {
			return false, 0, ea
		}
		if eb != nil && !errors.Is(eb, io.EOF) && !errors.Is(eb, io.ErrUnexpectedEOF) {
			return false, 0, eb
		}
		n := min(na, nb)
		if !bytes.Equal(ba[:n], bb[:n]) {
			for i := range n {
				if ba[i] != bb[i] {
					return false, off + int64(i), nil
				}
			}
		}
		if na != nb {
			return false, off + int64(n), nil
		}
		off += int64(n)
		if o != nil && o.Progress != nil && n > 0 {
			o.Progress(int64(n))
		}
		if na < len(ba) { // both ended here
			return true, -1, nil
		}
	}
}
