# Development Stages

Only one stage is active at a time.

## Stage gates

A stage is complete only when:

- implementation exists
- automated tests exist
- failure paths are covered
- relevant benchmark passes
- docs/ADR updated
- no known performance regression violates the current budget

## Sequence

| Stage | Name | Depends on |
|---|---|---|
| 00 | Foundation | — |
| 01 | File index | 00 |
| 02 | Thumbnail + poster pipeline and cache | 01 |
| 03 | Virtualized tile view | 02 |
| 04 | Image viewer | 03 |
| 05 | Filesystem UX + navigation + search + sort | 04 |
| 06 | Video playback + media preview | 05 |
| 07 | Batch operations + metadata foundations | 06 |
| 08 | Product polish + extensibility foundations | 07 |
| 08.5 | Viewer settings + interaction polish | 08 |
| 08.6 | UI polish v2 (folder covers, …) | 08.5 |
| 09 | Cross-platform hardening | 08.6 |
| 10 | Performance hardening | 09 |
| 11 | Release | 10 |

## Completed stages

| Stage | Completed | Record |
|---|---|---|
| 00 — Foundation | 2026-09-30 | `stages/00-foundation.md` |
| 01 — File index | 2026-09-30 | `stages/01-file-index.md`, `bench/results/stage-01-*` |
| 02 — Thumbnail pipeline + cache | 2026-09-30 | `stages/02-thumbnail-pipeline.md`, `bench/results/stage-02-*` |
| 03 — Virtualized tile view | 2026-09-30 | `stages/03-tile-view.md`, `bench/results/stage-03-*` |
| 04 — Image viewer | 2026-09-30 | `stages/04-viewer.md`, `bench/results/stage-04-*` |
| 05 — Filesystem UX + navigation + search + sort | 2026-09-30 | `stages/05-filesystem-ux.md`, `bench/results/stage-05-*` |
| 06 — Video playback + media preview | 2026-10-01 | `stages/06-media-playback.md`, `bench/results/stage-06-*` |
| 07 — Batch operations + metadata foundations | 2026-10-01 | `stages/07-batch-and-metadata.md`, `bench/results/stage-07-*` |

## Active stage

`08.6 — UI polish v2` (`stages/08.6-ui-polish-v2.md`), started 2026-10-05. Folder covers are implemented, tested and
measured end to end, including a 2,000-folder scroll e2e (ADR-0024). Also done: double-click on a video plays it full
screen, Ctrl/Cmd+C copies a picture to the OS clipboard (decoded in Go), richer tile and viewer context menus, and
additive Ctrl/Cmd+Shift selection. More polish items will be added to the stage scope.

The Stage 08.5 gate is still open: its implementation is done (2026-10-01), but its automated coverage was never
added (`stages/08.5-viewer-settings.md`).

Carried over from Stage 07: the intermittent modernc SQLite heap fault, which reproduces outside FastView and needs a
driver/hardware decision (`stages/07-batch-and-metadata.md`).

Carried over: idle memory is still near the budget edge (Stage 08: 52.9 MB over the Electron floor, budget 60). Cold
scans are 12–15 % slower since Stage 05. Both are to be re-measured in Stage 10. Shipping an LGPL ffmpeg/ffprobe build is a
Stage 11 packaging task (ADR-0018).
