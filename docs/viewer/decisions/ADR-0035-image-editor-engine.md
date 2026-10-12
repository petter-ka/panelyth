# ADR-0035 — Image Editor Engine: Sessions, Proxy Rendering, Save Semantics

## Status

**Accepted** (Stage 12, 2026-10-12), with the amendments in "Decided in Stage 12" below; where that section and
the text above it differ, the section holds. Proposed 2026-10-11 at the owner's request. Extends ADR-0022 (edit list,
"Image transforms and effects"), ADR-0006 (decoders), ADR-0009 (tokens) and ADR-0021/0029 (jobs, trash, conflicts).
Amends ADR-0027 (new viewer-only methods). Product spec: `docs/viewer/IMAGE-EDITOR.md`.

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

## Decided in Stage 12 (2026-10-12)

Measured on the reference machine (i9-13900K, 32 threads; pixel passes use 8 workers). Results:
`src/shared/bench/results/stage-12-*` (`edit.json` before the proxy and save changes below, `edit-2.json` after;
`imaging-bench.txt`; `e2e-editor.jsonl`).

### The four spikes

**(a) Frame delivery: an encoded JPEG file behind a token.**

| Frame | JPEG q85 | PNG (fastest) | BMP (raw pixels in a file) |
|---|---|---|---|
| 2 MP | 28–46 ms, 283 KB | 61–104 ms, 1.6 MB | 3–6 ms, 6.3 MB |
| 6 MP | 78–129 ms, 775 KB | 152–265 ms, 3.6 MB | 9–17 ms, 17.6 MB |

JPEG meets the budget with a twentieth of the bytes of raw pixels: in the app a dragged slider paints a frame every
37–40 ms at p95 (43–62 frames per drag, no long task), against a budget of 80 ms. So frames are JPEG, and three rules
keep them cheap: a draft frame is at most 1,280 px on its long edge (quality 80, 55–90 KB), a final frame is the size
the canvas shows it at (quality 90), and never more than the proxy. A raw (BMP) frame is six to nine times faster to
encode and stays the fallback if Stage P05 finds slider latency lacking; it is one line in `editor.writeFrame`.
**Transparency is drawn into the frame as a checkerboard** instead of travelling as PNG, which costs two to four times
as long; the histogram is counted before that, so transparent pixels are still left out.

**(b) EXIF: the in-house reader, extended.** `internal/imaging/exifread.go` is a bounded TIFF-directory reader over
an `io.ReaderAt` (the EXIF block of a JPEG, PNG or WebP, or a TIFF file itself): at most 512 entries per directory,
16 directories, 256 KB read, every offset checked, no directory read twice. `metadata.go` reads and writes what a
save carries over. No dependency was added. The fuzz target ran 8.5 million inputs in 20 s without a failure; its
seeds (truncated blocks, huge counts, a directory that points at itself) run in every `go test`.

**(c) Memory: a session holds its proxy, not the source.** A session is **72 MB** of heap for a 24, 50 or 100 MP
picture alike (the 2,560 px proxy, one scaled base, three checkpoints). The cap stays at **100 MP**.

| Picture | Open: time, peak heap | Save (3 geometry ops, JPEG): time, peak heap |
|---|---|---|
| 24 MP | 0.21 s, 152 MB | 0.88 s, 244 MB |
| 50 MP | 0.67 s, 139 MB | 1.80 s, 431 MB |
| 100 MP | 1.25 s, 261 MB | 3.60 s, 789 MB |

**(d) DCT-scaled decode: not available, and not needed.** Neither the standard library nor `x/image` scales while
decoding. The proxy is instead averaged straight from the decoded planes in parallel bands (no full-size RGBA copy):
opening a 24 MP JPEG went from 0.88 s to 0.21 s. The cgo escape hatch stays unused.

### Amendments to the decision above

- **A session keeps the proxy only.** The source is decoded again by the save job, after checking that the file
  has the size and modification time the session opened; a file that changed fails the save with a message. This is
  what makes a session 72 MB instead of up to 400 MB. A save collects garbage between its steps for pictures of
  16 MP and more, which took its peak from 438 MB to 244 MB (24 MP) and from 1.2 GB to 789 MB (100 MP).
