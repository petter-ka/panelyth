# Stage C02 — Keyboard, Marks and Quick Search

Status: **Implementation done** (2026-10-05); the gate waits on the items under "Open". Track: commander. Depends
on: C01 (implementation done; its gate is open). Unblocks: C03.

## Objective

The Total Commander keyboard model: a cursor and an independent marked set, marking by mask, type-ahead search, panel
swapping and history, all at constant cost on 100k listings; and the selection carried over between the apps.

## Decisions applied

- ADR-0028 (cursor vs marks), ADR-0017 (selection descriptors, rebase), ADR-0022 (keymap; commander scopes).
- ADR-0031 and `docs/shared/APP-SWITCHING.md`: the shared context, second part (selection).

## Scope

- Marking: Insert (mark and move down), Space (mark; on a folder also start a size job), Shift+arrows; Num+ / Num−
  with a mask dialog (masks share the `nameMask` syntax), Num* invert, Ctrl+A / Ctrl+Num+ all, Ctrl+Num− none, Alt+Num+
  the cursor's extension. Marks are descriptors from the shared selection algebra and are rebased after invalidation.
- Mouse: click moves the cursor; Ctrl+click toggles; Shift+click marks a range with the viewer's additive rules
  (Stage 08.6); a setting switches to right-button marking.
- Quick search: letters open a small search box; prefix match first, then substring; `*` and `?`; ↑/↓ jump between
  matches; Esc closes. Go answers with `query.locate`.
- Navigation: Ctrl+\ root; Ctrl+U swap panels; Ctrl+← / Ctrl+→ open the cursor folder in the left / right panel;
  Alt+← / Alt+→ back and forward per panel.
- Folder size: a cancellable `dirSize` job per folder; the result fills `dir_size_bytes`; the status line shows marked
  sizes through `selection.info` (debounced).
- Keymap: commander scopes registered with Total Commander defaults (`docs/commander/UX-DESIGN.md`); the shared
  Keyboard shortcuts dialog (F1, Ctrl+/) lists and remaps them.
- Accessibility: the ARIA grid pattern (`aria-activedescendant` for the cursor, `aria-selected` for marks).
- **Shared context, part 2** (both apps): `context.publish` includes the selection descriptor; Go keeps up to 10,000
  ids; the app being shown turns them into its own selection with `selection.fromContext` (the viewer drops entries it
  doesn't show). Over 10,000: a notice, no carry-over. Settings → General: carry over the folder, the entry under the
  cursor, the selection (each on by default), and "Start with: last used app · Viewer · Commander".

## Non-goals

- Tabs, drives, hotlist (C03); file operations (C04).

## APIs/contracts

- `query.locate({ queryId, pattern, from, direction }) → { index }` (−1 when there is no match).
- Job kind `dirSize { entryIds | descriptor }`, with results written to the index and an invalidation.
- `selection.fromContext({ version, queryId, queryVersion }) → SelectionDescriptor`; `context.publish` gains
  `selection`.

## Tests

- Renderer: cursor and mark algebra (Insert, Space, Shift ranges, masks, invert) on descriptors; quick-search state
  machine; key dispatch per scope.
- Go: `query.locate` (prefix, substring, wildcards, wrap-around) and its cost; `dirSize` cancel and link safety.
- E2E: scenarios 5 and 6; swap and history; the axe check on the grid; a manual NVDA pass recorded in the stage doc.
- E2E (switch): selection and marks carried both ways; entries the viewer doesn't show are dropped; the over-limit
  notice; each carry-over option off.

## Benchmarks

`BENCH_STAGE=C02`: held arrow on 100k (long tasks, frame gaps); quick search p95 on 100k; mark all and invert on 100k;
folder-size throughput on `tree-50k`; selection carry-over of 10,000 entries (< 100 ms).

## Acceptance criteria

- Cursor and quick-search budgets pass (`docs/commander/PERFORMANCE.md`).
- Every C02 row of the default keymap works, and each one can be remapped.

## Risks

- Letter keys conflict with commands. Mitigation: in a panel, plain letters always go to quick search; commands use
  modifiers or function keys.

## Results (2026-10-05)

Built:

- **Sidecar:** `query.locate` and `query.match` answer from a per-session lookup built once per version (folded names,
  folder flags, id → position); a keystroke is an in-memory scan (0.13 ms over 100k names), the first one per session
  version loads the names (about 100 ms on 100k). `dirSize` jobs walk folders without following links or junctions,
  cancel through the job context, write `dir_size_bytes` (kept by rescans) and invalidate the parent's sessions;
  `ContentItem.dirSizeBytes` and `selection.info` bytes include calculated folder sizes. The shared context keeps a
  carried selection (≤ 10,000 ids; larger ones set `selectionTooLarge`) with the version of the switch that carried
  it; `selection.fromContext` maps it onto the shown app's session from its id list alone (1.4 ms for 10,000 ids in
  100k).
