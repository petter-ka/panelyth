# Stage C01 — Panels and Listing

Status: **Planned**. Track: commander. Depends on: C00, P02. Unblocks: C02.

## Objective

Two panels that list any folder's entries in the Full view, fast at any size, sorted, with a path bar and a status
line; and switching between the apps carries the folder and the entry under the cursor over. This is where the
commander starts being useful.

## Decisions applied

- **ADR-0028** (proposed; this stage decides it): dual panels, fixed-geometry virtualized lists.
- ADR-0026 (all-entries scope), ADR-0017 (sessions), ADR-0020 (watching per visible panel), ADR-0011 (page store).
- ADR-0031 and `docs/shared/APP-SWITCHING.md`: the shared context, first part (folder and focus).

## Scope

- Panel locations: home on first run, then the persisted location. Enter on a folder or `..`; Backspace and Ctrl+PgUp
  go up, with the cursor landing on the folder just left.
- Listing: `dir.open` and `query.open` with the all-entries scope; a page store per session; refetch on
  `query.invalidated`; the folder of each visible panel is watched.
- Full view: `@tanstack/react-virtual` rows of fixed height; columns Name, Ext, Size, Date, Attr in a CSS grid with
  fixed widths (resizable, persisted); type glyphs; `<DIR>` for folders; hidden entries muted; the synthetic `..` row.
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

- Renderer: row geometry is fixed per interface size; columns resize and persist; header sort; status-line text.
- E2E: scenarios 1–4 and the error states of 16 (`docs/commander/TESTING.md`).
- E2E (switch): folder and focus carried both ways; same-folder switch keeps state; a non-media cursor entry selects
  nothing in the viewer; a folder deleted between switches; restart opens the last app and folder.

## Benchmarks

`BENCH_STAGE=C01`: enter a 1k folder (cached and uncached) and a 100k folder; 100k scroll in each panel (mounted rows,
long tasks, p95 frame); sort change on 100k; a switch with a folder change in each direction.

## Acceptance criteria

- The listing budgets in `docs/commander/PERFORMANCE.md` pass.
- One panel listing a 100k folder never delays input in the other panel.
- A switch with a folder change paints the target within its cached-folder listing budget.
- ADR-0028 is accepted.

## Risks

- Attribute and size reads on slow volumes. Mitigation: rows render with what the listing has; missing fields fill in
  through invalidation.

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
