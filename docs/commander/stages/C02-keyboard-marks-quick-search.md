# Stage C02 — Keyboard, Marks and Quick Search

Status: **Planned**. Track: commander. Depends on: C01. Unblocks: C03.

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

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
