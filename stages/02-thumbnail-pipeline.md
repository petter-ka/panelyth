# Stage 02 — Thumbnail Pipeline + Cache

## Objective

Generate and persist previews without blocking UI.

## Work

- decoder abstraction
- source identity
- preview profiles
- cache key
- sharded cache paths
- SQLite cache index
- bounded worker pool
- deduplicated jobs
- priority queue
- cancellation/deprioritization
- atomic cache writes
- cache cleanup
- controlled preview protocol

## Acceptance

- visible thumbnails appear incrementally
- repeated requests coalesce
- restart produces cache hits
- modified source produces cache miss
- corrupt cache item can be regenerated

## Performance checks

Record:

- p50/p95 thumbnail latency
- cache hit latency
- throughput at several worker limits
- CPU utilization
- disk write rate
