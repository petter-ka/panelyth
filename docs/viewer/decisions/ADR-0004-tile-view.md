# ADR-0004 — Virtualized Tile View (tiles only)

## Status

Accepted. **Amended 2026-09-30** by product decision: the content area is a tile view only, and list and table views
are removed from the product.

Scope (2026-10-05): the viewer only. The commander's detailed and brief lists are decided in ADR-0028.

## Context

The product needs to browse folders with hundreds of thousands of items while keeping DOM and React work
bounded. The product owner specified the layout: items are shown as **tiles next to each other, left to right,
wrapping to the next line**. The layout is **responsive**: more tiles fit in a row on wider windows and higher
resolutions. The owner explicitly does **not** want a table or list presentation, and tiles do not stretch to fill a row.

## Decision

- **One presentation: the tile view.** Every folder, image and video is a tile. There is no compact list, detailed list or
  table mode (BRS FR-11).
- **Fixed tile size per size setting** (small 120, medium 180, large 260 CSS px; `docs/viewer/stages/03-tile-view.md`).
  Tiles never grow or shrink with the window.
- **Responsive tiles per row:** `max(1, floor((availableWidth + gap) / (tileWidth + gap)))`. Rows are
  left-aligned, and spare width stays at the right edge.
- **Virtualization:** `@tanstack/react-virtual` virtualizes vertically; each virtual row is one line of tiles. Tile
  and row heights are fixed per size, so no image is ever measured.
- Resizing recomputes tiles per row only when a tile boundary is crossed, and anchors the scroll position to the first
  visible item.

## Implementation

Implemented in Stage 03 (`docs/viewer/stages/03-tile-view.md`): `apps/renderer/src/features/tiles/*` and `components/tiles/*`.

## Why

- Fixed geometry makes row heights a constant: no measuring, cheap scrolling, and a stable scroll position.
- Row virtualization keeps the mounted DOM proportional to the viewport at any folder size.
- Fixed-size tiles match the requested behavior: extra width means more items per row, not bigger items.

## Consequences

- A change in tiles per row changes the row count; the virtualizer's count is recomputed and the first visible item
  is kept in view.
- Sort, search, filter and properties never rely on columns. Details appear in tile tooltips and the preview/properties pane.
- The temporary first-page table from Stages 01–02 is removed in Stage 03.
- Keyboard navigation is two-dimensional: ←/→ by tile, ↑/↓ by tiles per row.

## Rejected

### List and table views (compact list, detailed list)

Removed by product decision (2026-09-30). Previously planned for Stage 05.

### Stretching tiles to fill each row

Rejected in favor of fixed-size tiles, so a wider window shows more items, not larger ones.

### CSS-only lazy rendering (`content-visibility`, native lazy images)

Not enough control over DOM size for very large folders.

### Masonry / Pinterest layout

Variable heights need measurement and make scroll positions unstable.
