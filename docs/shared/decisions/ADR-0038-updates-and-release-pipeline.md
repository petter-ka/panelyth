# ADR-0038 — Updates, the Native Menu and the Release Pipeline

## Status

Accepted (Stage P06, 2026-10-12). Settles what ADR-0032 left to P06: signing, notarization, updates and the
ffmpeg build to ship. Amends ADR-0032 (the release trigger, the packager's configuration file), ADR-0018 (the build
that ships), ADR-0027 (six methods in both profiles) and ADR-0034 (the native menu's text).

## Context

- The owner asked that the app be upgraded from inside the app: an About place that shows the version, finds a
  newer one, says what changed and installs it. And a native menu with the useful entries.
- Until now the window had Electron's default menu: its Help opens Electron's own site, and its View reloads the
  page and opens the developer tools in a release build.
- The packages come from electron-builder (ADR-0032). They were unsigned and carried no update metadata.
- The product has one shell, two apps and a sidecar (ADR-0031). A user cannot tell which of them is "the version".
- Electron main may reach the network; no renderer can (`connect-src 'self'`, ADR-0027). Text from a release feed is
  markup from the network.

## Decision

### One product version

- The shell, both apps and the sidecar carry one version. A release is named by `PANELYTH_VERSION` (the release
  workflow takes it from the tag: `v1.2.3` → `1.2.3`); every other build has the version of
  `src/shared/desktop/package.json`. `scripts/version.mjs` is the one place that reads it and refuses what is not
  semver.
- The sidecar is built with that version plus the commit as semver build metadata (`1.2.3+g1647109`) and reports it
  in `hello` and `system.info`. A packaged shell logs an error when its sidecar's version (before the `+`) is not
  its own. Settings → About shows both.

### Updates

- **electron-updater**, bundled into Electron main, reads the feed the build names. Default: the project's GitHub
  releases. `PANELYTH_UPDATE_URL` names any static HTTPS folder instead; `none` builds a package that never updates.
  The feed is `latest*.yml` beside the release's files; a download is verified against its SHA-512, and on Windows
  against the running app's publisher when the app is signed.
- **The user decides.** The app looks for a newer version 15 seconds after start and every six hours (Settings →
  About "Check automatically", the shared setting `shared.updates`; on by default). Finding one downloads nothing.
  "Download and install" downloads it; "Restart to update" quits, installs silently and starts the new version. A
  downloaded version also installs when the app is closed.
- **What a build can do** (`UpdateState.mode`):

  | Build | Mode |
  |---|---|
  | Windows installer | `auto`: downloads and installs |
  | macOS, signed with a Developer ID | `auto` |
  | macOS, ad-hoc signature | `manual`: finds the version, shows its notes, opens the download page |
  | Linux AppImage | `auto` |
  | Linux tar.gz | `manual` |
  | development build, or a package built with `none` | `off` |

- **Main owns all of it.** The state machine is `UpdateService` (`src/shared/desktop/src/main/updates.ts`) over an
  engine port; the apps get the state as `update.state` events and name the next step (`update.check`,
  `update.download`, `update.install`). No method takes a URL, a version or a file. The update library is loaded by
  the first check, never at start.
- **Release notes are plain text.** GitHub sends HTML. Main strips the markup (`notesToText`), cuts a note at 8,000
  characters and sends text; the renderer shows it with `white-space: pre-wrap`. Nothing from the network is ever
  parsed as markup in a renderer.
- **A failed automatic check says nothing**; it is logged and tried again. A check the user asked for shows its
  error.
- A version that waits (found, or downloaded) marks the Settings button of the rail in both apps, and the native
  menu's update item names the next step.

### Settings → About

- A tab of the shared settings dialog (`src/shared/ui`, both apps): version, the update state with its one action,
  the notes, "Check automatically", and four buttons: release notes, report a problem, the log folder, the
  third-party licences. Below: the sidecar's, Electron's, Chromium's and Node's versions and the platform.
- `app.openTarget` takes one of five names (`logs`, `notices`, `releases`, `issues`, `website`); main maps a name to
  a folder of its own, a file it ships or a page of the project. A renderer never names a URL or a path.

### The native menu

- Main builds the application menu (`src/shared/desktop/src/main/menu.ts`) and sets it before the window opens.
  `Menu.setApplicationMenu(null)` runs before the app is ready, so Electron never builds its default menu.
- Windows and Linux: File (Settings…, Exit), Edit, View (Viewer / Commander, full screen, zoom), Help (Keyboard
  Shortcuts, Check for Updates…, Release Notes, Report a Problem, Panelyth Website, Open Log Folder, Third-Party
  Licenses, About Panelyth). macOS: About, Check for Updates… and Settings… are in the app menu; a Window menu is
  added. Development builds add Reload and the developer tools; a release has neither.
- Amended 2026-10-23 (owner request): on Windows and Linux no window shows the menu bar (the main window calls
  `setMenuBarVisibility(false)` like the media, settings and document windows; Alt does not bring it back). The menu
  stays set, so its accelerators (Settings…, zoom, full screen, and Reload and the developer tools in development)
  still work. The menu's other items are reached from the apps: the rail (switching apps), Settings → About (updates, release
  notes, logs, licenses) and Settings → Shortcuts.
  macOS is unchanged: its menu is the system's menu bar, not a row in the window.
