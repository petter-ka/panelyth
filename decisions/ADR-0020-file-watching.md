# ADR-0020 — File Watching Scope

## Status

Accepted (Stage 01)

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
- On macOS, FSEvents (needs cgo, see ADR-0019) or polling is reconsidered in Stage 09 when kqueue's per-file
  descriptors are measured.

## Consequences

- Changes deep inside a recursive view are not picked up live. Refresh re-lists them.
- A burst of thousands of events costs one re-listing, not thousands of UI updates, which satisfies ARCHITECTURE.md
  "never emit one UI event per filesystem event".
