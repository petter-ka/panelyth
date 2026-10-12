# Commander Architecture

Status: **in progress** (C00 done, C01–C09 implemented; Stages C10–C11 planned). Panelyth Commander runs on the shared platform (`docs/shared/ARCHITECTURE.md`):
an app view in the Panelyth shell, next to the viewer, with the commander capability profile (ADR-0027, ADR-0031). It
shares the viewer's sidecar, index (queried with the `all` scope, ADR-0026), preview cache, jobs, clipboard and
`library.db`. Switching between the apps and the state they share: `docs/shared/APP-SWITCHING.md`. This document
covers what is specific to the commander.

## Processes and packages

```text
src/shared/desktop                the shell: preload/commander and the commander capability profile in main
src/commander/renderer     React app (src/shared/ui, src/shared/renderer-core, src/shared/media-ui)
src/shared/sidecar          the shared sidecar: all-entries scope, jobs v2, find, archives, compare, rename,
                            internal/remote (FTP and FTPS connections, Stage C10.5)
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
 cursor      cursor, anchor and marks per tab (selection algebra from src/shared/renderer-core)
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
  | { kind: "remote"; remoteId: number; path: string }      // Stage C10.5, ADR-0037

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

- Images and videos use the shared `ImageViewer` and `VideoPlayer` (moved to `src/shared/media-ui` in Stage C05) with
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

## Compare, synchronize and checksums

As built (Stage C08; `features/compare.ts`, `components/SyncDialog.tsx`, `DiffDialog.tsx`, `ChecksumDialog.tsx`):

```text
Shift+F2            → compare.marks({ leftQueryId, rightQueryId, date rules }) → marks of both panels
Synchronize         → compare.dirs({ leftDirId, rightDirId, … }) → { compareId, queryId }   the table's session
                      compare.progress … query.invalidated                                   rows when the walk is done
                      compare.show / compare.setAction → { session snapshot, plan }           applied at once
                      jobs.start({ kind: "sync", compareId, planVersion })                   the confirmed plan
Compare by content  → diff.open({ leftId, rightId }) → rows paged with diff.page
                      (not text, or over 50 MB: jobs.start({ kind: "compareFiles", leftId, rightId }))
Checksums           → jobs.start({ kind: "hashCreate" | "hashVerify", source, … })
```

- The synchronize table is a page store over the compare's session, like a panel's listing: virtualized rows, pages
  fetched for the visible range only. Its selection is the shared selection algebra, sent as a descriptor.
- Roots are folder ids (a typed folder is opened with `dir.open` first); a sync names a compare and a plan version,
  so no path and no list of files crosses the bridge.
- The plan covers the rows the table shows. Go refuses a plan version older than the current one, and the job checks
  each entry against the compare before touching it (ADR-0029 "As built (Stage C08)").
- The text diff's rows live in a small page cache outside React state (200 rows a page, 24 pages); the text itself
  stays in the files and in Go.
- The date rules (`compareToleranceMs` 0 or 2000, `compareDst`, `compareIgnoreDates`) are part of
  `commander.settings`: Shift+F2 uses them and the synchronize dialog shows and changes them.

## Multi-rename, attributes and properties

As built (Stage C09; `features/rename.ts`, `features/attributes.ts`, `components/MultiRenameDialog.tsx`,
`AttributeDialogs.tsx`):

```text
Ctrl+M            → rename.preview({ selection, plan, offset, limit })      a page of old and new names, the batch's counts
                    … again on every change of the plan, for the pages in view
                    jobs.start({ kind: "multiRename", source, plan })       the plan the preview showed
