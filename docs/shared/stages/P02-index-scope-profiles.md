# Stage P02 — Index Scope: All Entries, Filtered per Query

Status: **Partly done** (no stage record yet). Track: platform. Depends on: P01. Unblocks: C01.

## Progress (2026-10-05, found while starting Stage C01)

In the code, with tests (`internal/scan/allentries_test.go`, `internal/index/scope_test.go`, golden fixtures
`res-query.open-all.json`, `res-query.page-all.json`): the schema with `file` and `link` kinds and `attrs`, the
scanner storing every entry, and the query descriptor's `scope`, `showHidden`, `nameMask` and sort by `attrs`.
The kind checks exist too: main's `shell.open` refuses `file` and `link` entries (`src/shared/desktop/test/workspace.test.ts`),
and `media.resolve` serves only images and videos. Stage C01 added the main-process check that keeps the viewer on
the `media` scope.

Still open: per-app session budgets, watching only the visible app's folders, the regression and benchmark runs
below, and accepting ADR-0026.

## Objective

Store every entry in the one shared index (all file types, hidden and system files, links) with attributes, so the
commander can list everything, while the viewer keeps seeing exactly what it sees today (ADR-0026, ADR-0031).

## Decisions applied

- **ADR-0026** (proposed; this stage decides it): every entry stored, the scope chosen per query.
- ADR-0031 (one sidecar for both apps), ADR-0015 (directory-centric index; its rules become the `media` query scope),
  ADR-0017 (sessions), ADR-0020 (watching), ADR-0016 (index schema bumps by recreation), ADR-0027 (kind checks per
  app view).

## Scope

- **Schema** (`index.db` bump by recreation):
  - `kind` gains `file` and `link`;
  - `attrs` bit set: hidden, system, read-only, archive, executable, link;
  - `size_bytes` for every file; `dir_size_bytes` for folders (filled on demand later, Stage C02);
  - `ext_fold` for sorting by extension.
- **Scanner:** stores every entry; hidden and system entries get flags instead of being skipped. Links are listed via
  `Lstat`, never followed; the target is read on demand. Windows attributes come from the directory read; Unix
  executable bits from the mode.
- **Queries:** the descriptor's `scope` (`media` by default, `all` for the commander); `showHidden`; `nameMask`
  (wildcards, `;`-separated, with `|` exclusions); sort fields `ext` and `attrs`; folders first as today. The viewer
  sends nothing new and gets the same results.
- **Sessions per app:** budgets inside the one sidecar (viewer 8, commander 24); each app evicts only its own sessions.
- **Watching:** the sidecar watches the folders of the visible app only (`app.visibility` from P01); a hidden app's
  folders are re-listed when it is shown.
- **Kind checks in main:** `shell.open` and the media token protocol check the entry kind returned by the sidecar
  against the calling app view's profile (ADR-0027).
- **Contracts:** new kinds and fields in `src/shared/contracts`, guards, golden fixtures regenerated.

## Non-goals

- Commander UI (Stage C01), folder sizes (Stage C02), find files (Stage C06), archives (Stage C07).

## Tests

- Go scan tests: hidden and system flags (Windows attributes, dot-names), links listed and not followed, cycles,
  unreadable folders, executable flags per OS.
- Query tests: `scope`, `showHidden`, `nameMask` (include, exclude, case folding), sort by `ext` and `attrs`, folders
  first.
- Viewer regression: the `media` scope returns the same ids, order and counts as before on the shared fixtures,
  including the "other files not shown" count.
- Per-app session budgets and visible-app watching.
- Kind checks: the viewer view can't open or stream `file` or `link` entries.
- Golden fixtures for the new fields.

## Benchmarks

`BENCH_STAGE=P02`, reference machine, warm and cold:

- scan throughput before and after on `flat-100k` (90 % media) and on a media-only folder;
- a new mixed fixture (100k entries: media, documents, executables, hidden files, links);
- `query.open` and `query.page(256)` at deep offsets in both scopes; `nameMask` filter cost;
- `index.db` size growth for the mixed fixture.

## Acceptance criteria

- The viewer's budgets still pass (first page painted, paging, scrolling), and its e2e suite passes.
- The viewer's cold scan of `flat-100k` is at most 10 % slower than before; a media-only folder is unchanged within
  noise.
- `query.page(256)` p95 < 25 ms at any offset of a 100k `all`-scope folder.
- ADR-0026 is accepted, and the ADR-0015, ADR-0017 and ADR-0020 notes are updated.

## Risks

- Attribute reads cost a syscall per entry on some platforms (macOS, Linux). Mitigation: read only what `readdir`
  returns cheaply; fetch the rest lazily for the visible rows.
- Folders with huge numbers of non-media files (build trees) cost the viewer more than before. Mitigation: measured
  here; the listing stays incremental and cancellable.

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
