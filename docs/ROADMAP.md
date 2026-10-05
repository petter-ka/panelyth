# Roadmap

The product has two apps in one shell, with a switch icon and shared state between them (ADR-0025, ADR-0031,
`docs/shared/APP-SWITCHING.md`), and three tracks:

- **Viewer**: FastView, the photo and video viewer. Phases 0–8.6 are its delivery history; they also built most of
  the shared platform.
- **Platform**: shared work both apps need (P-stages).
- **Commander**: FastView Commander, the dual-panel file manager (C-stages).

Stage documents: `docs/viewer/stages/`, `docs/shared/stages/`, `docs/commander/stages/`. Status and gates:
`docs/DEVELOPMENT-STAGES.md`.

## Order across tracks

Only one stage is active at a time. Default order:

| # | Stage | Track | Why here |
|---|---|---|---|
| 1 | 08.6 — UI polish v2 | viewer | done 2026-10-05 |
| 2 | P01 — Multi-app platform: one shell, app views | platform | everything after it builds on app views and shared packages |
| 3 | P02 — Index scope: all entries, filtered per query | platform | the commander lists every file |
| 4 | C00 — Commander foundation and the app switch | commander | active (started with the minimal part of P01) |
| 5 | C01 — Panels and listing | commander | first useful version; folder and focus carried over on switch |
| 6 | C02 — Keyboard, marks and quick search | commander | the Total Commander interaction model; selection carried over |
| 7 | C03 — Drives, tabs, hotlist, history, session | commander | navigation complete; shared bookmarks and recent |
| 8 | P03 — File-operation engine v2 | platform | queue, conflicts, throughput (the viewer gains speed too) |
| 9 | C04 — File operations | commander | F5 / F6 / F7 / F8 |
| 10 | C05 — Quick view, lister, open and edit | commander | shared media components |
| 11 | C06 — Find files, branch view, quick filter | commander | |
| 12 | C07 — Archives | commander | |
| 13 | C08 — Compare, synchronize, checksums | commander | |
| 14 | C09 — Multi-rename, attributes, properties | commander | |
| 15 | C10 — Command line, tools, customization | commander | the most sensitive feature last |
| 16 | P04 — Cross-platform hardening | platform | both apps |
| 17 | P05 — Performance hardening | platform | both apps |
| 18 | P06 — Release engineering | platform | ships the product with the commander hidden |
| 19 | C11 — Commander release | commander | turns the commander on for users |

**Viewer-first alternative:** to release the viewer before the commander is ready, run P04–P06 right after P01 and
ship the shell with the commander hidden (feature flag), then continue with P02 and the commander. C11 then repeats
the commander-specific P04–P06 checks and turns the flag on.

## Viewer track

### Phase 0 — Foundation ✅ (2026-09-30)

Electron + React + Go sidecar + secure IPC + monorepo + benchmark harness.

### Phase 1 — Indexing ✅ (2026-09-30; drives moved to Phase 5, see ADR-0015)

Folders, drives, image/video detection, SQLite index, incremental paging, cancellation and file-watch foundation.

### Phase 2 — Preview pipeline ✅ (2026-09-30; image thumbnails; video posters arrived in Phase 6 with ADR-0018)

Image thumbnails + video posters, persistent disk cache, cache versioning, coalescing, priority queue, cleanup.

### Phase 3 — Virtualized tile view ✅ (2026-09-30)

Tile view: tiles left to right, wrapping, fixed size (small/medium/large) with more tiles per row on wider
windows; infinite paging; visible-range thumbnail priority. No list or table views (ADR-0004).

### Phase 4 — Image viewer ✅ (2026-09-30)

Fit, 1:1, zoom, pan, keyboard traversal.

### Phase 5 — Filesystem UX ✅ (2026-09-30)

Three resizable panes, drive sidebar, lazy folder tree, quick access, bookmarks, recent, back/forward/up, breadcrumbs,
search, recursive search, filters, multi-key sorting, context menus and properties.

