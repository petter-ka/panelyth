# ADR-0035 — Image Editor Engine: Sessions, Proxy Rendering, Save Semantics

## Status

**Proposed** (2026-10-11), at the owner's request. Decided in **Stage 12**; until it is accepted there, no stage builds
on it. Extends ADR-0022 (edit list, "Image transforms and effects"), ADR-0006 (decoders), ADR-0009 (tokens) and
ADR-0021/0029 (jobs, trash, conflicts). Amends ADR-0027 (new viewer-only methods). Product spec:
`docs/viewer/IMAGE-EDITOR.md`.

## Context

- ADR-0022 already has a non-destructive edit list (`rotate`, `flip`, `crop`, `resize`, `effect`) in Go, pure Go,
  deterministic, keyed into the preview cache. It says "files are never modified" and "nothing creates edit lists yet".
  The owner now wants an Edit button with color tools, effects, geometry, retouching and batch mode.
- Constraints that stay: Go owns image work and runs it off the UI thread (CLAUDE.md), bounded concurrency, context
  cancellation, no pixels over regular IPC, no base64 in React state, CGO off (ADR-0019), actions take entry ids not
  paths (ADR-0027), the viewer must not gain commander capabilities.
- Interactive tools need an answer while a slider moves. A 24 MP RGBA image is 96 MB; re-running a chain on it per
  mouse move is not an option.

## Decision

### An edit session (Go, `internal/editor`)

- `edit.open { entryId }` → `{ sessionId, width, height, format, hasAlpha, dpi, bitDepthNotice? }`. Go decodes once
  (EXIF orientation applied, like the viewer), keeps the **source** image and builds a **proxy** (the source scaled so
  its long edge is at most 2,560 px, or the canvas pixels at the current zoom, whichever is larger up to the cap).
  At most **one interactive session** is open per window; opening another closes the first. Sessions have an idle
  timeout (10 min) and close on window close.
- **Cap:** images above **100 MP** (width × height) are refused for editing with a clear message; the memory budget
  of a session (source + proxy + 3 checkpoints) is reserved from the shared decode budget (the same one previews use)
  before decoding, so an edit can never starve the tile view. Proposed numbers; Stage 12 measures and fixes them.
- 16-bit sources are reduced to 8 bits per channel with a notice (non-goal: high bit depth).

### Rendering

- `edit.render { sessionId, rev, editList, view: { scale, rect? }, quality: "draft"|"final" }` →
  `{ rev, frame: { url, width, height }, histogram?, stats? }`. The edit list is a few KB of JSON. The frame is an
  encoded image in `<cache>/tmp`, served through a one-shot read-only `panelyth-media:` token (ADR-0009). Go
  deletes frames when the session closes and at startup. **Open point, measured in Stage 12:** encoded frame + token
  (default) versus a raw RGBA buffer through a side channel; the winner is the one that meets the budget with less
  code. Either way no pixels cross the regular IPC.
- **Latest wins:** a render with a higher `rev` cancels the running one (context cancellation checked per tile row),
  and results for superseded revs are dropped, never sent. At most one render and one queued render per session.
- **Draft/final:** while a parameter is dragged the renderer asks `draft` (heavy operations run on a ¼-pixel proxy and
  skip expensive stages); on settle (150 ms without change) it asks `final`. Cheap point operations ignore the
  difference.
- **Prefix cache:** Go keeps the rendered result of the longest unchanged prefix of the edit list (the hash chain of
  `op.Key()`), so changing the last tool re-renders only that tool. At most 3 checkpoints per session, evicted by
  recency and by the memory budget.
- **Fusion:** consecutive per-pixel operations (levels, curves, brightness/contrast, saturation, grayscale, sepia,
  negative, color balance) are folded into one pass through composed 8-bit lookup tables (three 256-entry tables)
  or one 3×3 matrix where exact. Neighborhood operations (blur, sharpen, noise, oil, sketch, bump, lens) run
  tile-parallel with halo rows on the shared bounded `workpool`. Parallelism is `min(NumCPU-1, 8)`, never a goroutine
  per pixel or row group beyond that.
- **Determinism:** the same edit list on the same source produces byte-identical output across runs, platforms and
  worker counts (no data races on accumulation order, no `float` reductions across workers without a fixed order,
  seeded noise only). Proxy and final differ only by resampling.
- **Histogram and stats** (luminosity, R, G, B, 256 bins as `uint32`, clipping counts, mean) are computed in the same
  pass as the frame and returned inline (about 4 KB). `edit.colors { sessionId, maxColors }` counts distinct colors
  exactly (a 2²⁴-bit set, 2 MiB) and returns the dominant palette (≤ 32 swatches); it runs on demand, off the render
  path.

### The edit list grows

The operation set of ADR-0022 is extended by **registered operations** (the `Effect` registry stays the extension point;
each has `Validate`, `Apply`, `Key`, a `Version`, a `Batchable` flag and its parameter schema):

- Stage 12: `rotate` (90° steps and arbitrary angle with `expand|crop|fill`), `flip`, `crop`, `resize` (algorithm,
  target modes), `canvas` (anchor, fill), `dpi` (metadata or resample).
- Stage 13: `lighting`, `colors`, `levels`, `curves`, `sharpen`, `blur`, `denoise`, `replaceColor`, `swapChannels`,
  `reduceColors`, `grayscale`, `sepia`, `negative`.
- Stage 14: `border`, `frameMask`, `watermark`, `bump`, `sketch`, `oil`, `lens`, `obscure`.
- Stage 15: `draw` (stroke/shape/text list), `clone`, `heal`, `redeye`.
- Positions and sizes that the user draws are stored **normalized to the image at that step** (0–1, as `crop` already
  does), so the same list replays on the proxy, the full image and, for batch-capable ops, other images.
