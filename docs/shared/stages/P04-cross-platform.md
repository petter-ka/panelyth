# Stage P04 — Cross-Platform Hardening

Status: **In progress** (started 2026-10-08; packaging, CI and the Linux pass done; taken up again 2026-10-12: paths,
volumes, media tools, wheel input and the viewer's e2e specs done on Windows and Linux; the macOS items remain).
Track: platform (formerly viewer Stage 09). Depends on: P03 and the app stages in scope (see `docs/ROADMAP.md`).
Applies to both apps; when the viewer ships first, it runs with the viewer in scope and C11 repeats the commander
parts.

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

- Packager: **electron-builder** (`src/shared/desktop/electron-builder.yml`), run by `pnpm package`
  (`scripts/package.mjs`), which builds the bundles and the sidecar for each target arch
  (`pnpm build:sidecar --arch x64,arm64 [--platform …]` now cross-compiles). Windows NSIS (x64), macOS DMG and zip
  (arm64, x64; ad-hoc signed), Linux AppImage and tar.gz (x64). The sidecar ships per arch in `resources/bin/`, the
  renderers in `resources/renderer/` and `resources/commander/`, as `paths.ts` already expected.
- Packaged smoke test: `src/shared/e2e/smoke/packaged.spec.ts` (`pnpm test:smoke`, after `pnpm package --dir`): launch
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
  the spec waits for the focus. Timing budgets are set for the reference machine; the shared runners missed them by
  2-4x (Linux: C03 tab switch 76 ms, budget 50; Windows: C06 find first result 1,327 ms, budget 300; macOS: tab
  switch 168 ms). A doubled CI gate was tried first and was not enough. Timing and long-task budgets now go through
  `expectWithinBudget` (`src/shared/e2e/launch.ts`): they fail on the reference machine and developer machines, and under
  `CI` an over-budget value is a GitHub warning annotation. Structural checks (bounded mounted rows, heap growth, the
  dead drive never blocking) stay hard everywhere. Budgets are measured on the reference machine (P05).

### First macOS e2e run

- **macOS file watching** (carried over from ADR-0020): fsnotify's kqueue backend opened every file of a watched
  folder, synchronously inside `dir.open`, and kept the descriptors it had opened when one failed. After `flat-100k`,
  the next folder could not be opened (C06 and C02 benchmarks: "no rows for …/tree-50k"), the 100k listing painted in
  1.2 s, and tab switches took 168 ms. The sidecar now watches each folder through one kqueue descriptor on the folder
  (ADR-0020 amended); Linux and Windows keep fsnotify behind the same small backend interface.
- Specs: the C04 large-file copy completes at once on APFS (a clone), so it is paused only while still running (the
  cancelled second copy already allowed this); the shortcut list shows "⌘I" on macOS; Ctrl+click is a right-click on
  macOS, so the C02 spec clicks with Cmd there (`ControlOrMeta`). Plain Ctrl key presses already count as Mod on macOS.

### First Windows e2e run

- **The path editor closed while typing** (commander, all platforms): a late "app shown" event focused the panel's
  list, the path text box lost focus and its editor closed (the dead-network-drive spec: a slow start, then
  `goTo` found no text box). Being shown no longer takes the focus from a text field (`listing.test.tsx`).
- **Carried marks overwrote the user's marks** (commander, all platforms): switching back from the viewer asks Go
  for the viewer's selection and applied it as marks even when keys had changed the marks during that round-trip
  (Windows: Ctrl+Num− and a mask right after the switch were undone). The carried marks now apply only while the
  marks are unchanged (`marks.test.tsx`).
- Windows runners: on-access scanning of the freshly created 100k-file fixtures stalled a listing for minutes and
  slowed the first start; CI excludes the workspace and temp folders from Defender, and the first start may take
  45 s under `CI`.
- `library.db` stays locked for a moment after the app closes on Windows: the C01 specs remove their profile with
  retries, as the C03 specs already did.

### Linux results

- Go: all packages pass, also under `-race`. The real-trash tests (`PANELYTH_TEST_TRASH=1`) pass with the
  freedesktop trash. Skipped by design: long paths (Windows), the permission test (runs as root here), 7-Zip.
- Unit: contracts 72, renderer-core 12, media-ui 5, desktop 110, ui 26, viewer 164, commander 123.
- E2E: the commander and app-switch specs pass (37 of 37, 4.9 min). The C03 tab-switch and C06 find benchmarks missed their
  budgets only while another suite loaded the same 4 vCPUs; idle they pass.
- The packaged smoke test passes.

## Progress (2026-10-12)

Second slice, on the reference machine (Windows 11, i9-13900K) with the Go suite also run on Linux in a container
(Docker Desktop, WSL2 kernel, Go 1.27; as root and as an ordinary user). The "not started" items of the first slice,
the viewer's stale e2e specs, and what those runs found. macOS was not run: its parts are built for it and vetted
(`GOOS=darwin go vet`), and are named under "Open".

### Media tools per OS (ADR-0018, ADR-0030, amended)

- ffmpeg, ffprobe and 7-Zip are found by one finder (`internal/platform`, `ToolFinder`): the environment variable,
  next to the sidecar, `PATH`, then the folders package managers install to. **macOS: an app started from the Finder
  or the Dock gets a `PATH` without Homebrew and MacPorts**, so `PATH` alone found nothing there; `/opt/homebrew/bin`,
  `/usr/local/bin` and `/opt/local/bin` are searched. Linux adds `/usr/local/bin` and `/snap/bin`; Windows keeps
  `Program Files\7-Zip`.
- Only a complete packaged pair is used (ffmpeg beside the sidecar with the system's ffprobe is not mixed), and a
  wrong path in the variable does not fall back.
- The rules of each OS are tested on any host through an injected finder (`platform/tools_test.go`,
  `video/locate_test.go`, `archive/locate_test.go`); on this machine the sidecar finds the winget ffmpeg a shell finds.

### Paths and names (ADR-0015, amended)

- **Unicode normalization** (carried over): the key was NFC on every OS. That is right on macOS, where the composed
  and the decomposed form of a name are one file, and wrong on Windows and Linux, where they are two: a folder
  holding both showed one. The key is NFC on macOS only. Comparing two folders still pairs the two forms on every OS
  (`pathkey.NameKey`), since the sides may be volumes of different systems.
- **Case sensitivity per volume** (carried over): decided, not built. The key folds case by the platform's default
  (Windows and macOS fold, Linux does not). The cost is tested and recorded in ADR-0015: in a folder marked
  case-sensitive on Windows (`fsutil`, tested here) or on a case-sensitive APFS volume, two names that differ only in
  case share one row; on a case-insensitive volume under Linux, a folder reached by a path typed in another case gets
  a second key.
- **Names Windows rewrites** (found): a name ending in a dot or a space, or a device name such as `NUL`, was listed
  and then opened under the path Win32 makes of it. `photo.jpg.` opened `photo.jpg` (deleting the stray file would
  have deleted its neighbour) and `NUL` opened the null device (it read as an empty file). The index and the
  folder tree now join a listed name with `fsx.JoinName`, which gives the path the `\\?\` prefix where Windows itself
  says it would open something else; keys, volume ids and breadcrumbs ignore the prefix. The Recycle Bin refuses
  such an item with a reason; reading, deleting, folder sizes and folders with such names inside are tested
  (`scan/names_test.go`). Cost: 129–142 ns per join against 117–123 ns for `filepath.Join`, one allocation each
  (`BenchmarkJoinName`).
- **Long paths and UNC**: a folder 600 characters deep lists and opens; a folder on a share (the loopback admin
  share) lists by its UNC path, is a folder of its own to the index, and its root is the breadcrumb's root.

### Volumes

- **macOS**: the list came from reading `/Volumes` and resolving every entry, which can wait on a share that
  stopped answering, and every volume but the boot volume was "removable". It now comes from the mount table without
  waiting for any filesystem (`getfsstat`, `MNT_NOWAIT`): network filesystems are `network`, discs `optical`, mounts
  the Finder hides are left out. The selection is a pure function tested on every OS (`fsx.DarwinVolumes`); the
  system call around it has not run on a Mac yet.
- **Linux**: discs (`iso9660`, `udf`) are `optical`.
- **Windows**, on real drives: a substituted drive appears in the list and in the monitor's signature and
  disappears again, with the label and space of the disk behind it; a mapped share is `network`, has space and no
  label (a share's label is not read, by design).
- **Linux trash** (carried over from ADR-0021): verified on a second volume as an ordinary user. Where the volume's
  top folder is writable the item goes to `.Trash-$uid` there with a relative path; where it is not, the item stays
  and the error is `TRASH_UNAVAILABLE`. **Found: a fresh account had no trash at all.** `~/.local/share` does not
  exist until something creates it, the home trash was then skipped, and the fallback at the top of the home volume
  cannot be created by an ordinary user. The home trash is now made when it is first needed.

### Trackpad and wheel (carried over from viewer Stage 03)

- The lists scroll natively, so inertia is the browser's. Where the wheel **steps** instead (next file, tile size,
  rows of the lister's byte views), every event stepped once: a trackpad sends dozens per swipe. Steps now follow
  the distance travelled (`createWheelStepper` in `src/shared/ui`): the first event of a gesture steps, so one notch
  of any mouse is one step whatever the system reports for it (Chromium on Windows reports 100 px, macOS far less
  for a slow notch), and within a gesture a step takes a notch of travel.
- **Found: wheel navigation stepped once per event for every device.** The picture, with its wheel handler and the
  time of the last step, is replaced at every step, so the 140 ms limit never applied to the next event: eight
  events were eight pictures. The stepper now belongs to the window. (`viewer.test.tsx`, with the real image
  viewer.)
- Tested with modelled streams (notches, a spun wheel, a slow drag, a swipe with decaying inertia, a pinch); not yet
  felt on a real trackpad.

### E2E

- **The viewer's stale specs are repaired** (open since C06): `jobs`, `media`, `polish`, `previews`, `viewer`,
  `workspace` and `theme`, 34 tests. They show their folder through `showDialogFolder` (`src/shared/e2e/launch.ts`);
  measurements that must not miss the first events are installed at every load (`atEveryLoad`). `viewer.spec.ts`
  follows the picture into the media window, where a double-click opens it since ADR-0033; `theme.spec.ts` chooses
  the theme in Settings → Appearance.
- **Fixtures emptied by a temp cleaner** (the reference machine: Storage Sense, with the disk 99 % full) left their
  markers, and specs then tested what was left: the tiles spec saw 400 of 2,000 folders, the rename benchmark no
  files. A fixture's marker now carries the count of its root's entries and a tree with fewer is generated again
  (`internal/fixture`); the two spec-local fixtures check their content.
- Found by the Linux run: an FTP download test expected a name with a backslash to be refused everywhere (it is an
  ordinary character outside Windows); an attributes test left a folder an ordinary user cannot empty.

### Results

- Go, Windows: all packages pass. Go, Linux: all 31 packages pass as root and as an ordinary user (with the real
  trash), and the race detector passes over the eight packages changed here.
- Unit: contracts 202, i18n 26, renderer-core 39, desktop 272, ui 88, docviewer 15, media-ui 23, viewer 321,
  commander 288.
- E2E, Windows, every spec of both apps (121 tests, 11.6 min): 116 pass. Four are the commander tests that predate
  the document window (see Open). The fifth, `editor.spec.ts` "the commander's Edit lands in the viewer's editor",
  got no rows for its fresh folder once in two full runs and passes 5 of 5 alone.
- The packaged smoke test passes on Windows (1.4 s). Its last step waited for the in-page viewer and now follows
  the picture into the media window; it also drops `ELECTRON_RUN_AS_NODE`, which an editor's terminal sets and with
  which the packaged app never starts.
- Bundles against P01's last build: viewer JS +499 bytes (0.06 %), commander +339 bytes (0.04 %), the wheel stepper
  (`stage-P04-2026-10-12-petter-bundle.json`).
- Startup (`stage-P04-2026-10-12-petter-startup.json`): ready-to-show p50 262 ms, sidecar ready 162 ms, ping p95
  0.2 ms, sidecar exit 21 ms. Idle memory 446.8 MB, 153.3 MB over an empty Electron: as in Stage P01 (448.4 MB)
  and since C00, because a fresh profile opens Home at start and the sidecar decodes its covers (C00's record; the
  benchmark is to start without a folder again in P05).
- Media window: a step to the next 12 MP picture takes 636 ms at p50 and 702 ms at most; a 48 MP original shows
  91 ms after 1:1 with no long task (`stage-04-2026-10-12-e2e-viewer.jsonl`).

## Open

For the owner:

- **Case-sensitive folders and volumes** (ADR-0015, decided in this stage): the key folds case by platform, not by
  volume. Two names that differ only in case share one row in a case-sensitive folder on Windows or on a
  case-sensitive APFS volume. Say so if per-volume detection should be built before the release after all.
- **The media window has less than the full-screen viewer it replaced** (ADR-0033): no Ctrl+C or "Copy picture", no
  context menu, no rotate or flip, no Home and End, and no prefetch of the neighbours, so a step to the next 12 MP
  picture takes 636 ms at p50 where the in-page viewer took 1 ms for a prefetched one (Stage 04). The in-page
  viewer still exists and opens only when the media window cannot. `polish.spec.ts` no longer checks the copy
  inside the viewer.
- **Whether Enter on a `.cmd` should ask to run it or show it** (see the stale commander tests below).
- `pnpm lint` fails on formatting in `showcase/src/main.jsx` and `showcase/src/styles.css` (committed in
  `bc06a82`), which fails the CI lint job; `prettier --write` on the two files fixes it.
- `pnpm package` could not replace `src/shared/desktop/release/win-unpacked` on the reference machine (EBUSY: some
  program holds the folder; no Panelyth process was running). The package was built into another folder and passed
  the smoke test from there.

Not run on a Mac (built and vetted for it, tested through pure functions where possible):

- the volume list from the mount table (`getfsstat`), the Homebrew and MacPorts folders, NFC keys with composed and
  decomposed names on APFS (`TestComposedAndDecomposedNames` runs there in CI), the `clonefile` path, the e2e run
  after the watcher change;
- "Put Back" for items sent to the trash (ADR-0021): the trash is a rename into `.Trash`, which the Finder does not
  offer to put back. It needs Finder scripting, cgo or Electron's `shell.trashItem` from main; undecided;
- the wheel stepper on a real trackpad (macOS and a Windows precision touchpad).

Still open from the first slice:

- **Four commander e2e tests are stale since ADR-0033** (they fail at `bc06a82`): `archives.spec.ts` scenario 13
  and `viewers.spec.ts` scenario 11, "safety" and "bench" press F3 or Enter on a text file and wait for the in-app
  lister or the program dialog, but such a file now opens in a document window (`commander.settings`
  `documentOpen` is "window" or "system"; there is no in-app choice). They need the document window's page.
  "safety" presses Enter on `tool.cmd`: `cmd` is a text extension (`src/shared/contracts/src/documents.ts`), so the
  file opens as text and the "run this program?" dialog never shows.
- **E2E in CI**: the suites are switched off in `ci.yml` (runner minutes). With the viewer's specs repaired, the
  step can name `specs` as a whole when it is switched on again. Windows e2e was not blocking (owner's decision,
  2026-10-08); its open races: a restart opens the viewer instead of the last used commander when the start takes
  longer than the 400 ms wait for the shared context; the C02 carry-over spec failed twice on the runner.
- Startup and idle-memory budgets on Linux and macOS (`BENCH_STAGE=P04` was run on Windows only).
- Windows on a real removable drive and a real network server: the kinds and timeouts are tested with a
  substituted drive, the loopback share and stubbed space reads.
- Packing, checksum files and FTP uploads of a folder that holds a name Windows rewrites still walk it with plain
  joins: a name with a trailing dot or space inside fails there as not found. A file named `NUL` inside may be
  read as empty (not tested).
- Linux: shares mounted by the desktop (`gvfs`, under `/run/user`) are not in the drive list; they open by path.
- Link copies with the privilege (Windows) remain a manual check.
- On the reference machine one commander unit test failed once in eight runs of the suite and was not caught again
  (the machine's intermittent faults, see `docs/DEVELOPMENT-STAGES.md`).

## Exit checklist

- [ ] implementation complete (the macOS items and the commander's four stale e2e tests remain; see Open)
- [ ] tests complete (not run on a Mac; no real trackpad)
- [ ] benchmark complete (startup and memory measured on Windows; Linux and macOS open)
- [x] performance regression reviewed (statx faster than lstat, chunk ordering ≈ 0.1 µs per entry, the name join
  ≈ 10 ns per entry; startup as in P01)
- [ ] docs/ADR updated (ADR-0032 accepted; ADR-0015, 0018, 0021 and 0030 amended; this record continues)
