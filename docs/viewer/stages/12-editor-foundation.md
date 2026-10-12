# Stage 12 — Image Editor Foundation: Edit Button, Session, Geometry, Save, Info Panels

Status: **Implementation done** (2026-10-12). Track: viewer. Depends on: 08.6 (the viewer as built), P03 (job queue).
Unblocks: 13, 14, 15, 16. Started 2026-10-12 at the owner's request; the open items are listed under "Open".

<!-- File: docs/viewer/stages/12-editor-foundation.md -->

## Objective

Press **Edit** on a picture and get a fast, safe editor shell with the first useful tools: geometry (rotate, resize,
canvas size, DPI, crop), the read-only info panels (EXIF, histogram, file properties), undo/redo, before/after and a
save path that cannot lose the original. Every later stage adds tools into this shell without changing it.

## Decisions applied

- **ADR-0035 (accepted in this stage, with amendments):** edit sessions, proxy rendering, frame delivery, caps, save
  semantics, the viewer-only capability profile. Its section "Decided in Stage 12" has the spike numbers and what
  changed against the proposal.
- ADR-0022 (amended): the edit list is version 2, operations are registered, the editor has its own keymap scope.
- ADR-0006 / ADR-0019: decoders behind the interface, pure Go, `CGO_ENABLED=0`. No dependency was added.
- ADR-0009: frames reach the renderer through tokens (a small token store of their own).
- ADR-0021 / ADR-0029: save is a queue job (`editSave`); trash rules for Replace.
- ADR-0027 (amended): the `edit.*` methods are viewer-only; main validates every parameter; paths come from main
  dialogs only.
- ADR-0034: every string through `t()`, in eight languages; ADR-0014: motion and controls follow the design system.
- `docs/viewer/IMAGE-EDITOR.md` is the product spec for this and the next four stages.

## Scope

