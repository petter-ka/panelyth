# ADR-0001 — Electron + React + Go Sidecar

## Status

Accepted

Amended 2026-10-05: this stack applies to both apps of the product family, hosted by one Electron shell (ADR-0025,
ADR-0031).

## Context

Panelyth needs:

- Windows/macOS/Linux packaging
- high-quality desktop UX
- native filesystem access
- a React UI
- high-performance image processing

## Decision

Use Electron for the desktop shell and React for UI rendering.

Run Go as a dedicated child-process sidecar for filesystem/indexing/image/cache workloads.

## Why

- keeps renderer UI isolated from heavy native work
- Go is well suited to filesystem concurrency and image pipeline orchestration
- Electron provides cross-platform desktop packaging
- React remains focused on rendering and interaction

## Consequences

Positive:

- clear process boundaries
- heavy work can scale independently
- portable backend code

Negative:

- packaging includes a Go binary
- process lifecycle needs supervision
- IPC protocol becomes a compatibility surface

## Rejected

### Go compiled directly into Electron

Rejected for MVP because it complicates the JS/Electron runtime boundary and cross-platform packaging.

### Electron main as the image backend

Rejected because the main process is responsible for application coordination and should not become a heavy image-processing server.
