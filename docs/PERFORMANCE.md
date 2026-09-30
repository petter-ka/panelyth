# Performance Strategy

## Principle

Measure first, optimize second.

Electron's official performance guidance recommends profiling and specifically warns against blocking main/renderer work and against synchronous IPC. FastView therefore treats profiling as part of feature development.

## Performance budgets

### UI

Target:

- smooth scrolling under normal hardware
- no large synchronous React update during wheel/trackpad scroll
- mounted grid nodes proportional to viewport, not directory size

### Grid DOM budget

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

Prefer a row-based virtualized grid where each row has a predictable tile size.

Why:

- predictable scroll geometry
- fewer layout measurements
- small React render surface
- easy responsive column calculation

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

At minimum:

- `grid-sm`
- `grid-md`
- `viewer-fit`

A profile is part of the cache key.

The app should not generate a 4K preview when the grid tile needs only a ~300px image.

## Cache I/O

Use asynchronous file access.

Avoid repeatedly opening the same preview from scratch where practical.

The OS filesystem cache should be allowed to help with hot previews.

## React techniques

- stable keys
- memoized tile component where measured useful
- avoid context updates across the whole grid
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