| Item | State |
|---|---|
| **Edit** button in the focused viewer, preview pane and tile menu; `E` shortcut (`viewer.edit`); disabled with a reason for videos | done |
| Edit button in the commander's media overlay and in the media window switches to the viewer app with the picture | done |
| Editor shell: top bar, tool rail with tool search, canvas (zoom/pan reused), right panel, edit stack, before/after | done; before/after is a peek (hold `\` or the button), the split handle is open |
| Go edit session: decode, proxy, memory reservation, idle timeout, one interactive session per window | done |
| Render pipeline: latest-wins revisions, cancellation, prefix cache, draft/final, frame delivery by token | done |
| Undo/redo (edit-list snapshots), unsaved-changes prompt | done |
| Operations: rotate (90° steps, any angle, straighten, expand/crop/fill), flip, crop (free, ratios, numeric, overlays), resize (modes + algorithms), canvas size, set DPI | done; resize's "sharpen after" moved to Stage 13 |
| Panels: histogram (always on), EXIF (grouped, copy), file properties (the shared properties rows), estimated output size | done; the zebra overlay is open |
| Save: copy / as… / replace; JPEG, PNG, BMP, TIFF, GIF (single frame); quality; metadata keep/strip/strip GPS; DPI; atomic; job with progress and cancel | done |
| Settings → Editor: default save target, default JPEG quality, default metadata policy, canvas surround | done |
| Context menu entries, keymap actions (`viewer.edit`, `editor.undo`, `editor.redo`, `editor.compare`, `editor.save`, and close, search and zoom) | done |

### As built

**Go** (`src/shared/sidecar/internal/`):

- `imaging/ops.go`: the edit list (`{ op, p, off? }`), the operation registry, `Compile` (parse, sizes, limits, a
  hash-chain key per prefix) and `Program.Run` (resumes from any prefix at any working scale; a kept image is never
  modified). `imaging/geometry.go`: the six operations. `imaging/resample.go`: separable fixed-point kernels
  (Lanczos3, Catmull-Rom, bilinear, nearest). `imaging/parallel.go`: bounded row bands (at most 8 workers).
  `imaging/histogram.go`, `imaging/exifread.go`, `imaging/metadata.go` (read, patch, write EXIF, ICC, XMP, PNG text,
  resolution) and `imaging/save.go` (the five encoders, atomic file write, cancellation through the writer).
- `editor/`: the session manager (one per owner, idle timeout, reservation from the preview decode budget, frames
  removed at start and on close), `Session.Render` (latest wins; at most 3 checkpoints), `Session.Estimate`, and
  `Save` (full-resolution render, partial file, trash, commit).
- `jobs/editsave.go`: the `editSave` job kind; `app/editor.go`: the RPC methods.

**Contracts and main:** `src/shared/contracts/src/edit.ts` (types, limits, `editListProblem`), guards and golden
fixtures for every message; `src/shared/desktop/src/main/editor.ts` (frame tokens, the save dialog, reveal by job
id) and the validators.

**Renderer** (`src/viewer/renderer/src/`): `features/editor/` (`editorStore`, `scheduler`, `crop`, `tools`,
`editorSettings`) and `components/editor/` (`EditorOverlay`, `EditorCanvas`, `ToolPanels`, `Histogram`, `InfoTabs`,
`SaveControls`, `controls`).

How a drag works: every change of a control puts a request into the scheduler; one render is in flight and only the
newest request waits. While the control moves the request is a draft (a frame of at most 1,280 px); 150 ms after it
rests the full frame is asked for. Go cancels the running render when a newer revision arrives, starts from the
longest cached prefix of the list, and answers with a JPEG file that main turns into a token URL. The canvas swaps
the new frame in only once it has loaded.

### Geometry operations

| Operation | Parameters | Notes |
|---|---|---|
| `rotate` | `angle` (degrees, −360…360), `mode: expand \| crop \| fill`, `fill` color | multiples of 90° are exact pixel moves; other angles are bilinear while dragged and bicubic when at rest; `crop` is the largest upright rectangle inside; the straighten tool sets `angle` from a drawn line |
| `flip` | `axis: h \| v` | |
| `crop` | `rect` (normalized) | the box has thirds/golden/no guides, eight handles, a numeric box in px and a ratio lock; `Enter` applies; a crop can be reopened, which shows the picture before it |
| `resize` | `mode: pixels \| percent \| fit \| fill \| print`, `w`, `h`, `unit`, `dpi`, `algo: lanczos3 \| catmull \| bilinear \| nearest`, `noEnlarge` | `print` = size in cm/in at a DPI; a zero side keeps the proportions |
| `canvas` | `w`, `h`, `anchor` (9), `fill: color \| transparent \| edge` | |
| `dpi` | `x`, `y`, `resample: bool` | metadata only unless `resample` |

All are batch-capable (`Batchable`), with crop restricted to ratio/size + anchor in batch (Stage 16).

### Save

- Split button: the default target from Settings (*Save a copy* at first), then *Save a copy*, *Save as…*,
  *Replace original…* (a confirmation that says the original goes to the trash, with Cancel focused; where there is
  no trash or the format cannot be written the item is disabled and says why) and *Save options…*: format, quality
  with the JPEG note, metadata, DPI, the size in pixels and the estimated file size.
- `edit.save` starts the `editSave` job: progress in five steps, cancel, a partial file beside the destination, and
  the original untouched on any failure. After success the top bar says "Saved as …" with "Show in folder"; the
  editor stays open with its history; `Esc` then closes without a prompt and the tile view selects the saved file.
  After **Replace** the editor continues on the saved picture with an empty list (the edits are in the file).

## Non-goals

- Color, effect, draw and retouch tools (Stages 13–15), batch (16).
- Lossless JPEG rotate/crop, WebP output, RAW/HEIC/AVIF, animation, 16-bit editing (see IMAGE-EDITOR.md §6).
- Persisting unsaved edit lists across app restarts.
- Any change to the tile view, folder covers or scanning.

## Implementation tasks

- [x] **Spikes:** (a) frame delivery, (b) EXIF reader, (c) memory per session for 24/50/100 MP, (d) DCT-scaled decode.
  Results in ADR-0035 "Decided in Stage 12".
- [x] ADR-0035 accepted with the spike numbers and amendments; ADR index and `docs/README.md` updated.
- [x] Go `internal/editor`: `Session`, manager, render scheduling, prefix cache, frame writer, cleanup at start.
- [x] Go `internal/imaging`: the operation registry, the six operations, resample kernels, `OutputSize` for all,
  golden hashes.
- [x] Go: histogram pass, EXIF reader, metadata carry-over (JPEG APP1/APP2, PNG iCCP/eXIf/text, TIFF tags), DPI
  writers, encoders (JPEG/PNG/GIF/BMP/TIFF), size estimate.
- [x] Go: the `editSave` job with the Replace-through-trash path and atomic write; the save dialog hand-off through
  main.
- [x] Contracts: methods, results, guards, golden fixtures, `VIEWER_METHODS` entries, main validation, preload and
  bridge namespace `edit`; edit-list limits.
- [x] Main: save-as dialog, frame tokens, `app.switch` hand-off for Edit. Asset handles are Stage 14's.
- [x] Renderer: `editorStore`, shell, tool rail + search, canvas with before/after, controls (slider, number, reset,
  split button), crop overlay, straighten line, edit stack, histogram, EXIF and File tabs, save options, unsaved
  prompt, keymap actions, settings section, `t()` strings in the eight languages.
- [x] Edit buttons: focused viewer toolbar and menu, preview pane toolbar, tile menu, commander overlay, media window.
- [x] Docs: BRS FR-23, UX-DESIGN editor section, PERFORMANCE editor budgets, TESTING scenarios, FEATURE-MATRIX rows,
  DESIGN-SYSTEM additions, DOMAIN-API.

## APIs/contracts

All in the `edit` namespace, viewer profile only (ADR-0027); sizes in pixels, rectangles normalized.

| Method | Params → result |
|---|---|
| `edit.open` | `{ entryId }` → `{ sessionId, name, width, height, format, hasAlpha, dpi, notice?, saveFormat, canReplace }` |
| `edit.render` | `{ sessionId, rev, editList, view: { maxEdge }, quality, histogram }` → `{ rev, frame: {url,width,height}, output: {width,height,dpi}, histogram? }` or `{ rev, superseded: true }` |
| `edit.info` | `{ sessionId }` → `{ groups: { name, items: {id, value, code?}[] }[] }` |
| `edit.estimate` | `{ sessionId, editList, format, quality, metadata }` → `{ bytes }` |
| `edit.save` | `{ sessionId, editList, target, format, quality, metadata, dpi }` → `{ jobId, name }` (`jobId: null` when the save dialog was cancelled) |
| `edit.close` | `{ sessionId }` → `{ ok }` |
| `edit.saved` | `{ jobId }` → `{ entryId, name }` (the saved file's entry once indexed) |
| `edit.reveal` | `{ jobId }` → `{ ok }` (shows the saved file in the file manager) |

Main only, towards the sidecar: `edit.frame`, `edit.write`, `edit.source`, `edit.savedPath`. Events: `job.progress`
carries the save; `edit.request { entryId }` (from main) opens the editor for the commander's Edit. Error codes:
`EDIT_TOO_LARGE`, `EDIT_UNSUPPORTED`, `EDIT_SESSION_GONE`, `TRASH_UNAVAILABLE`, plus the existing ones.

## Tests

- **Go** (`internal/imaging`, `internal/editor`, `internal/app`, `internal/jobs`): golden hashes for 22 operation
  cases on 5 sources (odd sizes, 1×1, 1×N, N×1, alpha, every kernel); `OutputSize` equals the actual size on 300
  random lists; quarter turns equal the exact pixel move; the crop mode of a rotation contains no fill and stays
  inside the source at 10 angles; the same bytes for 1, 2, 3 and 8 workers; a run resumed from any checkpoint equals
  a run from scratch and leaves kept images untouched; the proxy stays within a bound of the final; cancel stops a
  run; histogram and color parsing; EXIF read in both byte orders, patch (orientation 1, size, resolution, thumbnail
  blanked, GPS removed and blanked), hostile input and a fuzz target; every save format round-trips with resolution,
  profile and metadata; metadata policies; cancel before and during a save leaves no file; sessions (open, render,
  one per owner, refusals, latest revision wins, prefix cache, memory reservation, idle timeout, shutdown, bounded
  goroutines); save a copy, save as, replace through an injected trash, the trash unavailable, cancel at every step,
  a changed file; the RPC methods and the job through the service.
- **Contracts/main:** every parameter of every method, hostile edit lists (depth, size, NaN, counts, prototypes), the
  commander's view refused on every `edit.*` method, the sidecar-side methods unreachable from any renderer, a
  renderer naming neither owner nor path, frame tokens only for frame files, the save dialog's path, golden fixtures.
- **Renderer** (43 tests): scheduler (one in flight, one queued, a superseded or stale frame dropped), crop math,
  store transitions, undo/redo and one history step per drag, drafts then a final frame, slider and crop by
  keyboard, tool search, the rail's roving focus, save a copy / as / replace / failure / cancel, the unsaved prompt,
  no pixel data in state, settings, disabled reasons.
- **E2E** (`src/shared/e2e/specs/viewer/editor.spec.ts`, 3 tests): open from a tile, EXIF and file panels, quarter
  turn, undo/redo, a slider drag with its frame intervals, crop and resize by keyboard, the Replace confirmation
  (cancelled), save a copy and check the file on disk (size, upright pixels with orientation 1, EXIF kept), "Show in
  folder", the unsaved prompt, the saved tile; a 24 MP picture within budget; the commander's Edit landing in the
  viewer's editor.

## Benchmarks

`BENCH_STAGE=12 pnpm bench:edit` (`cmd/editbench`), the Go micro-benchmarks and the e2e spec; results in
`src/shared/bench/results/stage-12-*`. The budgets below are the editor's from now on
(`docs/viewer/PERFORMANCE.md`).

| Metric | Budget | Measured |
|---|---|---|
| Edit pressed → first frame painted (preview cache hit) | < 100 ms | 16–22 ms |
| `edit.open` ready (24 MP JPEG, warm OS cache) | < 1.0 s | 0.21 s in Go; 0.37 s in the app, to the first painted proxy frame |
| Slider drag → frame painted, geometry operations | p95 < 80 ms | 20–52 ms in Go (draft frames); frame interval in the app p95 37–40 ms |
| Rotate any angle / resize on the proxy, full frame on a 1,600 px canvas | p95 < 120 ms | 68 ms |
| Save 24 MP JPEG with 3 geometry operations | < 3 s | 0.88 s |
| Heap for one 24 MP session | < 450 MB | 72 MB open; 152 MB peak while opening, 244 MB while saving |
| Goroutines per session | O(workers), none per pixel/row | at most 11 in the process during renders (8 workers) |
| Long tasks in the renderer during slider drags | none > 50 ms | none |
| Tile-view scroll with an editor session idle in background | no regression | not measured (see Open) |

A full frame for a 4K canvas (2,560 px, 3.8 MP) takes 125–131 ms at p95, of which the JPEG encoder is about half:
over the 120 ms line by a little, on the largest frame only. It is listed for Stage P05 with the raw-frame fallback.

Before and after of the two optimizations made in this stage (invariant 10): opening a 24 MP JPEG 0.88 s → 0.21 s
(the proxy averaged from the decoded planes in parallel bands); a save's peak heap 438 → 244 MB at 24 MP and
1.2 GB → 789 MB at 100 MP (garbage collected between steps).

## Acceptance criteria

- Edit works from all entry points, never blocks the UI, and the first frame is immediate. **Met.**
- Geometry operations and DPI produce the documented results; saved files open elsewhere with correct orientation,
  size, DPI, EXIF and ICC. **Met** in the round-trip tests and the e2e file check; not yet checked in other programs
  by hand.
- The original cannot be lost by any save path, including failure and cancel. **Met** (tests for every step).
- Budgets above are met on the reference machine, or the ADR records an accepted change. **Met**, with the 4K-canvas
  frame noted above.
- The commander's profile cannot call `edit.*`; the overlay hand-off works. **Met.**
- Keyboard-only and screen-reader paths work for everything delivered. **Keyboard met**; the screen-reader pass is
  open.

## Open

- **Accessibility:** the NVDA pass over the editor (tool rail, sliders' spoken values, crop box, dialogs).
- **Linux and macOS runs** of the Go and e2e suites (CI), and the race detector, which needs cgo (Linux CI only).
- **A full-resolution view of a region:** at zoom beyond the proxy the proxy's pixels are shown scaled (ADR-0035).
- **Before/after split handle** and the **zebra overlay** (Alt): the peek and the clipping badges are built.
- **The right panel** collapses and remembers that, but has a fixed width; **the edit stack** is reordered with its
  buttons, not by dragging.
- **E2E not covered:** cancelling a running save, 200 % interface size, a real Replace (an e2e run leaves the
  recycle bin alone; the Go tests cover the path with an injected trash).
- **Tile-view scroll with an idle session** was not measured: the viewer's tile e2e suite cannot open a folder since
  C06. An idle session runs no code and holds 72 MB.
- **A corpus of camera files** for the metadata tests: the fixtures are built in the tests.
- The full frame for a 4K canvas (125–131 ms) and a 100 MP save's 789 MB peak, for Stage P05.

## Risks

| Risk | Outcome |
|---|---|
| Pure-Go decode of 24–50 MP JPEG is slow (no DCT scaling) | 0.21 s / 0.67 s to open; the cached preview shows first |
| Frame delivery latency makes sliders feel laggy | JPEG frames paint every 37–40 ms at p95; raw frames stay the fallback |
| Session memory pushes the app over the idle-memory budget | 72 MB per session, reserved from the shared budget, released on close or after 10 idle minutes; P05 re-measures |
| Stdlib JPEG encoder only does 4:2:0 and drops metadata | the carry-over writer; the save options say what each format loses; PNG offered |
| Replace flows are dangerous | trash first, atomic write, confirmation with Cancel focused, tests for each failure |
| Scope creep into later tools | the registry and panels are generic; later tools are separate stages |

## Exit checklist

- [x] implementation complete
- [x] tests complete (the open items above are listed, not hidden)
- [x] benchmark complete
- [x] performance regression reviewed (both apps: the commander's suites pass; shared code changed in the router,
  the media overlay and the job manager only by additions)
- [x] docs/ADR updated (ADR-0035 accepted; DEVELOPMENT-STAGES, ROADMAP, README, BRS, FEATURE-MATRIX)
