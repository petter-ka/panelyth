# ADR-0020 — File Watching Scope

## Status

Accepted (Stage 01)

Amended 2026-10-05 (ADR-0026; ADR-0031): the sidecar watches the folders of the visible app only: the
viewer's open folder, or the folder of each visible commander panel. A hidden app re-lists its folders when shown.

Amended 2026-10-08 (Stage P04): on macOS the sidecar no longer uses fsnotify's kqueue backend, which opens every file
of a watched folder (one descriptor each, synchronously in `dir.open`; on the first error it returns without closing
what it opened). It watches each folder through one kqueue descriptor on the folder itself (pure Go,
`internal/watch/backend_darwin.go`). FSEvents (cgo) and polling were not needed. See "macOS" below.

Amended 2026-10-12 (Stage P02): **built.** A watch belongs to a slot (the viewer's folder, or a commander panel by
its lane; at most four per app) instead of a list of the four most recently opened folders. Main names the visible
app with `app.setVisible`; the watches of the other app are removed and its pending re-listings dropped. When an app
is shown, its folders that were not watched meanwhile are re-listed after the quiet period (a folder both apps
show stays watched and is skipped; so is a folder the app leaves within the quiet period). A folder that could not
be watched is not retried on every open, and is re-listed on show like the rest. Folders the commander opens
outside a panel are not watched. See "Slots and the visible app" below.

## Context

`fsnotify` is not recursive on Linux (inotify watch limits). On macOS it uses kqueue with one file descriptor
per watched *file*, which is unusable for a folder of 100k images. Windows `ReadDirectoryChangesW` is
efficient. Watching whole trees is therefore not portable.

## Decision

- Watch **only the currently open folder, non-recursively**. Watches on previously open folders are removed.
  The sidecar holds at most one watch in Stage 01. Expanded tree nodes (Stage 05) may add a few more, with a cap.
- Watch events are **not** applied one by one. Any event marks the folder dirty, and after a quiet period
  (300 ms, extended while events keep arriving, forced after 2 s) the folder gets a **shallow re-listing** with a
  new generation. That listing is the same reconcile path as a normal open, so watcher logic cannot drift from scan logic.
- If the watch fails (for example on a network share or with too many watches), the folder still works. The UI can
  offer refresh, and the error is logged, not surfaced as a failure.
- **macOS (Stage P04):** one kqueue descriptor per watched folder (`EVFILT_VNODE` with `NOTE_WRITE`, `NOTE_EXTEND`,
  `NOTE_ATTRIB`, `NOTE_DELETE`, `NOTE_RENAME`). Entries added, removed or renamed in the folder are seen; a file
  rewritten in place without its folder changing is not (most editors save through a temporary file and a rename,
  which is seen); F5 re-lists. Found by the first macOS CI run: after a 100k-file folder was opened, the next folder
  could not be opened ("no rows"), and listing and tab switching were slow. Linux (inotify) and Windows
  (`ReadDirectoryChangesW`) keep fsnotify.

## Slots and the visible app (Stage P02)

- `dir.open` carries the calling app (added by main) and the lane. The slot is `(app, lane)`: `(viewer, "")`,
  `(commander, left)`, `(commander, right)`. A new folder in a slot replaces its watch. A fifth lane of one app
  drops that app's least recently opened slot; another app's slots are never dropped.
- Calls that name no app (Electron main's own, for a file opened from the OS) are always watched.
- Before main has named the visible app (the first moments of a start, or an older main), every slot is watched.
- Two slots on one folder share one OS watch; it is removed when the last active slot lets go.
- The debounce of the Decision above is unchanged: 300 ms quiet, forced after 2 s, one shallow re-listing.

## Consequences

- Changes deep inside a recursive view are not picked up live. Refresh re-lists them.
- A burst of thousands of events costs one re-listing, not thousands of UI updates, which satisfies ARCHITECTURE.md
  "never emit one UI event per filesystem event".
