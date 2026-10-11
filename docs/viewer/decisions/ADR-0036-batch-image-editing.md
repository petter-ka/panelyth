# ADR-0036 — Batch Image Editing: Recipes, Edit Jobs and Output Rules

## Status

**Proposed** (2026-10-11), at the owner's request. Decided in **Stage 16**; no earlier stage builds on it. Depends on
ADR-0035 (accepted in Stage 12). Extends ADR-0021 and ADR-0029 (jobs and the queue), ADR-0017 (selection
descriptors) and ADR-0016 (durable user data in `library.db`).

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
