# ADR-0004 — Row-Based Virtualized Grid

## Status

Accepted

## Decision

Use `@tanstack/react-virtual` with a vertically virtualized set of rows.

Each row contains the current number of columns.

## Why

The product needs very large datasets while keeping DOM and React work bounded.

A predictable tile aspect ratio makes row heights cheap to calculate and avoids expensive dynamic measurement on every image.

## Consequences

- column count changes require a row-count recomputation
- tile geometry must remain predictable
- irregular masonry layouts are deferred

## Rejected for MVP

### CSS-only lazy rendering

Not enough control over DOM size for very large folders.

### Masonry / Pinterest layout

More measurement complexity and harder scroll stability.
