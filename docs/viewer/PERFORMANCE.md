# Viewer Performance

Viewer-specific budgets, rendering strategy and recorded results. Platform strategy and budgets (startup, idle memory,
IPC, paging, long tasks) are in `docs/shared/PERFORMANCE.md` and apply here too.

> The image editor's budgets are below ("Image editor"); Stages 13–16 add theirs in their stage documents.

## Viewer budgets

| Metric | Budget |
|---|---|
| Open a cached 100k folder → first page painted | < 300 ms |
| Mounted tiles | ≤ 300 |
| Long tasks during continuous tile scrolling | none > 50 ms |
| Thumbnail cache hit → painted | p95 < 50 ms |
| `preview.ensure` calls while scrolling | one per settled range, never one per tile or row |

## Image editor

Fixed by the Stage 12 baseline (ADR-0035; `BENCH_STAGE=12 pnpm bench:edit`, the e2e spec `viewer/editor.spec.ts`).
Reference: a 24 MP JPEG on a 1,600 px canvas.

| Metric | Budget | Stage 12 |
|---|---|---|
| Edit pressed → first frame painted (preview cache hit) | < 100 ms | 16–22 ms |
| `edit.open` ready (24 MP JPEG, warm OS cache) | < 1.0 s | 0.21 s (Go), 0.37–0.50 s (app: the longer runs include a second frame at the canvas size) |
| A dragged control → frame painted (draft) | p95 < 80 ms | 20–52 ms (Go), 37–40 ms between frames (app) |
| Full frame after a geometry operation | p95 < 120 ms | 68 ms |
| Save 24 MP JPEG with 3 geometry operations | < 3 s | 0.88 s |
| Heap of one session | < 450 MB | 72 MB; peaks 152 MB (open), 244 MB (save) |
| Goroutines | O(workers) | at most 8 workers per pixel pass |
| Long tasks in the renderer while a control is dragged | none > 50 ms | none |

Rules that keep it there: the renderer sends an edit list and shows a token URL, never pixels; one render is in
flight and only the newest request waits; a draft frame is at most 1,280 px; Go resumes from the longest cached
prefix of the list (at most 3 checkpoints per session) and cancels a superseded render; a session keeps a 2,560 px
proxy and reserves its memory from the preview decode budget; pixel passes run in row bands on at most 8 workers.

Known: a full frame for a 4K canvas (3.8 MP) takes 125–131 ms; a 100 MP save peaks at 789 MB of heap (Stage P05).

### Color tools

Fixed by the Stage 13 baseline (`BENCH_STAGE=13 pnpm bench:edit`, `BENCH_LARGE=1 go test ./internal/imaging -bench
ColorTools`, the e2e spec `viewer/editor-color.spec.ts`). Single passes on a 2 MP working picture unless a size is
given; session and app numbers are for a 24 MP JPEG on a 1,600 px canvas.

| Metric | Budget | Stage 13 |
|---|---|---|
| Fused chain of per-pixel operations | < 12 ms | 10–11 ms |
| Gaussian blur r=10; unsharp mask | < 60 ms | 19–26 ms |
| Reduce noise, fast: full frame; draft | < 400 ms; < 80 ms | 52–105 ms; 68–73 ms |
| Reduce noise, high quality: full frame; draft | < 1.5 s; < 150 ms | 254 ms; 130 ms |
| Reduce to 256 colors with dithering | < 400 ms | 55–132 ms |
| Exact color count, 24 MP (the count itself) | < 400 ms | 155–174 ms |
| Full resolution, 24 MP: fused chain; unsharp; noise (fast) | < 250 ms; < 1.2 s; < 5 s | 101 ms; 210 ms; 1.06 s |
| A dragged color control → frame painted (draft) | p95 < 80 ms | 29–65 ms (Go), 37–51 ms between frames (app) |
| Full frame after a color operation | p95 < 120 ms | 52–98 ms; 137 ms for 256 colors with dithering; 281 ms for noise in high quality |
| Color under the pointer (`edit.probe`) | < 16 ms | 1 ms |
| Twelve look thumbnails (`edit.thumbs`) | < 150 ms | 16 ms (Go), 66 ms until painted (app) |
| Count colors, the whole 24 MP picture, button to answer | < 1 s | 0.56 s |
| Save 24 MP JPEG: tone, curves and unsharp; with noise reduction | < 3 s | 1.30 s; 1.78 s |
| Long tasks in the renderer while a color control is dragged | none > 50 ms | none |

