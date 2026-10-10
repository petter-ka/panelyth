# Stage C01 — Panels and Listing

Status: **Implementation done** (2026-10-05); the gate waits on the items under "Open". Track: commander. Depends
on: C00, P02. Unblocks: C02.

Started at the owner's request before P02 closed: the P02 query core it needs (the `all` scope, `showHidden`,
`nameMask`, sort by `type` and `attrs`, `attrs` in rows) was already in the code; the rest of P02 stays open.

## Objective

Two panels that list any folder's entries in the Full view, fast at any size, sorted, with a path bar and a status
line; and switching between the apps carries the folder and the entry under the cursor over. This is where the
commander starts being useful.

## Decisions applied

- **ADR-0028** (proposed; this stage decides it): dual panels; the Full view on TanStack Table with TanStack
  Virtual.
- ADR-0026 (all-entries scope), ADR-0017 (sessions), ADR-0020 (watching per visible panel), ADR-0011 (page store).
- ADR-0031 and `docs/shared/APP-SWITCHING.md`: the shared context, first part (folder and focus).

## Scope

- Panel locations: home on first run, then the persisted location. Enter on a folder or `..`; Backspace and Ctrl+PgUp
  go up, with the cursor landing on the folder just left.
- Listing: `dir.open` and `query.open` with the all-entries scope; a page store per session; refetch on
  `query.invalidated`; the folder of each visible panel is watched.
- Full view: `@tanstack/react-table` for columns, headers and column sizing (resizable, persisted), with manual
  sorting (Go sorts) and a row model fed only the visible window from the page store; `@tanstack/react-virtual` rows
  of fixed height for the body. Columns Name, Ext, Size, Date, Attr; type glyphs; `<DIR>` for folders; hidden entries
  muted; the synthetic `..` row.
- Sorting: column-header click (again reverses) and Ctrl+F3 / F4 / F5 / F6; folders first; persisted per panel.
- Hidden and system files: Ctrl+H toggles `showHidden` (no rescan).
- Path bar: the current path; Alt+D or click edits it; Enter navigates; errors are shown inline.
- Status line: total count, marked count and size (once C02 adds marks), free space of the volume.
- Refresh: Ctrl+R. States: loading, empty, permission denied, not found, drive not ready (CFR-28).
- Cursor: arrows, PgUp/PgDn, Home/End move a single cursor (marking arrives in C02).
- **Shared context, part 1** (both apps):
  - on switch, the app being left calls `context.publish` with its folder and focused entry; the app being shown calls
    `context.get` and applies the carry-over rules: the commander's active panel opens the viewer's folder with the
    cursor on its selected tile; the viewer opens the active panel's folder and selects the cursor entry if it can show
    it;
  - nothing moves when the target already shows that folder; a missing folder shows the usual "not found" state;
  - `shared.context` is written on switch and on exit; the next start opens the last used app in the last folder.

## Non-goals

- Marks, quick search, tabs, Brief view, file operations.

## APIs/contracts

- Uses the P02 descriptor (`scope: "all"`, `showHidden`, `nameMask`, sort `ext`, `attrs`). Free space comes from
  `fs.volumes` (matched by volume root); C03 adds a per-path call if that is not enough.
- `context.publish({ app, dirId, focusId })` and `context.get()` (sidecar; both app profiles).

## Tests

- Renderer: row geometry is fixed per interface size; columns resize and persist; a header click changes the
  session sort (never a browser sort); the table's row model holds only the visible window; status-line text.
- E2E: scenarios 1–4 and the error states of 16 (`docs/commander/TESTING.md`).
- E2E (switch): folder and focus carried both ways; same-folder switch keeps state; a non-media cursor entry selects
  nothing in the viewer; a folder deleted between switches; restart opens the last app and folder.

## Benchmarks

`BENCH_STAGE=C01`: enter a 1k folder (cached and uncached) and a 100k folder; 100k scroll in each panel (mounted rows,
long tasks, p95 frame); sort change on 100k; a switch with a folder change in each direction; the commander bundle
size with `@tanstack/react-table`.

