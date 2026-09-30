# CLAUDE.md — FastView

## Mission

Build FastView, a high-performance local image viewer for Windows, macOS and Linux.

The primary product promise is:

> Opening a large image folder should feel immediate, scrolling should remain fluid, and thumbnail loading should not freeze the UI.

This repository is performance-sensitive. Treat unnecessary allocations, IPC chatter, synchronous I/O, large React state updates, and unbounded concurrency as defects until proven otherwise.

## Source of truth

Priority order:

1. `BRS.md` — business/product requirements
2. `docs/ARCHITECTURE.md` — technical architecture
3. `docs/PERFORMANCE.md` — measurable performance budgets
4. `docs/CACHE-DESIGN.md` — thumbnail/preview cache contract
5. `decisions/*.md` — accepted architectural decisions
6. `ROADMAP.md` — overall delivery sequence
7. `DEVELOPMENT-STAGES.md` — stage gates
8. `stages/*.md` — implementation scope for the current stage

If implementation conflicts with a decision, stop and update the relevant ADR rather than silently changing the architecture.

## Stack

- Desktop shell: Electron
- Renderer: React + TypeScript
- Go sidecar: filesystem, indexing, metadata, thumbnail generation, preview generation, cache management
- IPC: asynchronous request/response bridge through Electron preload/main to the Go sidecar
- Local persistence: SQLite owned by Go
- Frontend build: Vite-based Electron setup
- Package manager: pnpm
- Tests: Vitest + React Testing Library for renderer, Go tests/benchmarks for backend, Playwright/electron test harness for end-to-end flows
- Virtualization: `@tanstack/react-virtual`

Use current stable releases at implementation time. Do not hardcode obsolete versions into architecture documents.

## Coding rules

### TypeScript / React

- TypeScript only
- no semicolons
- strict TypeScript
- functional React components
- avoid class components
- avoid putting the complete file list into React state
- do not store raw image bytes as base64 in React state
- do not pass image binary data through regular Electron IPC for thumbnails
- prefer stable object shapes
- keep virtualized item components small
- use memoization only when profiling shows it helps
- prefer batched updates over per-file React updates
- renderer must remain responsive while indexing or decoding
- use `@tanstack/react-virtual` for the image grid
- use fixed or predictably measurable tile geometry where possible
- keep scrolling independent from data fetching

### Go

- idiomatic Go
- `gofmt` is mandatory
- all blocking disk and CPU-heavy work must run outside Electron's UI thread; in Go use bounded worker pools
- never create an unbounded goroutine per image
- use context cancellation for scan/decode jobs
- batch database writes
- use prepared statements for hot paths
- use benchmarks for image pipeline and directory scan changes
- design APIs around batches, not one-file-at-a-time calls

### Electron

- context isolation enabled
- sandbox enabled where compatible with the chosen architecture
- renderer receives only narrow, typed APIs through preload
- never expose raw `ipcRenderer`
- never expose Node APIs directly to React
- no synchronous IPC for hot paths
- no blocking filesystem work in the Electron main process
- Electron main owns native dialogs, lifecycle, protocol handlers and window management
- Go owns image/index/cache business logic

Electron explicitly recommends avoiding blocking work in main/renderer and avoiding synchronous IPC for performance-sensitive applications. See the official Electron performance and process model documentation.

## Performance invariants

These are non-negotiable unless an ADR explicitly changes them:

1. UI scrolling must never depend on thumbnail generation completing.
2. Thumbnail requests must be deduplicated.
3. Preview cache must live in the OS cache area, never beside the executable.
4. Cache keys must invalidate when the source file changes.
5. React must not mount thousands of image tiles at once.
6. Visible-item updates must be incremental.
7. Directory scanning must be cancellable.
8. Thumbnail generation must use bounded concurrency.
9. Large IPC payloads must be avoided.
10. Every performance optimization must have a benchmark or measured before/after result.

## Working style for Claude

For every stage:

1. Read the stage document and linked ADRs.
2. Inspect the existing implementation before editing.
3. State the intended change internally, then make the smallest coherent implementation.
4. Add/adjust tests.
5. Run lint, typecheck, unit tests and relevant Go tests.
6. Run the relevant benchmark/performance check.
7. Review for regressions against `docs/PERFORMANCE.md`.
8. Update the stage checklist and ADRs if behavior changed.
9. Do not implement future-stage features opportunistically.

## Do not do these things

- Do not introduce a web backend or cloud dependency for core viewing.
- Do not store the preview cache in the repository or application install directory.
- Do not use a single giant React array for 100k+ files.
- Do not generate every thumbnail immediately after opening a folder.
- Do not use `Promise.all()` over an unbounded image set.
- Do not send one IPC call per visible tile if a batched API can represent the same work.
- Do not make the Electron main process responsible for recursive folder scanning.
- Do not add heavy UI libraries to solve a small problem without an ADR.
- Do not trade correctness for benchmark numbers.

## Current stage

The active stage is declared in `DEVELOPMENT-STAGES.md`.

When a stage is completed, update:

- `DEVELOPMENT-STAGES.md`
- the stage document
- `ROADMAP.md`
- any affected ADR
- relevant benchmarks/results


## Product UX additions

The product includes a resizable three-pane workspace, drive/sidebar navigation, indexed search/sort/filter, large/medium/small thumbnail modes, compact/detailed lists, image zoom and local video playback, context menus, file properties, multi-selection and asynchronous batch operations. Tailwind + shadcn/ui form the visual system; effects must be performance-aware.