- **Main and contracts:** the commander profile gains `query.locate`, `query.match`, `selection.info`,
  `selection.rebase`, `selection.fromContext`, `jobs.start` and `jobs.cancel`; main lets the commander start only
  `dirSize` jobs until C04. `shared.switch` (carry-over options, "Start with") is read by main at start.
- **Shared packages:** the selection algebra (incl. invert, add/remove ranges), the keymap engine (with numeric-keypad
  chords `Num+`, `Num-`, `Num*`) and the switch-settings store moved to `src/shared/renderer-core`; `Button`, `Kbd`,
  `DialogWindow` and the shortcuts dialog to `src/shared/ui`. The viewer uses them unchanged in behavior.
- **Commander:** marks per panel as descriptors (`features/marks.ts`), rebased in Go when the listing changes and
  reset by a new session; Insert, Space (on a folder also its size), Shift+arrows / Shift+click with the viewer's
  additive rules, Ctrl+click, Ctrl+A / Ctrl+Num+, Ctrl+Num−, Num*, Num+ / Num− with a mask dialog (the last mask is
  offered), Alt+Num+, Alt+Shift+Enter for all folder sizes; marked rows in `accent` with a `•` gutter and
  `aria-selected`, the grid `aria-multiselectable`. Quick search (`features/quicksearch.ts`): letters open the box,
  ↓/↑ cycle, Esc closes, any other key closes and acts. Ctrl+\, Ctrl+U (panels, sessions, marks and size jobs swap),
  Ctrl+← / Ctrl+→, Alt+← / Alt+→ (history per panel, 50 entries). Status line: "n of m marked · x of y", sizes from Go
  (debounced), "Calculating folder sizes…" with Stop. Keys go through the commander's registry (`features/keymap.ts`:
  scopes `shell` and `panels`, overrides in `commander.shortcuts`); F1 and Ctrl+/ open the shared dialog to list and
  remap them. Closing a dialog opened from the keyboard returns focus to the active panel.
- **Shared context, part 2:** the switch publishes the marks (commander) or a multi-selection (viewer); the shown app
  applies the carried selection after opening the folder (or in the same folder), the viewer leaving out what it does
  not show; over 10,000 entries a notice says it was not carried. The viewer's Settings gain a General tab (while the
  commander is enabled): carry over the folder, the entry under the cursor, the selection; Start with.

Deviations from the scope above:

- Right-button marking was not built with the stage. Added 2026-10-10 at the owner's request, as the default, with
  the context menu on hold (`components/useRightButton.ts`, `components/RowMenu.tsx`, `rightbutton.test.tsx`;
  Settings → "Right mouse button" switches to a plain right-click menu). Customizing the menu stays in Stage C10.
- A new session (sort or hidden-files change) starts unmarked; Go rebases marks only across versions of the same
  session.
- The viewer publishes a selection only when more than one tile is selected (a single selected tile is the focused
  entry, which already carries).
