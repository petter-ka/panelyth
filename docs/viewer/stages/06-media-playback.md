# Stage 06 — Video Playback + Media Preview

Status: **Complete** (2026-10-01)

This file merges the former `06-video-playback.md`, which duplicated this plan (ARCHITECTURE-ANALYSIS C7).

## Objective

Make the right preview pane a useful local image/video surface: image fit/1:1/zoom/pan, local video playback with
poster, seek, duration, volume/mute, playback state, a fullscreen-ready path and explicit unsupported-media states.

## Decisions applied

- **ADR-0018 accepted:** posters and probing use **ffmpeg/ffprobe subprocesses** (`internal/video`). The sidecar stays
  pure Go (ADR-0019). The tools are found through `PANELYTH_FFMPEG`, then next to the sidecar, then `PATH`. Without them,
  videos still play; tiles show the video symbol and no failure is recorded.
- **Posters are previews:** same profiles, cache key (path_key + size + mtime + profile), disk cache, scheduler (dedup,
  priority, lane epochs, bounded workers, pixel budget), `preview.ready` events and page-attached cache hits as image
  thumbnails. Each poster is one frame at `min(10 % of duration, 10 s)`, scaled and autorotated by ffmpeg, and
  re-encoded by `imaging.Encode`.
- **Playback stays in Chromium** (ADR-0009): the original is played from a `panelyth-media://m/<token>` URL with HTTP Range.
  No media bytes travel over IPC. `media.resolve` and `media.open` carry `durationMs`, `videoCodec` and `audioCodec`.
- **The pane follows the settled selection.** A change within 150 ms of the previous one waits until the selection
  settles, so a held arrow key loads only where it stops. The pane uses its own `pane` preview lane, so its requests
  never cancel the focused viewer's prefetch, and the other way round.
- **One active surface:** while the focused image viewer is open, the pane unmounts its media. A playing video stops,
  and no second copy of the image stays decoded behind the overlay.
- **Images open the focused viewer, videos play in the pane.** Enter or double-click on a video tile selects it,
  opens a collapsed pane and starts playback.
- **Full screen** is element full screen on the player. The permission handler now allows `fullscreen`, only for the
  app's own origin; everything else stays denied.

## Scope delivered

| Stage plan item | Implementation |
|---|---|
| image preview, fit / 1:1 / zoom / reset / pan | The pane embeds the Stage 04 `ImageViewer` (progressive placeholder → viewer-fit → original only when zoomed past the preview). Header controls **Fit** · **1:1** · − · % · +, keys + − 0 1, wheel zoom at the cursor, drag to pan, double-click toggles fit |
| local video playback | `VideoPlayer`: `<video preload="metadata">` from the token URL. Leaving the item pauses it, removes `src` and calls `load()`, which releases the decoder and stream |
| poster generation / cache | Go `renderPoster` → disk cache. Video tiles show the poster with a play badge; the pane shows the `viewer-fit` poster (the tile poster until it is decoded). Posters for a revisited folder come attached to the page, so nothing is generated |
| seek | Native range slider plus ←/→ ±5 s, Home/End. Range requests (206) |
| duration | Known from ffprobe before metadata loads (`0:00 / 0:42`); the element's own duration replaces it. Also in the pane's detail line |
| volume / mute | Slider (hidden below 320 px pane width), mute button, ↑/↓ and M. Kept across videos for the session |
| playback state | `data-state` loading / ready / playing / paused / error; Play/Pause control; centered play button before the first play |
| fullscreen-ready path | Full screen button, F and double-click on the video; Esc leaves (Electron leaves exiting HTML full screen to the page) |
| unsupported codec / container | Media errors 3/4, or `videoWidth` 0 when ffprobe saw a picture (Chromium playing only the audio): "This video can't be played here" with the codec name ("MPEG-4 Part 2 video isn't supported…") and **Open with default app**. Error 2 (moved/unreadable): **Try again**. `CORRUPT_MEDIA` from ffprobe: "This video is damaged" |
| multi-selection / folder in the pane | "N items selected"; a folder shows its name and "Press Enter to open it" |

