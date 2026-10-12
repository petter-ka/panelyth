# Stage P01 — Multi-App Platform: One Shell, App Views, Shared Packages

Status: **Implementation done** (started 2026-10-05; the rest of scope 2 and the hidden-viewer rule on 2026-10-12).
Open: the owner's word on a bundle that grew by under 0.1 %, the viewer's work on a window resize while it is hidden,
and the Linux and macOS runs (CI). Track: platform. Depends on: viewer Stage 08.6 closed. Unblocks: P02, C00.

## Progress (2026-10-05, "minimal P01" agreed with the owner)

Done, because Stage C00 needs it:

- **Folder layout** (scope 1) and **comment follow-ups** (scope 6).
- **Shell with app views** (scope 3). The viewer stays the window's own web contents; the commander is a
  `WebContentsView` laid over it (`src/shared/desktop/src/main/shell.ts`), created on the first switch and kept alive
  hidden. `app.switch` and `app.visibility` work; the shell owns the window title; a crashed commander view reloads
  alone. This resolves ADR-0031's `WebContentsView` open point.
- **Capability profiles per app view** (scope 4). Main maps the calling frame's origin (`app://panelyth` or
  `app://commander`, or each dev server) to its app and checks the method against `APP_METHODS[app]`
  (`src/shared/contracts/src/rpc.ts`). Each app has its own preload (`preload.cjs`, `commander.cjs`).
- **Tooling** (scope 5). `BENCH_STAGE` accepts `NN`, `NN.N`, `PNN`, `CNN`; the e2e harness has `commanderPage`,
  `shellState` and `commanderEnv`; `pnpm build` and `pnpm dev` include the commander.
- **Part of scope 2:** `src/shared/ui` with the design tokens (`styles.css`, moved from the viewer with its token test),
  the theme and interface-size stores (now synced through `shared.appearance`) and the app switch button. The viewer
  re-exports them, so its imports did not change.

Moved since, by the commander stages that needed them (2026-10-05): the page store (C01), the selection algebra, the
keymap engine and the switch-settings store (`src/shared/renderer-core`, C02), and `Button`, `Kbd`, `DialogWindow` and the
shortcuts dialog (`src/shared/ui`, C02); the viewer re-exports or wraps them, so its imports and behavior did not change.

## Progress (2026-10-12, the rest of the stage)

- **Bridge core** (`src/shared/renderer-core/src/bridge.ts`): one `PanelythError` (code, message, `retryable`,
  `details`), `unwrap` (envelope → result or error) and `createBridgeCore<Api>()`, which reaches the preload API in
  one place. Each app keeps its own method list, typed by its own preload, so an app can still name only the methods
  of its profile. Before, each app had its own error class: the viewer's dropped `details`, the commander's dropped
  `retryable`, and the commander threw a plain `Error` without a preload.
- **Sidecar store** (`sidecarStore.ts`): `createSidecarStore(extra)` and `followSidecar(store, port, onReady)`. The
  viewer adds its ping and build info; the commander uses it as it is. This fixed a defect in the commander: its
  first `sidecar.getStatus` answer could replace a newer pushed status (the viewer already compared `since`).
- **Settings store** (`settingsStore.ts`): `createSettingsStore({ defaults, read, save })` builds the viewer's
  `viewer` and the commander's `commander.settings` stores (state `{ settings, open }`, `update`, `load`, `setOpen`,
  `reset`). The viewer's store was renamed to this shape (`preferences` → `settings`; `openSettings`,
  `closeSettings` and `setPreference` are functions of the module); what is stored did not change.