- Items that belong to an app (About, Check for Updates…, Settings…, Keyboard Shortcuts) are sent to the app on
  screen as a `menu.command` event; the app opens its own dialog. An item chosen while no window is open (macOS)
  opens the window and is handed over when the viewer asks for the update state, which it does once it listens.
- The menu's text is main's: `menuText.ts`, in the eight languages of ADR-0034, following Settings → Appearance.
  It is rebuilt only when the language, the app on screen or the update's next step changes.

### Signing

- **Windows**: electron-builder signs the app, the sidecar, the bundled programs and the installer when a
  certificate is configured: Azure Trusted Signing (`AZURE_SIGN_*` and the Azure credentials) or a certificate
  file (`WIN_CSC_LINK`).
- **macOS**: a Developer ID certificate (`CSC_LINK`) signs with the hardened runtime and two entitlements
  (JIT and unsigned executable memory, which Chromium needs; nothing else); the notary is called when an App Store
  Connect API key is configured. Without a certificate the app keeps its ad-hoc signature and its update mode is
  `manual`.
- **Linux**: the packages carry no signature. The release has `SHA256SUMS.txt` for every file, signed with GPG when
  a key is configured.
- An unsigned package is still built, and the build says so. `PANELYTH_REQUIRE_SIGNING=1` makes it fail instead.

### The release pipeline

- `pnpm package` (`scripts/package.mjs`) is the whole build of one OS: renderers, main and preloads, the sidecar per
  arch, the ffmpeg build, the licence notices, then electron-builder with
  `src/shared/desktop/electron-builder.config.mjs` (a script, so signing and the feed come from the environment).
- `release.yml` runs on a pushed tag `v*`: it packages Windows, macOS and Linux, runs the packaged smoke test on
  each, runs the install → update → uninstall test on Windows, and attaches everything to a **draft** release.
  Publishing the draft is the release: installed apps see it with every file in place. (Before: the build ran after
  a release was published, so for some minutes the newest release had no files.)
- `pnpm test:update` is that Windows test: two versions packaged against a feed on the machine, the older one
  installed silently, updated from Settings → About, restarted into the newer one and uninstalled.

### Third-party notices and ffmpeg

- One file, `THIRD-PARTY-NOTICES.txt`, generated by `scripts/notices.mjs` into every package: the npm packages
  bundled into the renderers (their `dependencies`, followed) and into main (from its source maps), the Go modules
  linked into the sidecar, Go, and what `src/shared/desktop/build/third-party.json` lists by hand (Electron, the
  fonts, the two icon sets, ffmpeg). The build fails on a component without a licence text or with a licence outside
  the list the product ships (permissive licences; LGPL for ffmpeg alone).
- **ffmpeg and ffprobe** sit beside the sidecar (ADR-0018). `src/shared/desktop/media-tools.json` names a build per
  platform by URL and SHA-256; `scripts/media-tools.mjs` fetches it, refuses a different checksum and refuses a
  build configured with `--enable-gpl` or `--enable-nonfree`. Shipped now: BtbN's LGPL (version 3) shared builds of
  FFmpeg 8.1.3 for Windows x64 and Linux x64. macOS has no entry and uses an ffmpeg installed on the system.
- 7-Zip is not bundled (ADR-0030: an optional tool the user installs).

### Databases across versions

- `index.db` is recreated when its schema version differs, older or newer (ADR-0016); tested both ways.
- `library.db` is migrated forward. A test opens a library written by every schema since the first, with rows a
  user of that schema could have, and checks the rows after the upgrade. The text of every released migration is
  pinned by its SHA-256, so a released migration cannot be edited. A library from a newer build is refused and left
  untouched; the sidecar then runs without it.

## Consequences

- The update library adds 524 kB of JavaScript to the package, in a chunk of its own that is read by the first
  check. Startup is unchanged (measured in the stage record).
- The app talks to the network for one purpose: the update feed. Turning "Check automatically" off stops it; the
  button still works.
- The project's releases must be readable without an account, or installed apps find nothing: a private GitHub
  repository needs `PANELYTH_UPDATE_URL`.
- A macOS build without a Developer ID certificate cannot update itself. That is Squirrel.Mac's rule, not ours.
- The Windows installer grows by about 53 MB with ffmpeg (137 → 190 MB): the LGPL build is a full one, with every
  codec and filter. A build of our own with only the decoders posters need would be a few megabytes and would also
  cover macOS; it is the stage's open item.
- A new main-local method that both apps call needs its event channel in the commander's preload list too; the
  commander's foundation e2e test fails when it is missing.

## Alternatives considered

- **No updater; a link to the download page.** The smallest thing that works, and what `manual` builds do. It was
  not what the owner asked for.
- **Download updates automatically.** Fewer clicks, but a 190 MB download nobody asked for, and a file manager that
  changes under its user. The check is automatic; the download is a decision.
- **Our own update code** (fetch the feed, download, run the installer). electron-updater already verifies
  checksums and signatures, drives Squirrel.Mac and replaces an AppImage, and it is the companion of the packager
  we use.
- **A native About window.** One more window and one more renderer for four lines of text. The settings dialog is
  there in both apps and has the place for the automatic check.
- **The renderers' message catalogs for the menu.** Main would bundle seven catalogs to use thirty-six strings.
- **Release notes as HTML in a sandboxed frame.** A frame, a second CSP and markup from the network, to show a list.
