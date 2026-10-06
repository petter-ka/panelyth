# Stage P03 — File-Operation Engine v2

Status: **Implementation done** (2026-10-06); see "Open". Track: platform. Depends on: P02. Unblocks: C04.

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

## Results (2026-10-06)

Built (ADR-0029 is accepted; its "As built" section has the details):

- **Queue** (`internal/jobs/manager.go`, `lane.go`): lanes per (source volume, destination volume), at most 4 running
  jobs, a queue of 256 (`BUSY` beyond), "start now" (`jobs.start` option `now`, or `jobs.startNow`) in up to 4 extra
  slots, pause and resume per job (`jobs.pause`, `jobs.resume`; a paused queued job is not started), states `paused`
  and `asking`.
- **Conflicts** (`internal/jobs/transfer.go`): the eight policies; "replace" and its variants merge a folder into an
  existing folder (`fileops.MergeCopy`, `MergeMove`), asking per file inside the merge when the policy is `ask`;
  `renameExisting` keeps the existing item's index row and user metadata; `ask` emits `job.conflict` and keeps the
  question on the snapshot until `jobs.resolve` (with apply-to-all) answers it; other jobs keep running.
- **Engine** (`internal/fileops/copy*.go`): `CopyFileExW` with one registered progress routine (progress, pause and
  cancel; the access time is set through its handle, so a fast copy needs no reopen), `copy_file_range` (Linux),
  `clonefile` (APFS), and a portable copy with pooled 1 MiB buffers; times and the read-only, hidden and system
  attributes kept; a read-only target replaceable; partial files committed with a no-replace rename; `\\?\` long
  paths; Windows naming rules on FAT, exFAT and NTFS destinations; files under 4 MiB copied 4 at a time on lanes
  without a spinning disk (`fsx.IsRotational`), one at a time on HDD lanes; SHA-256 verification (`VERIFY_FAILED`);
  links copied as links when main adds `copyLinks` (the commander's profile; a renderer cannot set it).
- **Trash** (`TrashMany`): one `SHFileOperationW` call per 200 items, then a per-item check that retries leftovers
  alone, so errors stay per item. One call per item had cost ~28 ms per item (the risk named below).
- **Progress:** `bytesPerSec` and `etaMs` over a 3 s window, cleared on resume and after a question; pause points
  between items for every job kind.
- **Contracts, main, preloads:** the new methods, states, snapshot fields, item code and event, with guards,
  validators (`copyLinks` rejected from renderers) and golden fixtures (a real `ask` conflict, pause, resume, resolve,
  start now). The viewer's job panel knows the two new states and otherwise ignores the new fields; its
  `jobs.spec.ts` passes unchanged.
- **Benchmark tool** `cmd/copybench`: copy jobs against robocopy (or `cp`) on the same files, with warm-up copies,
  alternating order and settle time; purges exactly its own trashed files from the recycle bin. The controlled
  large-file comparison is an opt-in Go test, `TestBenchLargeCopyVsOS` (`FASTVIEW_BENCH_LARGE=1`).

Decisions by measurement (reference machine): 4 small files in flight with a 4 MiB threshold (1 MB files went from 2.0×
to 1.34× of robocopy's time; 10 KB files are bound by per-file cost, not parallelism); unbuffered I/O off (buffered
was faster for 4 GB on NVMe and NVMe → HDD); 1 MiB portable buffers (the fast path is used on all three platforms).

Deviations and notes:

- **Measurement noise on the reference machine.** The NVMe (C:) is about 98% full and Defender real-time protection is
  on. A 4 GB same-volume copy takes 1–2 s or 27–40 s depending on whether the drive is flushing, for robocopy as much
  as for FastView, so `copybench`'s same-volume medians swung from 50% to 112% of robocopy between runs. The large-file
  acceptance numbers therefore come from the controlled, alternating comparison (below), which shows parity.
- The Linux (`copy_file_range`) and macOS (`clonefile`) fast paths compile and vet but were not run here (Windows
  machine); the link-copy tests skip without the symlink privilege, and the Windows-names test runs only off Windows.
  These are Stage P04 verification items.
- Renderer long tasks during a copy were not measured in P03 (no renderer change beyond types); Stage C04's benchmark
  measures them with the queue panel ("renderer long tasks and panel navigation while copying").
- Pause latency was not timed; a pause takes effect at the next pause point (a `CopyFileExW` chunk, at most 4 MiB in
  the portable copy, 16 MiB per `copy_file_range` call, or the next item). C04's acceptance measures it from the UI.

Tests: Go all (new in `fileops`: fast path vs portable copy agree on bytes, times, access time and read-only;
replacing a read-only target; long paths; verification catches an injected mismatch; links per mode; a
cross-volume move of a file and a folder; folder merges with every decision, copy and move; small files in flight;
pause and cancel at the gate for both copy paths. New in `jobs`: lanes, start now and the running cap; the queue cap;
pause, resume and cancel mid-file with the partial file kept and removed; every policy against disk and index; `ask`
with apply-to-all while another job runs; a folder merge asking per file; verify and links options; small files in
flight keep the index right; speed and ETA. New in `fsx`: volume ids, seek penalty, naming rules. Golden frames for the
new methods and events); contracts 61; desktop 98 (new: the engine v2 validators and `copyLinks` per profile);
viewer 167 plus the 2 known theme-label failures; commander 59; E2E `specs/viewer/jobs.spec.ts` 2 of 2 unchanged; the
full e2e suite (both apps) 67 of 69, the 2 being the known `theme.spec.ts` failures.

Found and fixed while testing (tooling): `scripts/go.mjs` ran its task on import, and the e2e fixtures import it, so
every Playwright run first ran the whole Go suite (once per worker, in parallel); under load a package passed its
120 s timeout, the import threw and no e2e test ran. It now runs a task only when executed as a script. The generated
e2e fixtures had again been partly emptied (`images-12mp-120`, `images-48mp-3`, `cover-src-6`, `folders-2000`:
markers kept, contents gone; see C03's record); they were deleted and regenerated.

Measurements (reference machine: i9-13900K, C: NVMe ~98% full, D: and E: SATA HDDs, Windows 11, Defender on;
`shared/bench/results/stage-P03-2026-10-06-*`):

| Metric | Result | Budget |
|---|---|---|
| Large file, same volume (2 GB, controlled, alternating, settled) | `CopyFile` 0.42–0.44 s, robocopy 0.44 s | ≥ 90% of the OS copy |
| Large file, NVMe → HDD (4 GB, controlled; job path) | median 31.9 s (128 MB/s) vs robocopy 37.1 s (110 MB/s): 116% | ≥ 90% |
| Large file in `copybench` (4 GB, 5 runs) | NVMe → HDD 86–87% of robocopy; same volume 12–50% and 112% (drive state, see above) | — |
| Small files, Stage 07's Go benchmark (200 × 64 KiB) | 96–130 MB/s (v1 on the same machine today: 32–36 MB/s) | ≥ 3 × 12.4 MB/s |
| 10,000 × 10 KB, job vs robocopy | 3.38–3.67 s vs 2.74–3.10 s (1.18–1.24×) | within 2× |
| 1,000 × 1 MB, job vs robocopy | 0.30–0.44 s vs 0.64–0.67 s (faster) | — |
| Delete 10,000 files permanently | 0.68–1.80 s (v1: 1.75 s) | — |
| Trash 10,000 files | 23.8–50.4 s (v1: 282 s; 5.6–11.8× faster) | — |
| Peak Go heap per running job | 4–5 MB | ≤ 64 MB |

## Open

- Linux and macOS fast paths, link copies with privilege, and Windows names off Windows: Stage P04.
- Renderer long tasks during copies and pause latency from the UI: measured in Stage C04.
- A 4.1 GB leftover of the first, aborted baseline run is at `%TEMP%\fastview-copybench` on the reference machine (the
  agent's removal was blocked by a safety check); delete it by hand.

## Exit checklist

- [x] implementation complete
- [x] tests complete (Linux/macOS paths in P04)
- [x] benchmark complete
- [x] performance regression reviewed (both apps: viewer jobs e2e unchanged, full e2e rerun)
- [x] docs/ADR updated (ADR-0029 accepted, ADR-0021 note, DOMAIN-API, ARCHITECTURE)
