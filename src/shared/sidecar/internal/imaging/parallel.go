package imaging

import (
	"context"
	"runtime"
	"sync"
	"sync/atomic"
)

// Workers is the parallelism of one pixel pass (ADR-0035): bounded, never a
// goroutine per row.
func Workers() int {
	if n := int(workerLimit.Load()); n > 0 {
		return n
	}
	return min(max(runtime.NumCPU()-1, 1), 8)
}

// workerLimit overrides Workers (tests and benchmarks compare worker counts).
var workerLimit atomic.Int32

// SetWorkers fixes the parallelism of pixel passes; 0 restores the default.
func SetWorkers(n int) { workerLimit.Store(int32(max(n, 0))) }

type workersKey struct{}

// WithWorkers bounds the pixel passes run under ctx to n goroutines. A batch
// (Stage 16, ADR-0036) runs its pictures in parallel and each picture's
// passes on one goroutine, so its CPU use is the number of its workers.
func WithWorkers(ctx context.Context, n int) context.Context {
	return context.WithValue(ctx, workersKey{}, max(n, 1))
}

func workersFor(ctx context.Context) int {
	if n, ok := ctx.Value(workersKey{}).(int); ok {
		return min(n, Workers())
	}
	return Workers()
}

// bandRows is how many rows a worker takes at a time; cancellation is
// checked between bands.
const bandRows = 32

// inlinePixels: passes smaller than this run on the calling goroutine.
const inlinePixels = 64 * 1024

// Rows runs fn over the rows [0,h) of a w-wide pass in bands, on at most
// Workers goroutines. fn must write only the rows it is given, so the
// result does not depend on the worker count. It returns ctx's error when
// the pass was cancelled; the image is then incomplete.
func Rows(ctx context.Context, w, h int, fn func(y0, y1 int)) error {
	return rowsN(ctx, workersFor(ctx), w, h, fn)
}

func rowsN(ctx context.Context, workers, w, h int, fn func(y0, y1 int)) error {
	if h <= 0 {
		return ctx.Err()
	}
	if workers <= 1 || w*h <= inlinePixels {
		for y := 0; y < h; y += bandRows {
			if err := ctx.Err(); err != nil {
				return err
			}
			fn(y, min(y+bandRows, h))
		}
		return ctx.Err()
	}
	var next atomic.Int64
	var wg sync.WaitGroup
	n := min(workers, (h+bandRows-1)/bandRows)
	wg.Add(n)
	for range n {
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				y := int(next.Add(bandRows)) - bandRows
				if y >= h {
					return
				}
				fn(y, min(y+bandRows, h))
			}
		}()
	}
	wg.Wait()
	return ctx.Err()
}
