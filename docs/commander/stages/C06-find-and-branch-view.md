# Stage C06 — Find Files, Branch View and Quick Filter

Status: **Planned**. Track: commander. Depends on: C05. Unblocks: C07.

## Objective

Find files by name, content, size, date and attributes across a tree, work on the results like a folder, and see a
whole subtree as one flat listing.

## Decisions applied

- ADR-0026 (all scope; recursive listings), ADR-0015 (bounded, cancellable recursive indexing).
- **Amends ADR-0017:** query sessions get a **session-source interface**. The index stays the default source; this
  stage adds the `find` source (results sorted and paged in Go, ids from a separate range). Archives (ADR-0030, Stage
  C07) and directory compare (Stage C08) reuse the interface.

## Scope

- **Find (Alt+F7):** General tab (masks with `|` exclusions, start folders, depth, text, case, whole words, encoding),
  Advanced tab (size, date, attributes), Results tab (streaming list; Feed to panel; Go to file; Stop). Search history
  is kept.
- **Engine (Go):** a bounded walk (never follows links, depth limit, cancellable) feeding a `find` session source
  (sorted and paged like a folder). Content search streams files with bounded buffers, skips binary files by option,
  and handles UTF-8, UTF-16 and single-byte encodings.
- **Feed to panel:** a panel location of kind `find`; every command works on it (copy, delete, quick view, …).
- **Go to file:** opens the containing folder in the panel with the cursor on the file.
- **Branch view (Ctrl+B):** the current folder's subtree as one flat listing (a recursive all-scope session).
- **Quick filter (Ctrl+S):** `nameMask` on the visible tab, shown in the path bar until cleared.

## Non-goals

- An index of file contents; searching inside archives.

## APIs/contracts

- `find.start(spec) → { findId, queryId }`, `find.cancel(findId)`; results reach the renderer through
  `query.invalidated` on the find session.
- The descriptor's `recursive` flag in the all scope (branch view).

## Tests

- Go: masks and exclusions, depth, link cycles, content in each encoding, binary skip, cancel latency.
- E2E: scenario 12.

## Benchmarks

`BENCH_STAGE=C06`: find by name over `tree-500k`; content search throughput against sequential read speed; branch
view of `tree-50k`; quick filter on 100k.

## Acceptance criteria

- Find and branch-view budgets pass (`docs/commander/PERFORMANCE.md`); cancel takes effect within 200 ms.
- Results stream in while the panels stay responsive.

## Risks

- Content search over network shares can be very slow. Mitigation: show progress per folder and allow excluding
  network paths.

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
