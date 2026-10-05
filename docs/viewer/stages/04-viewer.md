# Stage 04 — Full Viewer

Status: **Complete** (2026-09-30)

## Objective

Open images in a focused viewer while preserving tile view responsiveness.

## Decisions applied

- **A focused overlay** (ARCHITECTURE-ANALYSIS C9), opened with Enter or double-click on an image tile. It is built on a
  reusable `ImageViewer` component that the Stage 06 preview pane will embed.
- **Progressive loading** (analysis M9, ADR-0009):
  1. the tile thumbnail appears instantly;
  2. the Go-generated `viewer-fit` preview (≤ 2560 px, cached like thumbnails) replaces it;
  3. the **original** replaces that only when the zoom needs more pixels than the preview has. This applies to browser-native formats
     up to 50 MP; TIFF and larger images stay on `viewer-fit`.

  A layer is shown only after `img.decode()` has finished, off the main thread, so there are no blank or half-painted
  frames.
- **100 % means one image pixel per device pixel** (true actual size). Fit never upscales.
- Originals reach the renderer only as `fastview-media://m/<token>`: 128-bit random tokens in a bounded LRU in
  Electron main, mapped to paths the sidecar validated. Responses stream with HTTP Range support (206), which is ready
  for video seeking in Stage 06.

## Scope delivered

| Stage plan item | Implementation |
|---|---|
| selected file → viewer | Enter / double-click on an image tile (`openViewerAt`); folders keep opening as folders |
| fit mode / 1:1 mode / zoom | `features/viewer/zoom.ts` (pure, tested): fit, 100 %, + / − steps of 1.25×, 10 %–800 %, cursor-anchored wheel zoom, pan limits, double-click toggles fit ↔ 100 % |
| next/previous | ←/→, Page Up/Down, Home/End through the open query session in its current order; folders and videos are skipped; pages the tile view never loaded are fetched (`pageStore.ensureIndex`) |
| keyboard controls | ←/→ PgUp/PgDn Home End, + = −, 0 fit, 1 actual size, Esc / Backspace close |
| close/back | Esc returns to the tile view with the last image shown selected, focused and scrolled into view (`revealToken`) |
| viewer preview profile | `viewer-fit` on its own `viewer` lane: current image priority 0, neighbours priority 1, each step a new epoch |
| progressive full-image loading | placeholder → viewer-fit → original, decoded before display; neighbours are pre-decoded |

Backend and IPC:

- `media.resolve` (sidecar, callable by main only): validates that the entry is an indexed image or video that still
  exists, probes display size (EXIF-aware, ~1 ms), and reports whether the original is browser-displayable.
- `media.open` (renderer → main): resolves through the sidecar and mints the token URL.
- `fastview-media:` protocol with Range; CSP `img-src` and `media-src` allow it. Main-local handlers now receive their params.

UI: a viewer toolbar with Folder (back), name and position, Previous/Next, and Fit, 1:1, − / % / + (pressed state
in amber). The image sits on the neutral canvas. A failure shows "This image can't be displayed" with a reason and
**Try again**, which forces regeneration; navigation keeps working from the error state.

## Found and fixed while testing

1. **Every original was decoded on open.** Before the preview arrived, "the preview has 0 pixels", so the check
   "zoom needs more pixels than the preview" was always true, and the viewer fetched and decoded the full original
   (up to 50 MP) the moment it opened. That defeated progressive loading. Originals are now requested only when the decoded
   preview is too small for the zoom, or when the preview failed and the original is the only way to show the image. A
   unit test and an e2e check ("fit needs no original") guard it.
2. When the preview fails but the original is displayable, the viewer now **falls back to the original** instead of
   showing an error. The error with Try again appears only when nothing can be shown.
3. `clampOffset` returned `-0` when clamping into a zero range. It is harmless on screen but normalized.

## Tests

| Suite | Count | New in this stage |
|---|---|---|
| Renderer | 95 | zoom math (fit and no upscale, HiDPI, 100 % = device pixel, clamps, cursor anchoring, pan limits); viewer (Enter / double-click open, not on folders, viewer-fit for current + neighbours with priorities, fit layer at 25 %, original only past the preview's resolution, + / − / 800 % clamp, ←/→ skipping folders and videos and stopping at the ends, Home/End, stepping into unloaded pages, Esc selects the last image, fallback to original, error + Try again with forced regeneration, wheel zoom) |
| Desktop | 72 | `media.open` params routing; `media.resolve` forbidden from the renderer; media tokens (opaque, LRU, strict URL format); byte ranges (suffix, open-ended, clamped, invalid, multi-range) |
| Contracts | 22 | `media.resolve` result guard against Go golden fixtures |
| Go | 15 packages | `media.resolve` golden frames (success, not found) |
| E2E | 30 | Stage 04 (5): open from a tile, step, Esc back to the selected tile; prefetched step latency; 1:1 loads the original only when needed (4000 px, token URL); 48 MP original without long tasks; corrupt image error and navigation continues |

## Benchmarks

Windows 11, i9-13900K, production build, 1440×900 window. Results: `shared/bench/results/stage-04-2026-09-30-e2e-viewer.jsonl`,
`stage-04-2026-09-30-petter-startup.json`.

| Metric | Result | Target |
|---|---|---|
| Next image when prefetched (keydown → decoded layer shown), 12 MP sources | p50 **1 ms**, max 4 ms | "immediate": < 100 ms (e2e gate) |
| Jump to an image that was not prefetched (End), 12 MP | 554 ms (viewer-fit generated on demand) | — |
| 48 MP JPEG: open → fitted preview | 1.33 s | — |
| 48 MP JPEG: 1:1 → original shown | 83 ms (decoded off the main thread) | — |
| Long tasks during 48 MP open, 1:1 and panning | **0** | none > 100 ms (e2e gate) |

Startup regression: ready-to-show p50 232 ms, sidecar hello p50 116 ms, idle 338 MB (+44.9 MB over empty Electron;
Stage 03: +39 MB), ping p95 0.2 ms. All budgets pass.

## Acceptance

- [x] changing images feels immediate when cached (prefetched step p50 1 ms)
- [x] large image decode does not freeze the tile view (48 MP: 0 long tasks)
- [x] failed decode is recoverable (error + Try again; fallback to the original; navigation continues)

## Risks and follow-ups

- **Cold jumps** (Home/End, or fast repeated stepping past the prefetch) wait for viewer-fit generation, about 0.5 s for 12 MP and
  1.3 s for 48 MP. The tile thumbnail placeholder only exists if that tile was on screen. Stage P05 candidate: show
  `grid-md` immediately for off-screen targets, or prefetch two neighbours.
- **Idle memory** crept from +39 to +45 MB over the Electron floor (budget 60). It is not yet attributed; watch it in Stage 05.
- TIFF and images over 50 MP can only be viewed up to the 2560 px preview.
- Rotate/flip (FR-13) is prepared for, not implemented: the viewer applies a single transform, so rotation is one more term.

## Exit checklist

- [x] implementation complete
- [x] tests complete
- [x] benchmark complete
- [x] performance regression reviewed
- [x] docs/ADR updated
