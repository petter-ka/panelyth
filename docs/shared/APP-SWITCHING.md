# App Switching and Shared State

Status: **In progress**. Decided by ADR-0031 (accepted 2026-10-05). The switch and shared appearance work
(Stage C00, 2026-10-05: 92 ms first switch, 4–6 ms after). The folder and the entry under the cursor carry over, and
the next start opens the last used app (Stage C01, 2026-10-05); the selection carries over too, and Settings → General
holds the carry-over options and "Start with" (Stage C02, 2026-10-05; see "Delivery").

The viewer and the commander are two apps of one product. They meet in the UI in a **left app rail** with both app
icons; the current app is highlighted and the other icon switches to it. Behind the switch, both apps share state:
the folder you are in (and so the drive), the file you are on, what you selected, your bookmarks, your clipboard and
your appearance settings.

## Goal

- One click or one key moves between the viewer and the commander, in the same window, instantly.
- The other app opens where you are: the same folder, the same file under the cursor, the same selection.
- What you set once (theme, interface size, bookmarks) is the same in both apps.
- Each app keeps its own way of working (tiles vs panels) and its own layout.

## Model

```text
┌──────────────── FastView shell: one Electron app, one window ────────────────┐
│ Main process: window, app views, switch, per-view capability profiles,       │
│               protocols, sidecar lifecycle                                    │
│                                                                              │
│  ┌ viewer app view ─────────────┐        ┌ commander app view ───────────┐   │
│  │ WebContentsView              │        │ WebContentsView               │   │
│  │ viewer renderer + preload    │   ⇄    │ commander renderer + preload  │   │
│  │ visible                      │        │ hidden; created on 1st switch │   │
│  └──────────────────────────────┘        └───────────────────────────────┘   │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ one sidecar for both apps
                                       ▼
   Go sidecar: one index (all entries), one preview cache, jobs, internal clipboard,
   library.db (shared and per-app settings, bookmarks, recent, user metadata),
   the shared context
```

- One app view is visible at a time. The other is created the first time the user switches, then kept alive hidden,
  so later switches are instant.
- Each app view has its own renderer bundle, preload and capability profile (ADR-0027). The viewer never gains the
  commander's powers, even though both share one main process.

## App switcher rail

### Placement and look

- **Both apps:** a 44 px wide vertical rail on the left edge, spanning the app view. It shows the same two icons in
  the same order in both apps: Viewer, then Commander. This keeps switching in one predictable place without taking
  space from the navigation toolbar or Commander panels.
- Each app has an 18 px glyph in a 36 × 36 px button. The current app is highlighted on `raised` with the `accent`
  color and marked current; the other app is muted until hover and switches on click:

- In Viewer, its picture-tile glyph is selected and the Commander panels glyph switches to Commander.
- In Commander, its panels glyph is selected and the Viewer picture-tile glyph switches to Viewer.
- The inactive app's tooltip shows its switch action and the current keymap chord; the selected app is labeled as the
  current app.

- The inactive app has accessible name "Switch to Commander" / "Switch to Viewer", with `aria-keyshortcuts`; the
  selected app has `aria-current="page"` and is disabled.
- While the commander is not released, the whole rail is hidden (feature flag), so the viewer has no empty gutter.

### Behavior

- Click the other app's icon, or press **Ctrl/Cmd+Shift+M** (action `app.switch` in the `shell` keymap scope; remappable). It also
  works while a text field has focus, such as the viewer's search box or the commander's command line, because it is
  a Ctrl/Cmd chord (ADR-0022 "while typing" rule).
- The switch is instant, with no animation. The window title changes to the visible app ("FastView — Pictures",
  "FastView Commander — Pictures").
- Focus lands on the target's main surface: the viewer's tile view, or the commander's active panel.
- While a modal dialog is open, the switch is unavailable: the rail sits behind the dialog's backdrop and the key does
  nothing.
- Running jobs continue during and after a switch, and both apps show them.

## What is shared

