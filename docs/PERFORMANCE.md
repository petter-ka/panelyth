# Performance Strategy

## Principle

Measure first, optimize second.

Electron's official performance guidance recommends profiling and specifically warns against blocking main/renderer work and against synchronous IPC. FastView therefore treats profiling as part of feature development.

## Performance budgets

### UI

Target:

- smooth scrolling under normal hardware
- no large synchronous React update during wheel/trackpad scroll
- mounted tiles proportional to viewport, not directory size

### Tile view DOM budget

Starting target:

- visible rows + small overscan
- generally tens to low hundreds of tiles mounted
- never thousands solely because a folder is large

The exact budget is benchmarked rather than hardcoded as a universal promise.

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

## Rendering strategy

Use `@tanstack/react-virtual`.

The content area is a tile view (ADR-0004): fixed-size tiles flow left to right and wrap. The window width decides
how many tiles fit per row. Virtualize by row, where one virtual row is one line of tiles with a known, fixed height.

Why:

- predictable scroll geometry (row height is a constant per tile size)
- no layout measurement of tiles or images
- small React render surface
- tiles per row is one integer derived from the width; resizing re-renders only when it changes

TanStack Virtual supports long/infinite lists and exposes options such as overscan and direct DOM updates. React integration also supports disabling `flushSync` when performance or React 19 compatibility makes it desirable.

## Infinite scrolling design

The UI has:

- `loadedCount`
- `totalCount` when known
- page size
- prefetch threshold

Pseudo-flow:

```text
virtual range approaches last loaded row
        │
        ▼
request next page
        │
        ├── append metadata batch
        └── prefetch only near-visible thumbnails
```

Do not prefetch every image in the directory.

## Thumbnail prefetch

Priority order:

1. visible items
2. near-visible overscan items
3. small forward scroll buffer
4. optional user-direction-aware buffer

Cancel or deprioritize work that is no longer relevant.

## Thumbnail profiles

Implemented (Stage 02): `grid-sm` 192, `grid-md` 384, `grid-lg` 768, `viewer-fit` 2560 (long edge, device
pixels). The `grid-*` ids are protocol names for **tile** thumbnails. The tile view picks the smallest profile of at least
thumbnail box × devicePixelRatio (`stages/03-tile-view.md`).

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

## Recorded baselines

Benchmark writers require `BENCH_STAGE` (two digits) and never overwrite an earlier result (`scripts/results.mjs`).

| Stage | Result file | Highlights |
|---|---|---|
| 00 | `stages/00-foundation.md` (JSON superseded) | ready-to-show p50 230 ms; sidecar hello p50 83 ms; ping p95 0.2 ms; idle 329 MB total (+34 MB over empty Electron); quit → sidecar exit p95 5.7 ms |
| 01 | `bench/results/stage-01-2026-09-30-petter-{index.json,startup.json}`, `stage-01-…-e2e-renderer.jsonl` | 100k folder: 30–45k entries/s, first rows painted ~125 ms, 0 long tasks, page p95 ≤ 1.5 ms at any offset, query materialization 52–90 ms; sidecar hello p50 112 ms; idle +41 MB over empty Electron |
| 02 | `bench/results/stage-02-2026-09-30-petter-{previews,startup,index}.json`, `stage-02-…-e2e-previews.jsonl` | 12 MP → 384 px: 65–79 img/s at 8 workers (linear scaling); cache hit 0.01 ms/item; first thumbnail ~300 ms, 100 in ~550 ms; after restart 100 thumbnails in ~295 ms with 0 generated |
| 03 | `bench/results/stage-03-2026-09-30-*` | tile view: 100k scroll with 0 long tasks, p95 frame 7 ms, ≤ 180 tiles mounted, 1 `preview.ensure` per 5 s of scrolling; tiles per row 3 / 6 / 10 at 705 / 1345 / 1985 px; first thumbnail ≈ 250 ms after click |
| 04 | `bench/results/stage-04-2026-09-30-*` | viewer: prefetched next image p50 1 ms; cold jump 12 MP 554 ms; 48 MP original shown 83 ms after 1:1 with 0 long tasks; idle +44.9 MB over empty Electron |
| 05 | `bench/results/stage-05-2026-09-30-*` | search 100k: keystroke → results p50 215 ms incl. 200 ms debounce; session open 100k: created 51 ms, dimensions 61 ms, search 26 ms; 10k-subfolder tree expand ~70 ms, 0 long tasks, 47 rows mounted; pane resize 0 long tasks; cold 100k scan 1.34–1.38 s (+12–15 %); idle +52 / +72 / +59 MB over empty Electron (budget 60, at the edge) |
| 07 | `bench/results/stage-07-2026-10-01-*` (go-bench-5, -6, e2e-jobs) | favorite job over 90k selected files 1.37 s, 1 IPC call, 5 progress events, 0 long tasks; user-data sort 100k/10k annotated 141–144 ms, filter 50–55 ms; library favorite 100k 305 ms; small-file copy ≈ 12 MB/s (serial) |
| 08 | `bench/results/stage-08-2026-10-01-petter-startup.json`, tile scroll rows of 2026-10-01 09:29Z | design-system motion and labels add nothing to scrolling: 100k scroll p95 frame 7 ms, 0 long tasks, ≤ 180 tiles; ready-to-show p50 222 ms; idle +52.9 MB over empty Electron (budget 60) |

Current numeric budgets live in `docs/ARCHITECTURE-ANALYSIS.md` §10.4. Memory is budgeted as a delta over an
empty Electron window measured in the same run, because the Electron floor alone is about 300 MB on Windows.

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
