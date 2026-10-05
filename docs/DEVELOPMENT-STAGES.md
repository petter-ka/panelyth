# Development Stages

Only one stage is active at a time, across all tracks. The order across tracks is in `docs/ROADMAP.md`.

## Tracks and stage IDs

| Track | Stage IDs | Stage documents | Bench result IDs |
|---|---|---|---|
| Viewer | `00`…`08.6` (history and active); next new stage `12` | `docs/viewer/stages/` | `stage-03-…`, `stage-08.6-…` |
| Platform | `P01`…`P06` | `docs/shared/stages/` | `stage-P01-…` |
| Commander | `C00`…`C11` | `docs/commander/stages/` | `stage-C00-…` |

- The viewer stages 00–08.6 also built most of the shared platform; their records stay in the viewer track.
- The viewer's planned Stages 09, 10 and 11 became P04, P05 and P06 (2026-10-05, ADR-0025). Viewer numbers 09–11 are
  retired.
- New stage documents start from `docs/STAGE-TEMPLATE.md`.

## Stage gates

A stage is complete only when:

- implementation exists
- automated tests exist
- failure paths are covered
- relevant benchmark passes
- docs/ADR updated
- no known performance regression violates the current budget, in either app once the commander exists

## Sequence

### Viewer

| Stage | Name | Depends on | Status |
|---|---|---|---|
| 00 | Foundation | — | done |
| 01 | File index | 00 | done |
| 02 | Thumbnail + poster pipeline and cache | 01 | done |
| 03 | Virtualized tile view | 02 | done |
| 04 | Image viewer | 03 | done |
| 05 | Filesystem UX + navigation + search + sort | 04 | done |
| 06 | Video playback + media preview | 05 | done |
| 07 | Batch operations + metadata foundations | 06 | done |
| 08 | Product polish + extensibility foundations | 07 | implementation done; tests pending |
| 08.5 | Viewer settings + interaction polish | 08 | implementation done; tests pending |
| 08.6 | UI polish v2 (folder covers, …) | 08.5 | **active** |

### Platform

| Stage | Name | Depends on | Status |
|---|---|---|---|
| P01 | Multi-app platform: one shell, app views, shared packages | 08.6 | planned |
| P02 | Index scope: all entries, filtered per query | P01 | planned |
| P03 | File-operation engine v2 | P02 | planned |
| P04 | Cross-platform hardening (formerly 09) | P03 and the app stages in scope | planned |
| P05 | Performance hardening (formerly 10) | P04 | planned |
| P06 | Release engineering (formerly 11) | P05 | planned |

### Commander

| Stage | Name | Depends on | Status |
|---|---|---|---|
| C00 | Foundation and the app switch | P01 | planned |
| C01 | Panels and listing | C00, P02 | planned |
| C02 | Keyboard, marks and quick search | C01 | planned |
| C03 | Drives, tabs, hotlist, history and session | C02 | planned |
| C04 | File operations | C03, P03 | planned |
| C05 | Quick view, lister, open and edit | C04 | planned |
| C06 | Find files, branch view and quick filter | C05 | planned |
| C07 | Archives | C06 | planned |
| C08 | Compare, synchronize and checksums | C07 | planned |
| C09 | Multi-rename, attributes and properties | C08 | planned |
| C10 | Command line, tools and customization | C09 | planned |
| C11 | Commander release | C10, P04, P05, P06 | planned |

## Completed stages

| Stage | Completed | Record |
|---|---|---|
| 00 — Foundation | 2026-09-30 | `docs/viewer/stages/00-foundation.md` |
| 01 — File index | 2026-09-30 | `docs/viewer/stages/01-file-index.md`, `bench/results/stage-01-*` |
| 02 — Thumbnail pipeline + cache | 2026-09-30 | `docs/viewer/stages/02-thumbnail-pipeline.md`, `bench/results/stage-02-*` |
| 03 — Virtualized tile view | 2026-09-30 | `docs/viewer/stages/03-tile-view.md`, `bench/results/stage-03-*` |
| 04 — Image viewer | 2026-09-30 | `docs/viewer/stages/04-viewer.md`, `bench/results/stage-04-*` |
| 05 — Filesystem UX + navigation + search + sort | 2026-09-30 | `docs/viewer/stages/05-filesystem-ux.md`, `bench/results/stage-05-*` |
| 06 — Video playback + media preview | 2026-10-01 | `docs/viewer/stages/06-media-playback.md`, `bench/results/stage-06-*` |
| 07 — Batch operations + metadata foundations | 2026-10-01 | `docs/viewer/stages/07-batch-and-metadata.md`, `bench/results/stage-07-*` |

## Active stage

`08.6 — UI polish v2` (`docs/viewer/stages/08.6-ui-polish-v2.md`), started 2026-10-05. Folder covers are implemented,
tested and measured end to end, including a 2,000-folder scroll e2e (ADR-0024). Also done: double-click on a video
plays it full screen, Ctrl/Cmd+C copies a picture to the OS clipboard (decoded in Go), richer tile and viewer context
menus, and additive Ctrl/Cmd+Shift selection. More polish items will be added to the stage scope.

Next: **P01 — Multi-app platform: one shell, app views, shared packages**
(`docs/shared/stages/P01-multi-app-platform.md`), once 08.6 is closed.

The Stage 08 and 08.5 gates are still open: their implementation is done (2026-10-01), but their automated coverage
was never added (`docs/viewer/stages/08-product-polish.md`, `docs/viewer/stages/08.5-viewer-settings.md`).

Carried over from Stage 07: the intermittent modernc SQLite heap fault, which reproduces outside FastView and needs a
driver/hardware decision (`docs/viewer/stages/07-batch-and-metadata.md`).

Carried over: idle memory is still near the budget edge (Stage 08: 52.9 MB over the Electron floor, budget 60). Cold
scans are 12–15 % slower since Stage 05. Both are to be re-measured in Stage P05. Shipping an LGPL ffmpeg/ffprobe build
is a Stage P06 packaging task (ADR-0018).
