# ADR-0029 — File-Operation Engine v2: Queue, Conflicts, Throughput and Verification

## Status

Accepted (Stage P03, 2026-10-06). Proposed 2026-10-05. It refines ADR-0021. The viewer keeps its current dialogs and
behavior; it gains the engine's speed and the queue without UI changes. "As built" below records how the decision was
implemented and what was chosen by measurement.

## Context

- ADR-0021 runs every job item by item on one goroutine, at most 2 jobs at once (queue cap 32), with a conflict
  policy chosen up front (`keepBoth`, `skip`, `replace`). There is no pause, no per-item question, no speed or ETA, and
  small-file copies measured about 12 MB/s (Stage 07).
- Copy and move are the core of a file manager. Users expect a background queue, per-item conflict questions
  ("overwrite older?"), speed and ETA, pause and resume, optional verification, preserved timestamps and attributes,
  long paths, and throughput close to the OS's own copy.

## Decision

### Queue

- Jobs are queued in **lanes**, one per (source volume, destination volume) pair. Jobs in different lanes run in
  parallel; jobs in the same lane run one after another, so two copies never thrash one disk. A user can start a queued
  job right away.
- At most 4 jobs run at once; the queue holds up to 256.
- **Pause and resume** per job, applied between chunks and items. A paused job keeps its partial file.

### Conflicts

- Policies: `ask`, `keepBoth`, `skip`, `replace`, `replaceOlder`, `replaceIfDifferentSize`, `renameNew`
  (auto-numbered) and `renameExisting`.
- With `ask`, the job pauses at the conflicting item and emits `job.conflict { jobId, source, target }` with both
  sizes and dates. `jobs.resolve(jobId, decision, applyToAll)` continues it. Other jobs keep running.

### Copy engine

- Streaming copy with large reused buffers (1–4 MiB, bounded memory per job).
- OS fast paths, all pure Go through syscalls (ADR-0019): `CopyFileEx` on Windows, `copy_file_range` on Linux,
  `clonefile` on APFS when source and destination share a volume. Each has a portable fallback.
- Small files: 2–4 files in flight per job on SSD lanes, chosen by measurement in P03.
- Preserves modification and access times and the read-only/hidden attributes. ACLs, alternate data streams and
  sparse files are out of scope.
