# Stage C03 — Drives, Tabs, Hotlist, History and Session

Status: **Implementation done** (2026-10-06); the gate waits on the items under "Open". Track: commander. Depends
on: C02 (implementation done; its gate is open). Unblocks: P03, C04.

## Objective

Move around the filesystem the way Total Commander users do: drive buttons and menus, folder tabs, a directory
hotlist, history, the Brief view, and a full session restore.

## Decisions applied

- ADR-0028 (views; one session per visible tab), ADR-0016 and ADR-0031 (the shared `library.db`), ADR-0026
  (watching per visible panel).
- `docs/shared/APP-SWITCHING.md`: shared bookmarks and recent locations.

## Scope

- Drives: a drive bar and menus (Alt+F1 left, Alt+F2 right) with labels, free and total space, removable and network
  markers; refresh on volume changes (OS events where available, otherwise polling while visible). A drive that isn't
  ready shows a state, never a hang.
- Tabs per panel: Ctrl+T new, Ctrl+W close, Ctrl+Tab / Ctrl+Shift+Tab cycle, drag to reorder, lock, close others. Only
  the visible tab holds a session; the old one closes after a short grace period.
- Directory hotlist (Ctrl+D): add the current folder, open, edit, group, reorder. It is the shared bookmarks list:
  a bookmark added in the viewer appears in the hotlist and the other way round; groups are a commander addition that
  the viewer shows as a flat list.
- Recent locations: one shared list fed by both apps; the commander's per-panel history stays per panel.
- History per panel: Alt+↓ shows the list; persisted.
- Brief view (Ctrl+F1): names in fixed-width columns, flowing top to bottom; horizontal virtualization with
  `@tanstack/react-virtual` (no TanStack Table: a list has no columns); ←/→ change columns.
- Session restore: both panels, their tabs, views, sorts, column widths and cursor entries.
- Settings, Panels tab: size format (bytes or units), date format, hidden files default, where letters go.

## Non-goals

- File operations (C04), thumbnails view (C10).

## APIs/contracts

- `fs.volumes` gains free and total space and a change event (coalesced).
- `library.db` migration: a `group` column on the shared bookmarks table; per-panel history under `commander.*`.

## Tests

- Renderer: tab lifecycle (sessions opened and closed), hotlist editing, Brief-view geometry.
- Go: volume info per OS (fixed, removable, network), hotlist and history migrations.
- E2E (switch): a bookmark added in one app appears in the other; recent locations from both apps in one list.
- E2E: scenario 7 (tabs, drives, hotlist and history survive a restart).

## Benchmarks

`BENCH_STAGE=C03`: tab switch (session open → rows painted); drive menu with a slow network drive; session restore
time at startup.

## Acceptance criteria

- A tab switch paints rows within the cached-folder budget (p95 < 50 ms).
- Startup restores both panels within 1.3 s (`docs/commander/PERFORMANCE.md`).
- An unavailable network drive never blocks the drive menu or the other panel.

## Risks

- Volume enumeration can block on dead network mounts. Mitigation: per-volume timeouts in Go; the menu shows partial
  results.

## Results (2026-10-06)

Built:

- **Sidecar:** `fs.volumes` reads each volume's space in parallel with a timeout (0.5 s local, 1.5 s network); a
  read still blocked on a dead mount is joined, never started twice; removable, optical and network volumes that do
  not answer are `notReady`. Network shares now get free and total space too. A volume monitor (started by the first
  `fs.volumes`) compares the drive list every 2 s (drive letters and local labels only, no space reads) and sends
  `volumes.changed` with the new list, coalesced. `library.db` migration 4 adds `bookmarks.group_name`;
  `library.updateBookmark` (a taken path fails with `details.reason: "duplicate"`) and `library.reorderBookmarks`;
  every bookmark change sends `bookmarks.changed` with the whole list (at most 500 rows) to both apps. Dev mode only:
  `FASTVIEW_DEV_SLOW_VOLUME=path=ms` adds a network drive whose space read hangs (the drive-menu benchmark).
- **Main and contracts:** the commander profile gains the four bookmark methods; validators for the group (≤ 128),
  `updateBookmark` and `reorderBookmarks` (≤ 500 ids); `Bookmark.group`, `Volume.notReady`; the two events are
  forwarded with guards (golden fixtures for both; `evt-volumes.changed.json` is built from the Go type, since the
  polling cannot be triggered in the golden run).
- **Commander:** tabs per panel (`features/tabs.ts`): Ctrl+T (the new tab takes over the visible session), Ctrl+W
  (never the last or a locked tab), Ctrl+Tab / Ctrl+Shift+Tab, click, middle-click, drag to reorder, and a right-click
  menu with lock and close others (both also remappable actions without default keys). A tab being left parks its
  session for 3 s and reuses it when shown again within that time; otherwise it reopens its folder with the cursor on
  its entry. A locked tab branches navigations into a new tab. The drive bar (a button per drive, the panel's drive
  pressed, its free space) and the drive menu (Alt+F1 / Alt+F2: drives with labels, space and removable / network /
  optical markers, "not ready", then places; a drive letter selects) open at once with the last list and refresh
  behind ("Updating drives…"). The hotlist (Ctrl+D): add the current folder, groups as sections, Configure… edits name,
  folder and group, moves entries and removes them. The history menu (Alt+↓): the tab's history, newest first, then
  "Recent (both apps)". The Brief view (Ctrl+F1; Ctrl+F2 back): fixed-width columns flowing top to bottom, TanStack
  Virtual horizontally, ← / → a column, PgUp / PgDn a screen, marks and quick search as in the Full view (one shared
  key handler, `features/panelKeys.ts`), a listbox for assistive tech. Session restore (`features/session.ts`,
  `commander.panels` v2; v1 is still read): both panels, their tabs, views, sorts, column widths, histories and cursor
  entries. Settings (Ctrl+,), Panels tab: sizes in bytes or units, locale or ISO dates, hidden files in new panels,
  and whether letters start quick search or need Alt (plain letters are then left for the C10 command line).
