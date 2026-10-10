# Performance Strategy (shared)

Platform-wide strategy and budgets for every app of the product family (ADR-0025). Each app adds its own budgets and
recorded baselines:

- `docs/viewer/PERFORMANCE.md`: tile view, thumbnails on screen, focused viewer;
- `docs/commander/PERFORMANCE.md`: panel listings, cursor movement, file-operation throughput.

## Principle

Measure first, optimize second.

Electron's official performance guidance recommends profiling and specifically warns against blocking main/renderer work and against synchronous IPC. Both apps therefore treat profiling as part of feature development.

## Performance budgets

### UI

Target:

- smooth scrolling under normal hardware
- no large synchronous React update during wheel/trackpad scroll or held-key cursor movement
- mounted items (tiles, rows) proportional to the viewport, not to directory size

### IPC

Hot-path request rules:

- batched
- asynchronous
- cancellation-aware where useful
- no thumbnail bytes in normal IPC responses

### Backend

No unbounded:

- goroutine count
- decode queue
- DB write queue
- cache directory walk

### Thumbnail generation

Use a bounded worker pool.

Request deduplication is mandatory.

A repeated request for an already-running cache key joins the existing job.

## Thumbnail profiles

Implemented (Stage 02): `grid-sm` 192, `grid-md` 384, `grid-lg` 768, `viewer-fit` 2560 (long edge, device
pixels). The `grid-*` ids are protocol names for **tile** thumbnails. The tile view picks the smallest profile of at least
thumbnail box × devicePixelRatio (`docs/viewer/stages/03-tile-view.md`).

A profile is part of the cache key.

The app should not generate a 4K preview when a tile needs only a ~300px image.

## Cache I/O

Use asynchronous file access.

Avoid repeatedly opening the same preview from scratch where practical.

The OS filesystem cache should be allowed to help with hot previews.

## React techniques

- stable keys
- memoized tile component where measured useful
- avoid context updates across the whole tile view
- use selectors for global stores
- batch backend events
- use transitions for non-urgent state updates
- avoid layout reads inside scroll handlers
- avoid synchronous image measurement for every tile

## Instrumentation

Add:

- `performance.mark()` / `performance.measure()` in renderer
- scan duration
- files discovered/sec
- metadata/sec
- thumbnail queue depth
- thumbnail generation latency
- cache hit ratio
- cache miss ratio
- visible range
- rendered tile count
- IPC request latency
- folder-open-to-first-result
- folder-open-to-first-thumbnail
- folder-open-to-interactive

Go:

- benchmark scanner
- benchmark SQLite page queries
- benchmark image decode/resize
- benchmark cache lookup/write
- profile CPU and allocations

## Platform budgets

Measured per app on the reference machine (i9-13900K, Windows 11) and one low-end machine. Memory is budgeted as a
delta over an empty Electron window measured in the same run, because the Electron floor alone is about 300 MB on
Windows. These rows come from `docs/shared/ARCHITECTURE-ANALYSIS.md` §10.4, as recalibrated through Stage 08; the
app-view and switch rows were added with ADR-0031 and get calibrated in Stages P01 and C00.

| Metric | Budget |
|---|---|
| Cold start → window shown | < 1.0 s |
| Cold start → sidecar `hello` | < 500 ms |
| Idle memory, all processes, one app view (the other never opened) | < 400 MB absolute **and** < 60 MB over an empty Electron window |
| Idle memory, both app views created | < 160 MB over an empty Electron window (recalibrated in Stage C00: one more renderer process measures ≈ 97 MB; ADR-0031) |
| App switch to an existing app view → visible and focused | ≤ 1 frame (16 ms), plus the target's listing budget if the folder changes |
| First app switch (the app view is created) → interactive | < 800 ms |
| `system.ping` round trip renderer → Go → renderer | p95 < 3 ms |
| `query.page(256)` at any offset, 100k folder | p95 < 25 ms |
| Long tasks during continuous scrolling or held-key navigation | none > 50 ms |
| Sidecar clean shutdown | < 1 s |

App budgets (mounted tiles or rows, first page painted, thumbnails, file-operation throughput) are in the app
documents above; the switch and shared-state budgets are in `docs/shared/APP-SWITCHING.md`.

## Benchmark results

Result files go to `src/shared/bench/results/stage-<id>-<date>-<host>-<kind>.<ext>` and are never overwritten
(`scripts/results.mjs`). `<id>` is the stage ID: viewer numbers (`03`, `08.6`), platform `P01`…, commander `C00`….
`BENCH_STAGE` accepts two digits today; Stage P01 extends it to the other forms.

## Performance regression gate

A PR that changes a hot path should include either:

- a benchmark, or
- a measured before/after trace

If the change makes scrolling worse, fix or justify before merging.

## Practical anti-patterns

Bad:

```ts
const [allFiles, setAllFiles] = useState<FileItem[]>([])
```

when `allFiles` represents hundreds of thousands of rows and every mutation re-renders the parent.

Better:

- indexed/batched backend queries
- a small frontend window of metadata
- virtualized rendering
- localized state changes

Bad:

```ts
await Promise.all(files.map(generateThumbnail))
```

Better:

- bounded scheduler with priority + cancellation

Bad:

```text
renderer -> IPC -> bytes -> base64 -> img src
```

Better:

```text
renderer -> preview URL -> controlled protocol -> disk cache
```
