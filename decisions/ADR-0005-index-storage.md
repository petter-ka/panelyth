# ADR-0005 — SQLite Local Index

## Status

Accepted

## Decision

Store the persistent local file index in SQLite managed by Go.

## Why

Need:

- deterministic sorting
- offset/limit paging
- incremental updates
- metadata filtering
- durable scan state

SQLite provides a compact embedded query engine without requiring a separate server.

## Rules

- WAL mode where supported/appropriate
- indexes on hot query columns
- batch inserts/updates
- prepared statements
- never query one row at a time from the renderer
