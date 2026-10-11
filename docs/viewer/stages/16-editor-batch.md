# Stage 16 — Image Editor: Batch Mode

Status: **Planned** (2026-10-11). Track: viewer. Depends on: 12, 13, 14 (15 for the optional auto red-eye), P03.
Unblocks: nothing planned (the editor is complete). Not active.

<!-- File: docs/viewer/stages/16-editor-batch.md -->

## Objective

Run the editor's batch-capable tools over many pictures at once — from a multi-selection — with a UI that lets the user
build a recipe, judge it on real sample pictures, choose where results go, and run it as a safe, cancellable,
undoable job that never freezes the app.

## Decisions applied

- **ADR-0036 (proposed → decided in this stage):** recipes, the `edit` job kind, bounded workers with a memory
  budget, output rules, reports, dry-run, undo.
- ADR-0035: operations, determinism, metadata policy, Replace-through-trash rules.
- ADR-0021 / ADR-0029: job queue, per-item conflicts, pause/resume, errors paging, progress coalescing.
- ADR-0017: selection descriptors, never id lists from the renderer.
- ADR-0016: recipes are durable user data in `library.db`.
- ADR-0027: viewer profile only; main validates recipes.
- CLAUDE.md: bounded concurrency, cancellation, batched DB writes, no unbounded `Promise.all`.
- `docs/viewer/IMAGE-EDITOR.md` §3 (Batch column) and §5.4.

## Scope

| Item | State |
|---|---|
| "Edit N pictures…" from the batch bar, tile context menu and `Ctrl/Cmd+E` with a multi-selection (images only; others skipped and counted) | planned |
| Batch editor: sample filmstrip (≤ 12), restricted tool rail, recipe stack, Output panel, Run | planned |
| Recipe model, validation, tokens, relative units, `Batchable` table | planned |
| `edit` job kind: bounded workers, memory semaphore, atomic outputs, cancel, errors, progress | planned |
| Output: format/quality, destination (next to originals + suffix / folder / replace), name template, conflict policy, metadata policy, DPI, mirror subfolders | planned |
| Reports: Count colors and EXIF to CSV | planned |
| Saved recipes (library.db), presets list in single and batch editors, import/export `.panelyth-recipe.json` | planned |
| Undo this batch (created files to trash) | planned |
| Jobs panel integration: label, progress, per-item errors, "Show results" selects the outputs | planned |

### Batch-capable operations (hand-off table)

| Operation | Batch behavior |
|---|---|
| `rotate` | 90° steps, any angle with `expand/crop/fill`; **Auto-orient** (apply EXIF, reset orientation) |
| `flip` | as is |
| `crop` | ratio + anchor, or fixed size + anchor, or "trim borders" (uniform edge color, tolerance); no free rectangle |
| `resize` | percent, fit within W×H, fill, longest edge, print size at DPI, never-enlarge |
| `canvas` | relative or fixed size + anchor + fill |
| `dpi` | metadata or resample |
| `lighting`, `colors`, `levels`, `curves` | fixed values or stored curves; **auto** levels/enhance computed per picture |
| `sharpen`, `blur`, `denoise` | radius in proxy-independent units (px at 12 MP reference, scaled by picture size, option "absolute px") |
| `replaceColor`, `swapChannels`, `reduceColors`, `grayscale`, `sepia`, `negative` | as is |
| `border`, `frameMask`, `watermark`, `bump`, `sketch`, `oil`, `lens` | relative sizes; watermark tokens |
| `obscure` | fixed relative region only (e.g., bottom 8 %) |
| `redeye` | only **Auto**, only if Stage 15 shipped it for batch |
| `draw`, `clone`, `heal` | not batchable (disabled with the reason) |
| *Count colors*, *EXIF export* | report to CSV |

### Batch editor UX

- Same shell as the editor, so the learning carries over: tool rail on the left (batch-incapable tools disabled with a
  one-line reason), canvas center, recipe on the right.
