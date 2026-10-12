# Roadmap

The product has two apps in one shell, with a left app switcher rail and shared state between them (ADR-0025, ADR-0031,
`docs/shared/APP-SWITCHING.md`), and three tracks:

- **Viewer**: Panelyth, the photo and video viewer. Phases 0–8.6 are its delivery history; they also built most of
  the shared platform.
- **Platform**: shared work both apps need (P-stages).
- **Commander**: Panelyth Commander, the dual-panel file manager (C-stages).

Stage documents: `docs/viewer/stages/`, `docs/shared/stages/`, `docs/commander/stages/`. Status and gates:
`docs/DEVELOPMENT-STAGES.md`.

## Order across tracks

Only one stage is active at a time. Default order:

| # | Stage | Track | Why here |
|---|---|---|---|
| 1 | 08.6 — UI polish v2 | viewer | done 2026-10-05 |
| 2 | P01 — Multi-app platform: one shell, app views | platform | everything after it builds on app views and shared packages |
| 3 | P02 — Index scope: all entries, filtered per query | platform | the commander lists every file (implementation done 2026-10-12) |
| 4 | C00 — Commander foundation and the app switch | commander | done 2026-10-05 (with the minimal part of P01) |
| 5 | C01 — Panels and listing | commander | implemented: first useful version; folder and focus carried over on switch |
| 6 | C02 — Keyboard, marks and quick search | commander | implementation done: the Total Commander interaction model; selection carried over |
| 7 | C03 — Drives, tabs, hotlist, history, session | commander | implementation done (2026-10-06): navigation complete; shared bookmarks and recent |
| 8 | P03 — File-operation engine v2 | platform | implementation done (2026-10-06): queue, conflicts, throughput (the viewer gains speed too) |
| 9 | C04 — File operations | commander | implementation done (2026-10-06): F5 / F6 / F7 / F8 |
| 10 | C05 — Quick view, lister, open and edit | commander | implementation done (media routing added 2026-10-09) |
| 11 | C06 — Find files, branch view, quick filter | commander | implementation done (2026-10-07): session sources (ADR-0017) |
| 12 | C07 — Archives | commander | implementation done (2026-10-07): ADR-0030 accepted; archives as session sources |
| 13 | C08 — Compare, synchronize, checksums | commander | implementation done (2026-10-11): compares as session sources; sync and checksum jobs |
| 14 | C09 — Multi-rename, attributes, properties | commander | implementation done (2026-10-11): one rename engine, a previewed multi-rename with an undo, attribute jobs |
| 15 | C10 — Command line, tools, customization | commander | implementation done (2026-10-11): ADR-0027 accepted in full; the command line, user commands, toolbar, Thumbnails view, settings |
| 15a | C10.5 — Tab sets, folder tree, FTP connections, compare selected files | commander | implementation done (2026-10-12, owner request): ADR-0037 accepted with amendments; tab sets, the folder tree on shared code, FTP and FTPS as a session source with saved connections, compare for several files. P04 covers FTP and the tree on all three OSes |
| 16 | P04 — Cross-platform hardening | platform | active (in progress since 2026-10-08, taken up again 2026-10-12): packaging, CI, the Linux pass, paths, volumes, media tools, wheel input and the viewer's e2e specs done; the macOS items remain |
| 17 | P05 — Performance hardening | platform | both apps |
| 18 | P06 — Release engineering | platform | packages both app views with the commander enabled |
| 19 | C11 — Commander release | commander | completes the commander-specific release checks and acceptance |
| — | 12–16 — Image editor | viewer | planned, not scheduled (owner request 2026-10-11); proposed slot: after P04, before P05, so P05 profiles the editor too |

Packaged builds include the commander. Development can still run the viewer alone by leaving
`PANELYTH_COMMANDER` unset; C11 completes the commander-specific release checks after C08–C10.

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

### Phases 12–16 — Image editor (started 2026-10-12)

An **Edit** button on pictures opens a non-destructive editor (`docs/viewer/IMAGE-EDITOR.md`, ADR-0035, ADR-0036):

- **12** foundation (implementation done 2026-10-12): edit session and render pipeline, rotate / resize / canvas /
  DPI / crop, histogram, EXIF and file panels, undo/redo, safe save (copy, as, replace through trash)
- **13** color (implementation done 2026-10-12): lighting, colors, levels, curves, sharpen/blur, noise, replace
  color and swap channels, reduce and count colors, grayscale, sepia, negative, twelve looks
- **14** effects (implementation done 2026-10-12): border, frame mask, watermark (text with tokens, or a picked
  picture), bump map, sketch, oil painting, lens, obscure
- **15** draw and retouch (implementation done 2026-10-12): draw (brush, eraser, shapes, text, fill), clone, heal,
  red-eye with an interactive Auto
- **16** batch (implementation done 2026-10-12): recipes built on samples of a selection, the `edit` job with
  bounded workers, output rules (folder, names, conflicts, replace through the trash), a plan before Run, saved and
  built-in recipes, undo of a batch. Reports and recipe files are open

### Phases 9–11 — moved

Cross-platform hardening, performance hardening and release apply to both apps, so they became platform stages
P04–P06 (2026-10-05). Viewer numbers 09–11 are retired; the first new viewer stage is 12 (the image editor, above).

## Platform track

### P01 — Multi-app platform: one shell, app views, shared packages (implementation done 2026-10-12)