Rules that keep it there: consecutive per-pixel operations are one pass, and adjacent tables one table; a Gaussian
blur is three box passes whose cost does not grow with the radius; radii are scaled to the working size; a draft of
the noise filters looks at fewer neighbours; the histogram a tool draws comes with the frame (`histogramAt`), not from
a second render; a curve drag updates the store once per frame; thumbnails of all looks are one request.

Known: reducing to 256 colors with dithering and the high-quality noise filter take longer than 120 ms for a full
frame (their drafts are within the frame budget, except the high-quality noise filter at 110 ms, which is why "fast"
is the default); with a neighborhood operation a 100 MP save peaks at 1.2 GB of heap and an exact count of 100 MP
at 972 MB (Stage P05).

### Effects

Fixed by the Stage 14 baseline (`BENCH_LARGE=1 go test ./internal/imaging -bench Effects`, the e2e spec
`viewer/editor-effects.spec.ts`). Single passes on a 2 MP working picture unless a size is given.

| Metric | Budget | Stage 14 |
|---|---|---|
| Border; with a drop shadow | < 30 ms | 10.5 ms; 24.5 ms |
| Frame mask | < 30 ms | 14–15 ms |
| Watermark (text or picture, also repeated) | < 30 ms | 1–3.5 ms |
| Text laid out and drawn (48 px line) | < 5 ms | 0.3 ms |
| Bump map; sketch | < 100 ms | 21 ms; 19–21 ms |
| Oil painting, radius 4: full frame; draft | < 800 ms; < 120 ms | 31 ms; 31 ms |
| Lens | < 60 ms | 34 ms (26 ms in a draft) |
| Obscure by blur, a quarter of the picture | < 40 ms | 8–21 ms |
| Full resolution, 24 MP: watermark and border; oil; sketch | < 400 ms; < 4 s; < 1.5 s | 88 ms; 0.31 s; 0.15 s |
| A dragged effect control → frame painted, 24 MP in the app | p95 < 80 ms | 40–61 ms between frames |
| Long tasks in the renderer while an effect control is dragged | none > 50 ms | none |

Rules that keep it there: shapes are computed from their outline's distance, with no mask bitmap; a drop shadow
falls off analytically instead of blurring a plane (48–52 ms before, 24.5 ms after); a watermark is built once and
cached while it is placed; oil painting slides its window instead of visiting every neighbour; Obscure works on the
region's box only; fonts are scanned for names once and a font file is read when it is first used.

### Batch

Fixed by the Stage 16 baseline (`PANELYTH_BENCH_BATCH=1 go test ./internal/app -run TestBenchBatch`, the e2e spec
`viewer/editor-batch.spec.ts`): the real service with its job queue, the editor's save and the decode budget
previews share. 200 JPEGs of 12 MP and 3.8 MB; 32 logical CPUs.

| Metric | Budget | Stage 16 |
|---|---|---|
| 12 MP JPEG → fit 1600 px + sharpen + text watermark → JPEG 85, 4 workers | ≥ 5 pictures/s | 5.9 pictures/s (71 MP/s) |
| Scaling from 1 to 4 workers | ≥ 2.5× | 4.4× (1.33, 2.93, 5.88 pictures/s) |
| Peak heap in use, 4 workers | ≤ 800 MB | 538 MB (171 MB with one worker) |
| Goroutines of a batch | workers + O(1) | workers + 4 |
| `batch.plan` for 100,000 pictures | < 300 ms, one IPC call | 157 ms median, 181 ms worst |
| Cancel: the pictures in progress stop | < 1 s, no partial file | 0.16 s, none |
| Thumbnails while a batch runs | throughput drop ≤ 30 % | 9 % |
| Long tasks in the renderer and tile-view frames while a batch runs | none > 50 ms | none; frame gap p95 19 ms at 59 Hz |

Rules that keep it there: a batch is parallel across pictures and single-threaded inside one, so it takes as many
cores as it has workers (at most four); a picture reserves three times its pixels from the previews' decode budget
before it is decoded; the renderer makes one call for the plan and one for the run, whatever the selection's size,
and holds one small snapshot per job; the plan reads the selection's index rows without joins and without building
paths (`Store.Briefs`: 418 ms before, 157 ms after) and reads the headers of at most eight pictures.

### Draw and retouch

Fixed by the Stage 15 baseline (`BENCH_LARGE=1 go test ./internal/imaging -bench DrawAndRetouch`, the e2e spec
`viewer/editor-retouch.spec.ts`).