- **The view is `{ maxEdge }`**, the long edge the canvas shows in device pixels; there is no `rect`. Beyond the
  proxy's resolution the proxy's pixels are shown scaled: **a full-resolution view of a region is not built.** It is
  an open item for Stage 13, where sharpening needs it.
- **Renderer methods and what stays in main.** The renderer calls `edit.open`, `edit.render`, `edit.info`,
  `edit.estimate`, `edit.save`, `edit.close`, `edit.saved` and `edit.reveal`. Three of them are answered by Electron
  main, which calls sidecar methods no renderer can reach: `edit.render` → `edit.frame` (a frame file; main mints the
  token and checks that the file is a frame in `tmp/edit`), `edit.save` → `edit.source` and `edit.write` (main owns the
  save dialog and the path), `edit.reveal` → `edit.savedPath`. `edit.colors` comes with Stage 13.
- **One session per window:** main adds the calling web contents' id to `edit.open` as `owner`. There is no release
  on window close: a session ends when the editor closes, when the same window opens another, or after 10 idle
  minutes.
- **The save job's kind is `editSave`** (job kinds are camel case). It runs in the lane of the volumes it reads and
  writes; its progress counts five steps (check, decode, render, write, commit). The copy's default name is
  `name (edited).ext`, numbered when taken.
- **Replace without a trash is not offered.** `edit.save` with `replace` answers `TRASH_UNAVAILABLE` and the
  interface offers "Save a copy"; there is no second confirmation for a permanent replacement. A "save as" onto the
  original itself goes the same safe way (through the trash).
- **Metadata.** "Strip all" keeps the ICC profile (it is about color, not about the photographer). "Strip GPS"
  removes and blanks the GPS directory and leaves out an XMP packet that mentions GPS. The EXIF thumbnail is always
  blanked: it would show the picture before the edit. A TIFF source carries its profile and resolution, not its EXIF.
  TIFF, BMP and GIF output hold no EXIF, and BMP and GIF no profile; the save options say so. JPEG, GIF and BMP have
  no transparency here: the picture is placed on white.
- **The edit list is version 2** (ADR-0022, amended): every operation is `{ op, p, off? }` with strictly parsed
  parameters, registered with `imaging.RegisterOp` (the `Effect` registry is replaced by it). A list has at most 512
  operations; no step may exceed 100 MP or 65,535 px on an edge. An unknown resolution counts as 72 dpi where a size
  is derived from it. Golden tests compare SHA-256 hashes of the pixels (`internal/imaging/testdata/golden.json`)
  instead of committed PNG files: as exact, and a few bytes per case.
- **Fusion of per-pixel operations** is Stage 13's (Stage 12 has no per-pixel operation). **Asset handles** are
  Stage 14's (nothing uses them before). Resize's "sharpen after" comes with the sharpen operation in Stage 13.
- **Error codes** added: `EDIT_TOO_LARGE`, `EDIT_UNSUPPORTED`, `EDIT_SESSION_GONE`, `TRASH_UNAVAILABLE`. There is no
  `OUT_OF_MEMORY`: memory is reserved from the decode budget (a request waits for it), and a picture over the cap is
  refused.
- **The commander's Edit** is `app.switch { to: "viewer", edit: entryId }`, allowed for the commander's origin only
  (its media overlay and the media window). Main shows the viewer and sends it `edit.request`; the commander's
  profile still has no `edit.*` method.

## Decided in Stage 13 (2026-10-12)

Results: `src/shared/bench/results/stage-13-*` (`edit.json` with a `color` block, `imaging-bench.txt`,
`e2e-editor.jsonl`).

