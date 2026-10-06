# Stage 03 — Virtualized Tile View

Status: **Complete** (2026-09-30)

## Objective

Deliver the main browsing surface: every item of the open folder is a **tile**. Tiles sit next to each other
**left to right** and wrap to the next line, like icons in a file explorer. The layout is **responsive**:
tiles keep a fixed size, so a wider window (or a higher resolution) fits **more tiles per row**. It works for
folders of any size without mounting them in full.

There is **no list view and no table view** in the product (product decision 2026-09-30, BRS FR-11,
ADR-0004). This stage removes the temporary first-page table from Stages 01–02.

## Layout rules

```text
content width 1000 px, medium tiles          content width 2400 px, medium tiles
┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐            ┌────┐ ┌────┐ ┌────┐ ┌────┐ … 12 per row
│    │ │    │ │    │ │    │ │    │  ← spare   │    │ │    │ │    │ │    │
└────┘ └────┘ └────┘ └────┘ └────┘    space   └────┘ └────┘ └────┘ └────┘
name   name   name   name   name              name   name   name   name
┌────┐ ┌────┐ …                                ┌────┐ …
```

1. **Order:** left to right, then top to bottom, in the current sort order. Folders come first as folder tiles,
   followed by images and videos.
2. **Fixed tile size per size setting.** Tiles never stretch or shrink with the window. Values are in CSS pixels
   (sizes in `docs/viewer/UX-DESIGN.md`, "Tile view"):

   | Size | Tile width | Thumbnail box | Gap |
   |---|---|---|---|
   | Small | 120 | 120 × 120 | 8 |
   | Medium (default) | 180 | 180 × 180 | 12 |
   | Large | 260 | 260 × 260 | 16 |

3. **Tiles per row** = `max(1, floor((availableWidth + gap) / (tileWidth + gap)))`, where
   `availableWidth` = content-area width minus 16 px padding on each side. Rows are left-aligned, and spare space
   stays at the right edge. For example, with medium tiles: 1000 px → 5 per row, 1600 px → 8, 2400 px → 12.
4. **Tile anatomy:** each tile keeps a fixed square slot. Image and video previews preserve their aspect ratio
   (`object-fit: contain`, never cropped), leave unused space transparent, and draw selection/focus outlines to their
   fitted bounds. Folder covers fill the square; glyph fallbacks and loading placeholders keep a square frame. The tile
   height is fixed per size, so row heights are known without measuring.
5. **Resizing** the window or a pane recomputes tiles per row only when a tile boundary is crossed. The first visible
   item stays in view, so the scroll position is anchored to the item, not the pixel offset.
6. **Thumbnail resolution** follows the displayed size and screen density. The preview profile is the smallest one whose long
   edge is at least `thumbnail box × devicePixelRatio` (profile ids are the Stage 02 protocol names):

   | Size | 1× display | 2× display |
   |---|---|---|
   | Small (120) | `grid-sm` (192) | `grid-md` (384) |
   | Medium (180) | `grid-sm` (192) | `grid-md` (384) |
   | Large (260) | `grid-md` (384) | `grid-lg` (768) |

## Work

- tile layout: items-per-row calculation from width and tile size, fixed tile geometry, left alignment
- virtualization with `@tanstack/react-virtual`: only the lines of tiles in view plus a small overscan are mounted
  (ADR-0004); each virtual row is one line of tiles
- page loader on query sessions (Stage 01): fetch pages for the visible range ± one page, deduplicated, and
  abandoned when the range moves on
- infinite scrolling: the scrollbar reflects the full total from the start, and pages load as rows come into view
- visible-first thumbnail requests (Stage 02 lanes and epochs): priority 0 for visible tiles, 1 for overscan, 2 for
  the next screen in the scroll direction; nothing requested while scrolling fast
- tile size control (small / medium / large) in the content toolbar, persisted (localStorage until `library.db`
  exists in Stage 05)
- keyboard navigation: ←/→ move by one tile, ↑/↓ by one row (tiles per row), Home/End, Page Up/Down by
  visible rows, and Enter opens a folder
- selection model: single selection plus the focused item, stable across page loads and invalidations (by entry id).
  Multi-selection is Stage 05.
