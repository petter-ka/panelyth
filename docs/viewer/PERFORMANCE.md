# Viewer Performance

Viewer-specific budgets, rendering strategy and recorded results. Platform strategy and budgets (startup, idle memory,
IPC, paging, long tasks) are in `docs/shared/PERFORMANCE.md` and apply here too.

## Viewer budgets

| Metric | Budget |
|---|---|
| Open a cached 100k folder → first page painted | < 300 ms |
| Mounted tiles | ≤ 300 |
| Long tasks during continuous tile scrolling | none > 50 ms |
| Thumbnail cache hit → painted | p95 < 50 ms |
| `preview.ensure` calls while scrolling | one per settled range, never one per tile or row |

## Tile view DOM budget

Starting target:

- visible rows + small overscan
- generally tens to low hundreds of tiles mounted
- never thousands solely because a folder is large

The exact budget is benchmarked rather than hardcoded as a universal promise.

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

## Recorded baselines

| Stage | Result file | Highlights |
|---|---|---|
| 00 | `docs/viewer/stages/00-foundation.md` (JSON superseded) | ready-to-show p50 230 ms; sidecar hello p50 83 ms; ping p95 0.2 ms; idle 329 MB total (+34 MB over empty Electron); quit → sidecar exit p95 5.7 ms |
| 01 | `bench/results/stage-01-2026-09-30-petter-{index.json,startup.json}`, `stage-01-…-e2e-renderer.jsonl` | 100k folder: 30–45k entries/s, first rows painted ~125 ms, 0 long tasks, page p95 ≤ 1.5 ms at any offset, query materialization 52–90 ms; sidecar hello p50 112 ms; idle +41 MB over empty Electron |
| 02 | `bench/results/stage-02-2026-09-30-petter-{previews,startup,index}.json`, `stage-02-…-e2e-previews.jsonl` | 12 MP → 384 px: 65–79 img/s at 8 workers (linear scaling); cache hit 0.01 ms/item; first thumbnail ~300 ms, 100 in ~550 ms; after restart 100 thumbnails in ~295 ms with 0 generated |
| 03 | `bench/results/stage-03-2026-09-30-*` | tile view: 100k scroll with 0 long tasks, p95 frame 7 ms, ≤ 180 tiles mounted, 1 `preview.ensure` per 5 s of scrolling; tiles per row 3 / 6 / 10 at 705 / 1345 / 1985 px; first thumbnail ≈ 250 ms after click |
| 04 | `bench/results/stage-04-2026-09-30-*` | viewer: prefetched next image p50 1 ms; cold jump 12 MP 554 ms; 48 MP original shown 83 ms after 1:1 with 0 long tasks; idle +44.9 MB over empty Electron |
| 05 | `bench/results/stage-05-2026-09-30-*` | search 100k: keystroke → results p50 215 ms incl. 200 ms debounce; session open 100k: created 51 ms, dimensions 61 ms, search 26 ms; 10k-subfolder tree expand ~70 ms, 0 long tasks, 47 rows mounted; pane resize 0 long tasks; cold 100k scan 1.34–1.38 s (+12–15 %); idle +52 / +72 / +59 MB over empty Electron (budget 60, at the edge) |
| 07 | `bench/results/stage-07-2026-10-01-*` (go-bench-5, -6, e2e-jobs) | favorite job over 90k selected files 1.37 s, 1 IPC call, 5 progress events, 0 long tasks; user-data sort 100k/10k annotated 141–144 ms, filter 50–55 ms; library favorite 100k 305 ms; small-file copy ≈ 12 MB/s (serial) |
| 08 | `bench/results/stage-08-2026-10-01-petter-startup.json`, tile scroll rows of 2026-10-01 09:29Z | design-system motion and labels add nothing to scrolling: 100k scroll p95 frame 7 ms, 0 long tasks, ≤ 180 tiles; ready-to-show p50 222 ms; idle +52.9 MB over empty Electron (budget 60) |
| 08.6 | `bench/results/stage-08.6-2026-10-05-*` | folder covers: discovery 0.09–0.16 ms (media near the start), 0.95–1.0 ms (no media, bounded at 2,048 entries); 2,000-folder scroll: ≤ 80 tiles, 0 long tasks, 1 `folder.covers` call per scroll, 0 on return; picture copy 1600×1200 → clipboard 116–123 ms, 24 MP decode + PNG 353–362 ms in Go; video double-click → full screen and playing 49–229 ms |
