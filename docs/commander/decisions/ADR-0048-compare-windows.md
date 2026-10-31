# ADR-0048 — Compare by Content and Synchronize in Windows of Their Own

## Status

Accepted (2026-10-31), at the owner's request, outside the stage list (the active stage is C10.9), like ADR-0033 and
ADR-0039. It changes where three commander views are shown; it adds no capability. Amends ADR-0027 (one new
commander-only main method) and ADR-0039 (the commander's settings also reach its compare windows).

## Context

- Compare by content (Stage C08), its result list for several marked files (Stage C10.5) and Synchronize directories
  (Stage C08) were in-page dialogs of the commander's view: they covered the panels and blocked them until closed.
- The owner wants them in a child window: one that can be moved, resized and kept open beside the panels, as the
  compare tool of a two-panel file manager is.
- ADR-0039 put a second page on an app's origin with that app's preload (`settings.html`), so it runs on the app's
  profile (ADR-0027) without a profile of its own; ADR-0033 did the same for the media window (`media.html`).
- Everything the three views do is already a commander method that takes ids: `diff.open` / `page` / `close` by
  entry ids, `compareFiles` and `sync` jobs, `compare.dirs` and its session, `query.locate` / `page` on the panels'
  sessions. Sessions belong to the commander as an app (ADR-0017, Stage P02), not to one web contents.

## Decision

- **A compare window** is a `BrowserWindow`, a child of the shell window (`parent`), **not modal**: the panels stay
  usable. It is resizable (1200 × 800 at first, a result list 900 × 640; at least 560 × 400), minimizable and
  maximizable, closes with the shell, and on Windows draws the title strip (ADR-0045). Its title names what it
  compares ("a.txt ↔ b.txt – Compare by content", "Synchronize directories").
- **Its page is `compare.html` on the commander's origin with the commander's preload**, so it runs on the
  commander's profile; main takes nothing about the page from the caller. The page starts only what a comparison
  needs: the compare, query and job events, the job list, the commander's settings, the shared appearance and the
  title strip.
- **One method, `compare.openWindow`** (main, commander profile only). Its params name the view:
  - `files { left: { id, name }, right: { id, name } }`: two files side by side (the text diff, or the streamed
    "identical or not" for other files).
  - `many { jobId, side, count, folder, mineQueryId, theirsQueryId }`: the result list of a `compareFiles` job the
    commander started. Enter shows a pair in the same window; the pair is found by name in the two panels' query
    sessions as they were when compared, so a panel that has moved on gives "no longer show both files", as before.
  - `sync { left: { path, dirId }, right: { path, dirId } }`: Synchronize directories for the two folders; the page
    compares, filters, sets directions and starts the sync job itself.

  Main checks the shape and puts the values in the URL fragment; ids are the commander's own, names and folders are
  only shown. The same two files, or the same two folders, bring their open window forward instead of a second one;
  each result list has its own window.
- **The window ends with its comparison**: Close, Esc (from a pair opened from the list: back to the list), or a
  sync that started (its job runs in the queue). Closing the window lets go of what it holds in Go: the diff, a
  compare job still running (cancelled), the directory compare.
- **Settings stay one value.** The synchronize view edits the date rules Shift+F2 uses (`commander.settings`). Main
  relays a write of that key from a compare window to the commander's view and the other compare windows, and a
  write from the commander's view or its settings window to the compare windows; each applies it as the commander's
  view applies the settings window's (ADR-0039).
- **Go keeps four text diffs** (`MaxTextDiffs`). With several windows open, the oldest can be let go; its window
  compares the pair again when it next pages rows (twice in a row at most, then it says why). A comparison shown
  with an error has a Compare again button.
- **Fallback:** when the window cannot open (no bridge, as in component tests, or an error), the in-page dialogs
  are shown as before. They and the window render the same views (`DiffView`, `CompareManyView`, `SyncView`).

## Consequences

- The commander ships a fourth page (`compare.html`, about 3 KB of its own plus a 49 KB chunk of the compare views;
  the rest is shared with the commander's view).
- Comparisons and panels are used side by side; several comparisons can be open at once.
- End-to-end specs reach a comparison through `compareWindow` (`src/shared/e2e/launch.ts`), polling the app's
  windows for `compare.html`. Esc closes the window on keydown, so a spec sends the keydown alone.

## Verification

- Unit tests: main's window manager (fragment, parent and preload, one window per pair or folder pair, its pages),
  the router's allowlist and validation, the page (its request, the three views filling it, Esc, a diff that Go let
  go, a job that ended before the window followed it, a list's pair and the way back, release on close) and the
  commander opening windows instead of dialogs, with the dialog when the window cannot open.
- E2E: `compare.spec.ts` (scenario 14: the diff, three synchronize windows, the 100k-tree benchmark in the window)
  and `tabstree.spec.ts` (scenario 22: two files, a result list, Enter, Shift+N, back to the list).
- Not run: macOS and Linux.
