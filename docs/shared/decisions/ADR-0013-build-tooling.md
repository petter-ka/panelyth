# ADR-0013 — Build Tooling and Workspace Layout

## Status

Accepted (Stage 00)

Amended 2026-10-05 (ADR-0031): the code moved into `shared/` (`desktop`, `contracts`, `sidecar`, `e2e`, `bench`),
`viewer/` (`renderer`) and `commander/`; package names were kept. Stage P01 extracts `src/shared/ui` and
`src/shared/renderer-core`; `src/shared/desktop` stays the single shell, with one preload per app; Stage C00 adds
`src/commander/renderer`.

Amended 2026-10-10: `shared/`, `viewer/` and `commander/` moved under `src/`; `scripts/` stays in the repository root.
Paths below use the new layout.

## Decision

- **pnpm workspace** with packages `src/shared/desktop`, `src/viewer/renderer`, `src/shared/contracts`, `src/shared/e2e`
  and `src/shared/bench`. `src/shared/sidecar` is a single Go module outside the JS workspace.
- **Vite for all three JS bundles**:
  - renderer: a standard Vite React app (`src/viewer/renderer/dist`), served in production from `app://panelyth/`
  - main: Vite library mode, a single CommonJS bundle (`dist/main/main.cjs`), with `electron` and Node builtins external
  - preload: Vite library mode, a **single self-contained CommonJS file** (`dist/preload/preload.cjs`) that
    may require only `electron`, as the Electron sandbox requires
  - `src/shared/contracts` ships TypeScript source and is bundled into each consumer. It has no build step.
- `electron-vite` is not used, because it assumes main, preload and renderer share one package. That conflicts with the
  separate `src/shared/desktop` and `src/viewer/renderer` packages that Stage 00 prescribes.
- **Go sidecar** builds with `CGO_ENABLED=0 go build -trimpath` for the host into
  `src/shared/desktop/resources/bin/<platform>-<arch>/panelyth-sidecar[.exe]` (`pnpm build:sidecar`). Packaged
  builds read it from `resources/bin`. The packager is electron-builder (ADR-0032, Stage P04).
- **TypeScript is pinned to 6.0.x**, because `typescript-eslint` 8.x supports `<6.1`. Move to TypeScript 7 (the
  native compiler) once the lint toolchain supports it.
- **Formatting and lint**: Prettier (`semi: false`), ESLint flat config with typescript-eslint and
  react-hooks. A lint rule bans `sendSync`/`invokeSync`, and the renderer may not import `electron` or `node:*`.
  gofmt and go vet run through `node scripts/go.mjs`.
- **Tests**: Vitest (contracts, desktop with a real-binary sidecar integration test, renderer with jsdom and RTL),
  `go test` (including a subprocess test of the real entrypoint), and Playwright `_electron` for e2e.

## Consequences

- Main and preload changes need a restart of `pnpm dev`. Only the renderer hot-reloads.
- Windows `go test -race` needs a C toolchain, so race runs are expected on Linux CI.
