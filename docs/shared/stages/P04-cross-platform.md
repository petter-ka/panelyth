# Stage P04 — Cross-Platform Hardening

Status: **In progress** (started 2026-10-08; packaging, CI and the Linux pass done). Track: platform (formerly viewer Stage 09). Depends on: P03 and the app stages in scope (see
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

## Progress (2026-10-08)

First slice: packaging, CI and release builds, and a full pass of every suite on Linux (a 4-vCPU cloud container,
Ubuntu, ext4, kernel 6.18, Go 1.27, Node 22, Electron 44 under Xvfb). Windows and macOS run in the CI matrix; they were
not run by hand here.

### Packaging and release (ADR-0032)

- Packager: **electron-builder** (`shared/desktop/electron-builder.yml`), run by `pnpm package`
  (`scripts/package.mjs`), which builds the bundles and the sidecar for each target arch
  (`pnpm build:sidecar --arch x64,arm64 [--platform …]` now cross-compiles). Windows NSIS (x64), macOS DMG and zip
  (arm64, x64; ad-hoc signed), Linux AppImage and tar.gz (x64). The sidecar ships per arch in `resources/bin/`, the
  renderers in `resources/renderer/` and `resources/commander/`, as `paths.ts` already expected.
- Packaged smoke test: `shared/e2e/smoke/packaged.spec.ts` (`pnpm test:smoke`, after `pnpm package --dir`): launch
  with a fresh profile, list a folder in the commander, copy an image with F5 (bytes compared), switch to the viewer
  (the folder carries over), preview the image (fit layer decoded), quit; the sidecar process exits with the shell.
  Passes on Linux (3.1 s).
- `.github/workflows/ci.yml`: lint, typecheck and Go race tests on Linux; unit, Go, e2e (commander and app switch) and
  the packaged smoke test on Windows, macOS and Linux.
- `.github/workflows/release.yml`: on a published GitHub release, packages Windows and macOS, runs the smoke test on
  each and attaches the installers to the release (version from the tag, `v1.2.3` → `1.2.3`); by hand it uploads them
  as workflow artifacts.

### Found and fixed on Linux

- **A copied read-only file became writable** (Linux and macOS): the copy is created with the owner's write bit (and
  under the umask) and the mode was never restored. `preserve` now sets the source's permission bits after the times.
  `TestFastPathAndPortableCopyAgree` caught it; the Linux `copy_file_range` path is now verified (P03's open item).
- `TestFastPathAndPortableCopyAgree` also failed on access time: the first copy's read moved the source's atime
  (`relatime`), so the second run compared against a moved value. The test resets the times per run.
- **Entry ids depended on the filesystem's directory order** (NTFS lists names sorted, ext4 in hash order), so the
  golden frames drifted on Linux. The scanner now orders each listing chunk the way NTFS lists names (upper-cased
  runes, ASCII fast path; `compareUpper`), which keeps the Windows fixtures and gives the same ids on every OS.
  Cost: 54 µs per 512-entry chunk (≈ 0.1 µs per entry, no allocations; `BenchmarkSortChunk`).
- The golden test's `scanId` is now normalized: on Linux, inotify reports the test's own writes and watcher rescans take
  scan ids at timing-dependent moments (seen under `-race`).
- **Created time on Linux** (carried over from viewer Stage 05): the scanner and find list entries with `statx`
  relative to the directory's descriptor (`fsx.EntryInfo`), single files through `fsx.Stat`; `Sys()` stays the
  `*syscall.Stat_t` that `os.Lstat` returns (`TestEntryInfoMatchesLstat` compares every field). One syscall per entry,
  as before: 0.87 µs vs 1.1 µs per entry for `lstat` (1,000 files), 196–224 ms vs 231–266 ms over `flat-100k`.
  Kernels or seccomp profiles without `statx` (ENOSYS, EPERM) fall back to `lstat` without birth times.
- **Quick access listed home three times** on Linux systems whose XDG user dirs point at home (xdg-user-dirs writes
  that for folders that do not exist, and Electron returns home for them): a place other than home that resolves to
  home is dropped (desktop `workspace.test.ts`).
- **Mark by mask was silently dropped while the folder refreshed** (all platforms): a rescan commits in batches, every
  commit makes a new query version, and `markByMask` discarded an answer for an older version. It now matches again
  against the new version (up to 4 attempts). Found by `marks.spec.ts` "each carry-over option…", which failed in
  3 of 7 runs here.
- **Keys were undone by a refresh** (commander, all platforms): an invalidated panel looks its cursor entry up in Go
  and moved the cursor back to it, overwriting keys pressed during the round-trip (seen as a lost ArrowDown in the C01
  100k spec: the right panel's cached folder refreshed while the test pressed keys; 5 of 6 runs failed after another
  test). The lookup now leaves a cursor the user moved meanwhile (a file operation's pending focus still applies).
- The C03 spec "bookmarks and recent locations are one list" assumed the bookmark rows were mounted; the viewer's
  sidebar is virtualized and reveals the open folder, and on Linux `/` lists about 20 folders above `/tmp`. The spec
  scrolls the list to the top first.

### First CI run (Windows, macOS, Linux runners)

- **Windows: the file watcher could deadlock** (`TestWatchDoesNotBlockWhileEventsFlow` hung for 2 min). `Watch` held
  the watcher's lock while calling fsnotify's `Add`; on Windows `Add` waits for fsnotify's I/O goroutine, which was
  waiting to hand an event to our loop, which waited for the lock. `Add` and `Remove` now run outside the lock (an
  evicted folder is not removed if a `Watch` took it back meanwhile).
- Windows: `TestBurstBecomesOneRelist` saw two re-listings for 200 writes: on the runner the burst paused longer than
  the test's 100 ms quiet window. The test uses a 500 ms window; it checks coalescing, not runner speed.
- macOS: the pause tests assumed a streaming copy, but on APFS the fast path is `clonefile`, one instant step with no
  pause point. The fileops test checks the clone itself (complete, full progress, same bytes); the jobs pause test
  forces the streaming copy on macOS (`fileops.ForcePortableCopy`).
- Linux runner: the C07 archive scenario pressed F8 before closing the lister had returned the focus to the panel;
  the spec waits for the focus. The C03 tab-switch benchmark measured 76 ms (budget 50 ms on the reference machine);
  under `CI` the gate is twice the budget, and the measured values are recorded either way.

### Linux results

- Go: all packages pass, also under `-race`. The real-trash tests (`FASTVIEW_TEST_TRASH=1`) pass with the
  freedesktop trash. Skipped by design: long paths (Windows), the permission test (runs as root here), 7-Zip.
- Unit: contracts 72, renderer-core 12, media-ui 5, desktop 110, ui 26, viewer 164, commander 123.
- E2E: the commander and app-switch specs pass (37 of 37, 4.9 min). The C03 tab-switch and C06 find benchmarks missed their
  budgets only while another suite loaded the same 4 vCPUs; idle they pass.
- The packaged smoke test passes.

## Open

- **The viewer's e2e specs** still click "Open folder…", which the first screen no longer shows (the startup folder
  opens home; open since C06, see the C07 record). They need a way to open a folder from the UI (a product decision:
  for example an Open folder shortcut) or a test path; until then CI runs the commander and app-switch specs only.
- Windows and macOS: the first CI run is the first run of the packaging and smoke test there, and of the e2e suites on
  macOS. The macOS `clonefile` path, "Put Back", FSEvents vs kqueue, and NFC/NFD names are verified in that run or by
  hand on a Mac.
- Not started: volume tests (removable, network, labels), Unicode normalization and per-volume case sensitivity for
  `path_key`, Windows UNC and reserved names, ffmpeg/ffprobe and 7-Zip discovery per OS, trackpad and wheel inertia,
  startup and idle-memory budgets per OS (`BENCH_STAGE=P04`).
- Link copies with the privilege (Windows) remain a manual check.

## Exit checklist

- [ ] implementation complete (packaging, CI and Linux done; see Open)
- [ ] tests complete
- [ ] benchmark complete (scanner ordering and statx measured; startup and memory per OS open)
- [x] performance regression reviewed (scanner listing: statx faster than lstat, chunk ordering ≈ 0.1 µs per entry)
- [ ] docs/ADR updated (ADR-0032 accepted; this record continues)