- **Fusion as built.** A per-pixel operation yields stages: a table per channel, a 3×3 matrix with offsets, or a
  function. `Program.Run` runs consecutive per-pixel operations as one pass and folds adjacent tables into one; a
  stage that changes nothing is dropped, so identity parameters leave the picture byte-identical. Fusion stops where
  an intermediate result is kept as a checkpoint or asked for (`histogramAt`), and where an operation needs the
  picture to build its stage (levels' `auto`). A fused chain over a 2 MP frame takes 10–11 ms, over 24 MP at save
  101 ms. Fused and sequential results are identical for opaque pixels.
- **Pixels stay premultiplied `image.RGBA`**, as in Stage 12; a per-pixel pass un-multiplies only partly transparent
  pixels. The plan's "non-premultiplied working format" was not needed.
- **Radii are in pixels of the full picture** and scaled to the working size (`Env.Scale`), so the proxy and the
  saved file agree. **The full-resolution view of a region stays open:** on a picture larger than the proxy a fine
  sharpening radius is under-represented in the preview. Building it means keeping the source or decoding a region
  per view, which changes the session's memory (72 MB today); decide with Stage P05.
- **Drafts of heavy operations:** the bilateral filter uses the 5×5 window in a draft, non-local means a smaller
  search window; both run on the draft frame (at most 1,280 px). Dragging the fast noise filter paints a frame every
  65 ms at p95 in Go and 47–51 ms apart in the app; high quality 110 ms, over the frame budget, so it is opt-in.
- **`histogramAt`** on `edit.render` returns the histogram of the picture after that many active operations
  (`before`), taken from the run or a checkpoint at no extra render. Levels and Curves draw it.
- **Three renderer methods were added**, all viewer-only (ADR-0027): `edit.colors` (as planned, with a `scope`:
  `preview` counts the proxy, `edited` and `original` decode the source and are exact; the count is a 2²⁴-bit set,
  155–174 ms for 24 MP), `edit.probe` (the average color around a point of the picture, 1 ms) and `edit.thumbs` (at
  most 16 edit lists rendered at up to 256 px from a small copy of the proxy, 16 ms for twelve; main answers with
  tokens through the main-only `edit.thumbFrames`). Probe and thumbs exist so that eyedroppers, the loupe's numbers
  and preset thumbnails need no pixel in the renderer; the loupe's magnified view is painted from the frame that is
  already on screen (`drawImage`, never read back).
- **Auto variants write ordinary values.** The Auto buttons compute levels in the renderer from the `before`
  histogram (the same rule as `imaging.AutoLevels`, tested on both sides) and store numbers; only a batch recipe
  uses `levels.auto`, which Go resolves per picture.
- **Indexed output.** A picture with at most 256 colors is written as a paletted PNG or GIF, whatever produced it;
  Reduce colors sets the save format to PNG. JPEG, TIFF and BMP store full color.
- **Memory.** A point pass allocates one output buffer (the input may be a cached checkpoint, so not in place), a
  neighborhood filter two. A session stays at 72 MB. Saves with a neighborhood operation peak at 339 MB (24 MP) and
  1.2 GB (100 MP); an exact count of 100 MP at 972 MB. Stage P05 owns these peaks.

## Decided in Stage 14 (2026-10-12)

Results: `src/shared/bench/results/stage-14-*`.

- **Resources of a run.** A step may need more than the picture: `imaging.Resources` gives it registered assets,
  fonts by family and facts about the picture (tokens). `RunOptions.Res` carries them; a session builds one, and a
  save job keeps the session's, so it finishes after the editor closes. Without resources the built-in fonts still
  work and an asset is an invalid edit.
- **Asset handles as built.** Main's dialog returns a path; main passes it to the main-only `edit.assetAdd`. The
  sidecar accepts a regular file whose first bytes say PNG, JPEG, WebP or GIF, at most 16 MB and 8,000 px a side,
  not animated; anything else is `EDIT_ASSET_INVALID`. **The id is a hash of the content** (stable across
  sessions, the same file is the same asset, and a cache key that contains it stays true). The store is the
  manager's, not a session's: at most 32 assets, at most 32 MP decoded, decoded pixels dropped when the last
  session closes. `asset.pick` takes a session id instead of a `kind`: there is one kind, and a session says for
  which picture.
- **Fonts as built.** Go, not main, lists the fonts: scanning font folders is file work and stays out of
  Electron main. Names are read from each file's name table through a bounded reader; nothing but names goes to a
  renderer. Two families ship in the binary (Go and Go Mono, from `golang.org/x/image`, already a dependency), so
  a recipe has a font everywhere. Text is laid out left to right with kerning; **shaping is not done**.
- **Relative units.** Every size of an effect is a percentage of the shorter edge (a border may be in pixels of
  the full picture). A step gets its input's full size (`Env.InW`, `InH`), which `border` needs to know how much it
  adds. A test renders 21 effect lists on a quarter-size picture and compares with the full result scaled down.
- **Feathers have a side.** A frame mask's feather lies inside its outline; an obscured region's lies outside, so
  the region the user drew is fully hidden.
- **Obscure and metadata.** Every save blanks the EXIF thumbnail (Stage 12), so an obscured picture cannot leak
  through it; no special case was added, and "Strip metadata" is not raised by Obscure.
- **Determinism.** The effects use floating point for shapes and lighting and round to 8 bits; the golden hashes
  are from amd64. The first arm64 run has to confirm them (Go may fuse a multiply and an add there); if they
  differ, the affected products get explicit conversions as in `rotateAny`.

## Decided in Stage 15 (2026-10-12)

Results: `src/shared/bench/results/stage-15-*`.

- **A drawing is one operation.** `draw` holds a list of strokes painted in order on a transparent layer over the
  picture. That is what makes an eraser possible without pixel history: it removes ink of its drawing, and the
  picture under the layer was never touched. Undo stays a list snapshot (a stroke shorter). `clone`, `heal` and
  `redeye` are one operation per stroke or eye and read their input, so a stroke never smears itself.
- **No incremental render protocol.** The proposed `edit.render { live: { opId, appendedPoints } }` was not built.
  The renderer draws the stroke in progress itself, as a path on its own canvas (26 ms at most from the pointer
  event on 24 MP, in the event's task), and sends the list as it is once per animation frame through the ordinary
  render call (latest wins); Go's frame follows at 51 ms p95 and replaces the ink. A path is not picture data: the
  rule that pixels stay in Go holds.
- **The kept layer.** Rendering a drawing of n strokes per frame cost n strokes (330 ms for 50). The layer after
  all strokes but the last is kept (two layers, working sizes up to 8 MP only, keyed by a hash chain over the
  strokes, the size and the scale), so a frame paints one stroke (11 ms). A stroke whose ink depends on more than
  the list (a fill, which looks at the picture; a text with a token) ends the chain. A test adds strokes one at a
  time and compares every frame with a render from nothing.
- **Heal** is a copy corrected to the tone around the stroke (a normalized blur of the difference outside the
  mask); spot heal picks its source among 48 offsets by how well the ring around the stroke matches. The fixture
  bound is in the stage document. No solver, no patch search.
- **Red-eye Auto is interactive-only.** `edit.eyes` finds pairs of pupils and the editor adds a visible `redeye`
  step for each. The detection's test set is synthetic, which does not show how it fares on photographs, so
  `redeye` is not `Batchable` and Stage 16 does not offer it.
- **Limits.** 2,000 strokes per drawing, 20,000 points per stroke; the list is at most 1 MB as it travels, which
  is about 60,000 points with four decimals (the plan said 100,000 points). One heal stroke works on at most
  2,048 × 2,048 pixels and is refused beyond that.

## Decided in Stage 16 (2026-10-12)

- **The save is the batch's writer too** (ADR-0036). `editor.Save` is called once per picture of a batch, with the
  recipe as its edit list; a batch therefore writes what the editor writes. Two additions serve it: a pixel pass
  honours a worker limit carried by its context (`imaging.WithWorkers`; a batch gives each picture one goroutine),
  and a save can send the file that has the destination's name to the trash before it commits (`TrashDest`, the
  batch's `replace` conflict policy). Neither changes a save from the editor.
- **Tokens outside a session.** A batch picture's tokens (`editor.Facts`) are read from the file when a template
  or a watermark first asks for one that the path does not give; the name, the extension and the folder cost
  nothing.
- **Assets stay handles of the running app.** A stored recipe that names a picture is valid while that asset is
  registered; after a restart the batch editor asks for the picture again. Persisting assets is left to recipe
  export and import.

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
