package preview

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"panelyth/sidecar/internal/imaging"
	"panelyth/sidecar/internal/index"
)

// Cleaner enforces the cache size ceiling (LRU) and removes orphan files,
// one shard per run so a pass never walks the whole cache. It never touches
// source images: it only deletes files it derives from cache keys.
type Cleaner struct {
	store    *index.Store
	cache    *DiskCache
	log      *slog.Logger
	maxBytes int64

	mu        sync.Mutex
	nextShard int
}

// NewCleaner creates a cleaner with a size ceiling in bytes.
func NewCleaner(store *index.Store, cache *DiskCache, log *slog.Logger, maxBytes int64) *Cleaner {
	return &Cleaner{store: store, cache: cache, log: log, maxBytes: maxBytes}
}

// CleanupResult reports one pass.
type CleanupResult struct {
	EvictedFiles  int
	EvictedBytes  int64
	OrphanFiles   int
	ShardsSwept   int
	TotalBytesNow int64
}

// RunOnce evicts least-recently-used previews until the cache is at 90% of
// the ceiling, then sweeps orphan files in `shards` shards.
func (c *Cleaner) RunOnce(ctx context.Context, shards int) (CleanupResult, error) {
	var res CleanupResult
	total, err := c.store.PreviewBytes(ctx)
	if err != nil {
		return res, err
	}
	if total > c.maxBytes {
		target := c.maxBytes / 10 * 9
		for total > target && ctx.Err() == nil {
			rows, err := c.store.OldestPreviews(ctx, 500)
			if err != nil || len(rows) == 0 {
				break
			}
			keys := make([][]byte, 0, len(rows))
			for _, r := range rows {
				var k Key
				copy(k[:], r.Key)
				// File first: a row without a file regenerates; a file
				// without a row is an orphan the sweep removes later.
				if err := c.cache.Remove(k, imaging.Format(r.Format)); err != nil {
					c.log.Warn("evict preview", "err", err)
					continue
				}
				keys = append(keys, r.Key)
				total -= r.ByteSize
				res.EvictedBytes += r.ByteSize
				res.EvictedFiles++
				if total <= target {
					break
				}
			}
			if err := c.store.ForgetPreviews(ctx, keys); err != nil {
				return res, err
			}
		}
	}
	for range shards {
		n, err := c.sweepShard(ctx)
		if err != nil {
			return res, err
		}
		res.OrphanFiles += n
		res.ShardsSwept++
	}
	res.TotalBytesNow = total
	return res, nil
}

func (c *Cleaner) sweepShard(ctx context.Context) (int, error) {
	c.mu.Lock()
	shard := c.nextShard
	c.nextShard = (c.nextShard + 1) % 256
	c.mu.Unlock()
	files, err := c.cache.Shard(shard)
	if err != nil || len(files) == 0 {
		return 0, err
	}
	keys := make([][]byte, len(files))
	for i := range files {
		keys[i] = files[i].Key[:]
	}
	known, err := c.store.LookupPreviews(ctx, keys)
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, f := range files {
		if row, ok := known[string(f.Key[:])]; ok && row.Format == string(f.Format) {
			continue
		}
		if err := c.cache.Remove(f.Key, f.Format); err == nil {
			removed++
		}
	}
	return removed, nil
}

// Start runs passes after delay and then every interval until ctx ends.
func (c *Cleaner) Start(ctx context.Context, delay, interval time.Duration) {
	go func() {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				res, err := c.RunOnce(ctx, 16)
				if err != nil {
					c.log.Warn("cache cleanup", "err", err)
				} else if res.EvictedFiles+res.OrphanFiles > 0 {
					c.log.Info("cache cleanup", "evicted", res.EvictedFiles, "freedBytes", res.EvictedBytes,
						"orphans", res.OrphanFiles, "totalBytes", res.TotalBytesNow)
				}
				timer.Reset(interval)
			}
		}
	}()
}
