# ADR-0028 — Commander Panels: Dual-Panel Layout and Virtualized Lists

## Status

Proposed (2026-10-05). Decided in Stage C01.

## Context

- The commander is a dual-panel file manager (ADR-0025). Users expect a detailed list (name, extension, size, date,
  attributes), a brief list (names only, in columns), cursor movement and marking from the keyboard, and 100k-entry
  folders without lag.
- ADR-0004 forbids list and table views **in the viewer** and virtualizes tile rows with `@tanstack/react-virtual`.
  Its reasons (fixed geometry, nothing measured, mounted DOM proportional to the viewport) apply to lists too.

## Decision

### Layout

- Two panels side by side (left and right) with a resizable divider: 50/50 by default, double-click resets, and the
  split is persisted. One panel is active at a time; Tab switches.
- Above the panels: the app bar with the switch icon to the viewer (ADR-0031). Under the panels: the command line
  and the function-key bar. Each panel has a drive and tab bar, a path bar, a column header, the list and a status line
  (`docs/commander/UX-DESIGN.md`).

### Views per panel

| View | Layout | Stage |
|---|---|---|
| **Full** (default) | one row per entry; columns Name, Ext, Size, Date, Attr | C01 |
| **Brief** | names only, flowing top to bottom, then into the next column | C03 |
| **Thumbnails** | tiles from the shared tile components and the shared preview cache | C10 |

- Row height is fixed per interface size. Column widths are user-resizable and persisted, and Name takes the remaining
  width. Columns are a CSS grid with fixed widths, so no cell is ever measured.

### Virtualization and data

- Full view: `@tanstack/react-virtual` over rows. Brief view: horizontal virtualization of fixed-width columns. Overscan
  stays bounded in both.
- Rows read page data from an external page store (`useSyncExternalStore`, ADR-0011), shared with the viewer through
  `packages/renderer-core`. A listing never lives in React state as one array.
- Each visible tab of a panel holds one query session (ADR-0017; per-profile cap in ADR-0026).

### Cursor and marks

- The **cursor** (focus) and the **marked set** (selection) are separate, as in Total Commander. Commands act on the
  marked set, or on the cursor entry when nothing is marked.
- Marks use the selection-descriptor algebra (ADR-0017) shared with the viewer, so Ctrl+A on 100k entries stays one
  range.

### Keyboard

- A Total Commander-compatible default keymap in the shared keymap (ADR-0022), with commander scopes (`panels`,
  `lister`, `dialogs`). Every command is remappable.

## Why

- Fixed row geometry keeps scrolling and cursor movement constant-cost at any folder size.
- Separate cursor and marks are the core Total Commander interaction, and descriptor-based marks scale to 100k entries.

## Consequences

- ADR-0004's "no list or table views" applies to the viewer only; it carries a note saying so.
- Thumbnails mode depends on moving the viewer's tile components into a shared package (Stage C10).
- Screen-reader semantics follow the ARIA grid pattern (Full) and listbox pattern (Brief), verified in Stage C02.
