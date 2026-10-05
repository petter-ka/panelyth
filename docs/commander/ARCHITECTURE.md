# Commander Architecture

Status: **planned** (Stages C00–C11). FastView Commander runs on the shared platform (`docs/shared/ARCHITECTURE.md`):
an app view in the FastView shell, next to the viewer, with the commander capability profile (ADR-0027, ADR-0031). It
shares the viewer's sidecar, index (queried with the `all` scope, ADR-0026), preview cache, jobs, clipboard and
`library.db`. Switching between the apps and the state they share: `docs/shared/APP-SWITCHING.md`. This document
covers what is specific to the commander.

## Processes and packages

```text
apps/desktop                the shell: preload/commander and the commander capability profile in main
apps/commander-renderer     React app (packages/ui, packages/renderer-core, later packages/media-ui)
native/fastview-go          the shared sidecar: all-entries scope, jobs v2, find, archives, compare
```

## Renderer composition

```text
AppShell
 ├── AppBar: the app switch icon (to the viewer), later the C10 toolbar
 ├── PanelPair: left and right Panel, resizable divider (ADR-0028)
 │    └── Panel: drive/tab bar · path bar · column header · list (Full | Brief | Thumbnails) · status line
 ├── CommandLine (Stage C10)
 ├── FunctionKeyBar
 ├── QueuePanel (jobs, Stage C04) and dialogs (copy/move, conflict, delete, new folder, find, rename, sync)
 └── overlays: QuickView (in the other panel's place), Lister (full window)

features/
 panels      panel and tab state, active panel, layout
 listing     session lifecycle per visible tab (open, page, invalidate, close)
 cursor      cursor, anchor and marks per tab (selection algebra from packages/renderer-core)
 quicksearch type-ahead over the session (query.locate)
 drives · hotlist · history
 jobs        queue, dialogs, conflict resolution (extends the shared job store)
 quickview · lister        shared media components + text and hex views
 find · branch · archives · compare · rename · cmdline · tools
```

Global stores are small Zustand stores per feature; listings use the external page store (ADR-0011). Nothing holds a
full listing in React state.

## Panel and tab model

```ts
type Location =
  | { kind: "dir"; dirId: number; path: string }
  | { kind: "archive"; archiveId: number; inner: string }   // ADR-0030
  | { kind: "find"; findId: number }                        // Stage C06
  | { kind: "branch"; dirId: number; path: string }         // Stage C06

interface Tab {
  id: number
  location: Location
  sort: SortKey[]
  view: "full" | "brief" | "thumbs"
  showHidden: boolean
  nameMask: string               // quick filter; "" = all
  history: { back: Location[]; forward: Location[] }
  locked: boolean
}

interface PanelState {
  side: "left" | "right"
  tabs: Tab[]
  activeTab: number
  columns: { ext: number; size: number; date: number; attr: number }   // px; Name takes the rest
}
```

- Only the **visible tab** of each panel holds a query session. Switching tabs opens the new session (rows are served
  from the index immediately, ADR-0015) and closes the old one after a short grace period.
- Per tab, the cursor index, the anchor and the marks (a selection descriptor) live in the cursor store. After
  `query.invalidated`, marks are rebased with `selection.rebase` (ADR-0017), and the cursor follows its entry id.

## Listing pipeline

```text
Enter on a folder
  → dir.open({ path, recursive: false })            shallow listing, all-entries scope (ADR-0026)
  → query.open({ dirId, sort, showHidden, nameMask })
  → query.page(…) for the visible rows + overscan    the page store fills rows; the list never waits
  → watch events → re-listing → query.invalidated    refetch only the pages held
```

- The `..` row is synthetic in the renderer and never part of the session.
- **Quick search:** `query.locate({ queryId, pattern, from, direction })` returns the next matching position. Go uses
  an id → position map of the session and a name query on the folder, so the cost depends on the matches, not on the
  folder size.
- **Status line:** the session `total`, `selection.info` for the marked count and size (debounced, as in the viewer's
  status bar), and free space from the volumes API.