- tile states: loading placeholder, thumbnail, folder tile, video tile (poster from Stage 06), unsupported/corrupt
  tile, empty-folder state
- remove the temporary first-page table (`FirstItemsList`) and its bounded-page store

## Performance rules

- mounted tiles are proportional to the viewport, never to the folder size
- tiles are positioned by row transforms, with no layout reads in scroll handlers and no per-tile measurement
- one `preview.ensure` per visible-range change, never one call per tile
- page data lives outside React state; a tile subscribes to its own index/id only
- no per-tile animations, shadows or `backdrop-filter` on the scrolling surface (ADR-0014)
- do not decode non-visible images: `<img>` exists only for mounted tiles

## Performance checks

- Record scroll frame timing and long tasks for 10k and 100k folders at 1280, 1920 and 2560 px widths.
- Record the mounted tile count, pages fetched, and `preview.ensure` calls per second of scrolling.
- Record time from folder open to the first screen of tiles with thumbnails (cold and warm cache).

## Implementation

| Item | Where |
|---|---|
| Layout rules (fixed S/M/L metrics, tiles per row, fixed row height, profile per size × DPR) | `viewer/renderer/src/features/tiles/layout.ts` |
| Virtualized view (one ResizeObserver, rows re-render only when tiles per row change, scroll anchored to the first visible item, keyboard, Ctrl + wheel) | `components/tiles/TileView.tsx` |
| Tile (fixed box + name line, thumbnail / folder / video / unavailable glyphs, selection and focus outlines inside the box, tooltip with size and date) | `components/tiles/Tile.tsx`, `glyphs.tsx` |
| Page store outside React state (256-item pages, ± 1 page, LRU of 24 pages, ≤ 3 requests in flight, requests for scrolled-past pages never started, invalidation refetches only pages in view, expired session reopened in place) | `features/tiles/pageStore.ts` |
| Thumbnails: profile follows tile size × DPR; pages seed cached URLs; one `preview.ensure` per settled range (visible → overscan → next screen in scroll direction), lane `tiles` | `features/previews/thumbStore.ts` |
| Single selection by entry id, focus by index | `features/tiles/selectionStore.ts` |
| Tile size (S/M/L segmented control, persisted) | `components/tiles/TileSizeControl.tsx`, `features/tiles/layoutStore.ts` |
| Folder tiles open by id (`dir.openEntry`, new sidecar method; the renderer never builds paths) | `shared/sidecar/internal/app/library.go`, contracts, preload |
| Temporary Stage 01–02 table removed | — |

Also added: a main-process IPC call counter (`globalThis.__fastviewIpcCounts`, main only, not reachable from the renderer) that e2e tests use to count `preview.ensure` calls, and a debug-level log line per `preview.ensure` call in the sidecar.

## Found and fixed while measuring

1. **The first thumbnail was held back by ~230 ms in most runs.** The first `preview.ready` arrived 420–430 ms after the click instead of ~190 ms, and the timing was bimodal. Aligning the sidecar log with in-page timestamps showed the renderer sending `preview.ensure` 230 ms after the tiles mounted. Two **no-op programmatic scrolls on mount** caused it: the "back to top" reset (`scrollToOffset(0)` while already at 0) and scroll anchoring reacting to tiles per row jumping from the placeholder value 1 to the first real measurement. Each flags TanStack's `isScrolling` for ~150 ms, and the thumbnail request waits for scrolling to settle. Both now skip when there is nothing to scroll; the settle pause applies only after real user scrolling. An e2e test guards it (mount → first ready < 200 ms).
2. **The selection outline was clipped to its bottom edge**, because the tile's paint containment clips anything painted outside it. Outlines are drawn inside their frame (negative offset), and containment stays on.
3. **Page-store tests timed out** because of jsdom's ~4 ms clamping of nested `setTimeout(0)`. The runaway loop then leaked requests into the next test. The tests now drain microtasks instead.

## Tests

