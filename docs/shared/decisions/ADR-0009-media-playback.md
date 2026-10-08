# ADR-0009 — Local Video Playback

## Status

Accepted

Amended 2026-10-05 (ADR-0027, proposed): for the commander's app view, the token protocol also serves non-media files,
read-only, for the lister and quick view.

## Decision

Use Electron/Chromium media capabilities for local video playback where supported. Go owns discovery, metadata and cached poster generation.

## Implementation note (Stage 04)

`panelyth-media://m/<token>` exists: 128-bit random tokens in a bounded LRU in Electron main map to paths validated by
the sidecar (`media.resolve`, callable by main only); responses stream with HTTP Range (206). Stage 04 uses it for
image originals; Stage 06 adds video. `media.open` (renderer) returns only the token URL, never a path.

## Implementation note (Stage 06)

- Videos always get a token URL. `media.resolve` adds `durationMs`, `videoCodec` and `audioCodec` from ffprobe
  (ADR-0018), or zero/empty values without it. A file ffprobe can't read is `CORRUPT_MEDIA`.
- The preview pane plays the original in a `<video preload="metadata">` from the token URL. Seeking uses HTTP Range
  (206), so no media bytes cross IPC. Leaving the item removes `src` and calls `load()`, which releases the decoder and
  the stream.
- Unsupported states are explicit. A media error 3/4 (decode, unsupported source) is "can't be played here", with the
  codec name and **Open with default app**. When metadata loads with `videoWidth` 0 although ffprobe saw a video
  stream, Chromium is playing only the audio of a video codec it can't decode, so playback stops and the same state is
  shown. Error 2 (network: moved or unreadable) offers **Try again**. `CORRUPT_MEDIA` shows "damaged".
- Full screen is element full screen on the player. The session permission handler allows only `fullscreen`, and only
  for the app's own origin; everything else is still denied.

## Implementation note (Stage C05)

`file.open` (commander only) mints tokens for any file kind, bound to the commander's origin; the scheme is
registered with `corsEnabled`, answers `OPTIONS` preflights for `Range`, and only the commander's CSP may `fetch()`
it. The lister and quick view read 64 KiB chunks with Range (a 4 MiB LRU per open file). `ImageViewer` and
`VideoPlayer` moved to `shared/media-ui` and serve both apps (ADR-0025).

## Rules

- video bytes do not flow through normal RPC
- media URLs are validated/controlled
- poster frames are cache-backed
- unsupported codec/container states are handled explicitly
