# ADR-0020 — File Watching Scope

## Status

Accepted (Stage 01)

Amended 2026-10-05 (ADR-0026, proposed; ADR-0031): the sidecar watches the folders of the visible app only: the
viewer's open folder, or the folder of each visible commander panel. A hidden app re-lists its folders when shown.

Amended 2026-10-08 (Stage P04): on macOS the sidecar no longer uses fsnotify's kqueue backend, which opens every file
of a watched folder (one descriptor each, synchronously in `dir.open`; on the first error it returns without closing
what it opened). It watches each folder through one kqueue descriptor on the folder itself (pure Go,
`internal/watch/backend_darwin.go`). FSEvents (cgo) and polling were not needed. See "macOS" below.

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

## Consequences

- Changes deep inside a recursive view are not picked up live. Refresh re-lists them.
- A burst of thousands of events costs one re-listing, not thousands of UI updates, which satisfies ARCHITECTURE.md
  "never emit one UI event per filesystem event".
