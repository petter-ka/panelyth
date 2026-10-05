# ADR-0013 — Build Tooling and Workspace Layout

## Status

Accepted (Stage 00)

Amended 2026-10-05 (ADR-0031): Stage P01 renames `apps/renderer` to `apps/viewer-renderer` and extracts `packages/ui`
and `packages/renderer-core`; `apps/desktop` stays the single shell, with one preload per app; Stage C00 adds
`apps/commander-renderer`.

## Decision

- **pnpm workspace** with packages `apps/desktop`, `apps/renderer`, `packages/contracts`, `tests/e2e`
  and `bench`. `native/fastview-go` is a single Go module outside the JS workspace.
- **Vite for all three JS bundles**:
  - renderer: a standard Vite React app (`apps/renderer/dist`), served in production from `app://fastview/`
  - main: Vite library mode, a single CommonJS bundle (`dist/main/main.cjs`), with `electron` and Node builtins external
  - preload: Vite library mode, a **single self-contained CommonJS file** (`dist/preload/preload.cjs`) that
    may require only `electron`, as the Electron sandbox requires
  - `packages/contracts` ships TypeScript source and is bundled into each consumer. It has no build step.
- `electron-vite` is not used, because it assumes main, preload and renderer share one package. That conflicts with the
  separate `apps/desktop` and `apps/renderer` packages that Stage 00 prescribes.
- **Go sidecar** builds with `CGO_ENABLED=0 go build -trimpath` for the host into
  `apps/desktop/resources/bin/<platform>-<arch>/fastview-sidecar[.exe]` (`pnpm build:sidecar`). Packaged
  builds read it from `resources/bin`. The packager choice is deferred to Stage P04.
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
