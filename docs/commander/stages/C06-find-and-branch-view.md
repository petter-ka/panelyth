# Stage C06 — Find Files, Branch View and Quick Filter

Status: **Implementation done** (2026-10-07); the gate waits on the items under "Open". Track: commander. Depends on: C05. Unblocks: C07.

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

## Results (2026-10-07)

- **Engine (Go, `internal/find`):** a bounded walk over the start folders (never follows links or junctions, depth
  limit, hidden and system entries only on request, cancellable) feeds name, size, date and attribute filters, then
  the content search: files are streamed in bounded chunks with an overlap for matches across chunk edges, binary
  files are skipped by option, and the text is searched in UTF-8, UTF-16 LE / BE and the single-byte encodings
  (default: UTF-8, UTF-16 LE and Windows-1252), with case and whole-word options. Found entries are written to the
  index in batches (`index.PutFound`), so every command works on them. A search stops at 250,000 results
  (`truncated`), at most 8 searches are kept, and `find.progress` is throttled with the final state always sent.
- **Session sources (amends ADR-0017):** `query.Source` lets a session take its ids from somewhere other than the
  index; find results are the first source (sorted and filtered in Go like a folder). Pages of sessions spanning
  folders (sources and recursive all-scope listings) carry each row's `dirPath`.
- **Scan lanes:** `dir.open` / `dir.openEntry` take an optional `lane`; each commander panel scans in its own, so a
  branch view in one panel never cancels the other panel's listing. `dir.openContaining` serves "Go to file".
- **Contracts and main:** `find.start`, `find.cancel`, `dir.openContaining` (commander only), `find.progress`, the
  descriptor's `findId` (all scope, not recursive) and `lane`; validation in main, golden frames for the new methods.
- **Commander:** Alt+F7 opens Find files for the active panel (General: masks with `|` exclusions, start folders
  separated by `;`, depth, hidden files, text, case, whole words, encoding, binary skip; Advanced: size range with a
  unit, modified dates (whole days), five attributes as any / set / not set; Results: a virtualized list paging the
  search's own session in found order, live status, New search, Stop, Go to file, Feed to panel). Masks and texts
  are kept as history (`commander.findHistory`, 20 each). Feed to panel opens a second, sorted session over the same
  search in the panel; results keep arriving there; ".." or Backspace shows the folder again. Ctrl+B toggles the
  branch view (the folder's files below, one flat list). Ctrl+S edits the quick filter in the path bar; it filters
  as you type (150 ms pause; Enter at once), stays as a chip until cleared, and never rescans. Rows from other
  folders show the folder relative to the panel's, muted before the name, in the Full and Brief views.

Deviations from the scope above:

- Excluding network paths is left to the folder exclusions of the mask (`name\`); there is no network-drive switch.
  Progress shows the folder being searched.
- Responsiveness while results stream was checked by hand and through the e2e timings; it has no long-task gate of
  its own.

Found and fixed while testing: the quick filter re-applied its old text after Esc (the field's blur ran after the
clear), and Enter right after typing could apply the previous text; the Find status showed the session's lagging
total as the final count (Go's count is shown now; the list follows with the last refresh). Also, the `flat-100k`
and `tree-50k` fixtures on the reference machine had lost files (94,117 and 64 left) and were regenerated; earlier
C01 and C02 measurements on them should be read with that in mind.

Measurements (reference machine, 32 threads, warm cache; `src/shared/bench/results/stage-C06-2026-10-07-petter-find.json`
and `stage-C06-2026-10-07-e2e-find.jsonl`):

| Metric | Result | Budget |
|---|---|---|
| Find by name over `tree-500k` (506,981 entries), first result | 9–52 ms | < 300 ms |
| Find by name over `tree-500k`, throughput | 0.38–2.36 M entries/s | ≥ 100k entries/s |
| Content search, 1 GiB in 256 files, 3 encodings (default) | 72–109 % of sequential read | ≥ 70 % |
| Content search, case sensitive, 1 encoding | 179–193 % of sequential read | ≥ 70 % |
| Content search heap peak | 5.5–10 MB | bounded |
| Cancel latency | < 1 ms | < 200 ms |
| In the app: find `*.jpg` over `tree-50k` (12,950 results), first result row | 52–107 ms | < 300 ms |
| In the app: branch view of `tree-50k`, Ctrl+B → first page | 13–33 ms | — |
| In the app: quick filter on 100k, Enter → filtered page | 52–116 ms | < 300 ms; no rescan |

Sequential read speed here is the page cache (5.5–6.4 GB/s); cold-disk content search is not measured.

## Test runs

- **Go:** all packages pass; gofmt and vet clean. New: `internal/find` (masks and exclusions, depth, size, date and
  attributes, links never followed, every encoding, whole words and the binary skip, matches across chunk edges,
  cancel latency, the manager writing, sorting and revalidating results, the result limit) and `app` (find results
  as a folder through the RPC, `find.start` validation); golden frames for the new methods.
- **Contracts** 68; **desktop** 108 (the find methods, `lane` and `findId` validation, commander-only methods);
  **ui** 26; **media-ui** 5; **renderer-core** 12; **viewer** 164.
- **Commander** 114 (new: 9 in `find.test.tsx` — search and streaming results, Stop and closing, Feed to panel and
  "..", Go to file, validation, the spec builder, folder prefixes, the branch view in its lane, the quick filter
  without a rescan and Esc).
- **E2E:** `specs/commander/find.spec.ts` 2 of 2, three times in a row (scenario 12 and the benchmark); all commander
  and switch specs 33 of 35 in one run, the other two (the C00 shell start and the C01 100k listing, the latter right
  after the fixture was regenerated) passed on rerun.
- The full suite also showed 30-odd viewer failures that do not come from this stage: the viewer's toolbar lost its
  "Open folder…" button in `cea2a74`, which seven viewer specs use, and the theme label reads "Dark". Open below.
- **Lint and typecheck:** clean (four known `react-hooks/incompatible-library` warnings for TanStack Virtual).

Fixed before this stage started (regressions of the UI commits `b76d479` and `cea2a74`): the typecheck
(`FullView.tsx` header column, `@types/react-dom` for `src/shared/ui`, the `Tooltip` content type), four lint errors,
and renderer tests that followed the old markup (grid body, column widths, size units, the app rail, tooltips
instead of `title`, the theme label). Image tiles now show their label, favorite and rating badge while the
thumbnail loads (it was missing until the thumbnail arrived).

## Open

- The NVDA pass of C02–C05, now also over the Find dialog.
- The viewer e2e specs and the toolbar's "Open folder…" button (see above): restore the button or move the specs to
  another way of opening a folder.

## Exit checklist

- [x] implementation complete
- [ ] tests complete (the NVDA pass, with C02's to C05's)
- [x] benchmark complete
- [x] performance regression reviewed (commander; the viewer's e2e specs wait on the item above)
- [x] docs/ADR updated