- **Filmstrip:** up to 12 samples (first, last, evenly spread; user can pin a picture with a star, replace a sample
  from the selection grid, or cycle). Clicking a sample shows it large; a "Compare all" grid view shows the 12
  results at once, rendered with the ordinary session path, one at a time at proxy size (never 12 sessions at once).
- **Recipe stack** works as the editor's edit stack; parameters shown in relative units with their absolute
  meaning on the current sample ("10 % → 412 px on this picture").
- **Output panel:** format (Keep each picture's format / JPEG / PNG / TIFF / BMP), quality, destination, name template
  with token chips and a live "preview of names" list (first 5), conflict policy, metadata policy, DPI, "mirror
  subfolders" (recursive selections). Warnings inline: Replace requires trash (checked before Run), format change from
  WebP (saved as PNG/JPEG), alpha loss when JPEG is chosen with transparent pictures.
- **Summary bar:** N pictures, M skipped (hover for why), estimated output size (labeled "about"), where results go.
- **Run:** one button. The batch editor closes, the jobs panel opens with progress, current file, speed and ETA,
  Pause/Cancel, and failures with reasons. Finished jobs offer Show results and Undo this batch.
- Saved recipes: "Save recipe…", "My recipes" menu (rename, delete, export, import); a few built-in recipes
  (Web 1600 px, Email 1024 px, Thumbnail 256 px square, Print 10×15 cm @300 dpi, Watermark bottom-right, Black & white
  contrast) that are ordinary recipes, editable copies.
- Keyboard: every control reachable; `Ctrl/Cmd+Enter` runs; `Esc` closes with a prompt if the recipe is unsaved and
  non-empty.

### Job behavior

- Workers `min(4, max(1, NumCPU/2))`; per-picture reservation `w × h × 4 × 3` bytes from the job's byte semaphore
  (default 1 GiB, shared with the preview decode budget); a picture larger than the budget runs alone; operations
  run single-threaded within a picture.
- Decode → ops (fused) → encode → write partial → rename (or trash-then-rename for Replace). Source and destination
  equality is checked before starting. Cancel removes partials. Errors are per item with codes
  (`DECODE_FAILED`, `UNSUPPORTED`, `TOO_LARGE`, `WRITE_FAILED`, `TRASH_UNAVAILABLE`, `CONFLICT_SKIPPED`).
- The job journal keeps created paths for **Undo this batch** (≤ 10,000 per job).

## Non-goals

- Scripting, scheduling, watch-folder automation, command-line batch, running recipes on videos or from the commander
  (a later stage may expose "Edit N pictures…" in the commander through `app.switch`).
- Batch free-hand tools; cloud presets; recipe sharing beyond file export/import.
- Changing the ADR-0029 queue (this stage is a consumer).

## Implementation tasks

- [ ] ADR-0036 accepted or amended; index updated.
- [ ] Go: recipe types, validator (allowlist, relative units, token syntax, limits), token expander (reuse Stage 14's),
  migration `recipes` in `library.db`, import/export with asset embedding and hostile-JSON tests.
- [ ] Go: `edit` job kind in `internal/jobs`: worker pool, byte semaphore integration with the preview decode budget,
  lean per-picture pipeline reusing operations and fusion, output writer (shared with `edit.save`), report jobs
  (CSV), journal and undo.
- [ ] Go: per-picture auto operations (auto levels/enhance, auto-orient, trim borders), absolute/relative radius scaling.
- [ ] Contracts: `recipe.*` methods, `jobs.start` spec for `edit`, results, guards, golden fixtures; main validation;
  native folder dialog handoff for destinations.
- [ ] Renderer: batch editor (filmstrip, compare grid, output panel, name preview, summary, warnings), recipe library
  UI, jobs panel additions (label, Undo this batch, Show results), batch bar and menu entries, keymap action
  `item.editBatch`, `t()` strings.
- [ ] Built-in recipes as data with tests that each validates and produces the documented size.
- [ ] Tests, benchmarks, docs (BRS FR-23 batch clause, UX-DESIGN, TESTING, FEATURE-MATRIX, PERFORMANCE).

## APIs/contracts

| Method | Params → result |
|---|---|
| `jobs.start` (`kind: "edit"`) | `{ source: SelectionDescriptor, recipe, output }` → `{ jobId }` (validated before start; refuses with the full list of problems) |
| `recipe.list` / `recipe.save` / `recipe.delete` | CRUD for stored recipes (`{ id, name, json }`) |
| `recipe.export` / `recipe.import` | main-owned file dialogs; Go validates JSON |
| `edit.plan` | `{ source, recipe, output }` → `{ count, skipped: {reason,count}[], names: string[5], estimateBytes, warnings[] }` for the summary bar (no pixels) |
| `edit.sample` | `{ source, count }` → sample entry ids chosen by the rules above |
| `jobs.undo` | `{ jobId }` → `{ jobId }` (a trash job for the created files) |

Samples render through the Stage 12 `edit.open`/`edit.render` calls; only one is open at a time.

## Tests

- Go: recipe validation (every rejection path), token table tests, relative-unit determinism across sizes, memory
  semaphore never exceeded (tiny-budget test), worker count bound and goroutine count, cancel leaves no partials,
  trash-unavailable refusal before the first file, conflict policies, skip reasons, mirror subfolders, undo removes
  only created files and never originals, CSV report content, hostile import (huge, nested, unknown ops, path-like
  strings, asset path traversal), `-race` in Linux CI, deterministic outputs across worker counts.
- Renderer: batch editor state, name preview, summary updates, disabled-tool reasons, saved-recipe lifecycle,
  keyboard path, no `Promise.all` over the selection (lint rule/test), strings via `t()`.
- E2E: select 200 fixture pictures → resize + watermark recipe → Run → files exist with correct names and sizes,
  UI stays responsive (no long task > 50 ms), cancel mid-run, Replace with trash, Undo this batch, Count-colors CSV,
  recipe export/import, a mixed selection (images + a video + a folder) skipped correctly.

## Benchmarks

`BENCH_STAGE=16`. Proposed budgets (fixed by the baseline):

| Case | Budget |
|---|---|
| 1,000 × 12 MP JPEG, recipe: fit 1600 px + sharpen + watermark → JPEG 85, 4 workers | ≥ 6 pictures/s on the reference machine; linear scaling 1→4 workers ≥ 2.5× |
| Peak heap during that run | ≤ semaphore budget + 300 MB |
| `edit.plan` for a 100k-picture selection | < 300 ms, one IPC call |
| Cancel latency | < 1 s for the picture in progress to stop, no partials |
| Renderer long tasks and tile-view scroll fluidity during a running job | no regression |
| 10,000-picture job journal write | batched, < 100 ms overhead |

Plus goroutines (workers + O(1)), and the interference check with preview generation (thumbnail throughput drop while
a batch runs ≤ 30 %, measured).

## Acceptance criteria

- A user can build a recipe from sample pictures, run it on thousands of files, cancel it, and undo it, with the UI
  responsive throughout.
- No path in the flow can overwrite or lose an original without the trash step (or an explicit, separate confirmation
  when trash does not exist).
- Batch results equal the single-image editor's output for the same recipe on the same picture.
- Every batch-capable operation in the table works in batch; every other tool explains why not.
- Budgets are met, or the ADR records an accepted change.

## Risks

| Risk | Mitigation |
|---|---|
| Memory blow-up with large pictures in parallel | byte semaphore, big picture runs alone, test with tiny budget |
| Batch steals CPU/IO from browsing | worker bound, shared decode budget, lower scheduling priority lane, interference benchmark |
| Recipes behave differently on different sized pictures | relative units everywhere, determinism tests across sizes, absolute-px option explicit |
| Users overwrite originals by mistake | trash first, pre-flight refusal, summary bar text, Undo this batch |
| Hostile recipe files | validation as data only, size caps, no paths, import fuzz tests |
| Auto red-eye false positives | included only if Stage 15's gate passed |

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed (both apps when platform code changed)
- [ ] docs/ADR updated (ADR-0036 accepted; DEVELOPMENT-STAGES, ROADMAP, README, BRS, FEATURE-MATRIX)
