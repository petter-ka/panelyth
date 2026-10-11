# Stage 12 — Image Editor Foundation: Edit Button, Session, Geometry, Save, Info Panels

Status: **Planned** (2026-10-11). Track: viewer. Depends on: 08.6 (the viewer as built), P03 (job queue). Unblocks: 13,
14, 15, 16. Not active; the active stage is P04 (`docs/DEVELOPMENT-STAGES.md`).

<!-- File: docs/viewer/stages/12-editor-foundation.md -->

## Objective

Press **Edit** on a picture and get a fast, safe editor shell with the first useful tools: geometry (rotate, resize,
canvas size, DPI, crop), the read-only info panels (EXIF, histogram, file properties), undo/redo, before/after and a
save path that cannot lose the original. Every later stage adds tools into this shell without changing it.

## Decisions applied

- **ADR-0035 (proposed → decided in this stage):** edit sessions, proxy rendering, frame delivery, caps, save semantics,
  the viewer-only capability profile. Closing this stage's spikes accepts, amends or rejects it.
- ADR-0022: edit list, `Effect` registry, `OutputSize`, view transform. The editor starts from this code.
- ADR-0006 / ADR-0019: decoders behind the interface, pure Go, `CGO_ENABLED=0`.
- ADR-0009: frames reach the renderer through tokens.
- ADR-0021 / ADR-0029: save is a queue job; trash rules for Replace.
- ADR-0027: new methods are viewer-only; main validates every parameter; paths come from main dialogs only.
- ADR-0034: every string through `t()`; ADR-0014: motion and controls follow the design system.
- `docs/viewer/IMAGE-EDITOR.md` is the product spec for this and the next four stages.

## Scope

| Item | State |
|---|---|
| **Edit** button in the focused viewer, preview pane and tile menu; `E` shortcut (`viewer.edit`); disabled with a reason for videos and unsupported formats | planned |
| Edit button in the commander's media overlay switches to the viewer app with the picture | planned |
| Editor shell: top bar, tool rail with tool search, canvas (zoom/pan reused), right panel, edit stack, before/after | planned |
| Go edit session: decode, proxy, memory reservation, idle timeout, one interactive session per window | planned |
| Render pipeline: latest-wins revisions, cancellation, prefix cache, draft/final, frame delivery by token | planned |
| Undo/redo (edit-list snapshots), unsaved-changes prompt | planned |
| Operations: rotate (90° steps, any angle, straighten, expand/crop/fill), flip, crop (free, ratios, numeric, overlays), resize (modes + algorithms), canvas size, set DPI | planned |
| Panels: histogram (always on), EXIF (grouped, copy), file properties (reuses `PropertiesDialog` content), estimated output size | planned |
| Save: copy / as… / replace; JPEG, PNG, BMP, TIFF, GIF(single frame); quality; metadata keep/strip/strip GPS; DPI; atomic; job with progress and cancel | planned |
| Settings → Editor: default save target, default JPEG quality, default metadata policy, canvas surround | planned |
| Context menu entries, keymap actions (`viewer.edit`, `editor.undo`, `editor.redo`, `editor.compare`, `editor.save`) | planned |

### Editor shell (renderer, `src/viewer/renderer/src/features/editor/`)