- The commander has no settings dialog yet; the carry-over options and "Start with" are edited in the viewer's
  Settings → General and apply to both apps (`shared.switch`).
- The switch key is remapped per app (`shortcuts`, `commander.shortcuts`), not in a shared `shared.shortcuts`.

Found and fixed while testing: the app being shown published its own folder before reading the carried selection,
so the selection's version no longer matched (now kept per carrying version, see above); and closing a dialog opened
from the keyboard left focus on the page body, so the next panel key was lost (the mask field's `autoFocus` defeated
the dialog's focus restore).

Tests: Go all (new: `query.locate` prefix/substring/wildcards/wrap, `query.match` masks, positions, globbing, the
`dirSize` job with sizes, a junction loop not followed, cancel under 200 ms, sizes kept by rescans and counted by
`selection.info`, the carried selection surviving a folder publish; golden fixtures for `query.locate`,
`query.match`, `selection.fromContext` and the new context fields); contracts 55; desktop 95 (new: `dirSize` only for
the commander, the C02 validators, "Start with"); `src/shared/renderer-core` 12 (algebra, keypad chords, scoped
resolution); commander 40 (new: 14 in `marks.test.tsx`); viewer 165 + 2 failing (the known theme-label tests; new:
selection carry-over, notice, options, Settings → General). E2E: `specs/commander/marks.spec.ts` 6 of 6 (scenarios 5
and 6, swap and history, remapping in F1, the axe check of the grid with no violations, selection carried both ways
with the viewer dropping `notes.txt`, the too-large notice, the folder option off); the C00 surface check updated.

Full e2e run: 48 passed, 8 failed, 9 not run. On rerun: the 2 known `theme.spec.ts` failures; the two 100k tile
scroll tests of `tiles.spec.ts`, whose 100,000 px floor assumes a high refresh rate, while the machine's display
setup changed during the session to a single 60 Hz display (rAF median 16.7 ms; every scroll benchmark dropped from
~720 to ~300 frames at the same time, the commander's included); the rest were crashed workers.

Environment: on 2026-10-05 Node and Electron processes on the reference machine crashed at random points with access
violations (0xC0000005), V8 fatal checks and plain segfaults — vitest workers, Playwright, pnpm itself — while the
same commands passed on rerun and Go was unaffected. One crash source was ours (a test fake that never advanced its
session version made the page store refetch forever) and is fixed; the rest remain. With Stage 07's SQLite heap
fault this points at the machine (an i9-13900K), not the code.

Measurements (reference machine, `src/shared/bench/results/stage-C02-2026-10-05-e2e-marks.jsonl`; 60 Hz display):

| Metric | Result | Budget |
|---|---|---|
| Held arrow on 100k (one key per frame, 3 s) | 181 keys, p95 frame 18 ms, max gap 19 ms, 0 long tasks | no long tasks > 50 ms; no frame gaps > 50 ms |
| Quick search keystroke → cursor on the match (100k) | p50 18 ms, p95 19–21 ms (one earlier run had a single 3.1 s stall) | p95 < 50 ms |
| `query.locate` in Go (100k) | first keystroke 97 ms (builds the names), then 0–1 ms | — |
| Mark all / invert / invert back on 100k → status line | 10–12 / 5–8 / 5–11 ms | — |
| Folder sizes of `tree-50k` (51,800 files) | 96–257 ms, ≈ 200k–540k files/s | ≥ 50k entries/s |
| Selection carry-over, 9,900 entries, commander → viewer selected | 37 ms (236 / 123 ms before positions stopped loading names) | < 100 ms |
| Commander bundle, JS minified | 424.6 KB (C01: 364.3 KB) | not budgeted |

## Open

- The manual NVDA pass (not done; the axe check of the grid passes).
- C01's open items: the cold-cache 100k timings and the rest of P02.

## Exit checklist

- [x] implementation complete
- [ ] tests complete (the NVDA pass)
- [x] benchmark complete
- [x] performance regression reviewed
- [x] docs/ADR updated
