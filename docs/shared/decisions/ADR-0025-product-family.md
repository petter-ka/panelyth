# ADR-0025 — Product Family: Two Apps on One Platform

## Status

Accepted (2026-10-05). Product direction from the owner: a Total Commander-style file manager is built beside the
Panelyth viewer.

**Partly superseded by ADR-0031 (same day).** The owner then asked for an in-app switch with shared state, so both apps
run in **one shell, one window and one sidecar** with shared data. Superseded here: "Two apps, one platform, one
repository" (the separate Electron apps, one sidecar per app, separate data, capabilities per app process) and the
desktop part of "Code layout". Still valid: the shared platform idea, the documentation split, the tracks and stage
IDs, and the shared packages `packages/ui` and `packages/renderer-core`.

## Context

- Panelyth was built as one app: the Electron shell (`apps/desktop`), the React renderer (`apps/renderer`),
  `packages/contracts` and the Go sidecar (`native/panelyth-go`). Most of it is not viewer-specific:
  - sidecar: scanner, index, query sessions, selection descriptors, jobs, watcher, preview cache, decoders, library;
  - Electron main: sidecar supervision, IPC router and validation, protocols, security, logging;
  - renderer: design system, UI primitives, bridge, keymap, theme, settings and sidecar stores.
- The owner wants a second product: a dual-panel, keyboard-first file manager in the style of Total Commander
  ("the commander"). It needs the same platform, plus things the viewer must not do:
  - list and table views (ADR-0004 forbids them in the viewer);
  - every file type in listings (ADR-0015 indexes folders and media only);
  - opening any file and running programs (the viewer's main process opens only indexed folders and media).
- Options:
  - **A.** One app with two modes (viewer and commander in one process).
  - **B.** Two apps on a shared platform (separate executables; shared packages and sidecar binary).
  - **C.** A separate repository for the commander, copying the platform.

## Decision

### Two apps, one platform, one repository (option B)

> Superseded by ADR-0031: one shell hosts both apps, one sidecar serves both, and the data is shared.

- **Panelyth** (the viewer, existing) and **Panelyth Commander** (working title) are separate Electron apps. Each has
  its own window, main entry, preload, renderer, settings, installer and release cadence.
- They share the Go sidecar binary, `packages/contracts` and the shared packages that Stage P01 extracts: Electron
  main building blocks, the design system and UI primitives, and the renderer core (bridge, sidecar/theme/keymap/settings
  stores). Media components (image viewer, video player) move to a shared package when the commander needs them
  (Stage C05; done 2026-10-06: `shared/media-ui`).
- **One sidecar binary, one sidecar process per app.** The app is chosen at start (`--app viewer|commander`). The
  sidecar's `hello` reports it, and main refuses a sidecar started for the other app. The profile selects the data
  directories, the index scope (ADR-0026) and the enabled method groups (ADR-0027).
- **Separate data per app:**

  | App | Cache root (`index.db`, previews) | Config root (`library.db`) |
  |---|---|---|
  | Viewer | `<UserCacheDir>/Panelyth/` (unchanged) | `<UserConfigDir>/Panelyth/` (unchanged) |
  | Commander | `<UserCacheDir>/Panelyth Commander/` | `<UserConfigDir>/Panelyth Commander/` |

  Two sidecars never write one SQLite file, so ADR-0016's one-writer rule holds per process, and the viewer's data
  stays where it is. Sharing the preview cache between the apps is a later option; it needs cross-process cleanup
  coordination.
- **Capabilities per app** (ADR-0027): each app's main allows only its own renderer methods and shell actions.

### Documentation and planning follow the split

- `docs/shared/`: platform requirements, architecture, performance, testing, design system, shared ADRs, platform
  stages (`P01`…).
- `docs/viewer/`: viewer requirements, UX, viewer ADRs and stages (`00`…`08.6`, the delivery history so far).
- `docs/commander/`: commander requirements, UX, commander ADRs and stages (`C00`…).
- ADR numbers stay global across the folders. Platform and commander stage IDs carry a track prefix; the viewer keeps
  its plain numbers. The viewer's planned Stages 09–11 (cross-platform hardening, performance hardening, release)
  became platform Stages P04–P06, because both apps need them. Viewer numbers 09–11 are retired; the next viewer stage
  is 12.

### Code layout (implemented in Stage P01)

> Superseded by ADR-0031: `apps/desktop` stays the single shell, and `packages/desktop-core` is not needed.

```text
apps/viewer-desktop        (was apps/desktop)      Electron main + preload, viewer profile
apps/viewer-renderer       (was apps/renderer)     viewer React app
apps/commander-desktop                             Electron main + preload, commander profile
apps/commander-renderer                            commander React app
packages/contracts                                 wire types, guards, golden fixtures (both apps)
packages/desktop-core                              sidecar process, RPC client, IPC router, protocols, security
packages/ui                                        tokens, Tailwind theme, primitives, icons, dialogs, menus, Notice
packages/renderer-core                             bridge, page store, selection algebra, keymap, theme, settings
native/panelyth-go                                 one sidecar module, app profiles
```

The rename of the viewer's packages is mechanical and lands in one commit with every test green.

## Why

- The products differ in interaction model and safety rules: tiles vs lists, media-only vs all files, never-launch vs
  launch-on-Enter. Separate apps keep each main process's allowlist small and each renderer focused.
- A shared platform avoids a fork. Fixes and performance work in the sidecar, IPC and design system reach both apps.
- Users can install one app without the other, and each starts as fast as the viewer does today: one renderer, one
  sidecar.
- Separate data directories avoid two processes writing one database, and need no migration of the viewer's data.

## Consequences

- Running both apps costs two Electron processes and two sidecars (the Electron floor is about 300 MB on Windows).
  That is acceptable for a desktop tool. Revisit option A if users routinely keep both open.
- The two apps index the same folders separately, and the commander's index holds every file (ADR-0026).
- Bookmarks, recent folders, settings and user metadata are per app. Sharing them needs a later decision.
- Contracts tag method groups with the apps allowed to call them (ADR-0027).
- Once the commander exists, every platform change keeps both apps' tests and benchmarks green.

## Rejected

### A — One app with two modes

It saves memory when both are used together and switches instantly, but it couples the releases, mixes two
allowlists in one main process, and makes the viewer's startup pay for the commander. The shared packages keep this
option open: both renderers could later be hosted by one shell.

### C — Separate repository

It duplicates the platform, and every fix would have to be ported by hand.

## Open points (decided in Stage P01)

- Package boundaries and names (`@panelyth/desktop-core`, `@panelyth/ui`, `@panelyth/renderer-core`).
- Shared React packages ship as TypeScript source bundled by each app's Vite build (the `packages/contracts` pattern,
  ADR-0013), unless P01 measures a reason to prebuild them.
- The final product name of the commander.
