# ADR-0036 — Batch Image Editing: Recipes, Edit Jobs and Output Rules

## Status

**Accepted with amendments** (2026-10-12, Stage 16). Proposed 2026-10-11 at the owner's request. Depends on
ADR-0035 (accepted in Stage 12). Extends ADR-0021 and ADR-0029 (jobs and the queue), ADR-0017 (selection
descriptors) and ADR-0016 (durable user data in `library.db`). The text below is the proposal; where Stage 16 decided
otherwise, "Decided in Stage 16" at the end says what was built and why, and it wins.

## Context

The owner wants the editor's features "in batch mode where possible". Applying the same operation to hundreds or
thousands of pictures must not freeze the UI, exhaust memory or risk the originals, and must be judged by the user
before it runs.

## Decision

### Recipe

- A **recipe** is `{ version, name?, ops: Op[], output }`. `ops` is an edit list (ADR-0035) containing only operations
  flagged `Batchable`. `output` holds format, quality, metadata policy, DPI, destination and name template.
- **Relative units only.** Batchable operations express sizes as percent, ratio or "fit within W×H", positions as an
  anchor or normalized region, and watermark size as a share of the picture. An operation carrying a free-hand
  position (draw, clone, heal, a pointed red-eye, a free crop rectangle, a free-hand obscure region) is not
  batchable. Its tool is shown disabled in the batch editor with the reason. Per-image *auto* variants exist where the
  result depends on the picture: auto levels, auto enhance, auto red-eye (if Stage 15 ships it), crop to ratio about an
  anchor.
- **Tokens** in text parameters and in the name template: `{name}`, `{ext}`, `{n}`, `{n:3}`, `{date}`, `{year}`,
  `{exif.model}`, `{exif.date}`, `{width}`, `{height}`. Unknown tokens are validation errors shown in the editor before
  running.
- Recipes are stored in `library.db` (migration; table `recipes(id, name, json, created, updated)`), listed as
  presets, and can be exported/imported as `.panelyth-recipe.json` (a version field, assets embedded base64, ≤ 8 MB;
  imports are validated like any edit list and never execute anything).

### Job

- `jobs.start { kind: "edit", source: <selection descriptor>, recipe }` — one call for any number of pictures (the
  renderer never sends an id list, ADR-0021). Go resolves the descriptor when the job starts. Videos, folders and
  unsupported formats in the selection are skipped and reported (`SKIPPED_UNSUPPORTED`), not failed.
- **Bounded parallelism with a memory budget.** Workers = `min(4, max(1, NumCPU/2))`. Each worker, before decoding a
  file, reserves `width × height × 4 × 3` bytes (source + working copy + output) from a job-wide byte semaphore
  (default 1 GiB, shared with the preview decode budget so tiles keep working). A picture bigger than the whole
  budget runs alone. Operations themselves run single-threaded in batch (parallelism is across pictures), so the
  total CPU use is bounded.
- **Cancellation** is checked between pictures and between operations inside one; a cancelled picture leaves no partial
  file (`*.panelyth-partial` is removed). Pictures finished before the cancel stay done. `jobs.errors` pages per-item
  failures as for other jobs. Pause/resume come from ADR-0029.
- **Progress** uses the existing coalesced `job.progress` snapshot; `current` is the file name being processed.
- **Output rules.**
  - Destination: next to each original with a suffix (default `-edited`), a chosen folder (a native folder dialog in
    main, passed to Go as in ADR-0035), or replace. Subfolder structure of a recursive selection is optionally
    mirrored.
  - Conflicts follow ADR-0029's per-item policies (`keepBoth`, `skip`, `replace`, or ask).
  - **Replace** sends each original to the OS trash before the rename (ADR-0035). If trash is unavailable the job
    refuses to start with a single clear message, not after half the pictures; the dialog offers the other
    destinations.
  - Source and destination can never be the same file unless Replace is chosen explicitly.
  - Metadata policy: keep, strip all, strip GPS. Keep means EXIF/ICC are carried over as in ADR-0035.
- **Report operations.** Count colors and EXIF export are batch *reports*: the job writes a CSV (`name, width, height,
  unique colors, dominant colors…` or the chosen EXIF columns) to a file the user names, using the same bounded
  workers, with no image output.
- **Dry run.** Before Run, the batch editor renders the recipe on up to 12 sample pictures with the ordinary
  `edit.render` path (a session per sample, one at a time, proxy resolution). The user sees real variation; the job
  count, estimated size and a list of pictures that would be skipped or would overwrite are shown. The estimate is
  clearly labeled as such.
- **Undo.** A finished edit job keeps a record of the files it created (`jobs` journal, up to 10,000 paths).
  "Undo this batch" in the jobs panel sends the *created* files to the trash (never the originals, which for Replace
  are already in the trash and are offered back through "Show in trash"). Available until the app closes or the job
  record is cleared.

### Capability profile and safety

- `jobs.start` with `kind: "edit"` is a viewer-profile call only. Main validates the recipe (operation allowlist, size
  limits, token syntax, ≤ 64 operations) and refuses unknown operations or any parameter that names a path.
- Watermark logos, textures and frame masks in a recipe live in the recipe asset store (ADR-0035), not at arbitrary
  paths. A recipe whose asset is missing fails validation before the job starts.
- A job never reads or writes outside the selection's folders, the chosen destination and the recipe asset store.

### Benchmarks and tests

- `BENCH_STAGE=16`: throughput (pictures/s and MP/s) for 1,000 12 MP JPEGs with a 5-operation recipe, workers 1/2/4,
  peak heap under the semaphore, goroutine count (workers + O(1)), cancel latency, UI long tasks during a job (none
  > 50 ms), tile-view scroll fluidity while a job runs.