- **Viewer:** follows `bookmarks.changed` and re-reads bookmarks and recent locations when shown, so a folder
  bookmarked or opened in the commander shows in its sidebar.

Deviations from the scope above:

- Volume changes are polled by Go (every 2 s, cheap) for as long as the sidecar runs once a drive list was asked
  for, not only while a panel is visible; no OS volume events are used yet (Stage P04 may add them). Media inserted
  into an existing card-reader letter shows on the next menu open, not by event.
- History is per tab (the panel and tab model of `docs/commander/ARCHITECTURE.md`), persisted with the tab.
- "Hidden files in new panels" applies to panels without stored state; a new tab copies the current tab.
- Clicking a drive opens its root (Total Commander remembers the last folder per drive; not built).
- The Brief view keeps whole columns mounted: (visible columns + 1 overscan column) × rows per column, so more cells
  than the Full view's rows; it stays bounded by the panel's size.
- Hotlist keys 1–9 and sub-menus per group are not built; groups show as sections.

Found and fixed while testing: switching the view (Ctrl+F1) unmounted the focused view and dropped keyboard focus to
the page, so the next key was lost; Alt+F1 / Alt+F2 opened the menu but the active-panel focus effect took the keys
back; and a menu closed with Esc returned focus only on a timer, so a key right after Esc was lost. All three have
renderer tests now.

Tests: Go all (new: space timeouts per volume with a joined blocked read, the volume monitor emitting only on change,
bookmark groups, edit, duplicate, reorder, migration 4 from a pre-C03 database; golden fixtures for the new methods
and events); contracts 57; desktop 97 (new: the bookmark validators for both apps, forwarding of both events);
commander 59 (new: 19 in `navigation.test.tsx`: tab lifecycle with parked and closed sessions, locked tabs, drag
order, restore of tabs, views, sorts, history and cursors, the written state, Brief geometry and keys, marks and quick
search in Brief, drive bar and menu, a not-ready drive, slow volumes, `volumes.changed`, hotlist add, edit, group,
reorder, duplicate, remove and changes from the viewer, the history menu, settings, focus); viewer 167 plus the 2
known theme-label failures (new: bookmarks from the commander, recent re-read on show). E2E:
`specs/commander/navigation.spec.ts` 4 of 4 (scenario 7 across a restart, bookmarks and recent locations shared both
ways through the switch, the two benchmarks); the C00 surface check updated. All commander e2e specs (C00–C03): 20 of 21 on the full run; the one failure (C01 100k, its first 1k folder never painted within 30 s) passed twice on rerun. C01 and C02 benchmarks after C03: 100k first rows 178–240 ms (budget 300), uncached 1k 137–139 ms, cached 1k p95 13 ms; held arrow p95 frame 7 ms with no long tasks, quick search p95 10 ms, mark all 12 ms.

Environment: the generated fixtures under `%TEMP%\fastview-fixtures` (flat-100k, tree-50k, …) had been emptied at
00:29 on 2026-10-06, before this stage's work, while their marker files stayed, so `fixturegen` reported them as
present and every 100k test listed an empty folder. They were deleted and regenerated. `fixturegen` should check the
contents, not only the marker (a test-tooling fix, not done here).

Measurements (reference machine, `shared/bench/results/stage-C03-2026-10-06-e2e-navigation.jsonl`; 60 Hz display):

| Metric | Result | Budget |
|---|---|---|
| Tab switch, 1k-entry folders, parked session → rows painted | p95 12 ms, median 6 ms (includes one frame of polling) | p95 < 50 ms |
| Tab switch, 1k-entry folders, session reopened after the grace period | p95 14–46 ms over 6 runs, median 12–39 ms | p95 < 50 ms |
| Session restore: launch → both panels painted (2 tabs, Brief view, a drive root) | 310–336 ms | < 1.3 s |
| Drive menu with a dead network share (8 s): key → menu shown | 4–5 ms | — |
| … the other panel's cursor meanwhile | 1–3 ms | ≤ 1 frame |
| … the dead share listed as "not ready" | 1.32–1.33 s (its 1.5 s timeout, from the first refresh) | never blocks |
| Commander bundle, JS minified | 453.3 KB (C02: 424.6 KB) | not budgeted |

## Open

- An NVDA pass over the Brief view's listbox and the menus (with C02's open NVDA pass).
- C02's and C01's open items (see `docs/DEVELOPMENT-STAGES.md`).

## Exit checklist

- [x] implementation complete
- [ ] tests complete (the NVDA pass, with C02's)
- [x] benchmark complete
- [x] performance regression reviewed (both apps)
- [x] docs/ADR updated
