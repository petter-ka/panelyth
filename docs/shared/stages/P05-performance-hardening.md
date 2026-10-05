# Stage P05 — Performance Hardening

Status: **Planned**. Track: platform (formerly viewer Stage 10). Depends on: P04. Applies to both apps.

## Objective

Profile real use of both apps and fix what the profiles show. Profile first; every optimization records its baseline,
hypothesis, result and regression check (NFR-12).

## Focus

- renderer scroll and React commit traces (viewer tiles, commander lists)
- virtualizer tuning
- image decode behavior
- IPC latency and payloads
- scanner throughput
- SQLite query and write performance
- thumbnail scheduling
- cache I/O
- video poster generation
- batch filesystem throughput (after the P03 engine)
- memory and allocation behavior

### Carried over from viewer stages and ADRs

- Idle memory is near the budget edge (Stage 08: +52.9 MB over empty Electron; budget 60). Make the memory check the
  median of several launches and attribute the working set (viewer Stage 05).
- Cold scans are 12–15 % slower since Stage 05; occasional SQLite write stalls (antivirus or WAL checkpoints are
  suspected; viewer Stage 01); warm rescans about 40 % slower than cold because every row is rewritten (viewer Stage 01).
- Worker counts and throughput on low-end hardware (viewer Stage 02); prefetch distance by scroll velocity (viewer
  Stage 03); progressive placeholders for 48 MP images (viewer Stage 04).
- Poster generation variance and ffmpeg's peak memory with 4K videos (viewer Stage 06).
- A path-independent preview cache key, so a rename keeps its thumbnails (ADR-0021).
- The JSON codec vs MessagePack, decided with numbers (ADR-0012).
- Parallel small-file copies moved to Stage P03 (ADR-0029).

## Benchmarks

Before and after for every change (`BENCH_STAGE=P05`), with both apps' budgets (`docs/shared/PERFORMANCE.md`,
`docs/viewer/PERFORMANCE.md`, `docs/commander/PERFORMANCE.md`).

## Acceptance criteria

- Every budget passes on the reference machine and the low-end machine, or has an accepted, recorded exception.
- No change lands without a measured improvement and a regression check.

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
