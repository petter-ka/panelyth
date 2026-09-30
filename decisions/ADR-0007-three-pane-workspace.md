# ADR-0007 — Three-Pane Workspace

## Status

Accepted

## Decision

Use a resizable three-pane desktop workspace:

- left: filesystem/navigation sidebar
- center: current-folder content
- right: selected image/video preview

Persist pane dimensions and collapse state.

## Rationale

The product is both a filesystem browser and media viewer. Persistent preview reduces context switching.

## Rules

- each pane has min/max sizes
- content is the primary flexible pane
- resizing must not trigger expensive whole-tree/whole-grid renders
