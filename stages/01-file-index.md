# Stage 01 — File Index

## Objective

Incrementally index image files into SQLite.

## Work

- folder normalization
- recursive scan
- supported-image detector
- SQLite schema
- batch inserts
- deterministic sorting
- offset/limit API
- scan generation
- cancellation
- change detection foundation
- file watcher integration

## Acceptance

- index 100k synthetic entries without browser freeze
- browser receives results in batches
- scanner can be cancelled
- repeat open reuses existing index information

## Performance checks

Record:

- files/sec
- DB write batch latency
- first page latency
- memory growth
