# ADR-0021 — Batch Jobs, Delete/Clipboard/Rename Semantics and User Metadata

## Status

Accepted (Stage 07), by default: it adopts the proposals in `docs/shared/ARCHITECTURE-ANALYSIS.md` §9, M3 and M4, with the
changes listed under "Deviations". It refines ADR-0010 and amends ADR-0016 (no ATTACH).

Refined by ADR-0029 (accepted in Stage P03, 2026-10-06): queue lanes (4 running jobs, a queue of 256, "start now"),
per-item conflict questions and more policies, pause and resume, speed and ETA, verification, links as links for the
commander, and faster copies (OS fast paths, small files in flight). Where this ADR's numbers differ (2 running jobs, a
queue of 32, one file at a time, three policies), ADR-0029 applies.

## Decision

### Job manager (Go, `internal/jobs`)

- `jobs.start(spec) → { jobId }`. Every copy, move, trash, delete, batch rename and metadata change (favorite,
  rating, tag) is a job. `jobs.cancel(jobId)`, `jobs.errors(jobId, offset, limit ≤ 500)` and `jobs.list()` complete the
  API. A single rename (F2 on one item) is a synchronous `entry.rename`, because the inline editor needs its validation
  error immediately.
- **Sources** are either an ADR-0017 selection descriptor or the internal clipboard. Go resolves either one into an id list
  when the job starts. The renderer never sends a list of ids.
- **Bounded:** at most 2 jobs run at once, and the rest wait in a FIFO queue capped at 32 (`BUSY` beyond that). Each job
  runs its items sequentially on one goroutine, so one job adds exactly one goroutine. Copy/move on the same disk
  wouldn't get faster with parallel workers (HDD thrash), and metadata changes are chunked SQL.
- **Progress:** `job.progress` carries the job's full snapshot (`state`, `done`, `total`, `bytesDone`, `bytesTotal`,
  `failed`, `current`). It is throttled to 4 Hz per job and coalesced per job id, so the latest state always wins and
  the final state is never dropped. Per-item errors are not pushed. They are kept (up to 10,000 per job) and paged
  with `jobs.errors`.
- **Cancellation** is checked between items and every 4 MiB inside a file copy. A cancelled copy removes its partial
  file. Items finished before the cancel stay done; nothing is rolled back.
- **Journal:** `index.db` gains a `jobs` table (created with `IF NOT EXISTS`, no schema bump). On startup, jobs left
  `running` are marked `interrupted`, and `*.panelyth-partial` leftovers in their destination folder are removed.
  There is no automatic resume.

### File operations

- **Copy** writes to `.<name>.panelyth-partial` in the destination, then renames it to the final name. It preserves
  mtime. A folder is copied as a whole into a partial folder and renamed at the end.
- **Move** is `os.Rename`. Across volumes (EXDEV / `ERROR_NOT_SAME_DEVICE`), it is a copy, then a size check, then
  deletion of the source.
- **Conflicts:** the policy is chosen up front: `keepBoth` (default: "name (2).jpg"), `skip` or `replace`. Pasting into
  the source folder therefore duplicates, as in Explorer and Finder. An interactive "ask" policy is deferred.
- Copying or moving a folder into itself or into its own subtree is refused per item. Moving an item to the folder it
  is already in counts as done and does nothing.
- Symbolic links inside copied folders are skipped and reported. They are never followed (ADR-0015).

### Delete (resolves M3)

- **Delete** moves items to the OS trash. **Shift+Delete** deletes permanently, and the renderer always asks for
  confirmation first. Trash needs no confirmation, because it can be undone in the OS.
- Go owns the trash code, and all of it is pure Go (ADR-0019):
  - Windows: `SHFileOperationW` (`FO_DELETE | FOF_ALLOWUNDO`, silent), one item per call so errors are per item.
    It runs **only on fixed drives**. On removable and network drives the shell would delete permanently without
    warning, so Panelyth reports `TRASH_UNAVAILABLE` instead and the UI offers permanent delete.
  - Linux and other Unix: the freedesktop.org Trash spec. Items go to `$XDG_DATA_HOME/Trash` on the home volume and to
    `$topdir/.Trash-$uid` elsewhere, each with a `.trashinfo` file. If neither works, the item fails with `TRASH_UNAVAILABLE`.
  - macOS: a rename into `~/.Trash` (home volume) or `/Volumes/X/.Trashes/$uid`. Finder's "Put Back" is not
    supported without AppleScript or cgo, and Stage P04 revisits that.

### Clipboard and rename (resolves M4)

