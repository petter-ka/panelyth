package app

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"panelyth/sidecar/internal/fsx"
)

// Event channels of Stage C03 (mirrors src/shared/contracts/src/events.ts).
const (
	evVolumesChanged   = "volumes.changed"
	evBookmarksChanged = "bookmarks.changed"
)

// VolumePollInterval is how often the monitor compares the mounted
// volumes. A poll reads the drive list and local labels only (no space, no
// network calls): microseconds on Windows, one small file on Linux.
const VolumePollInterval = 2 * time.Second

// volumeMonitor notices drives that come and go (a USB stick, a mapped
// share) and sends volumes.changed with the new list (Stage C03). It starts
// with the first fs.volumes call, so an app that never shows drives costs
// nothing. No portable OS event covers all three platforms, so it polls.
type volumeMonitor struct {
	once sync.Once
	// interval is VolumePollInterval unless a test shortens it.
	interval time.Duration
	// signature replaces fsx.VolumeSignature in tests.
	signature func() (string, error)
}

func (m *volumeMonitor) start(ctx context.Context, emit func(), log *slog.Logger) {
	m.once.Do(func() {
		interval, sig := m.interval, m.signature
		if interval <= 0 {
			interval = VolumePollInterval
		}
		if sig == nil {
			sig = fsx.VolumeSignature
		}
		last, err := sig()
		if err != nil {
			log.Warn("volume monitor", "err", err)
		}
		go func() {
			t := time.NewTicker(interval)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
				}
				now, err := sig()
				if err != nil || now == last {
					continue
				}
				last = now
				emit()
			}
		}()
	})
}

// emitVolumes reads the volumes (space reads are bounded per volume) and
// posts them; a burst of changes sends the latest list.
func (s *indexService) emitVolumes() {
	vs, err := fsx.Volumes()
	if err != nil {
		s.log.Warn("volumes changed", "err", err)
		return
	}
	s.events.Post(evVolumesChanged, "", fsVolumesResult{Volumes: vs})
}
