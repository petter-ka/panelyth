# ADR-0002 — Sidecar IPC

## Status

Accepted

## Decision

Use asynchronous framed request/response messages over the Go process stdin/stdout for the control plane.

The renderer interacts only with typed preload APIs.

## Rules

- request IDs required
- batch-oriented payloads
- explicit error envelope
- cancellation support for long-running operations
- bounded response size
- no raw Electron APIs exposed to renderer

## Why

Stdio avoids opening a listening TCP port and makes sidecar ownership straightforward.

A transport abstraction keeps the protocol replaceable if a different native transport becomes necessary later.
