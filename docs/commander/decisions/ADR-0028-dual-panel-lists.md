# ADR-0028 — Commander Panels: Dual-Panel Layout, TanStack Table and Virtualized Lists

## Status

Accepted (2026-10-05, Stage C01). Amended by ADR-0043 (2026-10-16): rows in a Git repository colour their name and end with a
status letter (or a dot for a folder with changes inside); the row stays one component and one store read. Proposed and revised the same day (owner direction): the Full (table) view uses
TanStack Table with TanStack Virtual; the Brief (list) and Thumbnails (tile) views use `@tanstack/react-virtual`.

Stage C01 built the Full view this way and measured it: 100k-entry folders scroll with 0 long tasks and a 7 ms p95
frame, with at most 56 rows mounted; a header click sorts in Go (95–102 ms to the first page on 100k). The commander
bundle grew by 93.4 KB minified (27.6 KB gzip) with `@tanstack/react-table` v9, `@tanstack/react-virtual` and the
stage's code (`docs/commander/stages/C01-panels-and-listing.md`). Implementation notes: the table's `data` is the
visible window's row indexes, and rows read their entries from the page store. Column geometry comes from TanStack
sizes and only the bounded mounted window is rendered while the user resizes or changes layout.

Stage C10 built the Thumbnails view: rows of fixed-size tiles on `@tanstack/react-virtual`, with the tile geometry,
the thumbnail store and the preview frame moved from the viewer to `src/shared/media-ui`. On 100,000 entries it
mounts at most 77 tiles and scrolls with 0 long tasks (`docs/commander/stages/C10-command-line-and-customization.md`).
Folder tiles show the folder symbol; folder covers are not in the commander's profile.

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
- At the left: the shared app switcher rail (ADR-0031). Under the panels: the command line and the function-key bar.
  Each panel has a drive and tab bar, a path bar, the view (a table with a column header, a list or tiles) and a status line
  (`docs/commander/UX-DESIGN.md`).

### Views per panel

| View | Layout | Rendering | Stage |
|---|---|---|---|
| **Full** (default) | table: one row per entry; columns Name, Ext, Size, Date, Attr | TanStack Table + TanStack Virtual | C01 |
| **Brief** | list: names only, flowing top to bottom, then into the next column | `@tanstack/react-virtual` | C03 |
| **Thumbnails** | tiles from the shared tile components and the shared preview cache | `@tanstack/react-virtual` | C10 |

- Row height is fixed per interface size, so no row is ever measured.

### Full view: TanStack Table with virtual scrolling

- **`@tanstack/react-table`** (headless) owns the table model: column definitions (Name, Ext, Size, Date, Attr),
  header rendering, sort state, sizing, visibility, order and pinning. Every column can be resized; Name fills the
  remaining width until the user sets a width. Dragging the column menu's list entries reorders columns (headers do not drag), double-clicking a resize edge fits the
  header and currently virtualized cells, and the header context menu exposes sorting, visibility, movement, pinning
  and width reset. Layout and widths persist per panel. It renders into our own markup with design tokens; no table
  styles come with it.
- **Sorting and filtering stay in Go** (ADR-0008, ADR-0017): the table runs with `manualSorting` and
  `manualFiltering`. A header click changes the session's sort descriptor; it never sorts rows in the browser.
- **The table never holds the whole listing.** Its row model gets only the rows of the visible window plus overscan,
  read from the page store; unloaded rows render as placeholders. A 100k-entry folder costs the same as a 100-entry
  one.
- **Virtual scrolling:** `@tanstack/react-virtual` (`useVirtualizer`, fixed row height, bounded overscan) virtualizes
  the table body. The header is sticky inside the shared scroll viewport, so it stays aligned during horizontal
  scrolling and works with pinned columns. Cell widths come from the table's column sizes as CSS widths; fit-to-content
  measures only mounted virtual rows, never the full listing.

### Brief and Thumbnails views: `@tanstack/react-virtual`

- Brief view: horizontal virtualization of fixed-width name columns. Thumbnails view: the shared tile components
  (ADR-0004's row virtualization). Neither uses TanStack Table. Overscan stays bounded in both.

### Data

- Rows read page data from an external page store (`useSyncExternalStore`, ADR-0011), shared with the viewer through
  `src/shared/renderer-core`. A listing never lives in React state as one array.
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
- TanStack Table gives the table view proper columns (sizing, sorting, visibility, ordering and pinning)
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
