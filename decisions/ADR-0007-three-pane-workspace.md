# ADR-0007 — Three-Pane Workspace (Historical)

## Status

Superseded by [ADR-0023](ADR-0023-two-column-workspace.md)

The original side-by-side arrangement was replaced during Stage 08.5. Its
resizing and workspace persistence requirements continue in ADR-0023.

## Decision

Use a resizable three-pane desktop workspace:

- left: filesystem/navigation sidebar
- center: current-folder content
- right: selected image/video preview

Persist pane dimensions and collapse state.

## Implementation (Stage 05)

`react-resizable-panels` v4 (`Group` / `Panel` / `Separator`): sidebar 180–480 px and preview 220 px–50 % keep
their pixel width when the window resizes (`groupResizeBehavior: preserve-pixel-size`); content is at least 360 px and
takes the rest. Both side panes collapse (drag past the minimum, or the toolbar toggles), and double-clicking a divider
resets it. The layout is persisted with the workspace (library.db + localStorage mirror) from `onLayoutChanged`, so
never per pixel. A drag re-renders tile rows only when tiles per row change. Measured: 30-step drag, 0 long tasks.

## Rationale

The product is both a filesystem browser and media viewer. Persistent preview reduces context switching.

## Rules

- each pane has min/max sizes
- content is the primary flexible pane
- resizing must not trigger expensive whole-tree/whole-tile-view renders (only a change in tiles per row re-renders rows)