### Phase 6 — Media playback ✅ (2026-10-01)

Local video element integration, poster cache, seek, volume, mute, playback state and codec/capability handling.

### Phase 7 — Batch + metadata ✅ (2026-10-01)

Copy/move/delete/rename, progress/cancellation, favorites, tags, ratings and metadata foundations.

### Phase 8 — Product polish

Tailwind + shadcn/ui refinement, dark/light theme, accessibility, subtle effects, custom shortcuts. (Dark/light theme
shipped in Stage 00 and the persisted workspace layout in Stage 05; Phase 8 refines them.)

### Phase 8.5 — Viewer settings + interaction polish

Tabbed settings, persisted startup/viewer preferences, Escape exit behavior and configurable image wheel navigation.

### Phase 8.6 — UI polish v2

Richer browsing without scroll cost. Folder tiles show up to four pictures or video posters from inside the folder
(ADR-0024); video double-click plays full screen; pictures copy to the OS clipboard; additive Shift selection.

### Phases 9–11 — moved

Cross-platform hardening, performance hardening and release apply to both apps, so they became platform stages
P04–P06 (2026-10-05). Viewer numbers 09–11 are retired; the next viewer stage is 12.

## Platform track

### P01 — Multi-app platform: one shell, app views, shared packages

The window hosts one app view per app with its own capability profile; `shared/ui` and
`shared/renderer-core` are extracted. The folder layout (`shared/`, `viewer/`, `commander/`) is already done.
The viewer is unchanged.

### P02 — Index scope: all entries, filtered per query

The shared index stores every entry with attributes; the viewer queries the `media` scope and sees what it sees today,
the commander queries `all` (ADR-0026).

### P03 — File-operation engine v2

Queue lanes, per-item conflict questions, pause and resume, speed and ETA, OS fast paths, verification (ADR-0029).

### P04 — Cross-platform hardening (formerly Phase 9)

Packaged builds of both apps on Windows, macOS and Linux; path, volume, trash, watching and media capability tests.

### P05 — Performance hardening (formerly Phase 10)

Profile real use of both apps; tune scanner, SQLite, decoder, cache, IPC, renderers and batch throughput.

### P06 — Release engineering (formerly Phase 11)

Signing, notarization, update strategy, installers, migrations, notices and release documentation for the product
(both apps in one shell; the commander behind a feature flag).

## Commander track

### C00 — Foundation and the app switch

The commander as the second app view: dual-panel shell, function-key bar; the switch icon and Ctrl/Cmd+Shift+M in both
apps; shared appearance.

### C01 — Panels and listing

Two panels with the Full view: every entry, columns, sorting, path bar, status line, hidden-files toggle. Switching
carries the folder and the entry under the cursor over.

### C02 — Keyboard, marks and quick search

Cursor and marks, marking by mask, quick search, swap panels, history, folder sizes. Switching carries the selection
over.

### C03 — Drives, tabs, hotlist, history and session

Drive bar and menus, folder tabs, directory hotlist (= the shared bookmarks), shared recent locations, history, Brief
view, full session restore.

### C04 — File operations

F5 copy, F6 move, rename, new folder, trash and permanent delete, queue panel, conflict dialog, drag and drop.

### C05 — Quick view, lister, open and edit

Quick view, F3 lister (text, hex, images, video), F4 editor, opening files with confirmation for programs.

### C06 — Find files, branch view and quick filter

Find by name, content, size, date and attributes; feed to panel; flat subtree listing; quick filter.

### C07 — Archives

zip and tar(.gz) as folders; pack, unpack, test; optional 7-Zip.

### C08 — Compare, synchronize and checksums

Compare and synchronize directories, compare files, checksums.

### C09 — Multi-rename, attributes and properties

Multi-rename tool with preview and undo; attributes and timestamps; folder sizes; properties.

### C10 — Command line, tools and customization

Command line, user commands, toolbar, thumbnails view, complete settings.

### C11 — Commander release

Verification and documentation of FastView Commander 1.0, and the product release that turns it on for users.