- **UI primitives** (`src/shared/ui`): the context and dropdown menus (`menu.tsx`; the Radix menu packages are now
  this package's dependencies), the 25 chrome icons (`icons.tsx`) and the `Notice` view. The viewer re-exports them;
  its `ContextMenuItem` only adds the hint from its keymap, and its `Notice` only reads its store. The commander's
  `PopupMenu` and action icons stay in the commander: nothing else uses them.
- **Package boundaries** (scope 2, "Dependency rules"): `eslint.config.js` forbids an app importing the other app,
  a shared package importing an app, the shell or a package above it (`contracts`, `i18n` < `renderer-core` < `ui` <
  `media-ui`), and renderer code importing `electron` or `node:*`. `src/shared/desktop/test/boundaries.test.ts`
  proves the rules fire (32 imports, by name and by path) and checks the same layering in the `package.json` files.
- **Hidden-app rule for the viewer** (scope 3): while the commander is shown, a `query.invalidated` for the viewer's
  folder waits; the newest one is applied when the viewer is shown (`startFolderMonitoring`), as the commander has
  done since C01. A copy of 10,000 files into the folder the hidden viewer shows no longer makes it fetch pages and
  thumbnails after every batch. Consequence: after more than one change while hidden, the selection is cleared
  rather than mapped over (Go maps across one version, ADR-0017); with carry-over on, the commander's marks replace
  it anyway.
- **Tooling** (scope 5): `pnpm bench:bundle` (`scripts/bundle-size.mjs`) records each renderer's JS and CSS, raw
  and gzipped; `src/shared/bench/scripts/startup.ts` now starts from a VS Code terminal (it removes
  `ELECTRON_RUN_AS_NODE`, with which Electron runs as plain Node); the viewer's tile spec files its results under
  `BENCH_STAGE`.
- **The viewer's tile e2e spec** opens folders again (it clicked a toolbar button gone since C06): it sets the
  startup folder and reloads, as the editor specs do. Its resize test waits for the page to have the new width, and
  the first-thumbnail test opens the folder by its tile. The preload-surface test lists `edit`, `batch` and
  `recipes` (Stages 12 and 16).

Not moved, and why: the theme and interface-size stores live in `src/shared/ui` (`appearance.ts`) beside the tokens
they switch, not in `renderer-core` as the table below planned; `ui` already depends on `renderer-core`, so nothing
is duplicated.

## Results (2026-10-12)

Reference machine (i9-13900K, Windows 11), `BENCH_STAGE=P01`; before = commit `bc06a82`, after = this stage's build.
Files: `src/shared/bench/results/stage-P01-2026-10-12-*`.

| Measure | Before | After |
|---|---|---|
| Viewer ready-to-show, p50 | 266 ms | 256–259 ms (4 runs) |
| Sidecar ready, p50 | 161 ms | 149–158 ms |
| Idle memory, all processes | 448.4 MB | 446.4–447.6 MB |
| `system.ping` p95 | 0.2 ms | 0.2 ms (one of four runs read 0.5 ms) |
| 100k tile scroll, medium tiles at 1920 px | p95 frame 7 ms, 0 long tasks, 80 tiles mounted (2026-10-06) | the same |
| 100k tile scroll, small tiles at 2560 px | p95 frame 7 ms, 0 long tasks, 204 tiles mounted (2026-10-06) | the same |
| First switch to the commander | 178–200 ms (6 runs) | 177–191 ms |
| Later switches | 4–8 ms | 4–5 ms |
| Viewer JS | 786,221 B (gzip 242,088) | 786,892 B (gzip 242,256): +671 B, +0.09 % |
| Viewer CSS | 41,808 B | 41,808 B |
| Commander JS | 897,784 B (gzip 266,707) | 898,414 B (gzip 267,028): +630 B, +0.07 % |
| Commander CSS | 40,856 B | 41,390 B: +534 B, the menus' and the notice's classes |
| Document window JS | 764,592 B | 764,592 B |

- The tile-scroll "before" is the record of 2026-10-06 (`stage-03-2026-10-06-e2e-tiles.jsonl`): at `bc06a82` the
  spec could not open a folder.
- **The bundle grew**, by 671 bytes in the viewer and 630 in the commander. The stage says it must not grow. The
  bytes are the factories and two thin wrappers; no dependency is bundled twice, the Radix menus are not in the
  commander's bundle (it does not use them) and neither are the icons it does not draw. Accepting this is the
  owner's call.
- The idle-memory budget (60 MB over the Electron floor) fails before and after (152–155 MB over); it has failed
  since C00 and is a Stage P05 item.
- Packages still ship TypeScript source bundled by each app: nothing measured gives a reason to prebuild them.

Tests: contracts 201, desktop 267 (39 new: boundaries), renderer-core 39 (20 new), ui 72 (35 new), media-ui 23,
i18n 26, docviewer 15, viewer 320 (3 new), commander 288 (6 new). E2E on the final build: the app switch (3), both
foundation specs (8), the viewer's tile spec (9). Go was not touched and its tests were not run.

The commander's e2e suite (54 tests) ran twice on the final build: 47 and 48 passed.

- Four tests fail in both runs and at `bc06a82` as well: `archives.spec.ts` scenario 13 and `viewers.spec.ts`
  scenario 11, "safety" and "bench". They press F3 or Enter on a text file and wait for the in-app lister or the
  program dialog; since ADR-0033 such a file opens in a document window (`tool.cmd` of "safety" too: `cmd` is in
  the text extensions of `src/shared/contracts/src/documents.ts`). The specs were not updated (a Stage P04 item,
  recorded there).
- Five others failed in one run each and never in both: `navigation.spec.ts` "switch: bookmarks…", `tabstree.spec.ts`
  scenario 19 and its tree benchmark (69.6 ms against 50), `tools.spec.ts` scenario 17 and `ftp.spec.ts` "a server
  that stops answering". Each passes alone on the final build (2 or 3 runs of each), and the three of the first run
  pass at `bc06a82` alone too. The first run shared the machine with other work of this stage. The suite was not
  run whole at `bc06a82`, so "no more often than before" is not shown; Stage P04 records the same pattern on
  Windows CI.

The viewer's `editor.test.tsx` "asks before replacing the original…" fails some runs on a focus assertion; it did so
at `bc06a82` too (2 of 5 runs).

Still open:

- the owner's word on the bundle growth above;
- the hidden viewer still lays its tiles out again when the window is resized while the commander is shown, which
  costs a page and a thumbnail request for the new range; a pause in the page store is the fix (not part of
  Stage P02, which built the sidecar's side: session budgets and watching per app);
- the viewer's other e2e specs (`index`, `jobs`, `media`, `polish`, `previews`) still click the removed "Open
  folder…" button (a Stage P04 item); the tile spec shows the replacement;
- the Linux and macOS runs (CI).

## Objective

Turn the single viewer app into a shell that can host two apps in one window, each in its own app view with its own
permissions, and extract the shared renderer packages, without changing what the viewer does or how fast it is
(ADR-0025, ADR-0031).

## Decisions applied

- **ADR-0031** (accepted): one shell, one window, one app view per app, one sidecar. This stage settles its open
  points (`WebContentsView` focus, DevTools, drag and drop, Playwright access; keeping the hidden view alive).
- **ADR-0027** (proposed; this stage accepts the per-view allowlist part): a capability profile per app view.
- ADR-0025 (shared platform and packages), ADR-0012 (contracts canonical, golden fixtures), ADR-0013 (build tooling;
  amended by this stage), ADR-0011 (stores).

## Scope

### 1. Folder layout — done early (2026-10-05)

The code already moved into `shared/`, `viewer/` and `commander/` (ADR-0031 "Code layout"; under `src/` since
2026-10-10): `src/shared/desktop`, `src/shared/contracts`, `src/shared/sidecar`, `src/shared/e2e`, `src/shared/bench`,
`src/viewer/renderer`. Package names were kept. All
suites passed after the move, except tests that were already failing.

### 2. Extract the shared renderer packages

| Package | Moves from the viewer | Notes |
|---|---|---|
| `src/shared/ui` | `styles/index.css` (tokens, themes, interface size), `components/ui/*`, `Notice`, icons, `tokens.test.ts` | Tailwind must scan the package's sources |
| `src/shared/renderer-core` | bridge core (envelope → `PanelythError`), page store, selection algebra, keymap engine (actions registered per app), theme, interface size, settings and sidecar stores | feature stores stay in the apps |

- Packages ship TypeScript source bundled by each app's Vite build (the `src/shared/contracts` pattern), unless this
  stage measures a reason to prebuild them.
- Dependency rules (lint): apps may import packages; packages never import apps; renderer packages never import
  `electron` or `node:*`.

### 3. The shell: app views

- The main window becomes a `BaseWindow` with one `WebContentsView` per app. This stage hosts only the viewer view, plus
  a test-only second view (enabled by an environment variable in unpackaged builds) to prove switching.
- One preload per app (`src/shared/desktop/src/preload/viewer.ts` now, `preload/commander.ts` in C00).
- `app.switch({ to })` (renderer → main) and `app.visibility { app, visible }` (main → renderer): show one view, hide
  the other, move keyboard focus, update the window title. A view is created on the first switch to it and then kept
  alive.
- Hidden-app plumbing: hidden views are throttled and get `app.visibility`; the viewer pauses page and thumbnail
  requests while hidden and refreshes when shown (`docs/shared/APP-SWITCHING.md`, "Hidden app rules").
- Crash handling per view: a crashed view reloads alone (NFR-13).

### 4. Capability profiles per app view (ADR-0027)

- Contracts tag each method with the apps that may call it. Main keys every call by the sender's web contents and
  checks it against that view's profile; each preload exposes only its app's methods.
- The viewer's surface stays exactly as it is, plus `app.switch` (`src/shared/e2e/specs/viewer/foundation.spec.ts` changes only by
  that entry).

### 5. Tooling

- `BENCH_STAGE` accepts `NN`, `NN.N`, `PNN` and `CNN`, and the e2e result helpers take the same IDs.
- `src/shared/e2e/launch.ts`: `launchApp({ app })` chooses the app shown at start; helpers return each app view's page.
- `pnpm` scripts: the existing commands keep working; the commander renderer joins them in C00.

### 6. Documentation follow-ups — done early (2026-10-05)

Code comments that named pre-move doc paths or stage numbers were updated with the folder move.

## Non-goals

- The commander app and the switch icon (Stage C00); the shared context (Stage C01); index scope (Stage P02).
- No user-visible change in the viewer.

## Tests

- Every existing suite stays green: contracts, desktop, renderer, Go, e2e.
- Router per web contents: the viewer view's allowlist is unchanged, and a method outside it is rejected.
- Switching mechanics with the test-only view: views created lazily, `app.visibility` events, focus moves, title
  changes, a crashed view reloads alone.
- Preload surface per app view.
- Package boundaries: a lint or test that fails when a package imports an app.

## Benchmarks

Before and after, on the same machine (`BENCH_STAGE=P01`):

- viewer startup: ready-to-show (now the first paint of the viewer view), sidecar `hello`, idle memory over empty
  Electron;
- `system.ping` p95, 100k tile scroll (long tasks, mounted tiles, p95 frame);
- viewer renderer bundle size;
- the switch to the test-only view (first and later switches), to calibrate the budgets in
  `docs/shared/APP-SWITCHING.md`.

No regression beyond run-to-run noise (about ±5 %). The bundle must not grow.

## Acceptance criteria

- The viewer behaves and measures as before, with all tests green.
- The shell hosts app views with per-view profiles, and switching works with the test-only view.
- ADR-0031's open points are resolved, ADR-0027's per-view part is accepted, and ADR-0013 describes the new layout.

## Risks

- Playwright access to `WebContentsView` pages: verify first; fall back to CDP targets if needed.
- Focus and keyboard routing between views, drag and drop from the OS into a view, and DevTools per view behave
  differently from `BrowserWindow`. Mitigation: a spike before converting the window.
- Tailwind class scanning across packages: verify that `src/shared/ui` styles reach the bundle.
- Hidden coupling (shared code importing viewer feature stores). Mitigation: move pure logic first, and keep feature
  stores in the app.

## Exit checklist

- [x] implementation complete (the resize of a hidden viewer is open, see "Still open")
- [x] tests complete (the viewer's other e2e specs are a Stage P04 item; Linux and macOS runs in CI)
- [x] benchmark complete (`stage-P01-2026-10-12-*`)
- [ ] performance regression reviewed: no timing regression in either app; the bundles grew by 671 B (viewer) and
      630 B (commander) against "must not grow", which waits for the owner
- [x] docs/ADR updated (ADR-0013 amended; ADR-0031's open points and ADR-0027's per-view part were closed on
      2026-10-05)