## Acceptance criteria

- The listing budgets in `docs/commander/PERFORMANCE.md` pass.
- One panel listing a 100k folder never delays input in the other panel.
- A switch with a folder change paints the target within its cached-folder listing budget.
- ADR-0028 is accepted.

## Risks

- Attribute and size reads on slow volumes. Mitigation: rows render with what the listing has; missing fields fill in
  through invalidation.

## Results (2026-10-05)

Built:

- **Sidecar:** `context.publish` / `context.get` (`internal/app/sharedctx.go`; in memory, persisted as `shared.context`
  one second after the last publish and on shutdown); `query.indexOf` (18 µs on 100k ids); `fs.volumes` reports
  `freeBytes` / `totalBytes` for fixed and removable volumes; `dir.open` reads one name of the folder, so an
  unlistable folder is `PERMISSION_DENIED`, and an unready drive or an unreachable share is `INVALID_PATH` with
  `details.reason` `notReady` / `network` (CFR-28; Windows, Linux and macOS error numbers).
- **Main and contracts:** the commander profile gains the listing methods, `fs.volumes`, `places.list` and the
  context methods; both preloads expose the context (the viewer's only while the commander is enabled) and
  `query.indexOf`. Main accepts `context.publish` only from the visible app and only with its own app id, and rejects
  `scope: "all"` from the viewer (ADR-0027). At start, main reads `shared.context` (waiting at most 400 ms) and shows
  the commander first when it was the last used app.
- **Commander:** per panel a query session in the `all` scope and a `src/shared/renderer-core` page store
  (`features/listing.ts`). The Full view (`components/FullView.tsx`): TanStack Table v9 for columns, header sort
  indicators and column sizing, its row model fed only the visible window's row indexes; rows of fixed height
  (S 20 / M 22 / L 26 px) virtualized with TanStack Virtual, each reading its entry from the page store; column widths
  are CSS variables, so a resize never re-renders rows. Columns Name, Ext, Size, Date, Attr (`rhsa` on Windows, `rwx`
  elsewhere); type glyphs; `<DIR>`; hidden and system entries muted; the synthetic `..` row. A header click and
  Ctrl+F3 / F4 / F5 / F6 sort in Go (again reverses); Ctrl+H toggles hidden entries without a rescan; Ctrl+R
  refreshes; Enter, Backspace and Ctrl+PgUp navigate (up lands on the folder just left); arrows, PgUp/PgDn and
  Home/End move the cursor, which follows its entry when the listing changes. Path bar (click or Alt+D, inline
  errors), status line (count, "Listing… n entries so far" with Stop, free space), the CFR-28 states (empty, not
  found, permission denied, drive not ready, network unavailable; Retry, Back, Home folder). Folders, sorts, hidden
  toggles, column widths and the active panel persist as `commander.panels`.
- **Shared context, part 1:** the commander (`features/carry.ts`) and the viewer (`features/workspace/appSwitch.ts`)
  publish on the switch (with the cursor entry or the focused tile), when shown, and when their folder changes while
  visible. When shown, each applies a newer context of the other app: it opens the folder and puts the cursor or the
  selection on the entry if it can show it; nothing moves when it already shows that folder.

Deviations from the scope above:

- `shared.context` stores `{ v, app, path, pathKey }` without `focusPathKey`: the restart rule needs only the app and
  the folder, and each app restores its own cursor and selection (`docs/shared/APP-SWITCHING.md` updated).
- A viewer showing a recursive view or search results publishes its folder; a focused entry outside that folder's
  direct children is not in the commander's session, so the cursor stays at the top. The containing-folder rule needs
  the entry's parent and comes with the C02 carry-over work.
- The status line shows free space from `fs.volumes`, moved forward from Stage C03 (a per-path call stays C03's, if
  needed).
- The hidden commander keeps invalidations aside and refetches when shown, but does not re-list on show: the sidecar
  still watches every opened folder (P02's visible-app watching is open).

Tests: Go all (new: shared context round trip and persistence, `query.indexOf`, volume space, unavailable-volume
error numbers, golden fixtures for the three new results); contracts 52; desktop 92 (new: commander listing allowed,
the viewer kept to the media scope, `context.publish` only from the visible app as itself); commander 26 (new: 20 in
`listing.test.tsx`: home on first run, fixed row heights per interface size, a 100k folder mounts and pages only the
window, cursor keys, Enter/Backspace with the cursor on the folder just left, header and Ctrl+F-key sorting in Go,
Ctrl+H without a rescan, column resize persisted, restore, status line, the four error states with inline path
errors, empty folder, attribute formatting, the carry-over rules); viewer 155 + 2 failing (the theme-label tests that
already failed; new: 5 carry-over tests). E2E 56 of 59: `specs/commander/listing.spec.ts` (8, new) passes and the
commander foundation spec's surface check was updated; the 2 failing `theme.spec.ts` tests already failed, and
`tiles.spec.ts › wider windows fit more tiles per row` is flaky on this machine at HEAD too (1 of 3 runs fails at
HEAD, 2 of 3 here).

Measurements (reference machine; `src/shared/bench/results/stage-C01-2026-10-05-e2e-listing.jsonl`; 4 runs, the first
right after a build, with a cold file cache):

| Metric | Result | Budget |
|---|---|---|
| Enter a cached 1k folder → rows painted | p95 8–13 ms | p95 < 50 ms |
| Enter an uncached 1k folder → first rows painted | 110–116 ms | p95 < 150 ms |
| Enter an uncached 100k folder → first rows painted | 144–151 ms (cold first run: 470 ms) | < 300 ms |
| Keys in the other panel while 100k entries list | p95 7 ms, 0 long tasks | ≤ 1 frame |
| 100k scroll, each panel | p95 frame 7 ms, 0 long tasks, ≤ 56 rows mounted (32 visible + 2 × 12) | no long tasks; ≤ visible + 2 × overscan |
| Sort change on 100k → first page | 95–102 ms (cold first run: 366 ms) | < 300 ms |
| Switch with a folder change, commander → viewer (tile selected) | 43–44 ms | 1 frame + the viewer's cached-folder budget |
| Switch with a folder change, viewer → commander (cursor placed) | 18–25 ms | 1 frame + 50 ms |
| Commander bundle, JS minified / gzip | 364.3 / 112.8 KB; C00: 270.9 / 85.2 KB (+93.4 / +27.6 KB for `@tanstack/react-table`, `@tanstack/react-virtual` and C01's code) | not budgeted |

The cold first runs (470 / 366 ms) miss the 100k budgets; every warm run passes.

Viewer regression check: the viewer's unit and e2e suites are unchanged apart from the known failures above. Its
uncached 100k index measurement was noisy on this machine today in both trees (HEAD: first rows 124–625 ms, complete
2.0–12.8 s, 2 of 4 runs failing; this stage: first rows 10–225 ms, complete 1.9–4.6 s); runs with the `dir.open`
readability probe disabled landed in the same range, so no difference is attributable to C01. The viewer's start-up
path is unchanged while the commander is disabled (main reads the context only when the commander is enabled and no
start app is forced).

## Open

- **P02 rest:** per-app session budgets (the one 8-session budget now serves the viewer and both panels), watching
  only the visible app's folders, and P02's regression runs and benchmarks.
- **Cold-cache 100k numbers:** the first run after a build missed the first-rows and sort budgets (470 / 366 ms);
  re-measure on the reference and the low-end machine (Stage P05 at the latest).

## Exit checklist

- [x] implementation complete
- [x] tests complete
- [x] benchmark complete
- [ ] performance regression reviewed (cold-cache 100k runs over budget; the viewer comparison was noisy)
- [x] docs/ADR updated
