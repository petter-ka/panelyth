# Commander Architecture

Status: **in progress** (C00 done, C01–C07 implemented; Stages C08–C11 planned). Panelyth Commander runs on the shared platform (`docs/shared/ARCHITECTURE.md`):
an app view in the Panelyth shell, next to the viewer, with the commander capability profile (ADR-0027, ADR-0031). It
shares the viewer's sidecar, index (queried with the `all` scope, ADR-0026), preview cache, jobs, clipboard and
`library.db`. Switching between the apps and the state they share: `docs/shared/APP-SWITCHING.md`. This document
covers what is specific to the commander.

## Processes and packages

```text
shared/desktop                the shell: preload/commander and the commander capability profile in main
commander/renderer     React app (shared/ui, shared/renderer-core, shared/media-ui)
shared/sidecar          the shared sidecar: all-entries scope, jobs v2, find, archives, compare
```

## Renderer composition

```text
AppShell
 ├── AppSwitcher: left rail with Viewer and Commander icons (ADR-0031)
 ├── PanelPair: left and right Panel, resizable divider (ADR-0028)
 │    └── Panel: drive/tab bar · path bar · view · status line
 │         view: Full (TanStack Table + Virtual) | Brief (react-virtual list) | Thumbnails (react-virtual tiles)
 ├── CommandLine (Stage C10)
 ├── FunctionKeyBar
 ├── QueuePanel (jobs, Stage C04) and dialogs (copy/move, conflict, delete, new folder, find, rename, sync)
 └── overlays: QuickView (in the other panel's place), Lister (full window)

features/
 panels      panel and tab state, active panel, layout
 listing     session lifecycle per visible tab (open, page, invalidate, close)
 cursor      cursor, anchor and marks per tab (selection algebra from shared/renderer-core)
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
- As built (Stage C03, `features/tabs.ts`, `features/listing.ts`): the visible tab's live state is the panel's listing
  state; other tabs are small records (path, name, sort, `showHidden`, `view: "full" | "brief"`, `locked`, history,
  the cursor entry id). A tab being left **parks** its session for 3 s (`TAB_GRACE_MS`): switching back within that
  time reuses it (no `query.open`; the folder is re-listed in the background), and invalidations keep the parked
  snapshot current; then it closes. Ctrl+T's new tab takes over the visible session (same folder). A locked tab keeps
  its folder: a navigation from it branches into a new tab. History is per tab (50 entries).
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
- As built (Stage C04, `features/files.ts`, `features/queue.ts`): copy and move send `destinationDirId` (an edited
  destination is first opened with `dir.open` to get its id); main refuses a path destination from the commander.
  After F7, a rename or a delete, a pending focus (`focusEntry`) puts the cursor on the new folder, the renamed entry
  or the entry after the deleted ones once the session's invalidation brings it in.
- Jobs run in the ADR-0029 queue: lanes, pause and resume, `job.conflict` events answered with `jobs.resolve`. The
  queue panel subscribes to `job.progress` and `job.conflict`.
- After a job, both panels' sessions refresh through the normal invalidation path (ADR-0021 index consistency).

## Quick view and lister

- Images and videos use the shared `ImageViewer` and `VideoPlayer` (moved to `shared/media-ui` in Stage C05) with
  the shared preview cache and token protocol.
- Text and hex read **byte windows** through the token protocol with HTTP Range (ADR-0027). The scroll position maps
  to a byte offset, and lines are found inside the loaded window, so a multi-GB file opens instantly with bounded
  memory. Encoding detection runs on the first window (BOM, UTF-8 validity, then a single-byte fallback).
- Quick view follows the cursor after it settles (as the viewer's preview pane does, 150 ms).
- As built (Stage C05; `features/bytes.ts`, `features/text.ts`, `features/viewers.ts`, `features/open.ts`,
  `components/ByteViews.tsx`, `QuickView.tsx`, `Lister.tsx`): a `ByteSource` per open file reads 64 KiB chunks by
  Range into a 4 MiB LRU (find reads 1 MiB windows uncached). Lines longer than 4 KiB show as 4 KiB segments, which
  bounds every window; going up searches back 16 KiB for the line start (longer lines start approximately). The text
  view's top is a byte offset; its scroll bar maps to it, and End is the start of the last screen. UTF-16 without a
  mark is recognized too; zero or many control bytes mean binary (hex). Quick view replaces the other panel, which
  stays mounted and inert, and follows the active panel; Tab moves into it and back. The lister is a full-window
  dialog with its own keymap scope (`lister`: Esc, N / P, 1–4, W, Ctrl+F, F3 / Shift+F3). Images and videos use the
  shared components with the commander's preview lanes (`cmd-quick`, `cmd-lister`). Enter on an image or video
  publishes the panel's folder and entry to the Viewer, which opens its focused image view or full-screen player and
  opens the shared media overlay over Commander and reveals the same Commander session when closed. The independent
  overlay uses the shared image and video components; video remains full-window if Chromium denies native fullscreen.
  The Commander setting can route media to the system default app. Other files go
  through `listing.enter`'s file opener (`features/open.ts`).

## Methods and events by stage

| Stage | Methods and events |
|---|---|
| P01 | `app.switch`, `app.visibility` (main; used by both apps from C00) |
| P02 | all-entries scope; descriptor `showHidden`, `nameMask`; sort `ext`, `attrs` |
| C01 | `context.publish`, `context.get` (both apps); `query.indexOf`; volumes with free and total space; `dir.open` error reasons (`notReady`, `network`) |
| C02 | `query.locate`, `query.match`; `dirSize` jobs (`ContentItem.dirSizeBytes`); the selection in `context.publish` and `selection.fromContext` (both apps); `shared.switch` |
| C03 | `library.updateBookmark`, `library.reorderBookmarks` (bookmark groups); events `volumes.changed`, `bookmarks.changed`; `Volume.notReady`, space read per volume with a timeout |
| P03 / C04 | jobs v2: `jobs.pause`, `jobs.resume`, `jobs.startNow`, `jobs.resolve`, `job.conflict`; copy and move by `destinationDirId` with `mask` and `name`; `fs.mkdir`, `fs.canTrash`; `clipboard.copyPaths` `namesOnly` |
| C05 | `file.open` (token URL for any file kind; main-only `file.resolve`), `shell.open` with `allowProgram`, `shell.edit`, `fs.mkfile`; `media.open`, `preview.ensure`, `props.get` and the `preview.ready` event for the commander; shared `MediaViewerOverlay` above the Commander view; `entry.path.program` |
| C06 | `find.start`, `find.cancel` (a session source); branch listings (recursive, all scope) |
| C07 | `archive.open`, `archive.close`, `archive.check`, `archive.tools`; `query.open { archiveId, archiveDirId }` (a session source with its own rows); job kinds `extract`, `pack`, `testArchive` (ADR-0030 "As built") |
| C08 | `compare.dirs` (a diff session), sync jobs, `hash.create`, `hash.verify` jobs |
| C09 | `rename.preview`, rename jobs with an undo journal; attribute and timestamp jobs |
| C10 | `shell.run` (main), user commands |

Every method is batch-oriented, cancellable where it runs long, and validated in main (ADR-0012, ADR-0027).

## Persistence

The shared `library.db` (ADR-0016, ADR-0031): the commander's own settings under `commander.*` (`layout`, `panels`
with tabs, `columns`, `confirmations`, `editor`, `shortcuts`, per-panel history). As of Stage C03:
`commander.panels` `{ v: 2, active, left/right: { tabs: [{ path, name, sort, showHidden, view, locked, history,
historyIndex, cursorId }], active, columns } }` (v1 from C01–C02 is still read) and `commander.settings`
(Settings: size and date format, hidden files in new panels, where letters go; from C05 `mediaOpen` (viewer or system),
`runPrograms` (ask, always, never) and `editor`, which main reads for F4); the hotlist is the shared bookmarks
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

- The Full (table) view uses TanStack Table for columns, headers and column sizing, with manual sorting (Go sorts)
  and a row model of the visible window only, virtualized with TanStack Virtual. The Brief (list) and Thumbnails
  (tile) views use `@tanstack/react-virtual` alone (ADR-0028).
- Fixed row heights and column widths from the table model; nothing is measured while scrolling.
- One session per visible tab; one watch per visible panel (ADR-0026).
- Actions take ids, descriptors or panel locations, never renderer-supplied paths (ADR-0027).
- Nothing runs without an explicit user command; programs ask first by default.
- Recursive work (find, branch, folder sizes, copy) never follows links, is bounded, and can be cancelled.
