# ADR-0017 — Query Sessions and Selection Descriptors

## Status

Accepted (Stage 01), by default: adopted from `docs/shared/ARCHITECTURE-ANALYSIS.md` C3 and C4. Selection
descriptors are specified here and implemented with multi-selection in Stage 05. Each session also keeps
the previous version's id list, so a descriptor made just before a refresh still resolves exactly. After
`query.invalidated`, the renderer calls `selection.rebase`, which returns the same entries as ranges of the new
version. Older versions are rejected (INVALID_ARGUMENT), never misapplied. `selection.info` (count, size) and
`selection.paths` (main only; ≤ 10,000, for the clipboard) resolve descriptors in Go.

Amended 2026-10-05: sessions have a budget per app inside the one sidecar (ADR-0026, proposed); a selection can be
carried to the other app with `selection.fromContext` (ADR-0031); and find results, archives and directory compares
add session sources (commander Stages C06–C08, ADR-0030).

## Context

Offset/limit over a table that is still growing during a scan shifts rows under the user. SQLite `OFFSET` is
O(offset), which is slow deep into 100k rows. Batch APIs that take `ids[]` would send 100k ids over IPC after
Ctrl+A.

## Decision

### Query sessions

- `query.open(descriptor)` runs one `SELECT id … ORDER BY …` and keeps the ordered ids in Go memory as
  `[]int64` (100k rows ≈ 800 KB). It returns `{ queryId, version, total }`.
- `query.page(queryId, offset, limit ≤ 1000)` slices the id list and loads the rows with `WHERE id IN (…)`,
  so every offset costs the same.
- Ordering is always deterministic: directories first, then the requested sort keys, then `id`.
- When the index changes under a session (scan batches, watcher reconciles), Go re-materializes it on a
  debounce (about 250 ms) and emits `query.invalidated { queryId, version, total }`. The renderer refetches only
  the pages it holds, and ids keep selection stable.
- Sessions are capped (8 per sidecar, least-recently-used eviction) and closed explicitly with `query.close`.
  Per-window ownership comes with multi-window support.
- Descriptor fields in Stage 01: `dirId`, `recursive`, `sort: [{ field: name | modified | size | type,
  direction }]` and `kinds`. Search and more sort fields arrive in Stage 05.

### Selection descriptors (specified now, implemented later)

Batch operations take `{ queryId, version, ranges: [start, end)[], include: id[], exclude: id[] }`, and Go
resolves it. The renderer never sends a list of every id.