- Long paths: Windows `\\?\` prefixes beyond 260 characters. Names are validated for the destination file system.
- **Symlinks:** a job option. The commander copies a link as a link, never its target; the viewer keeps
  skip-and-report (ADR-0021).

### Verification and progress

- Optional verification hashes the source and the copy (streaming SHA-256 or xxhash) and reports a mismatch as a
  per-item error.
- Snapshots add `bytesPerSec` and `etaMs`, computed in Go over a moving window. The 4 Hz throttle and coalescing stay.

### Unchanged from ADR-0021

Jobs start from selection descriptors or the internal clipboard; partial files, the startup journal, index
consistency, trash and permanent delete, and name validation keep their rules. There is no undo for copy or move.
The commander's multi-rename gets a one-level undo of its own (Stage C09).

## As built (Stage P03)

- **Queue** (`internal/jobs/manager.go`, `lane.go`): a lane is `sourceVolume>destinationVolume` (`fsx.VolumeID`:
  the drive or share on Windows, the device elsewhere); trash, delete and rename use their own volume; metadata and
  folder-size jobs have no lane. At most 4 jobs run, plus up to 4 more started with "start now" (`jobs.start` option
  `now`, or `jobs.startNow` for a queued job); the queue holds 256. States gain `paused` and `asking`.
- **Pause** holds a job at its next pause point: every 4 MiB in the portable copy, every progress callback of
  `CopyFileExW`, every `copy_file_range` chunk (16 MiB), and between items. A paused queued job is not started.
- **Conflicts:** the policies listed above. "replace" and its variants **merge** a folder into an existing folder of the
  same name (missing items are added, folders merge recursively, files that exist on both sides are decided by the
  policy or asked about one by one); a file never replaces a folder, so such a pair keeps both. `ask` emits
  `job.conflict { jobId, conflict }` and sets the snapshot's `conflict` (so a renderer that was hidden still sees the
  question); `jobs.resolve(jobId, decision, applyToAll)` answers. Conflict sides carry size, date, folder flag and the
  entry id when indexed (for a preview).
- **Engine** (`internal/fileops/copy*.go`): `CopyFileExW` through one registered progress routine (unbuffered from
  256 MiB, chosen by measurement), `copy_file_range` on Linux, `clonefile` on APFS; the portable copy uses pooled
  1 MiB buffers. Modification and access times and the read-only, hidden and system attributes are kept; a read-only
  target can be replaced. Win32 calls use `\\?\` prefixes for long paths. Names are checked against Windows rules
  when the destination is a FAT, exFAT, NTFS (or, on macOS, SMB) volume.
- **Small files:** copies of files under 1 MiB run up to `SmallFilesInFlight` at a time per job, both inside folder
  copies and across the selected items, on lanes where neither volume has a seek penalty (`fsx.IsRotational`; HDD
  lanes copy one file at a time).
- **Links:** Electron main adds `copyLinks: true` to the commander's copy, move and paste calls from its profile; a
  renderer cannot set it. Links are recreated from their target text; where the OS refuses (Windows without Developer
  Mode or admin), the item fails as `SKIPPED_LINK` with that reason.
- **Verification:** SHA-256 of source and copy after each file; a mismatch fails the item as `VERIFY_FAILED` and the
  copy is removed.
- **Speed and ETA:** samples every ≥ 100 ms over a 3 s window, cleared on resume and after a question.

## As built (Stage C08): sync, checksums and compare by content

Four job kinds joined the queue (`internal/jobs/compare.go`); all run in volume lanes, pause between items and
chunks, cancel, and report bytes with speed and ETA.

- **`sync`** has no selection and no conflict policy: it applies the plan of a finished directory compare (ADR-0017),
  named by the compare's id and the plan version the user confirmed. Its lane is (left root's volume, right root's
  volume). Copies and new folders run first in the plan's order, deletes afterwards from the deepest entry up. Each
  entry is checked right before it is touched: the source and the target must still be as the compare saw them
  (present or absent, size and date). One that is not fails as `CHANGED` and is left alone; nothing is overwritten
  or deleted on the strength of an old comparison. Copies go through the engine's `CopyFile` (partial file, dates
  kept, replace). Deletes go to the trash in batches of 200, or are permanent when the dialog says so; a folder is
  removed with a plain remove, so one that is not empty stays.
- **`hashCreate`** and **`hashVerify`** hash one file at a time through a pooled 1 MiB buffer (SHA-256, SHA-1, MD5,
  CRC32). Creating writes each checksum file through a partial file. Verifying counts every listed file as an item;
  entries that are absolute or leave the list's folder are refused (`UNSAFE_PATH`), and a list with a line that
  cannot be read fails as a whole (`CORRUPT`).
- **`compareFiles`** reads two files side by side with two pooled buffers; "different" is an item error
  (`DIFFERENT`), so the queue's details show it like any other result.
- Verification after copy (above) still hashes with SHA-256 in `fileops`; the checksum package is separate because
  its formats and algorithms are the user's.

## As built (Stage C09): multi-rename, its undo, attributes and folder sizes

Three job kinds joined the queue; `dirSize` changed how it writes.

- **`multiRename`** (`internal/jobs/rename.go`) takes a selection and a rename plan (ADR-0021 "As built (Stage C09)").
  It names the batch, fails what is invalid or not free per item (`INVALID_NAME`, `ALREADY_EXISTS`), skips unchanged
  names, and renames the rest in an order that never needs a temporary name. It pauses and cancels between items; what
  was renamed stays renamed. At most 100,000 entries per job.
- **The one level of undo:** a multi-rename that renamed anything leaves a journal of (folder, old name, new name) in
  the order applied, replacing the previous one. It lives in the sidecar's memory: it is gone after a restart.
  `rename.undoInfo` says what it holds. **`undoRename`** has no selection: it takes the journal (nothing else can undo
  it meanwhile) and renames back, last first. An entry that is no longer there under its new name fails as `NOT_FOUND`,
  one whose old name is taken again as `ALREADY_EXISTS`; both stay as they are and nothing is overwritten. A cancelled
  undo, or one cancelled while queued, puts back what it did not reach, unless a newer multi-rename replaced the
  journal. The index follows where it knows the entry; a listing reconciles the rest.
- **`setAttributes`** (`internal/jobs/attrs.go`) sets and clears attributes and sets dates for a selection, optionally
  for everything below the selected folders (children before their folder, so a folder that loses its write or search
  permission is still walked). On Windows the bits are read-only, hidden, system and archive (every other attribute is
  kept); elsewhere they are the nine permission bits; each platform ignores the other's. Dates are the modified and the
  accessed time (1980 to 9999). Links are never changed and never followed. The changed rows of the selection go to the
  index at once (date and attribute bits, batched with the job's flush); entries below a folder are reconciled by the
  next listing.
- **`dirSize`** writes its results through the job's batches (500 items or 250 ms): one transaction and one refresh of
  the open listings per batch instead of one per folder. For a panel of 1,000 folders that is 2 refreshes instead of
  1,000, and 1.0 ms of index writes instead of 11.6 ms.
- All three rename and attribute jobs run in the lane of their volume; main lets only the commander start them.

## As built (Stage C10.5): transfers to and from a server, and comparing several files

Three job kinds joined the queue for connections (ADR-0037; `internal/jobs/remote.go`). Main lets only the commander
start them, and Go refuses entries of a connection in every other job.

- **The lane** of all three is the connection (`remote:<id>`), not a volume: two jobs on one server run one after
  another, jobs on two servers and jobs on local disks run side by side. Inside a job, files move over the
  connection's transfer sockets, 1–4 as the connection says (default 2); that is the bound a server sees.
- **`download`** takes a selection of a remote session and a local folder by its id. Folders are walked on the
  server (each listed once, at most 64 deep). A file is written through a partial file and renamed into place, with
  the server's date. A transfer that is cut off is retried once, from where it stopped when the server offers REST.
  A name is checked again where it is written, so nothing lands outside the target.
- **`upload`** takes local entries and a folder of a connection by its id. It writes each file under its final name
  (FTP has no portable rename-over) and then compares the size the server reports with what was sent; a cut-off
  upload is retried once, resuming where the server allows it. Links and special files are not uploaded.
- **`move`** (F6) is an option of both: a source is removed only after its copy is whole (for an upload, after the
  size check; for a folder, after everything in it went).
- **Conflicts** use the queue's policies and the same question as local copies, decided by size and date (a server
  gives no checksum): ask, overwrite, skip, overwrite older, rename new, rename existing.
- **`remoteDelete`** removes the selected entries on the server, deepest first. There is no trash on a server, so
  it is always permanent, and the dialog says so.
- All three pause between chunks and items, cancel (a cancelled download removes its partial file), report bytes
  with speed and ETA, and record per-item failures with the server's own words. After a job the folders it changed
  are read again, so the panels showing them follow.
- **`compareFiles` over a selection** (the same stage): next to its two-file form it takes a selection and a folder,
  and compares each selected file with the file of that name there, as one job. A pair that differs is an item
  error (`DIFFERENT`), a missing partner `NOT_FOUND`; folders in the selection are left out and counted.

## Why

- Lanes give parallelism across disks without thrashing a single disk.
- Asking per item is what file-manager users expect, and pausing only the asking job keeps the queue moving.
- OS fast paths and parallel small files close most of the gap to the OS's copy speed without cgo.

## Consequences

- The job snapshot and contracts grow (`paused` state, `conflict` event, `resolve` method, speed, ETA). The golden
  fixtures are regenerated.
- The viewer's job UI ignores the new fields until it opts in.
- Throughput targets live in `docs/commander/PERFORMANCE.md` and are measured against the OS's copy on the same
  machine.