Backend and IPC:

- New Go package `internal/video`: `Locate`, `Probe` (cached per identity, at most 2 concurrent, 10 s timeout),
  `Frame` (bounded stdout, 20 s timeout, killed on cancel, `CREATE_NO_WINDOW` on Windows), `PosterTime`.
  `fixture.GenerateVideo` builds test clips from ffmpeg's lavfi sources (rotation via a display-matrix remux).
- `preview.Service`: videos go through `renderPoster`. Failures: no video stream → `UNSUPPORTED_MEDIA` (permanent),
  unreadable → `CORRUPT_MEDIA` (permanent), timeout → retry after 5 min, permission → retry after 5 min. Video
  dimensions are recorded for sorting.
- `media.resolve`: videos are always `original: true` and gain the probe fields. The contract, guards and golden
  fixtures were updated, plus a new `res-media.resolve-video.json`. Golden runs set `PANELYTH_FFMPEG=off` so they
  don't depend on the machine.
- Main: `toMediaOpenResult` (tested) and `allowPermission` (fullscreen only, own origin).
- Renderer: `features/preview/previewStore` (settled selection, play requests), `features/media/video` (time format,
  codec names, problem mapping, session volume), `components/media/VideoPlayer`, the rewritten `PreviewPane`, and
  `requestFit(…, lane)` with per-lane epochs.

## Found and fixed while testing

1. **The focused viewer and the pane showed the same image twice.** Both mounted an `ImageViewer` for the selected id,
   and once the overlay decoded the 4000 px original, the hidden pane layer held it too. A video playing in the pane
   would also have kept playing under the overlay. The pane now suspends while the overlay is open (unit test).
2. **A Stage 04 latency probe measured the wrong element.** The e2e `timedStep` helper read the first
   `[data-testid=image-viewer]` in the DOM, which is now the pane's. It is scoped to the overlay, and the Stage 04 numbers
   were re-measured.
3. **Full screen was denied** by the deny-all permission handler. It is now allowed for `fullscreen` from the app's
   origin only (unit test plus e2e).
4. **Esc didn't leave full screen** in Electron. The player handles Esc while in full screen.

## Tests

| Suite | Count | New in this stage |
|---|---|---|
| Go | 18 packages | `video` (probe of H.264+AAC and VP9+Opus, frame scaling without upscaling, 90° rotation → display size and autorotated frame, seek past the end falls back to frame 0, corrupt and audio-only files, probe cache per identity, cancellation, tools off/nil, ffprobe JSON with cover art and side-data rotation); `preview` (poster generated → cache hit after restart → attached to pages → dimensions recorded; broken/empty videos fail permanently; without tools nothing is recorded and installing ffmpeg later works); `app` (`media.resolve` for a real WebM and a broken MP4; golden frames) |
| Contracts | 37 | video `media.resolve` fixture; guard requires the probe fields |
| Desktop | 84 | `media.open` result (token URL plus probe fields, never the path; no token for preview-only images); permissions (only fullscreen, only own origin) |
| Renderer | 137 | time/codec/problem helpers; pane image with pane-lane fit and zoom controls; selection settling (20 rapid changes → 1 load); multi-selection summary; video: token URL, probe duration, poster, play/pause, seek/time update/keys, volume and mute carried over, release on leave, suspended by the overlay, Enter plays, unsupported codec with Open with default app, audio-only decode, damaged and moved with Try again; video tile poster + badge |
| E2E | 39 | Stage 06 (4): posters for 24 visible 1080p videos without long tasks and 0 generated after a restart; pane playback from a token URL, seek, mute, tile walking during playback without long tasks; Enter plays and full screen works; MPEG-4 Part 2 MKV is unsupported with Open with default app, broken MP4 is damaged |

## Benchmarks