| Metric | Budget | Stage 15 |
|---|---|---|
| Pointer move → ink visible (24 MP picture, in the app) | p95 < 33 ms | at most 26 ms; drawn in the pointer event's task |
| Brush ring | one frame | moved in the pointer handler |
| Go's frame while a stroke is drawn (24 MP, in the app) | p95 < 80 ms | 51 ms between frames |
| The stroke being drawn, as an operation on a 2 MP frame | < 16 ms | 1.6–4.2 ms; 11–12 ms as the 50th stroke of a drawing |
| Clone stroke, 2 MP | < 8 ms | 7.5–7.9 ms |
| Heal: brush, region 256 × 256; spot, region 128 × 128 | < 120 ms; < 250 ms | 8–10 ms; 7–7.5 ms |
| Red-eye: a click on 24 MP; Auto scan of a 2 MP frame | < 150 ms; < 600 ms | 21–22 ms; 9.5–10 ms |
| A 5,000-point stroke replayed at 24 MP (save) | < 800 ms | 630–650 ms |
| Long tasks in the renderer while drawing | none > 50 ms | none |

Rules that keep it there: the ink of the stroke in progress and the brush ring are drawn by the renderer, with no
React render per pointer event; Go gets the stroke once per animation frame, the newest only; a finished stroke is
thinned to a quarter of a proxy pixel; the layer of a drawing's earlier strokes is kept between frames (330 ms
before, 11 ms after, for a drawing of 50 strokes); a stroke's coverage is computed in row bands over its box only.

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
| 01 | `src/shared/bench/results/stage-01-2026-09-30-petter-{index.json,startup.json}`, `stage-01-…-e2e-renderer.jsonl` | 100k folder: 30–45k entries/s, first rows painted ~125 ms, 0 long tasks, page p95 ≤ 1.5 ms at any offset, query materialization 52–90 ms; sidecar hello p50 112 ms; idle +41 MB over empty Electron |
| 02 | `src/shared/bench/results/stage-02-2026-09-30-petter-{previews,startup,index}.json`, `stage-02-…-e2e-previews.jsonl` | 12 MP → 384 px: 65–79 img/s at 8 workers (linear scaling); cache hit 0.01 ms/item; first thumbnail ~300 ms, 100 in ~550 ms; after restart 100 thumbnails in ~295 ms with 0 generated |
| 03 | `src/shared/bench/results/stage-03-2026-09-30-*` | tile view: 100k scroll with 0 long tasks, p95 frame 7 ms, ≤ 180 tiles mounted, 1 `preview.ensure` per 5 s of scrolling; tiles per row 3 / 6 / 10 at 705 / 1345 / 1985 px; first thumbnail ≈ 250 ms after click |
| 04 | `src/shared/bench/results/stage-04-2026-09-30-*` | viewer: prefetched next image p50 1 ms; cold jump 12 MP 554 ms; 48 MP original shown 83 ms after 1:1 with 0 long tasks; idle +44.9 MB over empty Electron |
| 05 | `src/shared/bench/results/stage-05-2026-09-30-*` | search 100k: keystroke → results p50 215 ms incl. 200 ms debounce; session open 100k: created 51 ms, dimensions 61 ms, search 26 ms; 10k-subfolder tree expand ~70 ms, 0 long tasks, 47 rows mounted; pane resize 0 long tasks; cold 100k scan 1.34–1.38 s (+12–15 %); idle +52 / +72 / +59 MB over empty Electron (budget 60, at the edge) |
| 07 | `src/shared/bench/results/stage-07-2026-10-01-*` (go-bench-5, -6, e2e-jobs) | favorite job over 90k selected files 1.37 s, 1 IPC call, 5 progress events, 0 long tasks; user-data sort 100k/10k annotated 141–144 ms, filter 50–55 ms; library favorite 100k 305 ms; small-file copy ≈ 12 MB/s (serial) |
| 08 | `src/shared/bench/results/stage-08-2026-10-01-petter-startup.json`, tile scroll rows of 2026-10-01 09:29Z | design-system motion and labels add nothing to scrolling: 100k scroll p95 frame 7 ms, 0 long tasks, ≤ 180 tiles; ready-to-show p50 222 ms; idle +52.9 MB over empty Electron (budget 60) |
| 08.6 | `src/shared/bench/results/stage-08.6-2026-10-05-*` | folder covers: discovery 0.09–0.16 ms (media near the start), 0.95–1.0 ms (no media, bounded at 2,048 entries); 2,000-folder scroll: ≤ 80 tiles, 0 long tasks, 1 `folder.covers` call per scroll, 0 on return; picture copy 1600×1200 → clipboard 116–123 ms, 24 MP decode + PNG 353–362 ms in Go; video double-click → full screen and playing 49–229 ms |
