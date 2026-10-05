# ADR-0003 — Persistent Preview Cache on OS Cache Drive

## Status

Accepted

Amended 2026-10-05: both apps share one sidecar and therefore one cache root, so a thumbnail made in one app is a
cache hit in the other (ADR-0031).

## Decision

Store generated thumbnails/previews beneath the per-user OS cache directory.

Use content-addressed, versioned cache keys that incorporate source identity and preview profile.

## Why

- cache must survive restarts
- source files must remain untouched
- application install locations may be read-only
- cache cleanup must be safe
- changing source content must invalidate previews

## Initial policy

- OS cache root from Go
- versioned directory
- two-level hash sharding
- atomic writes
- SQLite metadata
- bounded LRU cleanup

## Rejected

### Cache next to source file

Not acceptable because it modifies user folders and creates clutter.

### Cache inside application resources

Not writable/reliable across packaged installations.

### Base64 in localStorage

Excess memory and poor suitability for a large image collection.
