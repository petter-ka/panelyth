# CLAUDE.md — Panelyth Product Family

## Mission

Build the Panelyth product family: high-performance local desktop apps for Windows, macOS and Linux on one shared
platform, hosted by one shell in one window (ADR-0025, ADR-0031). A left app rail switches between them, and the apps
share state: the current folder, the selected file, the selection, bookmarks, recent locations,
appearance and the file clipboard (`docs/shared/APP-SWITCHING.md`).

- **Panelyth** (the viewer): a photo and video viewer.
  > Opening a large image folder should feel immediate, scrolling should remain fluid, and thumbnail loading should not
  > freeze the UI.
- **Panelyth Commander** (working title, planned): a keyboard-first, dual-panel file manager in the style of Total
  Commander.
  > Entering a folder should feel instant, the cursor should never lag, and file operations should never freeze the UI.

This repository is performance-sensitive. Treat unnecessary allocations, IPC chatter, synchronous I/O, large React state updates, and unbounded concurrency as defects until proven otherwise.

## Source of truth

Priority order:

1. `docs/shared/REQUIREMENTS.md` and the app's BRS (`docs/viewer/BRS.md`, `docs/commander/BRS.md`) — business/product
   requirements
2. `docs/shared/ARCHITECTURE.md` and the app's `ARCHITECTURE.md` — technical architecture
3. `docs/shared/PERFORMANCE.md` and the app's `PERFORMANCE.md` — measurable performance budgets
4. `docs/shared/CACHE-DESIGN.md` — thumbnail/preview cache contract
5. `docs/shared/decisions/`, `docs/viewer/decisions/`, `docs/commander/decisions/` — architectural decisions (index
   in `docs/README.md`)
6. `docs/ROADMAP.md` — delivery sequence across tracks
7. `docs/DEVELOPMENT-STAGES.md` — stage gates, stage IDs, the active stage
8. `docs/<track>/stages/*.md` — implementation scope for the current stage

If implementation conflicts with a decision, stop and update the relevant ADR rather than silently changing the architecture.

A **proposed** ADR is decided in the stage it names. Do not build on it before that stage accepts it.

## Documentation layout

All documentation lives in `docs/`; only this file stays in the root. Platform behavior shared by both apps goes to
`docs/shared/`; anything only one app has goes to `docs/viewer/` or `docs/commander/`. ADR numbers are global across
the folders. Write paths from the repository root. `docs/README.md` has the map and the reading order.

## Code layout

Code lives under `src/` and follows the same split as the docs (ADR-0031 "Code layout"):

- `src/shared/`: `desktop` (the Electron shell), `contracts`, `sidecar` (Go), `e2e` (Playwright harness; specs per app
  under `specs/viewer/`, `specs/commander/`), `bench`; later `ui`, `renderer-core`, `media-ui`
- `src/viewer/renderer`: the viewer's React app
- `src/commander/`: the commander's code (from Stage C00)
- `src/system/renderer`: Panelyth System, the computer dashboard and volume search (ADR-0042)
- `scripts/`: repository tooling (stays in the root)

## Stack

- Desktop shell: Electron (one shell app; each app is a `WebContentsView` with its own renderer, preload and
  capability profile; ADR-0031)
- Renderer: React + TypeScript
- Go sidecar: filesystem, indexing, metadata, thumbnail generation, preview generation, cache management, file
  operations, shared context (one sidecar process serving both apps)
