# Stage P06 — Release Engineering

Status: **Implementation done on Windows** (2026-10-12, at the owner's request, before P05). ADR-0038 accepted. The
signing certificates, an update feed installed apps can read, and the macOS and Linux runs remain (see "Open").
Track: platform (formerly viewer Stage 11). Depends on: P05 (taken out of order: P05's budgets are not a condition of
anything built here). Packaged builds include both apps and enable the commander, as recorded in ADR-0031.

## Objective

A repeatable, signed release pipeline for the product: one shell containing both apps, with the commander enabled
(ADR-0031).

## Scope

- One product version; the sidecar binary is versioned with it and reported in `hello`.
- Signed artifacts for each OS; macOS notarization.
- Update strategy (auto-update channel or manual).
- Installer smoke tests on clean machines.
- Cache and index migrations: an `index.db` version change drops the cache (ADR-0016); `library.db` migrations are
  tested from every released schema.
- Third-party binaries and notices: an **LGPL** ffmpeg/ffprobe build next to the sidecar, never a GPL build
  (ADR-0018); 7-Zip for the commander only if its licence fits (ADR-0030); one licence notice file.
- Release documentation (install, data locations, uninstall, known limits).
- Clean-machine validation of the packaged app with the commander enabled; verify the viewer-only development mode
  separately.

Added by the owner when the stage started (2026-10-12):

- The app is upgraded from inside the app: an About place with the version, the check, what changed and the install.
- A native menu with the useful entries, About among them.

## Acceptance criteria

- The product can be built, signed, installed, updated and removed on all three OSes from the pipeline alone.
- Notices list every bundled third-party component.

## Decisions applied

ADR-0038 (accepted in this stage): one version, updates, the native menu, signing, the release pipeline, notices and
the ffmpeg build. It amends ADR-0032 (the packager's configuration, the release trigger), ADR-0018 (the build that
ships), ADR-0027 (six methods in both profiles) and ADR-0034 (the menu's text). `docs/shared/REQUIREMENTS.md` NFR-06
names the update check as the one network request the app makes by itself.

## What was built (2026-10-12)

### In the app

- **Settings → About** (a tab of the shared settings dialog, both apps): the version; the update state with one
  action at a time (Check for updates → Download and install → Restart to update); the newer version's notes;
  "Check automatically"; buttons for the release notes, a problem report, the log folder and the third-party
  licences; the sidecar's, Electron's, Chromium's and Node's versions.
- **Updates** (`src/shared/desktop/src/main/updates.ts`): Electron main checks 15 s after start and every six hours,
  downloads only when asked, and installs on restart or when the app is closed. A build that cannot install (an
  unsigned macOS app, a Linux tar.gz) finds the version and offers the download page; a development build says it
  does not update. A waiting version marks the Settings button of the rail in both apps.
- **The native menu** (`menu.ts`, `menuText.ts`): File, Edit, View and Help (plus the app and Window menus on
  macOS), in the eight languages of the apps. Help has Keyboard Shortcuts, Check for Updates…, Release Notes, Report
  a Problem, Panelyth Website, Open Log Folder, Third-Party Licenses and About Panelyth. Electron's default menu,
  with its links to Electron's site and Reload in release builds, is gone.
- **Contracts**: `app.about`, `app.openTarget`, `update.get`, `update.check`, `update.download`, `update.install`
  (main-local, both profiles); events `update.state` and `menu.command`; the shared setting `shared.updates`.
  `app.openTarget` takes one of five names; no method takes a URL, a path or a version.

### In the pipeline

- **One version** (`scripts/version.mjs`): `PANELYTH_VERSION` or the desktop package's; the sidecar reports
  `<version>+g<commit>`; a packaged shell logs an error when its sidecar is another version's.
- **Packaging** (`scripts/package.mjs`, `src/shared/desktop/electron-builder.config.mjs`): the build, the sidecar,
  ffmpeg, the notices, then electron-builder; signing, notarization and the update feed come from the environment;
  the build prints whether the package will be signed and where it will look for updates.
- **Notices** (`scripts/notices.mjs`): `THIRD-PARTY-NOTICES.txt`, generated from the bundles' dependencies, main's
  source maps, the sidecar's Go modules and `build/third-party.json`; it fails on a missing licence text or a licence
  outside the allowed list. 89 components with ffmpeg, 88 without.
- **ffmpeg** (`scripts/media-tools.mjs`, `media-tools.json`): an LGPL build pinned by URL and SHA-256 for Windows
  x64 and Linux x64, beside the sidecar; a GPL or non-free build is refused.
- **Release workflow** (`.github/workflows/release.yml`): a tag builds Windows, macOS and Linux, smoke-tests each,
  runs the install → update → uninstall test on Windows, and creates a draft release with the packages, the update
  metadata and `SHA256SUMS.txt`. `ci.yml` packages with the notices and ffmpeg and checks them in the smoke test.
- **Migrations**: `library.db` is opened from every schema since the first with a user's rows and checked afterwards;
  released migrations are pinned by SHA-256; a newer library is refused and left untouched; `index.db` is recreated
  from a newer schema as from an older one.
- **Documentation**: `docs/RELEASING.md` (the procedure, the secrets, the release rules), `docs/INSTALL.md` (install,
  update, data locations, uninstall, known limits).

## Tests

- Electron main (vitest): the update service (20: every phase, the automatic check and its setting, a build without
  updates, progress throttling, a failed download, out-of-turn calls, the mode by platform, notes to text, the
  scripted engine), the menu (10: both layouts, the items' actions, the update item's label, the app switch and
  its mark moved in place, development-only items, the rebuild key, eight complete language tables), the fixed
  targets (4), the router (both profiles get the methods; a URL, a path or an unknown name as a target is refused).
- Shared UI and stores (vitest): the About tab in every update state, notes as text (a tag in them is shown, never
  built), the automatic-check switch, the menu's items in an app, the rail's mark (12); the About store, including
  an event that overtakes the answer of `update.get` or `update.check` (7). The message catalogs are complete in
  seven languages (24 new messages).
- Go: a library from each of the six schemas opens with its rows; the refused newer library; the pinned migrations;
  the index recreated from a newer schema.
- E2E, unpackaged (`src/shared/e2e/specs/about.spec.ts`, 5 tests, with a scripted update engine): the menu's items
  and their actions, the whole update flow in the viewer and its state in the commander, the shared setting, the
  menu in Hungarian after a language change, a development build without updates, refused targets.
- Packaged smoke (`pnpm test:smoke`, 2 tests): the shell's and the sidecar's version, the menu without Reload and
  developer tools, the update mode, the About tab, the notices' contents, ffmpeg beside the sidecar; then the P04
  walk through both apps.
- **Install → update → uninstall** (`pnpm test:update`, Windows): 0.9.0 and 0.9.1 packaged against a feed on the
  machine; 0.9.0 installed silently; Settings → About found 0.9.1 and showed its notes; downloaded; "Restart to
  update" replaced the program and started 0.9.1 (shell and sidecar both 0.9.1); the uninstaller removed the program
  and its registration and left the user's data. 2.1 minutes, passed.

## Results (reference machine, Windows 11)

- Unit tests: 1,333 TypeScript tests in 97 files and the Go suite pass. One viewer test
  (`editor.test.tsx`, "asks before replacing the original") failed once in four runs on a focus timing between a
  menu and a dialog; it touches nothing of this stage.
- E2E, the whole suite (`src/shared/e2e/specs`, 126 tests, 10.4 minutes): 121 passed. Four of the five failures
  are the commander tests P04 records as stale since ADR-0033 (`archives` scenario 13; `viewers` scenario 11,
  "safety" and "bench"). The fifth was a race in the harness, fixed here (see "Found and fixed").
- **Startup** (`BENCH_STAGE=P06 pnpm bench:startup`, 10 launches a run, three runs): ready-to-show p50 291, 286 and
  253 ms; the first two ran right after the package builds, with the sidecar ready 80 ms later than usual. The
  third matches P04's 262 ms and P01's 256–266 ms: no change. The update library is not loaded at start (its chunk
  is read by the first check).
- **Idle memory**: 445–448 MB for all processes, 149 MB over the empty-Electron floor; P04 measured 447 and 153.
  Unchanged (and over the budget as before: the benchmark opens Home, C00's record).
- **Bundles** (`pnpm bench:bundle`), against P04's record, which is two unrelated commits older: viewer JS 787,391 →
  793,128 B (+0.7 %), commander 898,753 → 903,808 B (+0.6 %), the document window +264 B; each language file grows
  by 1.5 kB. Main: `main.cjs` 205 kB plus a 524 kB chunk with the update library.
- **Package**: the Windows installer is 190 MB with ffmpeg (137 MB before); the libraries of the LGPL build are
  160 MB unpacked.
- **ffmpeg** (the pinned Windows build, with the sidecar's own arguments): probes and makes a poster from H.264, HEVC,
  VP9, AV1, MPEG-4, ProRes and WMV samples.

## Found and fixed while building

- The commander's preload has its own list of event channels. Without `update.state` in it, subscribing threw and
  the commander did not render at all. Found by the e2e run; the commander's foundation spec fails on it.
- The answer of `update.check` could arrive after the `update.state` event of a check that finished at once, and
  the tab stayed on "Checking…". The state now comes from the events alone.
- The menu was rebuilt on every app switch, to move the mark in View. A switch now changes `checked` on the two
  items of the menu that is there and builds nothing; the menu is rebuilt for a new language or a new update
  step only.
- **A race in the e2e harness** (`src/shared/e2e/launch.ts`): with the commander shown at start, Playwright's
  first page was sometimes the commander's view, and `switch.spec.ts` ("a folder that changed while its app was
  hidden") then looked for the viewer's tiles in it. It failed 9 of 13 runs on this machine today; `launchApp`
  now returns the viewer's page, and the test passed 17 of 18 runs afterwards (one failure unexplained).
- electron-builder writes `app-update.yml` for installer targets only. An unpacked `--dir` build has no feed and
  reports the mode `off`; the smoke test asks for the feed only where an installer was built.
- A Linux LGPL shared build finds its libraries in `../lib` (RPATH `$ORIGIN/../lib`), so they cannot sit beside the
  programs. The package has `resources/lib` for them. Checked in a container; the packaged Linux app was not run.
- The Go video tests make their samples with `libx264`, which no LGPL build has. They need a full ffmpeg on the
  `PATH`; the bundled build is for the product, and `pnpm media-tools --clean` takes it out of the development tree.

## Open

Needs the owner:

- **The update feed.** `github.com/petter-ka/panelyth` is not readable without an account. Until the releases are
  public, or `PANELYTH_UPDATE_URL` names another feed, an installed app's check fails and says so.
- **Certificates.** No signing identity exists yet. The pipeline signs and notarizes when the secrets are set
  (`docs/RELEASING.md`); none of that path has run. Unsigned: SmartScreen and Gatekeeper warn, and a macOS app cannot
  update itself.
- **The first version number**, and whether the first release ships FTP (carried from C10.5).
- **The ffmpeg build.** The pinned one is a full LGPL version 3 build: 53 MB more to download, and the libraries
  inside it are named by its configuration, not listed one by one in the notices. A build of our own with only
  the decoders that posters need would be a few megabytes, LGPL 2.1, complete in the notices, and would cover
  macOS. LGPL 3 also asks for the GPL's text beside the LGPL's; the build's licence file has the LGPL only.

Not run:

- macOS: the packaged app with the new menu (the app menu, an item chosen with no window open), signing,
  notarization, an update. ffmpeg is not bundled there.
- Linux: the package with ffmpeg in `resources/lib`, the smoke test, an AppImage updating itself.
- The release workflow itself (it runs on a tag).
- The NVDA pass over the About tab.

Smaller:

- The reference machine's system drive was full during this stage (11 GB free of 1.9 TB), and timings taken right
  after the package builds were slower than the settled ones; `openwith.spec.ts` failed once in eight runs and
  `editor.test.tsx` once in four, both on timing.
- `release/win-unpacked` was held open by another program on the machine, so `pnpm package --dir` could not
  replace it; the packages of this stage were built into other folders under `release/` and removed afterwards.
- A failed check's reason is the update library's English text.
- Notes of a version are cut at 8,000 characters; the release page has the rest.
- `pnpm test:update` starts the updated app once with the account's normal profile (the installer starts it, outside
  the test's environment); the test closes it.

## Exit checklist

- [x] implementation complete (Windows; macOS and Linux parts built, not run)
- [x] tests complete (unit, e2e, packaged smoke, install → update → uninstall on Windows)
- [x] benchmark complete (startup, memory, bundles)
- [x] performance regression reviewed (both apps: no change at start or idle)
- [x] docs/ADR updated (ADR-0038; ADR-0018, 0027, 0032, 0034 amended; RELEASING, INSTALL)
