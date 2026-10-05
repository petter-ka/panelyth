# Stage 07 — Batch Operations + Metadata Foundations

Status: **Complete** (2026-10-01). The SQLite fault under "Open before closing" was carried into Stage 08 unresolved
when work moved on.

## Objective

Enable power-user file operations and metadata-based organization.

## Decisions applied

- **ADR-0021 accepted:** every copy, move, trash, delete, batch rename and metadata change is a Go job
  (`internal/jobs`). At most 2 run at once, with a FIFO queue capped at 32. Each job is one goroutine and handles its
  items one at a time. Sources are ADR-0017 selection descriptors or the internal clipboard, never id lists from the
  renderer.
- **Progress** is a coalesced 4 Hz `job.progress` snapshot per job. Per-item errors are paged with `jobs.errors`
  (≤ 500 per page, ≤ 10,000 kept).
- **Delete = Recycle Bin / Trash, Shift+Delete = permanent** (after confirmation). Windows trashes only on fixed
  drives; elsewhere it reports `TRASH_UNAVAILABLE`.
- **User metadata** lives in `library.db` (migration 2: `items`, `tags`, `item_tags`). It is joined into index queries
  as one `json_each` parameter, not through `ATTACH`.

## Scope delivered

| Stage plan item | Implementation / evidence |
|---|---|
| copy / move / delete / rename | `internal/fileops` (partial-file copy + rename, EXDEV fallback, conflict policies, name validation, trash per platform); Go tests `TestCopy*`, `TestMove*`, `TestDelete*`, `TestRename*`, `TestFreedesktopTrash`, `TestTrashOnThisPlatform` |
| asynchronous Go job manager | `internal/jobs` (`manager.go`, `execute.go`); `TestQueueAndRecovery` (queue bound, startup marks `interrupted`, removes partials) |
| progress | coalesced snapshots; e2e `favorite-90k`: 5 events over 1.1 s, final state always delivered |
| cancellation | between items and every 4 MiB inside a copy; `TestCancelStopsBetweenAndInsideItems`, `TestCopyFileCancelRemovesPartial` |
| per-item errors | kept per job, paged; renderer `JobsPanel` lists failed items; e2e `file-ops` checks the index stays consistent after failures |
| properties | `PropertiesDialog` shows favorite, rating and tags beside the Stage 05 fields |
| favorites / tags / ratings | `BatchBar`, tile menu, tag dialog; tile badges; `library` tests `TestFavoriteRatingTagsAndPruning`, `TestRekeyAndForget` |
| metadata query support | descriptor `favorite`, `minRating`, `tags`; sorts `favorite`, `rating`, `tags`, `duration`; lazy dimension/duration extractor (`internal/meta`) |

## Fixes made while closing the stage

- **Sorting or filtering by user data hung the sidecar for 50–75 s per query** on a 100k folder with 10k annotated
  files. `json_each` reports a tiny row estimate, so `entries LEFT JOIN u` never got an automatic index, and SQLite
  rescanned the annotation list for every entry (≈10⁹ comparisons). Sorts now use the equivalent
  `u RIGHT JOIN entries` (annotations walked once, probing the unique `path_key` index), and filters use
  `u CROSS JOIN entries` (an annotation is required, so `u` is pinned as the outer loop).
  New test `TestUserSortAndFilter`.
- **Tag sort tie:** an untagged favorite (`tag = ''`) and an unannotated file (`tag IS NULL`) sorted differently when
  descending. Both now compare as `''` and fall back to name order.
- The foundation e2e isolation check now expects the new `clip`, `entry` and `jobs` preload namespaces.

## Measurements

| Result | File | Numbers |
|---|---|---|
| Go query benchmarks | `bench/results/stage-07-2026-10-01-petter-go-bench-6.txt` | 100k files, 10k annotated: sort by rating 141 ms, by tags 144 ms (were ~75 s); filter favorites 55 ms, tag 50 ms (were ~50 s). Search 100k unchanged: 27–40 ms, facets 44 ms |
| Go job benchmarks | `…-go-bench-5.txt` | favorite 100k items 305 ms; 10k-item favorite job 82 ms; small-file copy ≈ 12.4 MB/s, one file at a time (ADR-0021; Stage 10 candidate) |
| e2e | `bench/results/stage-07-2026-10-01-e2e-jobs.jsonl` | favorite over 90,000 selected files: 1.37 s, 1 `jobs.start` call, 5 progress events, 0 long tasks; copy/rename/delete with a failing item: index consistent |

`go-bench` files 1–5 contain failures from the SQLite fault described below. They are kept as evidence.

## Acceptance

- [x] large selections remain UI-responsive (90k-item job: 0 long tasks, one IPC call)
- [x] progress updates are coalesced (≤ 4 Hz per job; 5 events for a 1.1 s job)
- [x] job failures do not corrupt the index (e2e `file-ops`; failed items change nothing; crash recovery test)

## Open before closing

- **Intermittent SQLite heap corruption (modernc.org/sqlite v1.60.1 / libc v1.77.1, Windows).** The Go benchmarks that
  commit 100k rows in one transaction and then query from the reader pool sometimes fail with
  `database disk image is malformed` or `unexpected fault address` inside the transpiled SQLite (`libc.Xfree`, page
  and LIKE code). It reproduces **without FastView code** (a plain `database/sql` program: WAL, one writer and one
  reader connection, 100k inserts, then queries). It happens with Go 1.26 and 1.27 alike, with async preemption off,
  and with `mmap_size(0)`. It wasn't seen with a single connection (18 runs). It is not caused by Stage 07, but it threatens
  the "index never corrupts" promise. It needs a decision: report upstream and pin, switch drivers (ADR-0019
  amendment), or rule out this machine's CPU (i9-13900K; Raptor Lake instability causes similar random faults).
- **A damaged test fixture was found.** `flat-100k` had lost 58,119 of its 90,000 media files (deleted in NTFS
  name order, nothing in the Recycle Bin, last change 09:55 today). No FastView job journal from the surviving
  profiles touched it. The folder was kept as `%TEMP%/fastview-fixtures/flat-100k.damaged-2026-10-01` and the
  fixture regenerated. `fixturegen` trusts its marker file and does not detect missing files.

## Risks and follow-ups

- A renamed or moved file is regenerated once in the preview cache (the key includes `path_key`). Path-independent
  keys are a Stage 10 candidate.
- Copy throughput is one file at a time per job. Stage 10 measures 2–4 parallel copies on SSDs.
- macOS "Put Back" and Linux network shares without a top-level trash are Stage 09 verification items.

## Exit checklist

- [x] implementation complete
- [x] tests complete (Go all packages; renderer 157, desktop 84, contracts 47; e2e 41/41)
- [x] benchmark complete
- [x] performance regression reviewed (user-data queries fixed; search, scan and tile paths unchanged)
- [x] docs/ADR updated
- [ ] SQLite fault decision (carried over; see above)
