// Command fastview-sidecar is the FastView backend process. Electron main
// spawns it and talks to it over framed stdin/stdout; it exits when stdin
// closes, on system.shutdown, or on SIGINT/SIGTERM.
package main

import (
	"context"
	"flag"
	"os"
	"os/signal"
	"syscall"

	"fastview/sidecar/internal/app"
	"fastview/sidecar/internal/logging"
)

// version is set at build time: -ldflags "-X main.version=..."
var version = "dev"

func main() {
	os.Exit(run())
}

func run() int {
	logLevel := flag.String("log-level", os.Getenv("FASTVIEW_LOG_LEVEL"), "debug|info|warn|error")
	flag.Parse()

	// Keep the real stdout for frames only. Anything else that writes to
	// os.Stdout (a stray fmt.Println, a library) lands in stderr instead of
	// corrupting the protocol stream.
	protocolOut := os.Stdout
	os.Stdout = os.Stderr

	logger := logging.New(os.Stderr, logging.ParseLevel(*logLevel))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := app.Run(ctx, app.Config{
		In:      os.Stdin,
		Out:     protocolOut,
		Logger:  logger,
		Version: version,
	}); err != nil {
		logger.Error("sidecar failed", "err", err)
		return 1
	}
	return 0
}
