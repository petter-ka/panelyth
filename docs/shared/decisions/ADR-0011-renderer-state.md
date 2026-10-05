# ADR-0011 — Renderer State Management

## Status

Accepted (Stage 00)

## Context

`docs/shared/PERFORMANCE.md` requires "selectors for global stores" and forbids context updates that re-render the
whole tile view. The renderer needs a small amount of global UI state (sidecar status, theme, later layout,
navigation, query, selection, jobs). Large datasets (directory pages) must never live in React state.

## Decision

- Use **Zustand** for global UI stores: one small store per feature (`features/*/…Store.ts`), consumed
  through selectors so a component re-renders only when its slice changes.
- Stores are created at module level and can be driven outside React (event subscriptions in
  `startSidecarMonitoring()`), which keeps IPC event handling out of component effects.
- Paged/virtualized data (Stage 03+) uses plain external stores read through `useSyncExternalStore`, keyed
  by item index. Page arrays are never put in Zustand or React state.
- No React context for frequently changing values.

## Why

- About 1 KB, selector-based, no provider tree, works with React 19 concurrent rendering.
- Keeps the dependency surface small (CLAUDE.md: no heavy libraries without an ADR).

## Rejected

- **Redux Toolkit**: more ceremony than needed; the same selector model.
- **React context + useReducer**: every consumer re-renders on any change.
- **Hand-rolled `useSyncExternalStore` stores everywhere**: fine for the page store, but repetitive for
  ordinary UI state.
