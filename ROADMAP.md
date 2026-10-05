# Roadmap

## Phase 0 — Foundation ✅ (2026-09-30)

Electron + React + Go sidecar + secure IPC + monorepo + benchmark harness.

## Phase 1 — Indexing ✅ (2026-09-30; drives moved to Phase 5, see ADR-0015)

Folders, drives, image/video detection, SQLite index, incremental paging, cancellation and file-watch foundation.

## Phase 2 — Preview pipeline ✅ (2026-09-30; image thumbnails; video posters arrived in Phase 6 with ADR-0018)

Image thumbnails + video posters, persistent disk cache, cache versioning, coalescing, priority queue, cleanup.

## Phase 3 — Virtualized tile view ✅ (2026-09-30)

Tile view: tiles left to right, wrapping, fixed size (small/medium/large) with more tiles per row on wider
windows; infinite paging; visible-range thumbnail priority. No list or table views (ADR-0004).

## Phase 4 — Image viewer ✅ (2026-09-30)

Fit, 1:1, zoom, pan, keyboard traversal.

## Phase 5 — Filesystem UX ✅ (2026-09-30)

Three resizable panes, drive sidebar, lazy folder tree, quick access, bookmarks, recent, back/forward/up, breadcrumbs, search, recursive search, filters, multi-key sorting, context menus and properties.

## Phase 6 — Media playback ✅ (2026-10-01)

Local video element integration, poster cache, seek, volume, mute, playback state and codec/capability handling.

## Phase 7 — Batch + metadata ✅ (2026-10-01)

Copy/move/delete/rename, progress/cancellation, favorites, tags, ratings and metadata foundations.

## Phase 8 — Product polish

Tailwind + shadcn/ui refinement, dark/light theme, accessibility, subtle effects, custom shortcuts. (Dark/light theme
shipped in Stage 00 and the persisted workspace layout in Stage 05; Phase 8 refines them.)

## Phase 8.5 — Viewer settings + interaction polish

Tabbed settings, persisted startup/viewer preferences, Escape exit behavior and configurable image wheel navigation.

## Phase 8.6 — UI polish v2

Richer browsing without scroll cost. Folder tiles show up to four pictures or video posters from inside the folder
(ADR-0024), with more polish items to follow.

## Phase 9 — Cross-platform hardening

Windows, macOS, Linux packaged builds; path/volume/cache tests; native codec verification.

## Phase 10 — Performance hardening

Profile real use, tune scanner/SQLite/decoder/cache, reduce IPC, optimize renderer and batch throughput.

## Phase 11 — Release

Signing, notarization where required, update strategy, smoke tests and release documentation.
