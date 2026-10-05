# ADR-0029 — File-Operation Engine v2: Queue, Conflicts, Throughput and Verification

## Status

Proposed (2026-10-05). Decided in Stage P03. It refines ADR-0021. The viewer keeps its current dialogs and behavior;
it gains the engine's speed and the queue without UI changes.

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