Windows 11, i9-13900K, production build, ffmpeg 8.0.1. Results: `shared/bench/results/stage-06-2026-10-01-e2e-media.jsonl`,
`stage-06-2026-10-01-petter-go-bench.txt`, `stage-06-2026-10-01-petter-startup.json`.

| Metric | Result | Target |
|---|---|---|
| ffprobe (uncached), 1080p H.264 + AAC | 31 ms | — |
| Poster 1080p → `grid-md` 384 px / → `viewer-fit` | 80 ms / 101–104 ms | — |
| Poster 4K → `grid-md` | 196 ms | — |
| Open folder → all 24 visible video posters shown, cold cache | 928 ms (2.5 s on a cold OS file cache) | — |
| Same after restart | 199 ms, **0 generated** | cached poster reused (gate) |
| Long tasks while posters generate | **0** | none > 50 ms (gate) |
| Select a 1080p video → metadata loaded | 99–135 ms | — |
| Seek to 6 s → playing position (incl. Playwright polling) | 196–204 ms | — |
| Long tasks during playback while walking 12 tiles | **0** | none > 50 ms (gate) |

Earlier-stage e2e gates re-run on the same build, two runs each (`stage-0[3-5]-2026-10-01-*`):

- Stage 04 viewer: prefetched step p50 2 ms, max 3–4 ms; 48 MP 1:1 → original 94–111 ms; 0 long tasks.
- Stage 03 tiles: 100k scroll p95 frame 7 ms, 0 long tasks, ≤ 180 tiles mounted.
- Stage 05: search p50 216–223 ms; pane resize 0 long tasks.
- The cold jump to an un-prefetched image measured 643–725 ms (Stage 04: 554 ms). The pane adds no queued work
  during the overlay (it requested only the first image, which the overlay shares), so this looks like run-to-run
  variance in on-demand generation. Stage P05 should confirm it.

Startup regression: ready-to-show p50 224 ms, sidecar ready p50 119 ms (Stage 05: 116–121 ms; tool discovery is a
stat plus a `PATH` lookup), ping p95 0.2 ms, exit p95 17 ms, idle 352 MB, **56.7 MB over the Electron floor**
(budget 60; Stage 05: 52–72). All budgets pass.

## Acceptance

- [x] selected image/video previews load without freezing content browsing (settled selection, 0 long tasks while playing and walking tiles)
- [x] cached poster is reused (0 generated after restart; posters attached to pages)
- [x] video playback does not route media bytes through normal IPC (token URL + Range; `currentSrc` is `panelyth-media://m/<token>`)
- [x] large images use a dedicated viewer path (Stage 04 `ImageViewer`: viewer-fit, original only past its resolution)
- [x] unsupported codec/container states are explicit and offer a way out

## Risks and follow-ups

- **ffmpeg must ship with the app** (Stage P06): an LGPL build next to the sidecar, plus license notices (ADR-0018).
  Development machines often have GPL "full" builds, and those must not be redistributed. Stage P04 verifies discovery on
  macOS and Linux.
- **Concurrent ffmpeg processes:** up to one per preview worker (≤ 8). The pixel budget counts each source frame, but
  ffmpeg's own process memory (tens of MB for 4K) is outside Go's view. Stage P05 should measure peak RSS with a folder of
  4K/HEVC clips.
- **Codec support is decided at runtime.** HEVC playback depends on the platform's hardware decoders. Prediction from
  the ffprobe codec is deliberately not attempted; the error and audio-only paths cover it.
- Duration isn't on tiles or sortable yet (Stage 07 metadata). Probing happens on selection only.
- Volume and mute persist for the session only, not across restarts (they could join the library.db settings in Stage 08).
- During development, one renderer unit run reported an error that could not be reproduced in 13 later runs. Watch for
  flakiness in `components/media/preview.test.tsx`.

## Exit checklist

- [x] implementation complete
- [x] tests complete
- [x] benchmark complete
- [x] performance regression reviewed
- [x] docs/ADR updated