- **The clipboard is internal.** Ctrl+C / Ctrl+X store the resolved ids in Go (`clip.set`), so the clipboard survives
  navigation to another folder. Ctrl+V starts a copy or move job into the open folder. A cut is cleared after a
  successful paste. The OS file clipboard (Explorer/Finder interop) is not portable in Electron and is not supported. "Copy
  path" stays as it is.
- **Batch rename pattern:** `{name}` is the original name without its extension, and `{n}`, `{n:000}` is a counter
  (zero-padded to the given width) that starts at a chosen number and follows the order of the selection. The original
  extension is always kept, so a batch rename never turns a media file into an unindexed one. The UI previews the first
  names before anything is started.
- **Name validation** is done in Go: no separators or control characters, not `.` or `..`, and at most 255 bytes. On
  Windows it also rejects `<>:"|?*`, trailing dots and spaces, and reserved device names.
- There is no undo in the MVP.

### Index consistency

- Jobs edit `index.db` **directly and only for items that succeeded**, in batched transactions (each ≤ 250 ms or 500
  items). Removed items lose their rows; the delete cascades to folder subtrees. Moved and renamed items keep their id:
  `parent_id`, `path_key` and the name columns are rewritten, and so is every descendant key of a folder. Copies get new
  rows when the destination folder is indexed. Affected folders are passed to the query sessions as changes, so open
  views refresh through the normal `query.invalidated` path, and the watcher's re-listing of the open folder remains the
  safety net.
- A failed item changes nothing in the index, and a crash between the file operation and the index write leaves rows that
  the next listing reconciles (ADR-0015). Either way, the index stays a correct cache of the filesystem.

### User metadata (library.db)

- `library.db` migration 2 adds `items (path_key UNIQUE, favorite, rating 0–5)`, `tags (name, name_fold UNIQUE)` and
  `item_tags`. Rows exist only for annotated files, and an item with no favorite, no rating and no tags is deleted.
  Collections and color labels belong to Stage 08.
- A move or rename rewrites the `path_key`s in `library.db` in the same job step (and every descendant key for a
  folder). A permanent delete removes the item's rows. Trash keeps them, so a file restored to the same path keeps its
  favorite, rating and tags.
- Metadata changes run as jobs: one `library.db` transaction per chunk of 1,000 items.
- **Querying:** the descriptor gains `favorite` (only favorites), `minRating` (0–5) and `tags` (has all of them), and
  sort gains `favorite`, `rating`, `tags` (first tag alphabetically, untagged last; M10) and `duration`. Page rows
  carry `favorite` and `rating` for the tiles.

### Metadata extraction

- `dimensions` and `duration` are filled in lazily. A session sorted by either field queues its rows with
  `meta_state = 0` for a bounded extractor: 2 workers, image headers through `imaging.ProbeFile` and videos through
  ffprobe. The extractor writes in batches and refreshes the session through the normal invalidation throttle.
  The work stops when the session closes or changes order.

## Deviations from the analysis

- **No `ATTACH`.** ADR-0016 planned for `index.db` to attach `library.db`. Instead, Go reads the scope's annotations from
  `library.db` (by `path_key` range) and passes them to the index query as one `json_each` parameter, and only when the
  descriptor sorts or filters by user data. If `library.db` can't be opened, browsing keeps working (Stage 05 rule),
  no global connection hook is needed, and neither database ever locks the other. Page rows get favorite and rating
  from a second, small `library.db` lookup (≤ 1,000 keys).
  The join must drive from the annotation list: `json_each` reports a tiny row estimate, so `entries LEFT JOIN u`
  gets no automatic index and is quadratic (measured ~75 s at 100k × 10k). Sorts use `u RIGHT JOIN entries`, and
  filters, which require an annotation, use `u CROSS JOIN entries`. Both probe the unique `path_key` index
  (141 ms / 55 ms at 100k × 10k).
- **One progress channel.** There is no separate `job.state` channel: the coalesced snapshot already carries the state.
- **No per-item journal (`job_items`).** Items are resolved from the session's in-memory id list, and per-item errors
  stay in memory for the session. The journal only records what startup recovery needs.

## Consequences

- A renamed or moved file gets a new preview cache key (the key includes `path_key`), so its thumbnail is generated
  again once. A path-independent key (file identity) is a Stage P05 candidate.
- Copy/move throughput is one file at a time per job. Stage P05 measures whether small-file copies benefit from 2–4
  parallel copies on SSDs.
- macOS "Put Back" and Linux network shares without a top-level trash are Stage P04 verification items.