- The editor is a full-area mode of the viewer, entered from the focused viewer or the preview pane (a transition-free
  swap; focus moves to the tool rail's first tool, `Esc` returns). It does not mount in the tile view; opening it never
  holds the folder's file list.
- State lives in an `editorStore` outside React (ADR-0011): edit list, history, active tool, view, session status. React
  components subscribe to slices. The canvas image is an `<img>`/`<canvas>` whose source is a token URL; slider drags
  update the store and a scheduler (≥ 1 render in flight, 1 queued; revision counter) sends `edit.render`.
- The first frame is the viewer's cached large preview for the entry (instant); when `edit.open` returns, the first
  proxy frame replaces it at the same zoom with no jump (same logical box, layer swap as in the viewer).
- Slider/number/reset control, tool search, split button, and the edit stack list are built here from the shared
  primitives plus new ones in `src/viewer/renderer/src/features/editor/controls/`.

### Geometry operations

| Operation | Parameters | Notes |
|---|---|---|
| `rotate` | `angle` (degrees, −180…180), `mode: expand \| crop \| fill`, `fill` color | 90° steps are lossless pixel moves; arbitrary angles use bilinear (final: bicubic); `crop` mode computes the largest axis-aligned rectangle inside; straighten tool sets `angle` from a drawn line |
| `flip` | `axis: h \| v` | |
| `crop` | `rect` (normalized), `ratio?`, `lockRatio` | overlay with thirds/golden/none, handles, numeric box in px; `Enter` applies |
| `resize` | `mode: pixels \| percent \| fit \| fill \| print`, `w`, `h`, `dpi`, `algo: lanczos3 \| catmull \| bilinear \| nearest`, `noEnlarge`, `sharpenAfter` | `print` = size in cm/in at a DPI |
| `canvas` | `w`, `h`, `anchor` (9), `fill: color \| transparent \| edge` | |
| `dpi` | `x`, `y`, `resample: bool` | metadata only unless `resample` |

All are batchable (`Batchable`), with crop restricted to ratio/size + anchor in batch (Stage 16).

### Info panels

- **Histogram:** from the render pass. Luminosity (default), RGB overlay, R/G/B; linear/log; shows shadow/highlight
  clipping counts as a badge and an optional zebra overlay on the canvas (Alt held). Updates with each render,
  throttled to the frame rate; never recomputed on the renderer.
- **EXIF:** `edit.info` → grouped tags (Camera, Exposure, Lens, Date, GPS, Software, Image). Reader decision: extend
  `internal/meta`/`imaging/exif.go` to a bounded TIFF-IFD reader (APP1 only, ≤ 256 KB read, no pixel reads) *or* adopt
  a small pure-Go library; whichever has less code and passes the fuzz test. Values copyable; GPS shown as text with
  a "Show on map" action absent (no network). A "strip on save" switch mirrors the save popover.
- **File properties:** existing fields plus the edited dimensions and estimated file size (from a cheap encode of the
  proxy scaled by pixel count; labeled "about").

### Save

- Split button: *Save as copy* (default), *Save as…*, *Replace original* (confirmation dialog states that the original
  goes to the trash; where there is no trash the option is replaced by "Save as copy"). Popover: format, quality (with
  the JPEG re-encode note), metadata, DPI, estimated size.
- `edit.save` is a job (ADR-0035): progress for large images, cancel, atomic partial-file write, per-step failure
  leaves the original untouched. After success: a notice with "Show in folder" and the editor stays open with the
  history intact ("saved" marker); `Esc` then closes without a prompt.

## Non-goals

- Color, effect, draw and retouch tools (Stages 13–15), batch (16).
- Lossless JPEG rotate/crop, WebP output, RAW/HEIC/AVIF, animation, 16-bit editing (see IMAGE-EDITOR.md §6).
- Persisting unsaved edit lists across app restarts.
- Any change to the tile view, folder covers or scanning.

## Implementation tasks

- [ ] **Spikes first (1–2 days, results recorded in ADR-0035):** (a) frame delivery: encoded JPEG/PNG via token vs raw
  buffer, measured for 2 MP and 6 MP frames at 30 renders/s; (b) EXIF reader size/fuzz; (c) memory per session for
  24/50/100 MP; (d) DCT-scaled decode feasibility for the proxy (`x/image` has none; see ARCHITECTURE-ANALYSIS).
- [ ] ADR-0035 accepted (or amended) with the spike numbers; ADR index and `docs/README.md` updated.
- [ ] Go `internal/editor`: `Session`, manager (one per window, idle timeout, memory reservation from the shared decode
  budget), render scheduler (revisions, cancellation), prefix cache (≤ 3 checkpoints), frame writer + token, cleanup at
  start.
- [ ] Go `internal/imaging`: extend `EditList` ops (`rotate` any angle, `canvas`, `dpi`, `resize` modes), resample
  kernels (Lanczos3, Catmull-Rom, bilinear, nearest; separable, tile-parallel), `OutputSize` for all, golden fixtures.
- [ ] Go: histogram/stats pass, EXIF reader, metadata carry-over writer (JPEG APP1/APP2, PNG iCCP/text, TIFF tags),
  DPI writers, encoders (JPEG/PNG/GIF/BMP/TIFF), quality/size estimate.
- [ ] Go: `edit.save` job kind with the Replace-through-trash path and atomic write; native dialog handoff through main.
- [ ] Contracts: methods, results, guards, golden fixtures, `VIEWER_METHODS` entries, main validation, preload and
  bridge namespace `edit`; edit-list limits.
- [ ] Main: save-as dialog, asset handles skeleton (used from Stage 14), commander-overlay `app.switch` hand-off for Edit.
- [ ] Renderer: `editorStore`, shell, tool rail + search, canvas with before/after, controls (slider, number, reset,
  split button, popover), crop overlay, straighten line, edit stack list, histogram, EXIF and File tabs, save popover,
  unsaved prompt, notices, keymap actions, settings page, `t()` strings and the eight language files.
- [ ] Edit buttons: focused viewer toolbar, preview pane toolbar, tile menu, commander overlay.
- [ ] Docs: BRS FR-23 text, UX-DESIGN editor section, PERFORMANCE editor budgets, TESTING scenarios,
  FEATURE-MATRIX rows, DESIGN-SYSTEM additions (slider, curve placeholder).

## APIs/contracts

All in the `edit` namespace, viewer profile only (ADR-0027); sizes in pixels, rectangles normalized.

| Method | Params → result |
|---|---|
| `edit.open` | `{ entryId }` → `{ sessionId, width, height, format, hasAlpha, dpi, notice? }` |
| `edit.render` | `{ sessionId, rev, editList, view, quality }` → `{ rev, frame: {url,width,height}, histogram, stats }` (or `{ rev, superseded: true }`) |
| `edit.info` | `{ sessionId }` → `{ groups: { name, items: {tag, value}[] }[] }` |
| `edit.estimate` | `{ sessionId, editList, format, quality, metadata }` → `{ bytes }` |
| `edit.save` | `{ sessionId, editList, target, format, quality, metadata, dpi }` → `{ jobId }` (target `as` is completed in main) |
| `edit.close` | `{ sessionId }` → `{}` |

Events: `edit.frame` is not needed (render returns the frame); `job.progress` carries save progress. Error codes:
`EDIT_TOO_LARGE`, `EDIT_UNSUPPORTED`, `EDIT_SESSION_GONE`, `TRASH_UNAVAILABLE`, `PERMISSION_DENIED`, `OUT_OF_MEMORY`.

## Tests

- Go: golden images for each geometry op (all kernels, odd sizes, 1×1, 1×N, alpha), `OutputSize` equals actual size
  (property test), 90° rotation is exact, rotate-any then crop-mode contains no fill pixels, DPI writers round-trip,
  metadata carry-over (orientation reset to 1, dimensions updated, ICC kept) on a corpus of JPEG/PNG/TIFF files,
  EXIF fuzz (truncated, huge counts, loops), cancel mid-render and mid-save leaves no partials, Replace path with
  failing trash leaves the original, memory reservation refuses > cap, idle timeout closes, deterministic output across
  worker counts, race detector in Linux CI.
- Contracts/main: validation of every parameter, hostile edit lists (depth, size, NaN, huge dimensions), commander
  view calling `edit.*` is refused, golden fixtures.
- Renderer (Vitest + RTL): store transitions, scheduler (one in flight + one queued, stale frame dropped), undo/redo
  snapshot logic, keyboard operation of slider/crop, unsaved prompt, no raw bytes in state, strings go through `t()`,
  disabled-button reasons.
- E2E (`src/shared/e2e/specs/viewer/editor.spec.ts`): open editor, rotate/crop/resize, undo/redo, save as copy and
  check the new file's size/EXIF, replace original through trash, cancel save, close with unsaved prompt, histogram and
  EXIF render, commander overlay → Edit lands in the viewer editor, keyboard-only path, 200 % interface size.
- Accessibility pass: tool rail roving focus, slider spoken values, canvas alternative text (NVDA pass added to the
  open list like other stages).

## Benchmarks

`BENCH_STAGE=12`; budgets from `docs/shared/PERFORMANCE.md` and `docs/viewer/PERFORMANCE.md`. Proposed editor budgets
(fixed by this stage's baseline, then enforced):

| Metric | Proposed budget |
|---|---|
| Edit pressed → first frame painted (preview cache hit) | < 100 ms |
| `edit.open` ready (24 MP JPEG, warm OS cache) | < 1.0 s |
| Slider drag → frame painted, point/geometry ops, 2 MP proxy | p95 < 80 ms |
| Rotate any angle / resize on proxy | p95 < 120 ms |
| Save 24 MP JPEG with 3 geometry ops | < 3 s |
| Heap for one 24 MP session | < 450 MB |
| Goroutines per session | O(workers), none per pixel/row |
| Tile-view scroll with an editor session idle in background | no regression |
| Long tasks in the renderer during slider drags | none > 50 ms |

Results go to `src/shared/bench/results/stage-12-…`; Go micro-benchmarks for every kernel and the histogram pass.

## Acceptance criteria

- Edit works from all entry points, never blocks the UI, and the first frame is immediate.
- Geometry ops and DPI produce the documented results; saved files open elsewhere with correct orientation, size,
  DPI, EXIF and ICC.
- The original cannot be lost by any save path, including failure and cancel.
- Budgets above are met on the reference machine, or the ADR records an accepted change.
- The commander's profile cannot call `edit.*`; the overlay hand-off works.
- Keyboard-only and screen-reader paths work for everything delivered.

## Risks

| Risk | Mitigation |
|---|---|
| Pure-Go decode of 24–50 MP JPEG is slow (no DCT scaling) | show the cached preview first; progress line; decode once per session; spike (d); keep cgo escape hatch via a new ADR |
| Frame delivery latency makes sliders feel laggy | spike (a); draft quality; raw-buffer fallback |
| Session memory pushes the app over the idle-memory budget | reservation from shared budget, idle timeout, release on close; P05 re-measures |
| Stdlib JPEG encoder only does 4:2:0 and drops metadata | explicit carry-over writer; quality popover note; PNG offered |
| Replace flows are dangerous | trash-first, atomic write, confirmation, e2e coverage |
| Scope creep into later tools | tool registry and panels are generic; later tools are separate stages |

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed (both apps when platform code changed)
- [ ] docs/ADR updated (ADR-0035 accepted; DEVELOPMENT-STAGES, ROADMAP, README, BRS, FEATURE-MATRIX)
