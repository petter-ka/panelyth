# ADR-0032 — Packaging and Release Builds

## Status

Accepted (Stage P04, 2026-10-08). Settles the packager choice ADR-0013 deferred to P04. Signing, notarization,
updates and the ffmpeg/ffprobe build to ship stay Stage P06 decisions.

## Context

- One product package per OS holds the shell with both apps (ADR-0031): main, two preloads, the viewer's and the
  commander's renderers, and the Go sidecar.
- The renderers are served from disk through `app://panelyth/` and `app://commander/`; the sidecar is a child process.
  `shared/desktop/src/main/paths.ts` already reads all three from `process.resourcesPath` in packaged builds
  (`renderer/`, `commander/`, `bin/`).
- No native Node modules: the sidecar is pure Go (`CGO_ENABLED=0`, ADR-0019), so it cross-compiles for every target
  arch from one machine.
- The candidates were electron-builder and Electron Forge. Forge's makers run per platform with separate plugins
  (Squirrel or WiX, DMG, AppImage through a third-party maker) and its packaging hooks assume one package with
  `node_modules`; our app is a pnpm workspace package with no runtime dependencies and resources from three other
  packages.

## Decision

- **electron-builder**, configured in `shared/desktop/electron-builder.yml`, run by `pnpm package`
  (`scripts/package.mjs`): it builds the JS bundles and the sidecar for every arch the host OS's targets name, then
  packages. Output: `shared/desktop/release/` (ignored by git).
- Layout: `app.asar` holds `dist/` (main and preloads, without source maps) and `package.json`; `extraResources`
  copies `viewer/renderer/dist` → `renderer/`, `commander/renderer/dist` → `commander/` and
  `resources/bin/<platform>-<arch>/` → `bin/`, so each package carries only its arch's sidecar.
- `name` becomes `panelyth` and `productName` `Panelyth` in the packaged `package.json` (the workspace name would name
  the data folders `@panelyth/desktop`).
- Targets: Windows NSIS installer (x64, per-user, installation folder selectable); macOS DMG and zip for arm64 and x64;
  Linux AppImage and tar.gz (x64).
- Until P06: no signing identity (macOS gets an ad-hoc signature, which Apple silicon requires to run code at all), no
  notarization, `publish: null` (no update metadata). Packaged builds include and enable the commander (ADR-0031).
- **Release builds**: `.github/workflows/release.yml` packages Windows and macOS when a GitHub release is published,
  runs the packaged smoke test on each, and attaches the installers to the release. The tag names the version (`v1.2.3`
  → `1.2.3`). Run by hand, it uploads the packages as workflow artifacts instead.
- **CI**: `.github/workflows/ci.yml` runs lint, typecheck and the Go race tests on Linux, and the unit, Go, e2e and
  packaged smoke tests on Windows, macOS and Linux.
- The packaged smoke test (`shared/e2e/smoke/`, `pnpm test:smoke`) drives the packaged app through its UI: packaged
  builds ignore the unpackaged test hooks (canned dialogs, recorded shell calls, `PANELYTH_USER_DATA_DIR`), so the
  profile is isolated with `--user-data-dir`.

## Consequences

- Unsigned packages warn: Windows SmartScreen asks for confirmation; macOS Gatekeeper blocks a downloaded app until it is
  opened with right-click → Open (or `xattr -dr com.apple.quarantine Panelyth.app`). P06 removes both.
- A Windows arm64 or Linux arm64 package needs only a target arch in the config and a sidecar build for it.
- Packaged apps cannot be steered by the unpackaged test hooks; anything a packaged test needs goes through the UI or
  Chromium switches.
