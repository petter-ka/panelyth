# Stage P03 — File-Operation Engine v2

Status: **Planned**. Track: platform. Depends on: P02. Unblocks: C04.

## Objective

Make copy, move and delete fast and controllable enough for a file manager: a queue with lanes, per-item conflict
questions, pause and resume, speed and ETA, optional verification, and throughput close to the OS's own copy
(ADR-0029). The viewer keeps its UI and gets the speed.

## Decisions applied

- **ADR-0029** (proposed; this stage decides it). It refines ADR-0021 (jobs, delete, clipboard, index consistency).
- ADR-0019 (pure Go: OS fast paths through syscalls), ADR-0026 (`all` scope: any file, links), ADR-0027 (profiles).

## Scope

- **Queue:** lanes per (source volume, destination volume); parallel across lanes, serial within a lane; at most 4
  running jobs; queue cap 256; "start now" for a queued job; pause and resume per job.
- **Conflicts:** policies `ask`, `keepBoth`, `skip`, `replace`, `replaceOlder`, `replaceIfDifferentSize`, `renameNew`,
  `renameExisting`. With `ask`, the job pauses at the item and emits `job.conflict`; `jobs.resolve(jobId, decision,
  applyToAll)` continues it.
- **Engine:** reused large buffers (1–4 MiB); `CopyFileEx`, `copy_file_range` and `clonefile` fast paths with portable
  fallbacks; 2–4 small files in flight on SSD lanes (chosen by measurement); timestamps and read-only/hidden attributes
  preserved; Windows long paths (`\\?\`); names validated per destination file system.
- **Links:** a job option set by the app that starts the job: the commander copies links as links; the viewer keeps
  skip-and-report (as today).
- **Verification:** optional streaming hash of source and copy; a mismatch is a per-item error.
- **Progress:** snapshots gain `paused`, `bytesPerSec` and `etaMs`; the 4 Hz throttle and coalescing stay.
- **Contracts:** new job states, the `job.conflict` event, `jobs.resolve`, `jobs.pause`, `jobs.resume`; golden
  fixtures regenerated. The viewer's job UI ignores the new fields.

## Non-goals

- Commander dialogs and the queue panel (Stage C04). Undo of copies or moves. ACLs, alternate data streams, sparse
  files.

## Tests

- Lane scheduling (parallel across lanes, serial within), start-now, queue cap (`BUSY`).
- Pause and resume mid-file; cancel mid-file removes the partial file; startup recovery still marks interrupted jobs.
- Every conflict policy, `ask` with apply-to-all, and a conflict while other jobs run.
- Fast paths and fallbacks produce identical bytes, timestamps and attributes; cross-volume move; long paths on Windows.
- Verification catches an injected mismatch.
- Link handling per profile.
- The viewer's `jobs.spec.ts` passes unchanged.

## Benchmarks

`BENCH_STAGE=P03`, reference machine (NVMe), compared with the OS's copy on the same files (`robocopy` / `cp`):

- one 4 GB file, same volume and across volumes;
- 10,000 files of 10 KB and 1,000 files of 1 MB;
- delete 10,000 files to the trash and permanently;
- peak memory per job; long tasks in the renderer during a copy.

## Acceptance criteria

- Large files: ≥ 90 % of the OS copy's throughput on the same machine and volumes.
- Small files: at least 3× Stage 07's 12.4 MB/s for 10 KB files, and within 2× of the OS copy's time.
- Memory per running job ≤ 64 MB; no long tasks in either renderer during copies.
- ADR-0029 is accepted and ADR-0021 notes are updated.

## Risks

- Trash on Windows runs one `SHFileOperationW` call per item (ADR-0021), which is slow for huge selections. Measure;
  batch per folder if the API allows per-item errors.
- Fast paths behave differently on network shares. Fall back on any error class that the portable path handles.

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
