# Roadmap

## Phase 0 — Foundation

Electron + React + Go sidecar + secure IPC + monorepo + benchmark harness.

## Phase 1 — Indexing

Folders, drives, image/video detection, SQLite index, incremental paging, cancellation and file-watch foundation.

## Phase 2 — Preview pipeline

Image thumbnails + video posters, persistent disk cache, cache versioning, coalescing, priority queue, cleanup.

## Phase 3 — Virtualized browsing

Large/medium/small thumbnails, compact/detailed list, infinite paging, visible-range prefetch.

## Phase 4 — Image viewer

Fit, 1:1, zoom, pan, keyboard traversal.

## Phase 5 — Filesystem UX

Three resizable panes, drive sidebar, lazy folder tree, quick access, bookmarks, recent, back/forward/up, breadcrumbs, search, recursive search, filters, multi-key sorting, context menus and properties.

## Phase 6 — Media playback

Local video element integration, poster cache, seek, volume, mute, playback state and codec/capability handling.

## Phase 7 — Batch + metadata

Copy/move/delete/rename, progress/cancellation, favorites, tags, ratings and metadata foundations.

## Phase 8 — Product polish

Tailwind + shadcn/ui refinement, dark/light theme, accessibility, subtle effects, custom shortcuts, persisted workspace layout.

## Phase 9 — Cross-platform hardening

Windows, macOS, Linux packaged builds; path/volume/cache tests; native codec verification.

## Phase 10 — Performance hardening

Profile real use, tune scanner/SQLite/decoder/cache, reduce IPC, optimize renderer and batch throughput.

## Phase 11 — Release

Signing, notarization where required, update strategy, smoke tests and release documentation.
