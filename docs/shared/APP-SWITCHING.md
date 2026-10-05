# App Switching and Shared State

Status: **Planned**. Decided by ADR-0031 (accepted 2026-10-05). Delivered in Stages P01, P02 and C00–C03 (see
"Delivery").

The viewer and the commander are two apps of one product. For now they meet in the UI at one point: **an icon at the
top of each app switches to the other**. Behind the switch, both apps share state: the folder you are in (and so the
drive), the file you are on, what you selected, your bookmarks, your clipboard and your appearance settings.

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

## The switch control

### Placement and look

- **Viewer:** the first control of the navigation toolbar (top left), before the sidebar toggle, followed by a
  separator.
- **Commander:** the first control of a slim app bar above both panels (top left). The bar has the height of the
  viewer's navigation toolbar, so the icon sits on the same spot in both apps: clicking twice goes there and back.
  Stage C10's customizable toolbar joins this bar later.
- One icon button (28 × 28 px; `chrome`, hover `raised`, `accent` focus ring; `docs/shared/DESIGN-SYSTEM.md`) that
  shows the **other** app:

  | In | Icon | Tooltip |
  |---|---|---|
  | Viewer | commander glyph (two panels side by side) | Switch to Commander (Ctrl+Shift+M) |
  | Commander | viewer glyph (2 × 2 picture tiles) | Switch to Viewer (Ctrl+Shift+M) |

- Accessible name "Switch to Commander" / "Switch to Viewer", with `aria-keyshortcuts`.
- While the commander is not released, the icon is hidden (feature flag), so the viewer looks exactly as it does
  today.

### Behavior

- Click the icon, or press **Ctrl/Cmd+Shift+M** (action `app.switch` in the `shell` keymap scope; remappable). It also
  works while a text field has focus, such as the viewer's search box or the commander's command line, because it is
  a Ctrl/Cmd chord (ADR-0022 "while typing" rule).
- The switch is instant, with no animation. The window title changes to the visible app ("FastView — Pictures",
  "FastView Commander — Pictures").
- Focus lands on the target's main surface: the viewer's tile view, or the commander's active panel.
- While a modal dialog is open, the switch is unavailable: the icon sits behind the dialog's backdrop and the key does
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
| Carry-over options, start-with, the switch key | live | `shared.switch`, `shared.shortcuts` | C00–C02 |
| Bookmarks (viewer) = hotlist (commander) | one list; the commander adds groups | `library.db` `bookmarks` | C03 |
| Recent locations | one list; the commander's per-panel history stays per panel | `library.db` `recent` | C03 |
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

## Persistence: the shared storage

Everything shared lives in the existing `library.db` (`<UserConfigDir>/FastView/library.db`, ADR-0016):

- settings `shared.context` (`{ v: 1, app, path, pathKey, focusPathKey }`, written on switch and on exit; the
  selection is never persisted), `shared.appearance` (theme, interface size), `shared.switch` (carry-over options,
  start-with) and `shared.shortcuts` (the `shell` scope);
- the `bookmarks` and `recent` tables, used by both apps (Stage C03 adds bookmark groups for the hotlist);
- per-app settings under their own keys: the viewer's existing keys (`workspace`, `player`, `shortcuts`, …) keep their
  names; the commander uses `commander.*`. The viewer's current theme and interface-size values move to
  `shared.appearance` on first start.

The disposable `index.db` and the preview cache are shared too (one sidecar), so nothing is listed or generated twice.

## Contracts

| Method or event | Direction | Purpose |
|---|---|---|
| `app.switch({ to })` | renderer → main | show the other app view, creating it on demand |
| `app.visibility { app, visible }` | main → renderer | this app view was shown or hidden |
| `context.publish({ app, dirId, focusId?, selection? })` | renderer → sidecar | the leaving app's context; Go resolves the selection to an id list (≤ 10,000) and keeps it in memory |
| `context.get()` | renderer → sidecar | `{ version, app, dirId, path, volume, focusId, selectionCount }` for the app being shown |
| `selection.fromContext({ version, queryId, queryVersion })` | renderer → sidecar | the carried selection as ranges of the target's session, like `selection.rebase` (ADR-0017) |

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
| Idle memory, both app views created | < 150 MB over an empty Electron window |
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
