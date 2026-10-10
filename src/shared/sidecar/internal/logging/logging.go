// Package logging configures structured logging for the sidecar. Logs always
// go to stderr: stdout is reserved for protocol frames.
package logging

import (
	"io"
	"log/slog"
	"strings"
)

// ParseLevel maps a textual level to slog.Level, defaulting to info.
func ParseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// New returns a JSON logger writing to w.
func New(w io.Writer, level slog.Level) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level})).With("component", "sidecar")
}