- Tests: recipe validation, token expansion, relative-unit determinism on different sizes, memory-semaphore bound
  (a test with a tiny budget never exceeds it), cancel leaves no partials, trash-unavailable refusal, undo removes
  only created files, import rejects hostile JSON, e2e of the whole flow on the fixture folder.

## Alternatives considered

- **Run the single-image session once per file.** Simple but allocates the interactive proxy and checkpoints for each
  picture and cannot use fusion across files. Rejected: batch uses the same operations through a lean path.
- **Unbounded parallelism or one goroutine per picture.** Forbidden by CLAUDE.md.
- **Allowing free-hand positions in batch as absolute pixels.** Wrong on pictures of other sizes; relative rules and
  anchors only.
- **A separate scripting language for recipes.** No: recipes are data, validated, and can run nothing.

## Consequences

- Operations carry a `Batchable` flag and a relative-units contract; Stage 13–15 operations are written with it from the
  start (their stage documents list it), so Stage 16 is wiring, UI and the job, not rewriting.
- `library.db` gets a migration (`recipes`); the sidecar's job kinds gain `edit`; the jobs panel gains "Undo this
  batch" for this kind only.
- The shared byte semaphore couples batch editing to preview decoding; Stage P05 re-measures their interference.

## Decided in Stage 16 (2026-10-12)

Built as proposed: a recipe is data; the selection is a descriptor resolved in Go; bounded workers on the decode
budget previews share; operations single-threaded inside a picture; atomic outputs; cancel without partial files;
Replace through the trash with a refusal before the first picture where there is none; undo of the created files;
recipes in `library.db`. Decided differently:

- **A batch writes each picture with the editor's own save** (`editor.Save`), not with a second, lean pipeline. The
  save is not a session: it holds no proxy and no checkpoints; it decodes at full resolution, runs the fused
  program and encodes. So a batch's file is byte for byte the file the editor writes for that picture and recipe
  (tested for 1, 2 and 4 workers), and every later fix to the save applies to both.
- **The methods are `batch.plan`, `batch.start`, `batch.undo`, `batch.pickFolder` and `recipe.*`,** not
  `jobs.start { kind: "edit" }`, `edit.sample` and `jobs.undo`. `batch.plan` and `batch.start` are answered in
  Electron main, which turns the handle of a picked folder into its path and calls the main-only sidecar methods
  `edit.plan` and `edit.batch`; a renderer names a folder by a handle and never by a path. `jobs.start` refuses the
  kinds `edit` and `undoEdit`. The plan returns the samples, so there is no separate sample call.
- **A recipe is `{ version, ops, output }`;** its name belongs to the stored row, not to the recipe. It never holds a
  path: the folder of a "folder" output is chosen for each run.
- **Relative units are the editor's units.** Sizes that the editor expresses relative to the picture (border,
  watermark, frame mask, obscure, lens, a crop rectangle) are relative in a batch. Radii of sharpen, blur and noise
  reduction stay pixels of the full picture, as Stage 13 decided, so that a batch equals the editor; scaling them to
  the picture's size is not built. A crop rectangle is 0..1 of the picture and therefore allowed; crop by ratio
  with an anchor, trim borders and a canvas relative to the picture are not built. Auto levels reads each picture
  (it exists since Stage 13). Every result is upright, because the decode applies the orientation.
- **Red-eye is not in a batch** (Stage 15: its detector is tested on synthetic pictures only).
- **Memory is reserved in pixels,** three times a picture's, from the 250-megapixel budget of the preview service,
  not in bytes from a budget of the job's own. A request larger than the budget is capped to it, which is how a
  huge picture runs alone.
- **Names are given by one producer, in display order,** so `{n}` and the numbers of duplicate names are the same
  for any worker count. A result never lands on its own original, on another original of the batch or on a file
  the batch wrote; those get a number whatever the conflict policy.
- **Conflict policies are `keepBoth`, `skip` and `replace`;** `replace` sends the file that has the name to the
  trash first and is refused, before the first picture, where the destination has no trash. `ask` is not offered:
  the plan shows the names before Run, and a question per picture would stall a batch.
- **Tokens:** the name template takes the picture's tokens of Stage 14 and `{n}` / `{n:3}`; an unknown token is a
  validation problem; an EXIF tag a picture does not carry is empty. `{n}` is not a token of watermark text.
- **Skipped items are counted, not listed as errors:** folders, videos and files that are no pictures (the plan
  gives the count of each reason), and names taken under `skip`. Item errors use `DECODE_FAILED`, `UNSUPPORTED`,
  `TOO_LARGE` and the file-operation codes.
- **The undo journal is in memory:** path, size and modification time of at most 10,000 created files per job, kept
  while the job is listed (the last 20 finished jobs) and gone with the sidecar. The undo is a job (`undoEdit`) and
  trashes only files that are still what the batch wrote.
- **Stored recipes:** table `recipes(id, name, name_fold UNIQUE, json, created_at, updated_at)`, at most 200 recipes
  of 256 KiB; saving under an existing name replaces that recipe. The six built-in recipes are data in Go, listed
  first under a key the UI words. A stored recipe is checked for everything but its assets, which are checked when
  it is used: asset handles end with the app (ADR-0035), so a recipe with a picture asks for it again.
- **Not built:** the two reports (Count colors, EXIF to CSV), recipe export and import, the recipe list in the
  single editor, the "Compare all" grid and pinning or replacing samples, mirroring subfolders. They are listed as
  open in the stage record.
- **Budgets** are fixed by the stage's baseline (`docs/viewer/PERFORMANCE.md` "Batch"): 5.9 pictures/s with four
  workers on 12 MP JPEGs where the proposal named 6 (the budget is 5); a plan of 100,000 pictures in 157 ms; a
  cancel in 0.16 s; thumbnails 9 % slower beside a batch.