| Suite | Count | New in this stage |
|---|---|---|
| Renderer | 78 | layout rules (tiles per row at 1000 / 1600 / 2400 px, monotonic with width, fixed row heights, profile table), tile view (bounded tiles at 100k, 5 → 12 per row by width with a fixed 180 px box, small tiles 18 per row, one ensure per settled range with visible first, folders never requested, ←/→/↑/↓/End, Enter and double-click open folders, click selects exactly one, Ctrl + wheel, invalidation refetches only pages in view), page store (± 1 page, ≤ 3 in flight and skipped scrolled-past pages, LRU bound, stale and foreign invalidations ignored, expired session, old-session responses dropped), thumbnails on tiles, folder flow on tiles |
| Contracts / Desktop | 21 / 53 | `dir.openEntry` guard, validator and routing |
| Go | 15 packages | `dir.openEntry` golden frames (success and not found) |
| E2E | 25 | Stage 03 (8): tiles per row across window widths with a fixed box, 100k scroll stress at medium/1920 and small/2560, 10k scroll, first thumbnail without a settle delay, keyboard, double-click folder, tile size persisted. Stage 01/02 specs ported from the table to tiles |

## Benchmarks

Windows 11, i9-13900K, ~144 Hz display, production build. Results: `shared/bench/results/stage-03-2026-09-30-e2e-{tiles,previews,index}.jsonl` and `stage-03-2026-09-30-petter-startup.json`.

### Responsive layout (medium tiles)

| Window | Content width | Tiles per row |
|---|---|---|
| 1280 px | 705 px | 3 |
| 1920 px | 1345 px | 6 |
| 2560 px | 1985 px | 10 |

The thumbnail box stays at 180 px at every width.

### Scrolling (programmatic: 3 s fling at 400 px/frame, then 2 s at 12 px/frame; ≈ 177,000 px)

| Folder / tiles / window | p95 frame | Worst frame gap | Long tasks | Max mounted tiles | `preview.ensure` calls | `query.page` calls |
|---|---|---|---|---|---|---|
| 100k / medium / 1920 | 7 ms | 7 ms | 0 | 60 | 1 | 19 |
| 100k / small / 2560 | 7 ms | 7–14 ms | 0 | 180 | 1 | 69 |
| 10k / medium / 1920 | 7 ms | 7 ms | 0 | 60 | — | — |

Frame times sit at the display's refresh interval, so no frame was dropped by rendering. Thumbnail work during five seconds of scrolling is one request, sent when the scroll settled.

### Thumbnails on the tile view (150 × 1600×1200 images, 1440×900 window)

| Metric | Result |
|---|---|
| Click → tiles on screen | 105–132 ms |
| Tiles mounted → first `preview.ready` | 79–90 ms (was ~310 ms before the fix above) |
| Click → first thumbnail decoded on screen | ≈ 250 ms (Stage 02 table: ~300 ms) |
| Thumbnails generated for the first view | 40 (visible 24 + overscan + next screen), not the folder's 150 |
| After restart: all visible thumbnails on screen | 188–228 ms, 0 generated |

### Regressions checked

Startup: ready-to-show p50 233 ms, sidecar hello p50 117 ms, idle memory 337 MB (+39 MB over empty Electron), ping p95 0.2 ms, sidecar exit p95 11 ms. All budgets pass.

## Acceptance

- [x] a folder of 100,000 items scrolls continuously with no long tasks > 50 ms (0 long tasks; p95 frame at refresh rate)
- [x] mounted tile count stays bounded (≤ 180 observed; limit 300) at any window size and scroll position
- [x] widening the window increases tiles per row (3 → 6 → 10); tiles never change size
- [x] fast scrolling does not start unbounded thumbnail work (1 ensure call per 5 s scroll; queued work for scrolled-past tiles dropped by lane epochs)
- [x] keyboard navigation moves by tile and by row and keeps the focused tile visible

## Risks and follow-ups

- During a fling, rows show loading placeholders until their page arrives (by design: scrolling never waits for data). On slow disks this is more visible. Stage P05 can tune prefetch distance by scroll velocity.
- The benchmark scroll is programmatic; trackpad and wheel inertia on macOS and Linux are Stage P04 checks.
- Multi-selection, context menus and the preview pane are Stage 05 and later; Enter on an image does nothing until the Stage 04 viewer.
- A `fastview-thumb` image that fails twice shows the "unavailable" glyph until the folder is reopened.

## Exit checklist

- [x] implementation complete
- [x] tests complete
- [x] benchmark complete
- [x] performance regression reviewed
- [x] docs/ADR updated
