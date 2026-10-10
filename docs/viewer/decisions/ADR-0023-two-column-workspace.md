# ADR-0023 — Two-Column Workspace

## Status

Accepted

Amended 2026-10-10 (owner's request): the preview has two positions. A switch next to the title in the sidebar header
chooses between the preview under the folder tree (this ADR's layout, still the default) and a full-height preview
column to the right of the content.

## Decision

Use two resizable columns: the folder tree above the preview in the left column, and the current-folder content on the
right. Keep an independent divider between the tree and preview, so users can adjust both the column width and the
vertical split.

## Implementation

The outer horizontal panel group sizes the left column and content. A nested vertical group sizes the tree and preview.
Both groups save their layout to the workspace setting after user resizing. Existing saved left-column and content sizes
are retained; the former right-preview width is ignored because it does not represent a useful tree/preview height.

## Rationale

The content pane keeps the width needed to browse tiles, while the folder tree and selected-media preview share one
column. This gives the preview a useful place in narrower windows and keeps it close to navigation.

## Amendment (2026-10-10): preview position

- The sidebar header carries a two-button switch after the "Panelyth" title: **Preview under the folders** and
  **Preview in a column on the right**. The choice is saved with the workspace (`previewPlace`, default `left`).
- On the right, the outer group has three panels (sidebar, content, preview); the sidebar column shows only the tree.
  The preview column is resizable and collapsible like the other panes.
- Each position keeps its own saved sizes (the right-hand layout's are stored under `right:` keys), so switching back
  restores the widths used before.
- Switching rebuilds the panel groups once; it is a rare, deliberate action.

## Rules

- both dividers remain keyboard and pointer resizable
- with the preview on the left, the folder tree stays above it
- the preview can collapse independently
- resizing either group persists without per-pointer-move writes
