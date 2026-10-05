# Stage 05 — Filesystem UX + Navigation + Search + Sort

Status: **Complete** (2026-09-30)

This file merges the former `05-navigation-search.md`, which duplicated this plan (ARCHITECTURE-ANALYSIS C7).

## Objective

Turn the tile browser into a desktop power-user workspace: a resizable three-pane layout, filesystem
navigation, index-backed search, filters and sorting, multi-selection, context menus and properties. All of it is
keyboard-operable and lazy on huge filesystems.

## Decisions applied

- **`library.db`** (ADR-0016) now exists in the config directory. It holds settings (workspace), bookmarks
  (at most 500) and recent folders (the newest 50), with forward-only versioned migrations, and is never discarded.
  It opens in the background, so the sidecar handshake doesn't wait for it; user-data methods wait for it (tens of
  ms at most). If it can't be opened, browsing still works and the error is logged.
- **Workspace persistence:** `library.db` is the source of truth. A `localStorage` mirror lets the first paint use the
  saved layout. The mirror is written on every change; `library.db` is written debounced (300 ms) and flushed on
  `pagehide`. Each copy carries `at` (last change), and on startup the newer copy wins, so a change made just before
  quitting is never lost. The theme stays in `localStorage` only.
- **The folder tree reads the filesystem, not the index:** `fs.listDirs(path)` returns immediate subfolders in natural
  order (at most 20,000). It runs a bounded "has subfolders" probe: the first 512 children, 8 workers, at most 256 entries
  read per child. Unprobed children report "may have subfolders". Hidden and system folders and symlinks are skipped
  with the same rule as the scanner (`internal/fsx`).
- **Breadcrumbs come from the sidecar** (`dir.open` returns `crumbs`); the renderer never parses OS paths.
- **Selection** follows ADR-0017: `{ queryId, version, ranges, include, exclude }`, resolved in Go. Each session keeps
  the id list of its previous version, so a descriptor made just before a refresh still resolves exactly. On
  `query.invalidated` the renderer calls `selection.rebase`, which maps the selection onto the new order as ranges.
  A descriptor that is two versions behind is rejected (`INVALID_ARGUMENT`), never misapplied. Select-all in a 100k
  folder is one range.
- **UI primitives:** Radix UI (context menu, dropdown menu, dialog) and `react-resizable-panels` v4, as token-styled
  wrappers in `components/ui/` (ADR-0014).
- **Created time** is stored as `btime_ns` (schema v3, which recreates `index.db`) on Windows and macOS. Linux reports it
  as unavailable (sorts as 0; properties shows "Not available"). **Dimensions** sort by pixel count, using the size
  recorded when a preview was generated. Unknown sizes sort last in both directions until metadata extraction arrives
  (Stage 07).
