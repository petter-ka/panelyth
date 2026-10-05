# ADR-0023 — Two-Column Workspace

## Status

Accepted

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

## Rules

- both dividers remain keyboard and pointer resizable
- the folder tree stays above the preview
- the preview can collapse independently
- resizing either group persists without per-pointer-move writes
