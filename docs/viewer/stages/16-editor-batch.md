# Stage 16 — Image Editor: Batch Mode

Status: **Implementation done** (2026-10-12). Track: viewer. Depends on: 12, 13, 14, P03. Unblocks: nothing planned
(the editor's five stages are built). Open items are listed under "Open".

<!-- File: docs/viewer/stages/16-editor-batch.md -->

## Objective

Run the editor's batch-capable tools over many pictures at once — from a multi-selection — with a UI that lets the user
build a recipe, judge it on real sample pictures, choose where results go, and run it as a safe, cancellable,
undoable job that never freezes the app.

## Decisions applied

- **ADR-0036 (accepted with amendments in this stage):** recipes, the `edit` job kind, bounded workers on the shared
  decode budget, output rules, the plan, undo. What was decided differently from the proposal is in its "Decided in
  Stage 16" section.
- ADR-0035 ("Decided in Stage 16" added): a batch writes each picture with the editor's own save, so a batch's file
  is the file the editor would have written.
- ADR-0021 / ADR-0029: the job queue, pause/resume, errors paging, progress coalescing (this stage is a consumer).
- ADR-0017: the selection is a descriptor; the renderer never sends a list of ids.
- ADR-0016: saved recipes are durable user data in `library.db` (migration 5).
- ADR-0027 (amended): `batch.*` and `recipe.*` are in the viewer's profile only; main validates a recipe and owns
  the destination folder.
- `docs/viewer/IMAGE-EDITOR.md` §3 (Batch column) and §5.4.

## Scope as built

| Item | State |
|---|---|
| "Edit…" in the batch bar, "Edit pictures…" in the tile menu, `Ctrl/Cmd+E` (`item.edit`): several selected items open the batch editor, one picture the editor | built |
| Batch editor: sample filmstrip (≤ 12), the tool rail without the free-hand tools, the recipe stack, the Output dialog, Run | built |
| Recipe model, validation with every problem listed, name-template tokens | built |
| `edit` job kind: bounded workers, the shared decode budget, atomic outputs, cancel, per-item errors, progress | built |
| Output: format and quality, destination (next to the originals / one folder / replace), name template, conflict policy, metadata policy, DPI | built |
| The plan (`batch.plan`): how many pictures, what is skipped and why, the first names, an estimate, warnings, samples | built |
| Saved recipes in `library.db`, six built-in recipes | built |
| Undo this batch (the created files go to the trash) | built |
| Jobs panel: the label, progress, per-item errors, Show in folder, Undo this batch | built |
| Reports (Count colors, EXIF to CSV) | **not built** |
| Recipe export and import (`.panelyth-recipe.json`), recipes in the single editor | **not built** |
| "Compare all" grid, pinning and replacing samples | **not built** |
| Mirror the subfolders of a recursive selection | **not built** |

### Batch-capable operations

A recipe holds every operation of the editor except the four that point at a place in one picture. An operation
runs in a batch with the parameters it has in the editor:

| Operation | In a batch |
|---|---|
| `rotate`, `flip` | as in the editor. Every result is upright: the decode applies the EXIF orientation and the written file has orientation 1 (this is the plan's "auto-orient") |
| `crop` | the rectangle is 0..1 of the picture, so it is the same share of every picture. A ratio with an anchor and "trim borders" are not built |
| `resize` | pixels, percent, fit, fill, print size at a DPI, never-enlarge |
| `canvas` | pixels with an anchor and a fill. A size relative to the picture is not built |
| `dpi` | metadata or resample |
| `lighting`, `colors`, `levels`, `curves` | fixed values and curves; `levels` with `auto` reads each picture's own histogram |
| `sharpen`, `blur`, `denoise` | radii are pixels of the full picture, as Stage 13 decided for the editor. A radius scaled to the picture's size (the plan's 12 MP reference) is not built |
| `replaceColor`, `swapChannels`, `reduceColors`, `grayscale`, `sepia`, `negative` | as in the editor |
| `border`, `frameMask`, `watermark`, `bump`, `sketch`, `oil`, `lens`, `obscure` | sizes and regions are relative to the picture; watermark text takes the picture's tokens |
| `draw`, `clone`, `heal`, `redeye` | **not in a recipe.** The tool is shown disabled with "One picture at a time: this tool needs a place in the picture", the tool search does not offer it, and Go and main refuse a recipe that holds one. Red-eye Auto stays interactive-only (Stage 15) |

### Recipe and output

- A recipe is `{ version: 1, ops, output }`: an edit list (ADR-0035) of at most 64 operations, and the output rules.
  It never holds a path. `output` is `{ format, quality?, metadata, dpi?, destination, template?, conflict }`.
- `format`: `keep` (each picture's own format; one that can't be written, WebP, is saved as PNG) or JPEG, PNG, GIF,
  BMP, TIFF.
- `destination`: `beside` (next to each original; the default name is `{name}-edited`), `folder` (one folder; the
  default name is `{name}`) or `replace` (each original goes to the trash and the result takes its name; the format
  is then always `keep`, and a picture whose format can't be written fails as an item).
- **The folder** is picked in Electron main's dialog (`batch.pickFolder`). The renderer gets a handle (16 hex
  digits) and the folder's name; main keeps the path (the last 16 picked folders) and puts it in when it calls the
  sidecar. A recipe, a plan and a job start from a renderer never contain a path, and main refuses one.
- `template`: a file name without its extension, at most 120 characters, with `{name}`, `{filename}`, `{ext}`,
  `{folder}`, `{date}`, `{time}`, `{year}`, `{month}`, `{day}`, `{width}`, `{height}`, `{exif.<tag>}` (empty for a
  picture without that tag) and `{n}` / `{n:3}` (the picture's number in the batch, padded). An unknown token, a
  separator or a character a file name can't have is a problem shown before Run. What a token's value can't carry
  in a name (`:` in a time, `/` in a camera model) becomes `-`.
- `conflict`: `keepBoth` (a number is added: `name (2).jpg`), `skip`, or `replace` (the file that has the name goes
  to the trash first). A result never lands on its own original, on another original of the batch or on a file the
  batch itself wrote: those get a number whatever the policy. "Ask" is not offered: the plan shows the names first.
- **Validation** (`editor.Recipe.Problems`) returns every problem at once, as codes the UI words: `version`,
  `tooManyOps`, `notBatchable`, `invalidOp`, `missingAsset`, `unknownToken`, `template`, `format`, `quality`,
  `metadata`, `dpi`, `destination`, `conflict`. Main runs the structural half (`recipeProblem`) on everything a
  renderer sends; Go checks every operation's parameters and that the assets are registered.

### Batch editor UX as built

- **The same editor**, in batch mode (`data-batch`): the title is "Edit N pictures" with the sample's name beside
  it; the rail and the panels are the editor's. The four free-hand tools are disabled with the reason.
- **Filmstrip** under the canvas: up to 12 samples the plan chose (the first, the last and evenly between), with
  their tile thumbnails (one `preview.ensure` call). Clicking a sample, or the arrow keys on the strip, opens it under
  the same recipe: one edit session at a time, the list and its undo history stay.
- **Recipe stack** is the edit stack; Undo and Redo work as in the editor.
- **Summary** beside the strip and in the Output dialog: "200 pictures · 2 skipped · about 4.2 MB · into “Web
  export”". The skipped count has the reasons in its tooltip; the size is an estimate and says "about".
- **Output dialog**: destination (radio group, with the folder's Choose…/Change… button), file names with token
  chips, the conflict policy, format, JPEG quality, camera data, resolution, and "What will happen": the summary, the
  first five names as the job will give them, the warnings (no trash, WebP saved as PNG, JPEG has no transparency)
  and the problems of the recipe.
- **Run** (button, `Ctrl/Cmd+Enter`): one call. Replacing the originals asks first ("Replace N pictures?", Cancel
  has the focus). A recipe that cannot run opens the Output dialog on the reason instead of starting. The editor
  closes, a notice says the work continues in the background, and the jobs panel shows the job.
- **Jobs panel**: "Editing N pictures" with the counts, the current file, Cancel; when finished, the failures under
  Details, **Show in folder** (the first result in the system file manager) and **Undo this batch**.
- **Recipes dialog** (`Ctrl/Cmd+S` in batch mode): the six built-in recipes and the saved ones, each with Use
  (replaces the steps as one undo step, and the output), Delete for saved ones, and "Save the current recipe as".
- **Closing** with steps in the stack asks once ("Close without running?"; Keep editing has the focus); an empty
  recipe closes at once.
- Built-in recipes: Web 1600 px, Email 1024 px, Thumbnail 256 px square, Print 10 × 15 cm at 300 dpi (the longer edge
  is 15 cm; the shorter follows the picture), Watermark bottom right, Black and white with more contrast. They are
  data in Go, listed first, with names worded in the user's language.

### Job behavior as built

- **Workers** `min(4, max(1, NumCPU/2))`. Parallelism is across pictures: each picture's pixel passes run on one
  goroutine (`imaging.WithWorkers(ctx, 1)`), so a batch uses as many cores as it has workers.
- **Memory**: before decoding, a picture reserves three times its pixels (the decoded picture, its RGBA form and one
  operation's output) from the 250-megapixel decode budget previews use (`preview.ReserveDecode`); a picture larger
  than the whole budget runs alone.
- **One writer of names**: the producer names the files in display order, so `{n}` and the numbers of duplicate
  names do not depend on the worker count; the workers render and write; the job's own goroutine records results
  (the index, the journal, the progress).
- **Each picture** goes through `editor.Save`: check, decode at full resolution, the fused program, encode into a
  partial file beside the destination, sync, rename (after the trash step for Replace and for the `replace`
  conflict policy). A cancel removes the partial; pictures finished before it stay and can be undone.
- **Pre-flight**: Replace, and the `replace` conflict policy, need the trash. It is checked per volume before the
  first picture; without it the job fails with one message and nothing is touched. The plan warns earlier.
- **Skipped, not failed**: folders, videos and files that are no pictures are counted as skipped (the plan says how
  many of each). A name that is taken under the `skip` policy is skipped too.
- **Item errors**: `DECODE_FAILED`, `UNSUPPORTED` (an animation, a format that can't be written for Replace),
  `TOO_LARGE`, and the file-operation codes (`IO_ERROR`, `NO_SPACE`, `IN_USE`, `TRASH_UNAVAILABLE`, …).
- **Progress**: `total` is the selection, `bytesTotal` the pictures' size on disk; speed and ETA come from the
  bytes read.
- **Undo**: a finished or cancelled edit job remembers what it wrote (path, size and modification time; at most
  10,000 files; in memory, as long as the job is listed). `batch.undo` starts an `undoEdit` job that sends those
  files to the trash, and only those that are still what the job wrote: a result the user changed or removed since is
  left alone and counted as skipped. Originals are never touched (those a Replace took are in the trash already). A
  batch is undone once.

### Platform change made in this stage

- `fileops`: on Windows the rename that commits a partial file waits out a sharing violation for at most 410 ms. A
  file that was just written is often held for a moment by a virus scanner or the indexer. One picture of 200 failed
  once in a benchmark run before item errors were printed; it did not happen again in 4,600 further saves, so the
  cause is **not confirmed**. The retry is tested on its own (a file held for 60 ms is committed; a file held for
  good fails as `IN_USE` after the bound; a taken name is not waited for). It also applies to the copy engine's
  commits. Later an access denial was added to what it waits out, and commits that replace a file wait too (ADR-0029).
- `index.Store.Briefs`: entries without their paths, for the plan (below).

## Non-goals

- Scripting, scheduling, watch-folder automation, command-line batch, running recipes on videos or from the commander.
- Batch free-hand tools; cloud presets.
- Changing the ADR-0029 queue (this stage is a consumer).

## Implementation tasks

- [x] ADR-0036 accepted with amendments; index updated.
- [x] Go: recipe types, validator (allowlist, token syntax, limits), name templates, migration 5 (`recipes`) in
  `library.db`, hostile-JSON tests. Import/export is not built.
- [x] Go: `edit` job kind in `internal/jobs`: worker pool, the shared decode budget, the editor's save per picture,
  journal and undo. Report jobs are not built.
- [x] Go: per-picture auto levels (exists since Stage 13); results are upright. Trim borders and a scaled radius are
  not built.
- [x] Contracts: `batch.*`, `recipe.*`, the `edit` and `undoEdit` job kinds, guards, golden fixtures; main
  validation; the folder dialog with a handle.
- [x] Renderer: batch editor (filmstrip, output dialog, name preview, summary, warnings), recipes dialog, jobs panel
  additions, batch bar and menu entries, keymap actions `item.edit` and `editor.run`, strings in seven languages.
- [x] Built-in recipes as data with a test that each validates and produces the documented size.
- [x] Tests, benchmarks, docs.

## APIs/contracts as built

| Method | Who | Params → result |
|---|---|---|
| `batch.pickFolder` | viewer → main | `{}` → `{ folder: { folderId, name } \| null }` (main's dialog; no path) |
| `batch.plan` | viewer → main | `{ source, recipe, folderId? }` → `{ count, skipped: {reason,count}[], names[≤5], bytes, estimateBytes, warnings[], problems[], samples: {id,name}[≤12] }`; one call, no pixels |
| `batch.start` | viewer → main | `{ source, recipe, folderId? }` → job snapshot (`kind: "edit"`); refused with the list of problems |
| `batch.undo` | viewer → sidecar | `{ jobId }` → job snapshot (`kind: "undoEdit"`) |
| `recipe.list` / `recipe.save` / `recipe.delete` | viewer → sidecar | built-in recipes first, then the saved ones by name; `save { id, name, recipe }` replaces a recipe of the same name |
| `edit.plan`, `edit.batch` | main → sidecar only | the same with `folder` as a path |

`source` is `{ selection }` (a selection descriptor). `jobs.start` refuses the kinds `edit` and `undoEdit`. There is
no separate `edit.sample`: the plan returns the samples. Samples render through the Stage 12 `edit.open` and
`edit.render`; only one is open at a time.

## Tests

- Go, `internal/editor`: every rejection path of a recipe and all problems at once; strict parsing of stored JSON
  (unknown fields, a path in the output, wrong types, 256 KiB, deep nesting); the name template table; the namer
  (duplicates, taken names under each policy, never onto an original or an own result, Replace, WebP, `{n}`); facts
  read from the file only when a token needs them; the six built-in recipes validate, produce the documented size
  and survive storage unchanged.
- Go, `internal/jobs`: a batch beside the originals with a folder and a video skipped, the results indexed and the
  journal filled; **byte-identical files for 1, 2 and 4 workers, and identical to `editor.Save` of the same
  picture**; a tiny decode budget is never exceeded and a budget below one picture lets it run alone; workers are the
  bound and no goroutine is made per picture; cancel leaves no partial and keeps what was finished; Replace refused
  before the first picture without a trash, and through the trash with one; the three conflict policies; a corrupt
  file and an animation as item errors; validation at start; undo removes only what the batch wrote and is still as
  written, never an original, once.
- Go, `internal/library`: recipe storage (names without regard to case, rename, duplicates, limits, 200 recipes).
- Go, `internal/app`: the plan (counts, reasons, names, warnings, samples, estimate, problems, folder checks), a
  batch through the real service, the recipe store, golden fixtures for the six new methods.
- Go, `internal/fileops` (Windows): the commit waits out a brief hold and gives up on a lasting one.
- Contracts: `recipeProblem` (25 rejections), templates, the plan guard (names, never paths), stored recipes, method
  lists per profile. Desktop: the router (33 rejected calls, the commander has none of it, `jobs.start` refuses the
  kinds), the folder handle (the path stays in main, unknown and forgotten handles, a malformed plan).
- Renderer (`batch.test.tsx`, 16 tests): opening from the batch bar and by key; nothing that is a picture; the
  free-hand tools out of the rail, the store and the search; the recipe kept across samples with its history; the
  plan asked again once things rest; recipes used, saved and deleted; the name preview; the folder as a handle; no
  run without a folder; the Replace confirmation; warnings and problems; Run by `Ctrl+Enter`, the jobs panel, Show
  in folder and Undo; a start that fails; the close prompt; no `Promise.all` in the batch store.
- E2E (`viewer/editor-batch.spec.ts`, 3 tests): 200 real pictures with a video and a folder selected → a built-in
  recipe and a watermark judged on a second sample → a folder from the (canned) native dialog and a name template →
  200 whole 256 × 256 JPEGs with the right names, the originals untouched, no path in the page, no long task while
  the tile view is scrolled; a slow recipe cancelled mid-run with no partial and only whole files; "-edited" copies
  undone, then the originals replaced through the trash after the confirmation.

Not automated: mirror subfolders, reports and recipe files (not built); the race detector (Linux CI); a batch on
Linux and macOS.

## Benchmarks

`BENCH_STAGE=16`: `PANELYTH_BENCH_BATCH=1 go test ./internal/app -run TestBenchBatch` (the real service: job queue,
editor save, shared decode budget, previews) and the e2e spec. Results:
`src/shared/bench/results/stage-16-2026-10-12-petter-batch.json`, `…-batch-plan-2.json`, `…-e2e-editor.jsonl`.
Reference machine: 32 logical CPUs, NVMe. The pictures are 200 × 12 MP JPEGs of 3.8 MB (the plan named 1,000; the
rate is per picture). Budgets are fixed by this baseline.

| Case | Budget | Stage 16 |
|---|---|---|
| 12 MP JPEG → fit 1600 px + sharpen + text watermark → JPEG 85, 4 workers | ≥ 5 pictures/s | 5.9 pictures/s (71 MP/s); the plan proposed 6 |
| The same with 1 and 2 workers; scaling 1 → 4 | ≥ 2.5× | 1.33 and 2.93 pictures/s; 4.4× |
| Peak heap in use during the run | ≤ 800 MB at 4 workers | 171 / 259 / 538 MB for 1 / 2 / 4 workers |
| Goroutines | workers + O(1) | 6, 6 and 8 over the idle service |
| `batch.plan` for 100,000 pictures | < 300 ms, one IPC call | 157 ms median, 181 ms worst (**418 ms before** `Store.Briefs`) |
| `batch.plan` for 200 pictures | — | 1.0 ms |
| Cancel latency, 4 workers on 12 MP | < 1 s, no partial files | 159 ms, none (126–128 ms in the app) |
| The journal of a 10,000-picture job | < 100 ms | 4.6 ms (a slice in memory; nothing is written) |
| Thumbnails of 120 × 12 MP pictures while a batch runs | throughput drop ≤ 30 % | 3.19 s alone, 3.52 s beside a batch: 9 % |
| In the app: 200 × 0.3 MP pictures, a square thumbnail and a watermark | — | 1.2 s (171 pictures/s) |
| Long tasks in the renderer and tile-view frames while a batch runs | none > 50 ms | none; frame gap p95 19 ms on a 59 Hz display |

What the 12 MP picture costs: about 0.75 s of one core, most of it the JPEG decode and the resampling from 12 MP;
the encode of the 1.9 MP result is small. The measured optimization of this stage is the plan: reading the
selection's entries without joins and without building their paths (`Store.Briefs`, 5,000 per query) took it from
418 ms to 157 ms.

## Acceptance criteria

- [x] A user can build a recipe from sample pictures, run it on many files, cancel it and undo it, with the UI
  responsive throughout (the e2e spec; 200 pictures in the app, 100,000 in the plan).
- [x] No path in the flow overwrites or loses an original without the trash step; without a trash the job refuses
  before the first picture.
- [x] Batch results equal the single-image editor's output for the same recipe on the same picture (byte-identical,
  tested).
- [~] Every batch-capable operation works in a batch with the editor's parameters, and every other tool explains
  why not. The batch-only variants of the plan (crop by ratio, trim borders, a relative canvas, a scaled radius) and
  the two reports are not built.
- [x] Budgets are met as fixed by the baseline; the throughput budget is 5 pictures/s where the plan proposed 6.

## Open

- Not built from the plan: the reports (Count colors and EXIF to CSV); recipe export and import with embedded
  assets, and the recipe list in the single editor; the "Compare all" grid, pinning a sample and replacing one;
  mirroring subfolders; crop by ratio and anchor, trim borders, a canvas size relative to the picture, radii scaled
  to the picture's size; the `ask` conflict policy; "Show results" selecting every output in the tile view (Show in
  folder reveals the first).
- **A saved recipe with a picture** (a logo watermark, a mask, a texture) names the asset by its id, and assets
  live only while the app runs (Stage 14). After a restart such a recipe reports "choose its picture again".
  Persistent recipe assets come with import/export.
- A batch into one folder from a recursive selection gives equal names a number; the subfolders are not mirrored.
- `{n}` is a token of file names only; watermark text has the picture's own tokens.
- The undo journal is in memory: it ends with the sidecar and with the job's record (the last 20 finished jobs).
- The estimate is rough: it scales the pictures' present size by how the recipe changes the pixel count of a few
  samples, with a fixed cost per pixel when the format changes.
- The intermittent item failure seen once in the benchmark is not explained (see "Platform change").
- A stale selector in `viewer/jobs.spec.ts` (an "Open folder…" button the navigation toolbar no longer has) fails two
  Stage 07 tests before they start; it predates this stage and is not fixed here.
- The NVDA pass over the batch editor; the Linux and macOS runs and the race detector (CI).

## Risks (as they turned out)

| Risk | Outcome |
|---|---|
| Memory blow-up with large pictures in parallel | the shared pixel budget; 538 MB of heap for four 12 MP pictures at once; a tiny-budget test |
| Batch steals CPU/IO from browsing | four workers of one core each; thumbnails 9 % slower beside a batch |
| Recipes behave differently on different sized pictures | sizes relative to the picture where the editor has them; radii stay full-picture pixels (recorded as open) |
| Users overwrite originals by mistake | the trash first, the pre-flight refusal, the confirmation, the names shown before Run, Undo this batch |
| Hostile recipe files | a recipe is data: strict parsing, an operation allowlist in main and in Go, no path anywhere; no import yet |
| Auto red-eye false positives | not in batch (Stage 15) |

## Exit checklist

- [x] implementation complete (see Open)
- [x] tests complete
- [x] benchmark complete
- [x] performance regression reviewed (viewer and commander unit suites; the five editor e2e specs; Go)
- [x] docs/ADR updated (ADR-0036 accepted with amendments; ADR-0027 and ADR-0035 amended; DEVELOPMENT-STAGES,
  ROADMAP, README, BRS, FEATURE-MATRIX, PERFORMANCE, UX-DESIGN, TESTING, DOMAIN-API, IMAGE-EDITOR)
