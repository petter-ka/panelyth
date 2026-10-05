# ADR-0019 — Native Dependency (cgo) Policy

## Status

Accepted (Stage 01), by default: adopted from `docs/ARCHITECTURE-ANALYSIS.md` C6. Video posters (ADR-0018,
Stage 06) use ffmpeg/ffprobe as **subprocesses**, so the sidecar stays `CGO_ENABLED=0`.

## Decision

- The sidecar builds with **`CGO_ENABLED=0`** for the MVP. Every target is a static cross-compile, and no C
  toolchain or shared library ships with the app.
- SQLite: **`modernc.org/sqlite`** (pure Go translation of SQLite, currently SQLite 3.53 with FTS5).
- File watching: `github.com/fsnotify/fsnotify` (syscall-based, no cgo).
- Unicode normalization and case folding: `golang.org/x/text`.
- Image decoding (Stage 02): the standard library plus `golang.org/x/image`. Opaque previews are written as JPEG and
  alpha previews as PNG. **WebP output and libjpeg-turbo/libvips are deferred.** They are adopted only with benchmark
  evidence, behind the decoder/encoder interfaces (ADR-0006), which amends CACHE-DESIGN.md's WebP default.
- Any future cgo dependency needs a new ADR that covers per-OS/arch packaging and packaged-build tests
  (ADR-0006 packaging rule).

## Consequences

- modernc SQLite is slower than the cgo build for some workloads. Stage 01 benchmarks record the actual write
  and query costs, and a switch needs numbers.
- `go test -race` still needs cgo, so it runs in Linux CI only.
