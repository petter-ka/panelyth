# ADR-0018 — Video Posters and Probing via ffmpeg/ffprobe

## Status

Accepted (Stage 06). Resolves `docs/ARCHITECTURE-ANALYSIS.md` C5.

## Context

ADR-0009 gives poster generation and video metadata to Go, and Go has no video decoder. ADR-0019 keeps the
sidecar `CGO_ENABLED=0`, so linking libav* is ruled out. The renderer could grab frames with a hidden `<video>`
and a canvas, but then image bytes would cross IPC (CLAUDE.md: never for thumbnails), and the posters would depend on
which codecs Chromium happens to support.

## Decision

- Go runs **ffprobe and ffmpeg as subprocesses** (`internal/video`). They are separate executables, so the sidecar
  stays pure Go.
- **Discovery**, in this order: `FASTVIEW_FFMPEG` (path to ffmpeg, with ffprobe next to it; `off` disables both), then
  the sidecar's own directory (packaged builds), then `PATH`. This happens once at startup and is logged.
- **Probe:** `ffprobe -show_entries` (JSON) gives duration, the display size (rotation applied, attached cover art
  ignored) and the video and audio codec names. Results are cached in memory per source identity
  (path + size + mtime, 512 entries). At most 2 probes run at once, so walking the tiles with a held arrow key can't
  start a process per step. Timeout 10 s.
- **Poster:** one frame at `min(10 % of duration, 10 s)` (past black intros), using input seeking. If the seek yields no
  frame, the first frame is used. ffmpeg scales the frame to the profile edge (never upscaling) and autorotates it, then
  writes it as PNG to a pipe (stdout bounded at 64 MB). Go re-encodes it with the image encoder policy (`imaging.Encode`:
  JPEG, or PNG when there is alpha). The poster goes through the same scheduler, workers, pixel budget, cache key,
  disk cache and `preview.ready` events as image previews, so posters are deduplicated, prioritized, bounded and
  cancellable like thumbnails. `-threads 1` per process keeps the worker count the real CPU bound. Timeout 20 s.
  The process is killed when its context is cancelled (shutdown). On Windows it runs with `CREATE_NO_WINDOW`.
- **Failures** (CACHE-DESIGN failure memory):
  - unreadable container → `CORRUPT_MEDIA`, permanent for this key;
  - no decodable video stream (audio-only, or a codec ffmpeg can't decode) → `UNSUPPORTED_MEDIA`, permanent;
  - timeout → `CACHE_ERROR`, retried after 5 min;
  - read permission → `PERMISSION_DENIED`, retried after 5 min.
- **Missing tools degrade gracefully.** Video previews return `UNSUPPORTED_MEDIA` **without recording a failure**, so
  posters appear once ffmpeg is installed. Tiles show the video symbol, and `media.resolve` returns zero/empty
  probe fields. Playback is unaffected, because Chromium plays the file itself (ADR-0009).
- **Packaging** (Stage 11): ship an **LGPL** ffmpeg/ffprobe build next to the sidecar, without `--enable-gpl` and
  without non-free codecs, and add it to the license notices. The GPL "full" builds common on developer machines are
  fine for development, but must not be redistributed with the app. The cost is about 2 × 20–80 MB per platform,
  depending on the build. Stage 09 verifies discovery and posters on each OS.

## Consequences

- Poster cost is a process spawn plus one decode: ~80 ms for 1080p → 384 px, ~100 ms → 2560 px and ~200 ms for 4K →
  384 px (i9-13900K, `internal/video` benchmarks). That is comparable to a 12 MP JPEG through the pure-Go decoder.
- Probing costs ~31 ms per file uncached. It runs when a video is selected (`media.resolve`), not while scanning.
  Persisting duration in the index is Stage 07 metadata work.
- Video dimensions found while generating a poster are written to `entries` like image dimensions, so videos sort by
  dimensions once they have been seen.
