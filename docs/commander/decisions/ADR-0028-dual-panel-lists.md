# ADR-0028 — Commander Panels: Dual-Panel Layout, TanStack Table and Virtualized Lists

## Status

Proposed (2026-10-05). Decided in Stage C01. Revised 2026-10-05 (owner direction): the Full (table) view uses
TanStack Table with TanStack Virtual; the Brief (list) and Thumbnails (tile) views use `@tanstack/react-virtual`.

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
  and the function-key bar. Each panel has a drive and tab bar, a path bar, the view (a table with a column header, a list or tiles) and a status line
  (`docs/commander/UX-DESIGN.md`).

### Views per panel

| View | Layout | Rendering | Stage |
|---|---|---|---|
| **Full** (default) | table: one row per entry; columns Name, Ext, Size, Date, Attr | TanStack Table + TanStack Virtual | C01 |
| **Brief** | list: names only, flowing top to bottom, then into the next column | `@tanstack/react-virtual` | C03 |
| **Thumbnails** | tiles from the shared tile components and the shared preview cache | `@tanstack/react-virtual` | C10 |

- Row height is fixed per interface size, so no row is ever measured.

### Full view: TanStack Table with virtual scrolling

- **`@tanstack/react-table`** (headless) owns the table model: column definitions (Name, Ext, Size, Date, Attr; more
  columns later), header rendering, the sort state shown in the headers, column sizing (drag to resize, persisted;
  Name takes the remaining width) and, later, column visibility and order. It renders into our own markup with design
  tokens; no table styles come with it.
- **Sorting and filtering stay in Go** (ADR-0008, ADR-0017): the table runs with `manualSorting` and
  `manualFiltering`. A header click changes the session's sort descriptor; it never sorts rows in the browser.
- **The table never holds the whole listing.** Its row model gets only the rows of the visible window plus overscan,
  read from the page store; unloaded rows render as placeholders. A 100k-entry folder costs the same as a 100-entry
  one.
- **Virtual scrolling:** `@tanstack/react-virtual` (`useVirtualizer`, fixed row height, bounded overscan) virtualizes
  the table body; the header stays outside the scrolling body. Cell widths come from the table's column sizes as CSS
  widths, so nothing is measured while scrolling or moving the cursor.

### Brief and Thumbnails views: `@tanstack/react-virtual`

- Brief view: horizontal virtualization of fixed-width name columns. Thumbnails view: the shared tile components
  (ADR-0004's row virtualization). Neither uses TanStack Table. Overscan stays bounded in both.

### Data

- Rows read page data from an external page store (`useSyncExternalStore`, ADR-0011), shared with the viewer through
  `shared/renderer-core`. A listing never lives in React state as one array.
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
- TanStack Table gives the table view proper columns (sizing, header sort indicators, later visibility and order)
  without writing a table engine, and it is headless, so it costs nothing in styling and fits the design system. It
  comes from the same family as TanStack Virtual, which both apps already use. A list or tile layout has no columns,
  so the Brief and Thumbnails views don't need it.
- Separate cursor and marks are the core Total Commander interaction, and descriptor-based marks scale to 100k entries.

## Consequences

- ADR-0004's "no list or table views" applies to the viewer only; it carries a note saying so.
- A new dependency, `@tanstack/react-table`, in the commander renderer only (Stage C01). CLAUDE.md requires an ADR for
  UI libraries; this ADR is it. Its bundle cost is measured in C01.
- Manual sorting and a windowed row model mean TanStack Table's built-in sorting, filtering and pagination features
  are not used; the page store and query sessions stay the source of truth.
- Thumbnails mode depends on moving the viewer's tile components into a shared package (Stage C10).
- Screen-reader semantics follow the ARIA grid pattern (Full) and listbox pattern (Brief), verified in Stage C02.
