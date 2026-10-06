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
