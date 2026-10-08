// Package app wires the sidecar: storage roots, RPC server and handlers.
package app

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"runtime/metrics"
	"strconv"
	"strings"
	"time"

	"panelyth/sidecar/internal/archive"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/library"
	"panelyth/sidecar/internal/platform"
	"panelyth/sidecar/internal/rpc"
	"panelyth/sidecar/internal/video"
)

// Config holds process-level inputs; everything is injectable for tests.
type Config struct {
	In      io.Reader
	Out     io.Writer
	Logger  *slog.Logger
	Version string
	Getenv  func(string) string
}

// Run serves the protocol until stdin closes, ctx is cancelled or a
// system.shutdown request arrives. A nil error means a clean shutdown.
func Run(ctx context.Context, cfg Config) error {
	if cfg.Getenv == nil {
		cfg.Getenv = os.Getenv
	}
	dirs, err := platform.ResolveDirs(cfg.Getenv)
	if err != nil {
		return err
	}

	ctx, shutdown := context.WithCancel(ctx)
	defer shutdown()

	srv := rpc.NewServer(rpc.Options{Logger: cfg.Logger})
	registerSystem(srv, systemDeps{
		version:  cfg.Version,
		started:  time.Now(),
		shutdown: shutdown,
		devMode:  cfg.Getenv("PANELYTH_DEV_METHODS") == "1",
	})

	// index.db and previews live in the disposable cache root (ADR-0016).
	maxBytes := int64(DefaultCacheMaxBytes)
	if v, perr := strconv.ParseInt(cfg.Getenv("PANELYTH_CACHE_MAX_BYTES"), 10, 64); perr == nil && v > 0 {
		maxBytes = v
	}
	// Video posters and probing (ADR-0018); absent tools degrade gracefully.
	tools := video.Locate(cfg.Getenv)
	// Benchmarks only (dev mode): a network drive whose space read hangs,
	// "path=ms" (Stage C03 drive-menu benchmark).
	if cfg.Getenv("PANELYTH_DEV_METHODS") == "1" {
		if path, ms, ok := strings.Cut(cfg.Getenv("PANELYTH_DEV_SLOW_VOLUME"), "="); ok {
			if d, perr := strconv.Atoi(ms); perr == nil && path != "" {
				fsx.SimulateSlowVolume(path, time.Duration(d)*time.Millisecond)
			}
		}
	}
	// Archives beyond the built-in formats (ADR-0030); optional like ffmpeg.
	sevenZip := archive.LocateTool(cfg.Getenv)
	svc, err := newIndexService(dirs.CacheRoot, maxBytes, cfg.Logger, srv.Emit, tools, sevenZip)
	if err != nil {
		return err
	}
	defer svc.close()
	// library.db holds user data (ADR-0016): never deleted automatically.
	// It opens in the background so the handshake does not wait for it;
	// user-data methods wait (see indexService.library). If it cannot be
	// opened, browsing still works and the problem is logged.
	go func() {
		defer close(svc.libReady)
		lib, lerr := library.Open(filepath.Join(dirs.ConfigRoot, "library.db"))
		if lerr != nil {
			cfg.Logger.Error("library.db unavailable", "err", lerr)
			return
		}
		svc.lib = lib
	}()
	defer func() {
		<-svc.libReady
		// The last shared context reaches library.db before it closes.
		svc.context.flush()
		if svc.lib != nil {
			_ = svc.lib.Close()
		}
	}()
	svc.register(srv)

	cfg.Logger.Info("sidecar starting", "version", cfg.Version, "pid", os.Getpid(),
		"cacheRoot", dirs.CacheRoot, "configRoot", dirs.ConfigRoot,
		"ffmpeg", tools.FFmpeg, "ffprobe", tools.FFprobe, "7z", sevenZip.Path)

	err = srv.Serve(ctx, cfg.In, cfg.Out, rpc.Hello{
		Protocol:      rpc.ProtocolVersion,
		PID:           os.Getpid(),
		Version:       cfg.Version,
		GoVersion:     runtime.Version(),
		CacheRoot:     dirs.CacheRoot,
		ConfigRoot:    dirs.ConfigRoot,
		ThumbnailRoot: svc.disk.Root(),
	})
	cfg.Logger.Info("sidecar stopped", "err", err)
	return err
}

type systemDeps struct {
	version  string
	started  time.Time
	shutdown context.CancelFunc
	devMode  bool
}

// Mirrors shared/contracts/src/rpc.ts.
type (
	emptyParams struct{}

	pingResult struct {
		Pong         bool  `json:"pong"`
		ServerTimeNs int64 `json:"serverTimeNs"`
	}

	infoResult struct {
		Version         string `json:"version"`
		GoVersion       string `json:"goVersion"`
		PID             int    `json:"pid"`
		Protocol        int    `json:"protocol"`
		UptimeMs        int64  `json:"uptimeMs"`
		Goroutines      int    `json:"goroutines"`
		HeapBytes       uint64 `json:"heapBytes"`
		RuntimeMemBytes uint64 `json:"runtimeMemBytes"`
		NumCPU          int    `json:"numCpu"`
	}

	shutdownResult struct {
		Accepted bool `json:"accepted"`
	}

	echoParams struct {
		Payload string `json:"payload"`
	}

	echoResult struct {
		Payload string `json:"payload"`
	}
)

func registerSystem(srv *rpc.Server, deps systemDeps) {
	rpc.Register(srv, "system.ping", func(context.Context, emptyParams) (pingResult, error) {
		return pingResult{Pong: true, ServerTimeNs: time.Now().UnixNano()}, nil
	})

	rpc.Register(srv, "system.info", func(context.Context, emptyParams) (infoResult, error) {
		// runtime/metrics avoids the stop-the-world of runtime.ReadMemStats.
		samples := []metrics.Sample{
			{Name: "/memory/classes/heap/objects:bytes"},
			{Name: "/memory/classes/total:bytes"},
		}
		metrics.Read(samples)
		return infoResult{
			Version:         deps.version,
			GoVersion:       runtime.Version(),
			PID:             os.Getpid(),
			Protocol:        rpc.ProtocolVersion,
			UptimeMs:        time.Since(deps.started).Milliseconds(),
			Goroutines:      runtime.NumGoroutine(),
			HeapBytes:       sampleUint(samples[0]),
			RuntimeMemBytes: sampleUint(samples[1]),
			NumCPU:          runtime.NumCPU(),
		}, nil
	})

	rpc.Register(srv, "system.shutdown", func(context.Context, emptyParams) (shutdownResult, error) {
		// The response is queued before the handler returns, and Serve
		// flushes queued frames while draining, so the caller still gets it.
		deps.shutdown()
		return shutdownResult{Accepted: true}, nil
	})

	if deps.devMode {
		rpc.Register(srv, "system.echo", func(_ context.Context, p echoParams) (echoResult, error) {
			return echoResult(p), nil
		})
	}
}

func sampleUint(s metrics.Sample) uint64 {
	if s.Value.Kind() == metrics.KindUint64 {
		return s.Value.Uint64()
	}
	return 0
}
