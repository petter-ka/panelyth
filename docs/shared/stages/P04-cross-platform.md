# Stage P04 — Cross-Platform Hardening

Status: **Planned**. Track: platform (formerly viewer Stage 09). Depends on: P03 and the app stages in scope (see
`docs/ROADMAP.md`). Applies to both apps; when the viewer ships first, it runs with the viewer in scope and C11
repeats the commander parts.

## Objective

Make both apps work and package correctly on Windows, macOS and Linux, and turn the platform assumptions left from
earlier stages into tested behavior.

## Scope

- One product package per OS, containing the shell with both apps (ADR-0031): Windows, macOS (signing and
  notarization path), Linux. Choose the packager (electron-builder or Electron Forge; deferred here by ADR-0013).
- Sidecar executable resolution per OS/arch (`resources/bin/<platform>-<arch>/`).
- Drive and volume tests: fixed, removable and network volumes; free and total space; labels.
- Path handling tests: Unicode normalization (NFC/NFD on macOS), case sensitivity per volume (`path_key` folding uses
  the platform default today: viewer Stage 01), Windows long paths and UNC shares, reserved names.
- Native media capability tests: which image and video formats each OS's Chromium plays; ffmpeg/ffprobe discovery and
  posters on each OS (ADR-0018); optional 7-Zip discovery for the commander (ADR-0030).
- Packaged smoke tests: launch, open a folder, preview, switch to the other app (when enabled), list, copy a file,
  quit cleanly.

### Carried over from viewer stages and ADRs

- Created time on Linux through `statx` (viewer Stage 05).
- macOS watching: kqueue per-file descriptors measured; FSEvents (needs cgo) or polling reconsidered (ADR-0020).
- macOS trash "Put Back", and Linux network shares without a top-level trash (ADR-0021, viewer Stage 07).
- Trackpad and wheel inertia on macOS and Linux for the tile view and the commander lists (viewer Stage 03).
- Per-volume case-sensitivity detection for `path_key` (viewer Stage 01).

## Tests and benchmarks

- The e2e suites of both apps on all three OSes (CI matrix), plus the packaged smoke tests.
- Startup and idle-memory budgets (`docs/shared/PERFORMANCE.md`) measured on each OS (`BENCH_STAGE=P04`).

## Acceptance criteria

- The product installs, starts, browses, switches apps and quits cleanly on all three OSes from packaged builds.
- Every carried-over item above is either fixed with a test or recorded with a decision.

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
