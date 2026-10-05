# ADR-0024 — Folder Covers

## Status

Accepted (Stage 08.6, 2026-10-05)

## Context

Folder tiles showed a plain symbol. Users want to see what is inside a folder before opening it. The index is
directory-centric (ADR-0015): opening a folder lists only its direct children, so subfolders' files are not known.
Indexing or generating previews for every subfolder would break the "open a large folder immediately" promise.

## Decision

- A new sidecar method `folder.covers` takes visible folder entry ids and returns up to **4 cover slots** per folder.
- Go finds covers with a **shallow, bounded read**. It reads the folder in chunks of 256 and stops at 4 supported media
  files or 2,048 entries. Hidden entries, links and subfolders are skipped. Videos count only when posters can be made.
  Nothing is written to the index.
- Discoveries are remembered in memory per folder path key until the folder's mtime changes (bounded map).
- Cover previews use the **normal cache keys** (path key, size, mtime, profile) and the shared preview scheduler with
  its own `covers` lane. Requests carry entry id 0, and finished previews go to cover waiters, published as batched
  `folder.covers` events.
- The renderer asks only for folder tiles that are visible or in overscan, once per folder per folder visit.

## Consequences

- Each visible folder costs at most 4 preview generations and one bounded directory read, both off the UI thread.
- When the folder is later opened, those files are cache hits.
- Covers can be stale until the parent folder is re-entered.
- Cache rows created for covers carry `entry_id = 0`. The column is advisory (CACHE-DESIGN.md), and LRU cleanup treats
  them like any other row.