Undo last         → rename.undoInfo() → jobs.start({ kind: "undoRename" })  no selection: Go's journal
Change attributes → jobs.start({ kind: "setAttributes", source, setAttrs | setMode, …, modifiedMs, recursive })
Alt+Enter         → props.get(entryId) (attributes, permissions, link target) or selection.info for marks
```

- **Go names the batch, not the renderer.** Conflicts depend on every name of the batch, so `rename.preview` resolves
  all of it on each call (`rename.Resolve`, the function the job applies) and returns one page plus the counts and the
  position of the first problem. The entries of the previewed selection and the names of their folders are kept in Go
  between calls (one selection at a time, dropped after a minute without use or when the job starts), so a key press
  costs the naming only.
- **The preview table is virtualized** and holds its rows outside React state: pages of 200 rows, at most 12, asked
  for by the rows in view. One request is in flight at a time; while it is, newer plans only replace what is asked
  next, so typing never queues requests. Rows of the plan before the current one stay visible (dimmed) until their
  page is named again.
- **A plan that cannot be compiled** comes back as `INVALID_ARGUMENT` with `details { reason: "plan", field }`; the
  dialog shows Go's reason under that field and keeps the last rows.
- **Platform differences stay in Go:** `props.get` reports `permissions` as null on Windows and the dialog shows
  attributes or permissions accordingly; a `setAttributes` job carries either `setAttrs`/`clearAttrs` or
  `setMode`/`clearMode`.
- **Properties are shared:** `EntryProperties` and `SelectionProperties` (`src/shared/ui`) render the rows in both
  apps; the viewer adds its favorite, rating, label and tag rows, the commander the attributes and the link target.

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
| C08 | `compare.dirs` (a diff session with `ContentItem.diff` rows), `compare.cancel`, `compare.close`, `compare.show`, `compare.setAction`, `compare.plan`, `compare.marks` (Shift+F2); `diff.open`, `diff.page`, `diff.close` (the text diff); job kinds `sync`, `hashCreate`, `hashVerify`, `compareFiles`; the `compare.progress` event |
| C09 | `rename.preview` (paged), `rename.undoInfo`; job kinds `multiRename`, `undoRename`, `setAttributes`; `props.get` gains `attrs`, `permissions` and `linkTarget`; `dirSize` writes in batches |
| C10 | `shell.run` and `shell.runTool` (main-local; folders and names resolve in Go through `entry.path` and `selection.paths`); user commands in `commander.tools`; `query.page` with a thumbnail profile and `preview.ensure` lanes `cmd-tiles-left` / `cmd-tiles-right` for the Thumbnails view |
| C10.5 | `fs.listDirs` with `showHidden` (the folder tree); `remote.connections`, `remote.saveConnection`, `remote.removeConnection`, `remote.trust`, `remote.connect`, `remote.cancel`, `remote.disconnect`, `remote.open`, `remote.mkdir`, `remote.rename`, `remote.secureStore` and the `connections.changed` event (ADR-0037; main-only towards the sidecar: `remote.storeConnection`, `remote.secret`, `remote.dial`); `query.open { remoteId, remoteDirId }` (the fourth session source); job kinds `download`, `upload`, `remoteDelete`; `compareFiles` over a selection; `diff.page` rows with `spans` |

Every method is batch-oriented, cancellable where it runs long, and validated in main (ADR-0012, ADR-0027).

## Persistence

The shared `library.db` (ADR-0016, ADR-0031): the commander's own settings under `commander.*` (`layout`, `panels`
with tabs, `columns`, `confirmations`, `editor`, `shortcuts`, per-panel history). As of Stage C03:
`commander.panels` `{ v: 2, active, left/right: { tabs: [{ path, name, sort, showHidden, view, locked, history,
historyIndex, cursorId }], active, columns } }` (v1 from C01–C02 is still read) and `commander.settings`
(Settings: size and date format, hidden files in new panels, where letters go; from C05 `mediaOpen` (viewer or system),
`runPrograms` (ask, always, never) and `editor`, which main reads for F4); the hotlist is the shared bookmarks
table (with groups), and recent locations are shared with the viewer. Theme and interface size come from
`shared.appearance`. Settings are written debounced and flushed on exit, as in the viewer. As of Stage C10:
`commander.tools` `{ v: 1, commands: [{ id, title, command, params, dir, icon, menu, console }] }` (read by main when
a user command runs), `commander.toolbar` `{ v: 1, items }` (action ids, `tool:<id>`, `|` for a divider),
`commander.commandHistory` `{ v: 1, items }` (50 lines), a tab's `view` may be `thumbs`, and `commander.settings`
gains the three bars, the tile size, the default conflict policy and verify, and the two confirmations. As of Stage
C10.5: `commander.panels` is `v: 3` (a tab gains `title` and, for a tab on a connection, `remote { connectionId,
label, host, port, user, encrypted, path }`: where it was, never a password, and nothing that connects by itself);
`commander.tabSets` `{ v: 1, sets: [{ id, name, panels: [{ tabs, active }] }] }` (one panel's tabs, or the left and
the right panel's; at most 50 sets); `commander.layout` `{ v: 1, split, tree: "off" | "one" | "two", treeWidth }`;
`commander.settings` gains `tabBar` and `treeFollowCursor`. Saved connections are rows of the `connections` table
of `library.db`, with the password as ciphertext made by Electron main (ADR-0037).

## Tab sets, the folder tree and connections (Stage C10.5)

- **Tabs** (`features/tabs.ts`, `features/tabsets.ts`): the tab bar is always there (a setting hides it for one
  tab) with a "+" button; a tab can be renamed, duplicated and, once closed, brought back (the last 10 per panel,
  in memory). A tab set is a named list of tab records; opening one opens a session for the tab that becomes
  visible only.
- **The folder tree** (`features/tree.ts`, `components/TreePane.tsx`) is the viewer's tree store, moved to
  `src/shared/renderer-core` as a factory (`createTreeStore`) with the twisty in `src/shared/ui`; the viewer's
  sidebar uses the same code. One tree left of the panels follows the active panel, or each panel has its own. A
  node lists one level of subfolders when expanded (`fs.listDirs`, with the panel's hidden-files setting); rows are
  virtualized; the tree follows the panel after the panel's rows are painted.
- **Connections** (`features/remote.ts`, `components/ConnectionsDialog.tsx`; Go `internal/remote`, `internal/app/
  remote.go`; main `src/shared/desktop/src/main/remote.ts`): a connected server is a location over the panel's
  folder, like an archive. `remote.open` lists a folder on the server, a session pages it, and F5, F6, F7, F2 and
  F8 are routed to the server's jobs and calls. A password is typed in the renderer, encrypted or used by main for
  one call, and never returns; the renderer keeps it in no store. Nothing connects without a command: a restored
  tab says "Not connected". A listing that hangs is cancelled by Stop, Esc or the panel moving on. What needs files
  of this computer refuses with one message (`refusedOnConnection`).

## Switching to the viewer

- On switch, the commander publishes its context: the active panel's folder (or, for archive, find and branch
  locations, the folder containing the cursor entry), the cursor entry and the marks (`context.publish`). A compare
  is a dialog over the panels, not a panel location (Stage C08). On a connection it publishes the folder of this
  computer behind it, without an entry or marks: no connection and no entry of one carries over (Stage C10.5).
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
- Nothing runs without an explicit user command; programs ask first by default. A typed line runs on Enter in the
  command line only; a user command from its button, key or menu entry only (ADR-0027, Stage C10).
- Recursive work (find, branch, folder sizes, copy) never follows links, is bounded, and can be cancelled.