- **Folder sizes:** a cancellable size job per folder (Space) or for all folders in the panel; results go to
  `dir_size_bytes` and invalidate the session.

## File operations

- Dialogs build a job spec: `{ kind, source: descriptor | clipboard, destination: other panel's location, policy,
  mask, verify }`. The sidecar resolves the destination from the panel's `dirId`, never from a renderer path.
- Jobs run in the ADR-0029 queue: lanes, pause and resume, `job.conflict` events answered with `jobs.resolve`. The
  queue panel subscribes to `job.progress` and `job.conflict`.
- After a job, both panels' sessions refresh through the normal invalidation path (ADR-0021 index consistency).

## Quick view and lister

- Images and videos use the shared `ImageViewer` and `VideoPlayer` (moved to `packages/media-ui` in Stage C05) with
  the shared preview cache and token protocol.
- Text and hex read **byte windows** through the token protocol with HTTP Range (ADR-0027). The scroll position maps
  to a byte offset, and lines are found inside the loaded window, so a multi-GB file opens instantly with bounded
  memory. Encoding detection runs on the first window (BOM, UTF-8 validity, then a single-byte fallback).
- Quick view follows the cursor after it settles (as the viewer's preview pane does, 150 ms).

## Methods and events by stage

| Stage | Methods and events |
|---|---|
| P01 | `app.switch`, `app.visibility` (main; used by both apps from C00) |
| P02 | all-entries scope; descriptor `showHidden`, `nameMask`; sort `ext`, `attrs` |
| C01 | `context.publish`, `context.get` (both apps) |
| C02 | `query.locate`; folder-size jobs; `selection.fromContext` (both apps) |
| C03 | volumes with free and total space; hotlist and history in `library.db` |
| P03 / C04 | jobs v2: `jobs.pause`, `jobs.resume`, `jobs.resolve`, `job.conflict` |
| C05 | token protocol for any file kind (lister, quick view); `shell.open` with confirmation for programs |
| C06 | `find.start`, `find.cancel` (a session source); branch listings (recursive, all scope) |
| C07 | `archive.open`, `archive.close` (a session source); pack, unpack and test jobs |
| C08 | `compare.dirs` (a diff session), sync jobs, `hash.create`, `hash.verify` jobs |
| C09 | `rename.preview`, rename jobs with an undo journal; attribute and timestamp jobs |
| C10 | `shell.run` (main), user commands |

Every method is batch-oriented, cancellable where it runs long, and validated in main (ADR-0012, ADR-0027).

## Persistence

The shared `library.db` (ADR-0016, ADR-0031): the commander's own settings under `commander.*` (`layout`, `panels`
with tabs, `columns`, `confirmations`, `editor`, `shortcuts`, per-panel history); the hotlist is the shared bookmarks
table (with groups), and recent locations are shared with the viewer. Theme and interface size come from
`shared.appearance`. Settings are written debounced and flushed on exit, as in the viewer.

## Switching to the viewer

- On switch, the commander publishes its context: the active panel's folder (or, for archive, find, branch and
  compare locations, the folder containing the cursor entry), the cursor entry and the marks (`context.publish`).
- When shown, it reads the viewer's context (`context.get`): the active panel opens that folder if needed, puts the
  cursor on the focused entry, and turns the carried selection into marks (`selection.fromContext`).
- While hidden it does no work: no paging, no watching; on show it re-lists its visible panels.
- Rules and budgets: `docs/shared/APP-SWITCHING.md`.

## Commander rules

- Lists use fixed row heights and fixed column widths; nothing is measured while scrolling (ADR-0028).
- One session per visible tab; one watch per visible panel (ADR-0026).
- Actions take ids, descriptors or panel locations, never renderer-supplied paths (ADR-0027).
- Nothing runs without an explicit user command; programs ask first by default.
- Recursive work (find, branch, folder sizes, copy) never follows links, is bounded, and can be cancelled.
