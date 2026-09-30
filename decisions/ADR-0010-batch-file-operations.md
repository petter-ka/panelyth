# ADR-0010 — Asynchronous Batch File Operations

## Status

Accepted

## Decision

Copy/move/delete/rename are handled by a Go job manager with bounded concurrency and batched progress events.

## Rules

- every operation gets a job ID
- cancellation is supported where safely possible
- failures are reported per item
- browsing remains responsive