The window hosts one app view per app with its own capability profile; `src/shared/ui` and
`src/shared/renderer-core` are extracted (the bridge core, the settings and sidecar store factories, menus, icons and
the notice on 2026-10-12), with the package boundaries as lint rules. A hidden viewer no longer refetches its folder.
The folder layout (`src/shared/`, `src/viewer/`, `src/commander/`) was done first. The viewer is unchanged. Open: the
owner's word on bundles that grew by under 0.1 %, and the hidden viewer's work on a window resize.

### P02 — Index scope: all entries, filtered per query (implementation done 2026-10-12)

The shared index stores every entry with attributes; the viewer queries the `media` scope and sees what it sees today,
the commander queries `all` (ADR-0026, accepted with amendments). Sessions are budgeted per app (viewer 8, commander
24) and the sidecar watches the folders of the app on screen only; a hidden app's folders are listed again when it
is shown. Open: the owner's word on a cold scan of a 90 %-media folder that is 12–17 % slower (10 % allowed), and
the intermittent SQLite driver fault, which ended 3 of 12 runs of the index benchmark.

### P03 — File-operation engine v2 (implementation done 2026-10-06)

Queue lanes, per-item conflict questions, pause and resume, speed and ETA, OS fast paths, verification (ADR-0029).

### P04 — Cross-platform hardening (formerly Phase 9; in progress since 2026-10-08)

Packaged builds of both apps on Windows, macOS and Linux; path, volume, trash, watching and media capability tests.
Done by 2026-10-12 on Windows and Linux: packaging and CI (ADR-0032), path keys by platform and names Windows
rewrites (ADR-0015, amended), volumes, ffmpeg and 7-Zip discovery per OS, wheel input that steps by distance, the
Linux trash, and the viewer's e2e specs. Open: everything that needs a Mac ("Put Back", the volume list, a real
trackpad), budgets on Linux and macOS, and the commander's four e2e tests that predate the document window.

### P05 — Performance hardening (formerly Phase 10)

Profile real use of both apps; tune scanner, SQLite, decoder, cache, IPC, renderers and batch throughput.

### P06 — Release engineering (formerly Phase 11)

Signing, notarization, update strategy, installers, migrations, notices and release documentation for the product
(both apps in one shell, with the commander enabled in packaged builds).

## Commander track

### C00 — Foundation and the app switch ✅ (2026-10-05)

The commander as the second app view: dual-panel shell, function-key bar; app switching by icon and Ctrl/Cmd+Shift+M in both
apps; shared appearance.

### C01 — Panels and listing (implementation done 2026-10-05; gate open)

Two panels with the Full view: every entry, columns, sorting, path bar, status line, hidden-files toggle. Switching
carries the folder and the entry under the cursor over.

### C02 — Keyboard, marks and quick search (implementation done 2026-10-05)

Cursor and marks, marking by mask, quick search, swap panels, history, folder sizes. Switching carries the selection
over.

### C03 — Drives, tabs, hotlist, history and session (implementation done 2026-10-06)

Drive bar and menus, folder tabs, directory hotlist (= the shared bookmarks), shared recent locations, history, Brief
view, full session restore.

### C04 — File operations (implementation done 2026-10-06)

F5 copy, F6 move, rename, new folder, trash and permanent delete, queue panel, conflict dialog, drag and drop.

### C05 — Quick view, lister, open and edit (implementation updated 2026-10-09)

Quick view, F3 lister (text, hex, images, video), F4 editor, opening files with confirmation for programs. Enter or
double-click on media opens the shared media overlay over Commander and reveals the same Commander session when
closed; Settings can choose the system default app instead.

### C06 — Find files, branch view and quick filter (implementation done 2026-10-07)

Find by name, content, size, date and attributes; feed to panel; flat subtree listing; quick filter.

### C07 — Archives (implementation done 2026-10-07)

zip and tar(.gz) as folders; pack, unpack, test; optional 7-Zip.

### C08 — Compare, synchronize and checksums (implementation done 2026-10-11)

Compare directories (Shift+F2); synchronize two trees from a result table with a direction per row, as one job that
re-checks every entry; compare files by content (a text diff, or identical-or-not); create and verify checksum files.

### C09 — Multi-rename, attributes and properties (implementation done 2026-10-11)

Multi-rename (Ctrl+M) with Total Commander's masks, search and replace, case and a counter, previewed by the engine
that applies it, as one job with one level of undo; attributes or permissions and dates for the marked entries,
optionally below folders; folder sizes written in batches; properties (Alt+Enter) on rows shared with the viewer.

### C10 — Command line, tools and customization (implementation done 2026-10-11)

A command line that runs a typed line through the OS shell in the active panel's folder, on Enter only, with a
history and `cd`; user commands with placeholders, quoted by main and started from a customizable toolbar, a key or
the menu of files; a Thumbnails view on the tile parts shared with the viewer; settings in five sections. The
security review of `shell.run` and user commands is recorded with no open findings (ADR-0027 accepted in full).

### C10.5 — Tab sets, folder tree, FTP connections, compare selected files (implementation done 2026-10-12)

The tab bar always shown with a "+" button, rename, duplicate and reopen, and named tab sets that can be saved and
opened again; a folder tree beside the panels (one that follows the active panel, or one per panel) on the viewer's
tree moved to shared code; FTP and FTPS servers as panel locations with a connection manager, saved connections,
passwords encrypted by the OS store, and transfers as queue jobs (ADR-0037, accepted with amendments); Compare by
content for any number of marked files with a result list, and changes marked inside a line. The security review of
the remote path is recorded with no open blocking finding. Whether FTP is on in the first release is the owner's to
confirm before C11.

### C11 — Commander release

Verification and documentation of Panelyth Commander 1.0, and the product release that turns it on for users.