- IPC: asynchronous request/response bridge through Electron preload/main to the Go sidecar
- Local persistence: SQLite owned by Go (one `index.db` and one `library.db` shared by both apps; settings under
  `shared.*`, the viewer's keys and `commander.*`)
- Frontend build: Vite-based Electron setup
- Package manager: pnpm
- Tests: Vitest + React Testing Library for renderer, Go tests/benchmarks for backend, Playwright/electron test harness for end-to-end flows
- Virtualization: `@tanstack/react-virtual`
- Tables (commander Full view only): `@tanstack/react-table` with TanStack Virtual (ADR-0028)

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
- renderer must remain responsive while indexing, decoding or copying
- viewer: use `@tanstack/react-virtual` for the tile view (tiles left to right, fixed size, more per row on wider windows; no list/table views, ADR-0004)
- commander: the Full (table) view uses `@tanstack/react-table` (columns, headers, sizing; manual sorting, row model of the visible window only) with `@tanstack/react-virtual` rows; the Brief (list) and Thumbnails (tile) views use `@tanstack/react-virtual` alone; fixed row heights; the cursor and the marked set are separate (ADR-0028)
- use fixed or predictably measurable tile and row geometry where possible
- keep scrolling independent from data fetching
- shared code lives in `src/shared/*`; never copy platform code into an app

### Go

- idiomatic Go
- `gofmt` is mandatory
- all blocking disk and CPU-heavy work must run outside Electron's UI thread; in Go use bounded worker pools
- never create an unbounded goroutine per image or file
- use context cancellation for scan/decode/find/copy jobs
- batch database writes
- use prepared statements for hot paths
- use benchmarks for image pipeline, directory scan and file-operation changes
- design APIs around batches, not one-file-at-a-time calls
- keep app differences explicit: the query scope (`media` vs `all`, ADR-0026) and the caller's capability profile (ADR-0027), not scattered checks

### Electron

- context isolation enabled
- sandbox enabled where compatible with the chosen architecture
- renderer receives only narrow, typed APIs through preload
- never expose raw `ipcRenderer`
- never expose Node APIs directly to React
- no synchronous IPC for hot paths
- no blocking filesystem work in the Electron main process
- Electron main owns native dialogs, lifecycle, protocol handlers and window management
- Go owns image/index/cache/file-operation business logic
- each app view gets only its capability profile; main checks every call against the calling web contents (ADR-0027, ADR-0031); actions take entry ids or selection descriptors, never renderer-supplied paths

Electron explicitly recommends avoiding blocking work in main/renderer and avoiding synchronous IPC for performance-sensitive applications. See the official Electron performance and process model documentation.

## Performance invariants

These are non-negotiable unless an ADR explicitly changes them:

1. UI scrolling and cursor movement must never depend on thumbnail generation, listing or file operations completing.
2. Thumbnail requests must be deduplicated.
3. Preview cache must live in the OS cache area, never beside the executable.
4. Cache keys must invalidate when the source file changes.
5. React must not mount thousands of tiles or rows at once.
6. Visible-item updates must be incremental.
7. Directory scanning, find and file operations must be cancellable.
8. Thumbnail generation and file operations must use bounded concurrency.
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
7. Review for regressions against `docs/shared/PERFORMANCE.md` and the app's `PERFORMANCE.md` (both apps when platform code changed).
8. Update the stage checklist and ADRs if behavior changed.
9. Do not implement future-stage features opportunistically.

## Do not do these things

- Do not introduce a web backend or cloud dependency for core features.
- Do not store the preview cache in the repository or application install directory.
- Do not use a single giant React array for 100k+ files.
- Do not generate every thumbnail immediately after opening a folder.
- Do not use `Promise.all()` over an unbounded image or file set.
- Do not send one IPC call per visible tile or row if a batched API can represent the same work.
- Do not make the Electron main process responsible for recursive folder scanning or file copying.
- Do not add heavy UI libraries to solve a small problem without an ADR.
- Do not give the viewer commander capabilities (opening non-media files, running programs or commands; ADR-0027).
- Do not trade correctness for benchmark numbers.

## Current stage

The active stage is declared in `docs/DEVELOPMENT-STAGES.md`. Only one stage is active at a time, across the viewer,
platform and commander tracks.

When a stage is completed, update:

- `docs/DEVELOPMENT-STAGES.md`
- the stage document
- `docs/ROADMAP.md`
- any affected ADR
- relevant benchmarks/results

## Product UX additions

- **Viewer:** a resizable two-column workspace (folder tree above the preview, content on the right; ADR-0023), drive/sidebar navigation, indexed search/sort/filter, a responsive tile view (small/medium/large tiles flowing left to right; no list or table views), image zoom and local video playback, context menus, file properties, multi-selection and asynchronous batch operations.
- **Commander:** two panels with Full, Brief and Thumbnails views, the Total Commander keyboard model, a background operation queue, quick view and lister, find files, archives, compare and synchronize, multi-rename and a command line (`docs/commander/UX-DESIGN.md`).
- **Between them:** a left rail with both app icons and Ctrl/Cmd+Shift+M switches apps; the folder, the entry under the cursor and the selection carry over, and bookmarks, recent locations, appearance and the file clipboard are shared (`docs/shared/APP-SWITCHING.md`).
- Tailwind + shadcn/ui form the shared visual system (`docs/shared/DESIGN-SYSTEM.md`); effects must be performance-aware.