- **Search** matches file names. Every whitespace-separated term must occur, case-insensitively, against a stored
  NFC-lowercased `name_fold`. `%`, `_` and `\` are literal. It covers the current folder, or the subtree with
  "Include subfolders".

## Scope delivered

| Stage plan item | Implementation |
|---|---|
| three resizable panes, min/max, collapse, reset, persisted | `AppShell` on `react-resizable-panels`: sidebar 180–480 px, content ≥ 360 px, preview 220 px–50 %. Side panes keep their pixel width when the window resizes; toolbar buttons collapse and restore them; double-clicking a divider resets it. The layout is saved when the pointer is released, never per pixel |
| sidebar: drives, quick access, bookmarks, recent, lazy tree | One virtualized list (`SidebarPane`): Quick access (`places.list`: Home, Desktop, Documents, Downloads, Pictures, Videos that exist), Bookmarks, Recent (8 shown), Folders (volumes from `fs.volumes`: drive letters with labels on Windows, `/Volumes` on macOS, `/` plus `/media`, `/mnt`, `/run/media` on Linux). Children are listed on expand, one level at a time. The open folder is revealed: ancestors expand, the node is marked and scrolled into view |
| breadcrumb, back / forward / up / refresh | Nav bar: back/forward history (100 entries), up, refresh, and a breadcrumb showing the last four crumbs with earlier ones in a "…" menu. F5 re-lists the folder and keeps the session, so search, filters, selection and scroll stay |
| search (folder / subtree, debounced, count) | Search box (200 ms debounce, Enter commits now, Esc clears, Ctrl+F focuses). The summary line reads "N results for “x”", also while indexing |
| filters: kind chips + extensions with counts | Folders / Images / Videos chips and a "File types" menu. Counts come from `query.facets`, which uses the scope and search but ignores the filters, and refreshes at most once a second while scanning. "Clear" resets search and filters |
| multi-key sort | Sort menu: primary field and order, "Then by" field and order. Order labels say what they mean ("Newest first", "Largest first", "A to Z"). Folders always come first. Also available from the empty-area context menu |
| tile size, sort, pane layout persisted | Workspace persistence above; the Stage 03 `fastview.tileSize` key is migrated |
| multi-selection | Click, Ctrl/Cmd+click, Shift+click, Ctrl+Shift+click; Shift+arrows, Ctrl+arrows (move focus only) + Ctrl+Space; Ctrl/Cmd+A; Esc; clicking empty space clears. The status bar shows "N selected, size" (the count is exact locally; the size comes from `selection.info`, debounced 150 ms) |
| context menus limited to working actions | Tile: Open, Open with default app, Show in file manager, Copy path(s), Select all, Properties. Empty area: Sort by ▸, Tile size ▸, Refresh, Select all, Folder properties. Tree/sidebar: Open, Show in file manager, Copy path, Add/Remove bookmark, Refresh. No copy/move/delete/rename (Stage 07) |
| properties | Dialog (Alt+Enter or menu). For one entry: type, location, size in bytes, dimensions, created/modified/accessed from a live stat, and for folders the child counts from the last listing. For a selection: counts by kind and total size (folder contents not included) |

Backend and IPC:

- **Sidecar:** `fs.volumes`, `fs.listDirs`, `query.facets`, `props.get`, `selection.info`, `selection.rebase`, `library.get`,
  `library.setSetting`, `library.addBookmark`, `library.removeBookmark`. Callable by main only: `entry.path` and
  `selection.paths` (at most 10,000 paths; the result says when it was truncated).
- **Main:** `places.list`, `shell.open`, `shell.reveal`, `shell.revealPath`, `clipboard.copyPaths` and
  `clipboard.copyText`. Clipboard writes go through main because the renderer's permission handler denies everything.
  Paths for indexed entries are resolved by Go and never sent to the renderer for these actions, and the index only
  holds folders and media files, so "Open with default app" can't launch an executable. Unpackaged builds with
  `FASTVIEW_TEST_SHELL=record` record these calls instead of performing them (e2e).
- `query.open` gained `search` and `exts`, validated in main and Go; `dir.open` returns `crumbs`.
- Go packages: `internal/library` (library.db) and `internal/fsx` (file times, volumes, lazy listing, crumbs, and the
  hidden-file rule moved from `scan`). `index` gained `Facets`, `Summarize`, `EntryPaths` and `Entry`, which use one
  `json_each` parameter instead of chunked placeholder lists.

## Found and fixed while testing

1. **A change made within 300 ms of quitting was lost.** The Stage 03 test "tile size is remembered" caught it: the mirror
   was written by the same debounce as library.db. The mirror is now written immediately, library.db is flushed on
   `pagehide`, and the newer copy wins on startup.
2. **Clicking into the sidebar scrolled it to the top.** On focus the list moved focus to its first row and scrolled
   there, hiding the revealed folder. Focus now follows the clicked row, or falls back to the open folder's row, and
   focusing never scrolls.
3. **Alt+Enter opened the viewer** instead of properties: the tile view handled Enter and prevented the window-level
   shortcut. Alt combinations are now left to the window.
4. **Sidecar handshake +36 ms.** library.db was opened and migrated before the hello frame. It now opens in the background:
   sidecar ready p50 went from 152 ms back to 116–121 ms.
5. `TestCancelKeepsExistingRows` (Stage 01) was flaky: its 2 ms cancel could land during setup instead of during the scan.
   Setup now runs on its own context.

## Tests

| Suite | Count | New in this stage |
|---|---|---|
| Renderer | 121 | selection descriptors (ranges/include/exclude normalization, exact count, select-all is one range, rebase); workspace persistence (validation, legacy key, library.db applied, debounced save, newest copy wins, first run); sidebar (places, lazy one-level listing, reveal, bookmark from the context menu, keyboard); navigation (breadcrumb, back/forward/up, F5 keeps the session); search (debounce, one query per settled search, count, Esc); filters (chips with counts, file types, clear); two-key sort; multi-selection, status bar, copy paths as a descriptor, right-click, empty-area menu, properties for one entry and for a selection |
| Desktop | 81 | validators for every new method (selection ranges, sizes, paths, settings JSON size); main-only `entry.path` / `selection.paths` rejected from the renderer; workspace handlers (existing places only, open/reveal via sidecar paths, failed open, reveal only existing folders, copy paths one per line, empty selection doesn't clear the clipboard) |
| Contracts | 36 | guards for all new results against Go golden fixtures; stale selection is INVALID_ARGUMENT; crumbs end with the folder |
| Go | 17 packages | `library` (migrations survive reopen, validation, bookmark idempotence and limit, recent bounded and ordered); `fsx` (natural order, probe true/false/unknown, bounds, cancellation, crumbs incl. drive and UNC roots, file times per OS, mountinfo parsing); `index` (search incl. `%` `_` Unicode, filters, created/dimensions sort with unknowns last, multi-key, facets, summarize, paths, entry detail); `query` (previous-version ids, stale versions, facets); `app` (selection resolve/rebase, extension validation, golden frames for every new method) |
| E2E | 35 | Stage 05 (5): navigation by tiles, breadcrumb, Alt+arrows, Backspace; 10k-subfolder tree expand; search latency on 100k and sort by size; pane-resize smoothness plus workspace restored from library.db alone (fresh Electron profile); multi-selection with count/size, copy paths (4,500 lines), properties, show in file manager |

## Benchmarks

Windows 11, i9-13900K, production build. Results: `bench/results/stage-05-2026-09-30-e2e-workspace.jsonl`,
`stage-05-2026-09-30-petter-index*.json`, `stage-05-2026-09-30-petter-startup*.json`.

| Metric | Result | Target |
|---|---|---|
| Search in a 100k folder, keystroke → count and first tiles shown | p50 **215 ms**, including the 200 ms input debounce | < 700 ms (e2e gate) |
| `QueryIDs` with search on 100k (Go benchmark) | 28–42 ms; facets 45 ms | — |
| Session open on 100k: created desc / dimensions desc / search | 51 / 61 / 26 ms p50 (name asc 55 ms) | — |
| Expand a folder with 10,000 subfolders | **62–73 ms**, 0 long tasks, 47 rows mounted | no freeze (e2e gate: no long task > 200 ms, < 200 rows) |
| Pane resize (30-step drag) | **0 long tasks**; tiles per row 4 → 3 | none > 100 ms (e2e gate) |
| Cold index of flat-100k | 1,342–1,376 ms (Stage 02: 1,201 ms; +12–15 %, two more columns) | — |

Startup regression (three runs): ready-to-show p50 231–237 ms, sidecar ready p50 116–121 ms, ping p95 0.2 ms. Idle
memory over the empty-Electron floor was **52 / 72 / 59 MB** (budget 60; Stage 04: 45). Two runs passed and one failed.

## Acceptance

- [x] folder navigation works by mouse and keyboard (tree, breadcrumb, back/forward/up, tiles)
- [x] the sidebar stays lazy on huge filesystems (one level per expand; 10k subfolders in ~70 ms without long tasks)
- [x] search, filters and sort are index-backed and fast on a 100k folder
- [x] pane resize is smooth (no long tasks; the layout is saved on release, not per pixel)
- [x] the workspace persists across restarts (pane sizes, tile size, sort), from library.db alone
- [x] multi-selection works with mouse and keyboard, and its count and size come from the index
- [x] a very large folder stays responsive while all of the above is used

## Risks and follow-ups

- **Idle memory is at the budget edge.** Over the floor: 52, 72 and 59 MB in three runs (budget 60). The renderer's JS heap
  at idle is 3.7 MB with 165 DOM nodes on every launch, so the variance is in Chromium process working sets (the renderer
  tab 92–104 MB vs 85 MB in Stage 04; GPU +5 MB), not in app state. Code-splitting Radix would save little and is not
  done without evidence. Stage 10: make the memory check the median of several launches and attribute the working set.
- **Cold scans +12–15 %** from `name_fold` and `btime_ns` (and their index). Later benchmark runs were disturbed by
  background disk I/O on the machine (runs `-3` to `-5` show 2–10 s scans that aren't comparable). Re-measure on a
  quiet machine in Stage 10. Dropping the `btime` index was measured: it made the created sort 78 ms instead of 51 ms
  with no measurable scan gain, so the index stays.
- Created time is unavailable on Linux (statx is a Stage 09 refinement); dimensions are known only for previewed images
  until Stage 07 metadata.
- The folder tree doesn't watch the filesystem; F5 or "Refresh" on a node re-lists it.
- The preview pane is still a placeholder (Stage 06). *(Resolved in Stage 06.)*

## Exit checklist

- [x] implementation complete
- [x] tests complete
- [x] benchmark complete
- [x] performance regression reviewed
- [x] docs/ADR updated
