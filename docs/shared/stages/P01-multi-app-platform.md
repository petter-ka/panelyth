# Stage P01 — Multi-App Platform: One Shell, App Views, Shared Packages

Status: **Planned**. Track: platform. Depends on: viewer Stage 08.6 closed. Unblocks: P02, C00.

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

### 1. Rename the viewer's renderer

- `apps/renderer` → `apps/viewer-renderer` (`@fastview/viewer-renderer`). Scripts, the e2e harness and bench scripts
  follow. `apps/desktop` keeps its name: it is the shell.
- One mechanical commit with every suite green before anything moves between packages.

### 2. Extract the shared renderer packages

| Package | Moves from the viewer | Notes |
|---|---|---|
| `packages/ui` | `styles/index.css` (tokens, themes, interface size), `components/ui/*`, `Notice`, icons, `tokens.test.ts` | Tailwind must scan the package's sources |
| `packages/renderer-core` | bridge core (envelope → `FastViewError`), page store, selection algebra, keymap engine (actions registered per app), theme, interface size, settings and sidecar stores | feature stores stay in the apps |

- Packages ship TypeScript source bundled by each app's Vite build (the `packages/contracts` pattern), unless this
  stage measures a reason to prebuild them.
- Dependency rules (lint): apps may import packages; packages never import apps; renderer packages never import
  `electron` or `node:*`.

### 3. The shell: app views

- The main window becomes a `BaseWindow` with one `WebContentsView` per app. This stage hosts only the viewer view, plus
  a test-only second view (enabled by an environment variable in unpackaged builds) to prove switching.
- One preload per app (`apps/desktop/src/preload/viewer.ts` now, `preload/commander.ts` in C00).
- `app.switch({ to })` (renderer → main) and `app.visibility { app, visible }` (main → renderer): show one view, hide
  the other, move keyboard focus, update the window title. A view is created on the first switch to it and then kept
  alive.
- Hidden-app plumbing: hidden views are throttled and get `app.visibility`; the viewer pauses page and thumbnail
  requests while hidden and refreshes when shown (`docs/shared/APP-SWITCHING.md`, "Hidden app rules").
- Crash handling per view: a crashed view reloads alone (NFR-13).

### 4. Capability profiles per app view (ADR-0027)

- Contracts tag each method with the apps that may call it. Main keys every call by the sender's web contents and
  checks it against that view's profile; each preload exposes only its app's methods.
- The viewer's surface stays exactly as it is, plus `app.switch` (`tests/e2e/specs/foundation.spec.ts` changes only by
  that entry).

### 5. Tooling

- `BENCH_STAGE` accepts `NN`, `NN.N`, `PNN` and `CNN`, and the e2e result helpers take the same IDs.
- `tests/e2e/launch.ts`: `launchApp({ app })` chooses the app shown at start; helpers return each app view's page.
- `pnpm` scripts: the existing commands keep working; the commander renderer joins them in C00.

### 6. Documentation follow-ups (deferred from the 2026-10-05 docs move)

Code comments still name pre-move doc paths or stage numbers. Update them with this stage's mechanical changes:

- `apps/renderer/src/features/tiles/layout.ts`, `components/tiles/TileView.tsx`, `components/tiles/tileView.test.tsx`,
  `tests/e2e/specs/tiles.spec.ts` (`stages/03-tile-view.md`);
- `apps/renderer/src/features/theme/themeStore.ts`, `tests/e2e/specs/workspace.spec.ts` (`stages/05-filesystem-ux.md`);
- `apps/renderer/src/styles/index.css` (twice) and `styles/tokens.test.ts` (`docs/UX-DESIGN.md` →
  `docs/shared/DESIGN-SYSTEM.md`);
- `native/fastview-go/internal/preview/key.go` and `bench/scripts/startup.ts` (`docs/ARCHITECTURE-ANALYSIS.md`);
- `native/fastview-go/internal/fixture/fixture.go` (`docs/TESTING.md`);
- `native/fastview-go/internal/fsx/platform_unix.go` and `internal/pathkey/pathkey.go` ("Stage 09" → "Stage P04").

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
- Tailwind class scanning across packages: verify that `packages/ui` styles reach the bundle.
- Hidden coupling (shared code importing viewer feature stores). Mitigation: move pure logic first, and keep feature
  stores in the app.

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
