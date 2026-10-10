# Stage P01 — Multi-App Platform: One Shell, App Views, Shared Packages

Status: **In progress** (started 2026-10-05). Track: platform. Depends on: viewer Stage 08.6 closed. Unblocks: P02,
C00.

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

Still open: the rest of scope 2 (`src/shared/renderer-core`: bridge core, settings and sidecar stores; the remaining UI
primitives: menus, icons) and its bundle-size check.

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

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
