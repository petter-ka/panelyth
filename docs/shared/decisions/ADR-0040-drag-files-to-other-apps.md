# ADR-0040 — Dragging Files to Other Apps

## Status

Accepted (2026-10-15), at the owner's request, outside the stage list, like ADR-0033 and ADR-0039. Amends
ADR-0027 (one new main method in both profiles) and CFR-27 (drag and drop also reaches other apps).

## Context

- Drag and drop worked only inside each app: a commander row carried a data type of its own
  (`application/x-panelyth-panel`, the side it came from), a viewer tile the selection descriptor
  (`application/x-panelyth-selection`). Another app saw nothing it could take, so a file could not be dropped into
  a chat, a mail draft or the desktop.
- Other apps take files only from the OS's drag of files, which needs their paths. ADR-0027 keeps paths out of the
  renderer: actions take entry ids or selection descriptors, and main resolves them through Go.
- Electron starts the OS's drag with `webContents.startDrag({ file, files, icon })`, from main, while the pointer is
  still pressed. It must have an icon (macOS refuses an empty one).
- Chromium gives a page that receives the OS's drag of files only `Files` in its types, and no paths.

## Decision

- **One method, `drag.start { selection }`** (main, both profiles). Main resolves the selection with Go's
  `selection.paths` and calls `startDrag` on the calling web contents. It returns `{ count, truncated }`. When the
  selection has more entries than `selection.paths` gives (10,000), no drag starts, since dropping only some of the
  files would mislead the target, and the app says so.
- **The page's own drag never starts.** On `dragstart` the view calls `preventDefault()` and `drag.start`. The icon
  is the OS's icon for the first file (`app.getFileIcon`), or the app icon when there is none.
- **Drops back on the same view** read what was dragged from a small marker in `@panelyth/renderer-core`
  (`beginOwnDrag`, `ownDrag`, `endOwnDrag`). The marker holds the panel side in the commander and the selection
  descriptor in the viewer. It answers only while files are over the view. It ends at the drop, when the pointer
  moves with no button held, when the pointer is pressed again, or when the window loses focus. Ending early is safe,
  because a drop it misses does nothing. Files dragged in from other apps are not taken; that is a separate decision.
- **Copy or move.** Electron's drag offers a copy, so a drop target in the app always answers `copy`. The commander
  still moves on Shift, which it reads at the drop. Other apps copy; what they do with the files is up to them.
- **What drags out:**
  - commander: the marks or the cursor entry of a panel on this computer's folders (including find results and
    branch views);
  - commander, archive or connection panels: these keep the in-app drag, since their entries have no file to hand
    out;
  - viewer: the selected pictures and videos.

## Consequences

- Files go from either app to any app that accepts dropped files, on Windows, macOS and Linux.
- In-app drag and drop works as before: commander panels, tabs, drive buttons and the folder tree; viewer folder
  tiles and the folder tree.
- Paths still go from Go to main to the OS, never through a renderer. The renderer can only ask for a drag of a
  selection it already holds.
- Component tests simulate the OS's drag as a drop whose types are `["Files"]`. The e2e spec checks that a row's
  drag hands main the marked files' paths (`PANELYTH_TEST_SHELL=record` logs a `drag` action instead of starting
  one).
- Taking files dropped from other apps (copy into the folder under the pointer) remains open.