- `EditListVersion` bumps whenever an operation's output changes, which also invalidates preview cache keys for edited
  previews (CACHE-DESIGN `transformVersion`). The preview cache never stores editor frames.

### Saving

- `edit.save { sessionId, editList, target, format, quality, metadata, dpi }` is a **job** on the ADR-0029 queue
  (`kind: "edit.save"`, lane for single-file work), so a 60 MP save is cancellable and shows progress, and the editor
  stays usable.
- **Target** is one of: `copy` (default: `name (edited).ext` next to the original, `keepBoth` numbering on conflict),
  `replace`, or `as` with a destination chosen in a **native save dialog owned by Electron main**, which hands the
  path to the sidecar without it passing through the renderer (the renderer sees only a display name). The renderer
  never supplies a path (ADR-0027).
- **Replace** = write `.name.panelyth-partial`, `fsync`, send the original to the OS trash (ADR-0021 rules:
  fixed drives on Windows; `TRASH_UNAVAILABLE` elsewhere → the dialog offers "Save as copy" or a second, explicit
  confirmation for permanent replacement), then rename the partial over the name. A failure at any step leaves the
  original untouched or in the trash, and removes the partial.
- **Writes are atomic** (partial file + rename, as in file copy). Cancel removes the partial.
- **Formats:** JPEG, PNG, GIF (single frame), BMP, TIFF encoders from the standard library and `golang.org/x/image`;
  WebP source is saved as PNG or JPEG (no pure-Go WebP encoder; ADR-0019 policy applies to any change). Indexed
  PNG/GIF output after `reduceColors`.
- **Metadata:** JPEG saves carry over EXIF (APP1, with orientation set to 1 and pixel dimension tags updated), XMP and
  the ICC profile (APP2) unless the user chooses *strip all* or *strip GPS*. PNG/TIFF carry the ICC profile (iCCP) and
  text chunks the same way. DPI is written to JFIF/EXIF, `pHYs`, TIFF tags and the BMP header; GIF has none (control
  disabled). If a metadata kind cannot be written for a format, the save popover says so before saving.
- **JPEG is re-encoded** (4:2:0 with the Go encoder, quality default 92). Lossless MCU-aligned rotate/crop is a
  non-goal. The popover shows the estimated size and a one-line warning on repeated JPEG saves.
- After a successful save the index entry for a new file appears through the normal watcher (ADR-0020); the saved
  file's entry is selected in the tile view when the editor closes. The edited file's thumbnail is invalidated by
  its changed size/mtime like any file.

### Capability profile (ADR-0027)

- New methods `edit.open`, `edit.render`, `edit.colors`, `edit.close`, `edit.save`, `edit.info` (EXIF) are in the
  **viewer's** profile only. The commander's profile does not contain them; its media overlay's Edit button uses
  `app.switch` to reach the viewer.
- Assets the user picks (watermark logo, bump texture, frame mask) come from a main-owned native open dialog and are
  registered in main as **asset handles** (`assetId`, valid for the session, file type sniffed and size-capped at
  16 MB); the edit list refers to `assetId`, and main passes the resolved path to the sidecar. Recipes saved for
  batch store the file's path *inside the recipe asset store* (a copy under `<userdata>/recipe-assets/`), never a
  renderer-supplied path.
- Main validates every parameter (ADR-0012) and enforces size limits on the edit list (≤ 512 operations, ≤ 1 MB of
  JSON, ≤ 100k stroke points).

### Contracts, tests, benchmarks

- The contract package gets types, guards and golden fixtures for every message (ADR-0012).
- Every operation has: a validation test, a golden-image test on a small fixture (committed PNG, compared exactly
  because of determinism), a fusion-equivalence test (fused result equals sequential), a cancellation test and a
  proxy-vs-final difference bound.
- Benchmarks (`BENCH_STAGE=12…16`): per-operation ns/pixel at 2 MP proxy and 24 MP full image, session open, render
  latency p50/p95 for slider drags, fused-chain speed-up, save throughput, peak heap per session, goroutine count.

## Alternatives considered

- **WebGL/Canvas editing in the renderer.** Instant sliders, but it duplicates every algorithm in two languages (the
  saved file must equal the preview), holds pixels in the renderer (breaks the "no raw image data in React" rule and the
  memory budgets), and pushes decoding of big files into the UI process. Rejected; draft/final rendering in Go gets
  the responsiveness.
- **A cgo imaging library (libvips/ImageMagick/lensfun).** Faster and broader (WebP, HEIC, lossless JPEG) but breaks
  ADR-0019 and needs per-OS packaging. Kept as the documented escape hatch if the Stage 12–14 benchmarks miss budget,
  through a new ADR.
- **ffmpeg filters as a subprocess.** Already optional for video (ADR-0018) but not guaranteed present, with startup
  cost per call and a poor fit for interactive parameters.
- **Persisting edit lists as sidecar/XMP files.** Needs a format, conflict handling and cache semantics; deferred.

## Consequences

- The sidecar gains a long-lived, memory-heavy object (a session). Memory accounting and the idle timeout are part
  of Stage 12's exit gate; P05 re-measures idle and peak memory with the editor open.
- Edited-preview profiles (ADR-0022 follow-up) are not needed: tiles show saved files like any other.
- Adding an operation is: implement `Effect`, register, add a golden test and a contract schema, add its panel.
- The editor's UI is viewer-only; shared UI primitives (sliders, curve widget) are created in `src/shared/ui` only if
  the commander needs them (not now).
