# Stage C03 — Drives, Tabs, Hotlist, History and Session

Status: **Planned**. Track: commander. Depends on: C02. Unblocks: P03, C04.

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

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
