# ADR-0031 — One Shell for Both Apps: App Switching and Shared State

## Status

Accepted (2026-10-05). Product direction from the owner: the two apps connect in the UI and share state such as the
current folder and the selected file. Amended (2026-10-06, owner direction): the app switch is a shared left rail
with both app icons, the current app highlighted and the other app directly selectable. Specification:
`docs/shared/APP-SWITCHING.md`.

It supersedes ADR-0025's process model: separate Electron apps, one sidecar per app, separate data per app,
capabilities per app process, and the `apps/*-desktop` and `packages/desktop-core` parts of its code layout. ADR-0025's
shared platform, documentation split, tracks and stage IDs stand. It amends ADR-0026 (one index with all entries,
filtered per query) and ADR-0027 (a capability profile per app view).

## Context

- ADR-0025 made the viewer and the commander separate Electron apps with separate data. It named "one app with two
  modes" as the option to revisit if users work with both apps together.
- The owner wants to switch between the apps directly and find the same folder, file and selection
  in the other app. With separate apps:
  - the switch launches or focuses another program (a cold start the first time, two windows in the taskbar);
  - two sidecars index the same folders twice and keep two preview caches;
  - the folder, file and selection travel as path lists between processes, and large selections don't fit;
  - bookmarks, recent folders and preferences exist twice and need syncing;
  - both Electron runtimes stay in memory (about 300 MB floor each on Windows).
- The capability split of ADR-0027 still matters: the viewer must never run programs or commands, even if its renderer
  were compromised through a malicious media file.

## Decision

### One shell, one window, one view per app

- One Electron app, **the shell**, owns one window. Each app (viewer, commander) is an **app view**: a
  `WebContentsView` with its own renderer bundle, its own preload and its own capability profile (ADR-0027).
- One app view is visible at a time. The other is created on the first switch and then kept alive, hidden, so later
  switches are instant. The viewer's startup never loads commander code.
- The window title follows the visible app ("Panelyth — Pictures", "Panelyth Commander — Pictures").

### One sidecar, shared data

- One Go sidecar serves both apps: one `index.db` storing every entry (ADR-0026 as amended), one preview cache, one job
  manager, one internal file clipboard, one `library.db`.
- Data stays where the viewer keeps it today: `<UserCacheDir>/Panelyth/` and `<UserConfigDir>/Panelyth/`. The separate
  `Panelyth Commander/` directories of ADR-0025 are dropped.
- Settings are namespaced: `shared.*` for state both apps use, the viewer's existing keys for the viewer,
  `commander.*` for the commander.

### The switch and the shared context

- Each app shows the same vertical rail at the left with Viewer and Commander icons; the current app is highlighted
  and the other can be selected directly. The entire rail is hidden while the commander is not released. **Ctrl/Cmd+Shift+M**
  also switches apps (action `app.switch`, `shell` keymap scope, remappable).
- The app being left publishes its **context** (folder, focused entry, selection) to the sidecar; the app being shown
  applies it. Context uses entry ids and selection descriptors of the shared index, so a large selection carries over
  as ranges, never as a path list.
- Shared: current folder (and with it the drive), focused entry, selection (bounded), last used app, theme and interface
  size, carry-over options, bookmarks (= the commander's hotlist), recent locations, user metadata, the index, the
  preview cache, jobs and the internal clipboard. App-specific: layouts, views, sorts, the viewer's workspace and tile
  size, the commander's panels and tabs.
- A hidden app keeps its state but does no work (no requests, no watches); it refreshes when shown.

### Code layout

```text
shared/                   used by both apps
  desktop/                the shell: Electron main, one preload per app (@panelyth/desktop)
  contracts/              wire types, guards, golden fixtures (@panelyth/contracts)
  sidecar/                the Go sidecar for both apps (module panelyth/sidecar)
  e2e/                    Playwright harness; specs/viewer/, later specs/commander/ (@panelyth/e2e)
  bench/                  startup benchmark, empty-Electron baseline, results/ (@panelyth/bench)
  ui/                     (Stage P01) tokens, Tailwind theme, primitives, icons, dialogs, menus, Notice, app switcher rail
  renderer-core/          (Stage P01) bridge, page store, selection algebra, keymap, theme, settings, sidecar store
  media-ui/               (Stage C05) image viewer, video player; tile components (Stage C10)
viewer/
  renderer/               the viewer's React app (@panelyth/renderer)
commander/
  renderer/               (Stage C00) the commander's React app
scripts/                  repository tooling (dev, build, Go wrapper, bench results)
```

The folders were reorganized on 2026-10-05 (from `apps/desktop`, `apps/renderer`, `packages/contracts`,
`native/panelyth-go`, `tests/e2e` and `bench`).

A separate `desktop-core` package (ADR-0025) is not needed: there is one main process.

### Packaging

One product, one installer per OS. The commander stays hidden behind a feature flag (the app switcher rail doesn't appear)
until Stage C11 enables it.

## Why

- Switching inside one window is instant after the first time, and the context is applied directly from the shared
  index: no second program, no path lists.
- One sidecar means every listing, thumbnail, bookmark and clipboard entry made in one app is ready in the other.
- Separate app views keep separate renderer processes, bundles and capability profiles, so the viewer's security
  guarantees and startup time are unchanged.
- One process tree costs far less memory than two Electron apps when both are used.

## Consequences

- The viewer's index stores non-media entries too (filtered out per query). Stage P02 measures the cost on the viewer's
  scans and keeps it inside its budgets.
- Main routes every call by the calling web contents to that app's profile (ADR-0027). Tests assert each app view's
  exact preload surface.
- Releases are coupled: one product version contains both apps. A feature flag decides whether users see the
  commander.
- Playwright must drive `WebContentsView` pages; Stage P01 verifies the harness before converting the window.
- Opening both apps in two windows side by side is possible later (one more window with the other app view).

## Rejected

### Separate apps with a handoff (ADR-0025 as written)

The switch would launch or focus another program and carry paths over a cross-process channel; data would be
duplicated and synced. It loses on speed, memory and simplicity for the requested behavior.

### One renderer containing both apps

Simplest to share state in, but the viewer's UI would run with the commander's powers (open any file, run commands),
and the viewer's bundle would carry the commander's code.

### Two sidecars under one shell

Keeps ADR-0026's per-process scope, but the apps couldn't share ids, so selections would travel as paths, and folders
would be indexed and thumbnails generated twice.

## Open points (decided in Stage P01)

- ~~`WebContentsView` details~~ — **resolved 2026-10-05 (P01/C00):** the viewer stays the `BrowserWindow`'s own web
  contents and the commander is a `WebContentsView` laid over it, so the existing window code, dialogs and tests are
  unchanged. Focus moves with the switch (`webContents.focus()`), keys reach only the visible app (e2e), each view has
  its own DevTools in development, and Playwright reaches the commander's page through `app.windows()`. Drag and drop
  from the OS is checked when the commander gets drop targets (Stage C04).
- ~~Whether the hidden app view is kept forever or released after idle~~ — **resolved 2026-10-05 (owner decision
  after Stage C00):** the hidden view is kept, so a switch stays within one frame. Measured: the commander view costs
  about 97 MB at idle (one more renderer process); both views total about 153 MB over an empty Electron window. The
  both-views budget is recalibrated from 150 MB to **160 MB** (`docs/shared/PERFORMANCE.md`). Releasing the hidden
  view after a long idle time stays possible later if memory pressure warrants it.