| State | How | Stored in | Stage |
|---|---|---|---|
| Current folder (and its drive or storage volume) | carried over on switch | `library.db` `shared.context`, for the next start | C01 |
| Focused entry (the selected tile, the commander's cursor) | carried over on switch | `shared.context` | C01 |
| Selection (the commander's marks) | carried over on switch, up to 10,000 entries, resolved in Go | memory only | C02 |
| Last used app | the next start opens it | `shared.context` | C01 |
| Theme, interface size | live: a change in one app applies to the other at once | `shared.appearance` | C00 |
| Carry-over options, start-with | live | `shared.switch` | C02 |
| Bookmarks (viewer) = hotlist (commander) | one list, live: Go sends `bookmarks.changed` after every edit; the commander adds groups, the viewer shows a flat list | `library.db` `bookmarks` (`group_name`, migration 4) | C03 |
| Recent locations | one list fed by every folder either app opens (`dir.open`); the viewer re-reads it when shown, the commander when its history menu opens; the commander's per-tab history stays its own | `library.db` `recent` | C03 |
| Favorites, ratings, tags, labels, collections | one library; the commander shows them later | `library.db` | already shared |
| Listings and thumbnails | one index and one preview cache: what one app listed or generated is ready in the other | `index.db`, preview cache | P01, P02 |
| Jobs | one queue, visible in both apps | sidecar | P01 |
| Internal file clipboard | Ctrl+C in one app, Ctrl+V in the other | sidecar | P01 |

**Not shared:** the viewer's workspace layout, tile size, sort, filters and search; the commander's panels, tabs,
views, columns, sorts, per-panel history and quick view. Each app stores these under its own keys.

## Carry-over rules

The app being left publishes its context; the app being shown applies it.

### Viewer → Commander

- The commander's **active panel** opens the viewer's folder, unless it is already there. The inactive panel doesn't
  change.
- The cursor lands on the viewer's focused tile.
- The viewer's selection becomes the panel's marks.
- If the viewer shows a recursive view ("Include subfolders") or search results, the panel opens the folder of the
  focused entry and carries no marks.

### Commander → Viewer

- The viewer opens the active panel's folder.
- The cursor entry becomes the viewer's selected tile if it is a folder, image or video. Otherwise the viewer shows the
  folder with nothing selected.
- Marks become the viewer's selection, minus entries the viewer doesn't show (other files, hidden files).
- If the active panel shows an archive, find results, a branch view or a compare result, the viewer opens the folder
  that contains the cursor entry and carries no selection.

### Always

- Nothing moves if the target already shows the same folder: its own state (scroll position, view, sort) stays.
- A selection over 10,000 entries is not carried over; a short notice says so ("The selection is too large to carry
  over").
- A folder that no longer exists shows the target's usual "not found" state with Go to parent.
- Every part can be switched off in Settings → General: "When switching apps, carry over: the folder · the entry under
  the cursor · the selection". Settings → General also has "Start with: the last used app · Viewer · Commander".

## Hidden app rules

A hidden app keeps its state and sessions but does no work:

- no page or thumbnail requests and no folder watching (the sidecar watches only the visible app's folders), with
  timers throttled;
- when shown again, it re-lists its visible folders (served from the index first, ADR-0015), applies the carried-over
  context, and carries on.

Where this stands (Stage C01): the hidden commander keeps `query.invalidated` aside and refetches pages only when
shown; it does not re-list on show, because the sidecar still watches every opened folder (bounded, ADR-0020). The
viewer does not pause yet. Watching only the visible app's folders is part of Stage P02.

## Persistence: the shared storage

Everything shared lives in the existing `library.db` (`<UserConfigDir>/FastView/library.db`, ADR-0016):

- settings `shared.context` (`{ v: 1, app, path, pathKey }`; the selection is never persisted). The visible app
  publishes its context when it is shown, when its folder changes and on the switch (with the focused entry and the
  selection); Go writes the setting one second after the last publish and on shutdown. The focused entry is not
  persisted: each app restores its own cursor and selection (Stage C01);
- `shared.switch` (`{ v: 1, carry: { folder, focus, selection }, startWith: "last" | "viewer" | "commander" }`,
  Settings → General, Stage C02). At start, main reads it with `shared.context` (waiting at most 400 ms) and shows the
  commander first when "Start with" says so, or when it was the last used app;
- `shared.appearance` (theme, interface size). The switch key is remapped per app, in each app's own shortcut setting
  (`shortcuts`, `commander.shortcuts`), not in a shared one (Stage C02);
- the `bookmarks` and `recent` tables, used by both apps (Stage C03 added bookmark groups for the hotlist:
  `group_name`, library.db migration 4);
- per-app settings under their own keys: the viewer's existing keys (`workspace`, `player`, `shortcuts`, …) keep their
  names; the commander uses `commander.*`. The viewer's current theme and interface-size values move to
  `shared.appearance` on first start.

The disposable `index.db` and the preview cache are shared too (one sidecar), so nothing is listed or generated twice.

## Contracts

| Method or event | Direction | Purpose |
|---|---|---|
| `app.switch({ to })` | renderer → main | show the other app view, creating it on demand |
| `app.visibility { app, visible }` | main → renderer | this app view was shown or hidden |
| `context.publish({ app, dirId, focusId, selection? })` | renderer → sidecar | the visible app's context; main accepts it only from the visible app's view and only with that app's own id. The switch sends `selection` (a descriptor, or null for none); Go resolves it to at most 10,000 ids and keeps them, with the version that carried them, in memory. A folder change omits `selection` and leaves the carried one readable, so the app being shown can publish its own folder before it reads the selection |
| `context.get()` | renderer → sidecar | `{ version, app, dirId, path, focusId, selectionCount, selectionTooLarge }`; `version` 0 = nothing published in this run, `app` and `path` then come from the last run; the selection fields describe this version only |
| `selection.fromContext({ version, queryId })` | renderer → sidecar | the carried selection as ranges of the target's current session version; entries the session doesn't list are dropped |

Context carries entry ids and descriptors; display paths are never used for actions (ADR-0027). The switch sequence:
the leaving app calls `context.publish`, then `app.switch`; main shows the other view and sends `app.visibility`; the
shown app calls `context.get`, navigates if needed, then `selection.fromContext` once its session is open.

## Security

- One main process, two capability profiles: main checks every call against the profile of the calling web contents
  (ADR-0027). `app.switch` and the context methods are in both profiles; everything else stays app-specific.
- The viewer applies a carried-over focus only when it can show that entry. It never opens a non-media file because
  the commander's context pointed at one.

## Performance budgets

| Metric | Budget |
|---|---|
| Switch to an existing app view → visible and focused | ≤ 1 frame (16 ms); with a folder change, plus the target's listing budget |
| First switch (the app view is created) → interactive | < 800 ms |
| Selection carry-over of 10,000 entries | < 100 ms |
| Idle memory, one app (the other never opened) | unchanged: < 60 MB over an empty Electron window |
| Idle memory, both app views created | < 160 MB over an empty Electron window (recalibrated 2026-10-05, ADR-0031) |
| A hidden app | no requests, no long tasks |

## Tests

- E2E: switch both ways by icon and by key; folder, focus and selection carried over; a same-folder switch keeps the
  target's state; each carry-over option off; the too-large-selection notice; a folder deleted between switches; a copy
  that keeps running across switches; a theme change applied in both apps; a restart that opens the last app in the
  last folder.
- Security: each app view's preload surface is exact; a commander-only method called from the viewer view is
  rejected.
- Performance: the budgets above, measured under the delivering stage's `BENCH_STAGE`.

## Delivery

| Stage | Delivers |
|---|---|
| P01 | the shell with app views (the viewer only), per-view capability profiles, `app.switch` and `app.visibility`, the hidden-app rules |
| P02 | one index with all entries; the viewer filters per query |
| C00 | the commander app view; the switch icon and key in both apps; shared appearance |
| C01 | carry-over of the folder and the focused entry; the last app and folder on start |
| C02 | selection carry-over; the carry-over settings |
| C03 | shared bookmarks (hotlist) and recent locations |

## Later

- Context actions: "Show in Commander" on a viewer tile, "Open in Viewer" on a commander folder or image.
- Both apps in two windows side by side (a second window hosting the other app view).
- Drag and drop between the apps.
