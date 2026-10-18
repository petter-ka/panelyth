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

## Amendment: the app's own trouble is not the file's (2026-10-18, owner request)

"Can't be played here — Open with default app" showed far more often than files were unplayable. A sample of the
owner's library (683 videos played in the app's Chromium) found 94 % playing, about 3 % that Chromium can't decode
(Motion-JPEG, SVQ3 and MPEG-4 Part 2 video) and 3 % playing without sound (AC-3, DTS, E-AC-3 and MP2 audio). The rest
of the messages came from errors of the app itself: `media.open` failing with `TIMEOUT`, `BUSY`, `SIDECAR_UNAVAILABLE`
or `CANCELLED` (the sidecar still starting, a drive spinning up, the ffprobe slots taken by posters) was mapped to
"unsupported", and the failure was kept for that file for the rest of the session.

- Only `UNSUPPORTED_MEDIA` and media errors 3 and 4 say "can't be played here". The app's own failures are a fourth
  state, **unavailable** ("This video can't be opened right now", with **Try again**), and so is media error 1
  (aborted).
- `requestMedia` (`viewerImages.ts`) asks again after 1 s and 3 s on those codes, staying in the loading state, and
  never keeps a failure for the next look at the file.
- `media.resolve` waits at most 3 s for the video probe (`resolveProbeWait`): the probe only adds size, duration and
  codec names, and main gives the whole call 10 s. A probe cut short is not cached.

## Implementation note (Stage C05)

`file.open` (commander only) mints tokens for any file kind, bound to the commander's origin; the scheme is
registered with `corsEnabled`, answers `OPTIONS` preflights for `Range`, and only the commander's CSP may `fetch()`
it. The lister and quick view read 64 KiB chunks with Range (a 4 MiB LRU per open file). `ImageViewer` and
`VideoPlayer` moved to `src/shared/media-ui` and serve both apps (ADR-0025).

## Rules

- video bytes do not flow through normal RPC
- media URLs are validated/controlled
- poster frames are cache-backed
- unsupported codec/container states are handled explicitly
