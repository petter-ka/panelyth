# Stage P02 — Index Scope: All Entries, Filtered per Query

Status: **Implementation done** (the query core on 2026-10-05; session budgets, visible-app watching, the
benchmarks and ADR-0026 on 2026-10-12). Open: the owner's word on a cold scan of `flat-100k` that is 12–17 % slower
(the stage allows 10 %), the viewer's remaining stale e2e specs (Stage P04), a run with links, and the Linux and
macOS runs (CI). Track: platform. Depends on: P01. Unblocks: C01.

## Progress (2026-10-05, found while starting Stage C01)

In the code, with tests (`internal/scan/allentries_test.go`, `internal/index/scope_test.go`, golden fixtures
`res-query.open-all.json`, `res-query.page-all.json`): the schema with `file` and `link` kinds and `attrs`, the
scanner storing every entry, and the query descriptor's `scope`, `showHidden`, `nameMask` and sort by `attrs`.
The kind checks exist too: main's `shell.open` refuses `file` and `link` entries (`src/shared/desktop/test/workspace.test.ts`),
and `media.resolve` serves only images and videos. Stage C01 added the main-process check that keeps the viewer on
the `media` scope.

## Progress (2026-10-12, the rest of the stage)

- **Who is calling.** Electron main adds the calling app to `dir.open`, `dir.openEntry`, `dir.openContaining` and
  `query.open` (`profileParams` in `src/shared/desktop/src/main/ipc/router.ts`; contract type `CallerApp`). A
  renderer cannot send the field: the validators take exact shapes, and main's value would replace it. Main's own
  calls (the neighbours of a file opened from the OS) name no app.
- **Sessions per app** (`internal/query/sessions.go`). A session has an owner: the viewer (8), the commander (24)
  or main (8). An app over its budget loses its own least recently used session and never another app's. Before,
  one budget of 8 covered everything: a commander with tabs, a find and a compare could close the viewer's folder.
  Find results, archives, remote folders and compares are the commander's. "Least recently used" is now a use
  counter: two sessions used within one clock tick had no order on Windows, and the wrong one could go.
- **Watching the visible app only** (`internal/watch/watcher.go`). A watched folder now belongs to a slot: the
  viewer's one folder, or a commander panel (its lane), at most four per app. Only the slots of the app on screen
  are watched; main's own are always. The watcher was a list of the four most recently opened folders of anyone,
  so three typed copy destinations could push a panel's watch out.
- **Which app is on screen.** Main calls the new `app.setVisible { app, seq }` at start, after a sidecar restart
  and on every switch (`AppShell`'s `onShown`); no renderer can call it. The sequence number orders the calls,
  because the sidecar handles requests concurrently and a quick switch there and back must end right. Until main
  has named an app, every app's folders are watched.
- **A hidden app's folders are listed again when it is shown.** Only those that were not watched meanwhile: a
  folder both apps show stays watched and is not listed again. The listing waits for the watcher's quiet period
  (300 ms), so the usual switch, where the app being shown opens the folder carried over from the other app, does
  not list the folder it is leaving.
- **Not on screen, not watched.** A folder the commander opens outside a panel (a typed copy or unpack
  destination, a compare root) is opened and indexed, never watched.
- **Scan lanes are per app.** The same lane-less opens used the viewer's scan lane and cancelled the viewer's
  running listing (it stopped at 1,024 of 3,000 entries in the test that now guards this).
- **Fixtures and benchmark.** `fixture.Spec` has `ExecEvery` and `LinkEvery`; the marker of a generated tree
  keeps its old form for old specs, so the 100k-file fixtures were not rebuilt. `cmd/indexbench` scans the mixed
  folder with programs and links and a media-only folder (`media-100k`).
- **The viewer's index e2e spec** opens folders again (it clicked a button gone since C06): the 100k folder is
  opened from its tile in the folder above and timed in the page as before. `showViewerFolder` in
  `src/shared/e2e/launch.ts` is the shared way to show a folder. The foundation spec no longer waits for the "No
  folder open" screen, which lasts 20–50 ms since the startup folder exists.

## Results (2026-10-12)

Reference machine (i9-13900K, Windows 11). Files: `src/shared/bench/results/stage-P02-2026-10-12-*`.

**Scans, before and after on the same day.** "Before" is the scanner of commit `2341f43` (folders and media
only), built from that commit and run on today's fixtures; "after" is this stage's code. Twelve alternating runs
each; minimum and the best half are compared, because C: was 99 % full and single scans stalled to 3–12 s in both
builds (`…-index-compare.txt` has every run).

| Cold scan (empty index) | Before | After | Change |
|---|---|---|---|
| `flat-100k` (90 % media) | 1.29–1.34 s | 1.44–1.57 s | +12 % (minimum) to +17 % (median) |
| `media-100k` (media only) | 1.59–1.66 s | 1.61–1.70 s | +2–3 %, within noise |
| `tree-50k` (recursive, 90 % media) | 0.68–0.73 s | 0.74–0.81 s | +8–11 % |
| `mixed-100k` (40 % media) | 0.58–0.59 s | 1.68–1.77 s | 2.9× |

- `flat-100k` misses the stage's 10 %. Per stored row the scanner is as fast as before (68.9k rows/s then, 66k
  now); the time is the 11 % more rows, since the 10,000 other files are now stored. The criterion asks for less
  than the rows cost.
- The mixed folder is what ADR-0026 predicted: a folder where most files are not media costs the viewer the whole
  folder. It is still listed in batches (first rows committed after 22–47 ms) and can be stopped.
- `mixed-100k` here: 40,000 media, 42,000 documents, 14,000 hidden files, 4,000 programs. **No links**: this
  Windows account cannot create symbolic links (no developer mode), so the generator wrote documents in their
  place. Links are covered by the scan tests, not by this benchmark.
- `index.db` with its WAL: 101 MiB for 277,000 rows before, 127 MiB for 352,000 rows after. About 380 bytes a row
  in both; the mixed folder's 60,000 extra rows are about 22 MiB.

**Queries on 100,000 entries** (`query.open` p50; `query.page(256)` p95 at the worst of the first, middle and last
offsets):

| Session | Rows | Open | Page |
|---|---|---|---|
| `flat-100k`, media, by name (the viewer) | 90,000 | 72 ms (56 ms before) | 1.5 ms |
| `flat-100k`, all, by name | 100,000 | 71 ms | 1.5 ms |
| `mixed-100k`, media, by name | 40,000 | 49 ms | 1.5 ms |
| `mixed-100k`, all, by name | 86,000 | 68 ms | 1.5 ms |
| `mixed-100k`, all with hidden, by name | 100,001 | 71 ms | 1.5 ms |
| `mixed-100k`, all, by extension | 86,000 | 88 ms | 1.5 ms |
| `mixed-100k`, all with hidden, by attributes | 100,001 | 95 ms | 1.5 ms |
| `mixed-100k`, all, mask `*.txt` | 42,000 | 54 ms | 1.5 ms |
| `mixed-100k`, all, mask `*|*.txt;*.jpg` | 24,000 | 49 ms | 1.5 ms |

A page is far inside the 25 ms the stage allows at any offset. The viewer's `query.open` on the 100k folder went
from 56 to 72 ms: the folder now has 100,000 rows to filter instead of 90,000. The viewer's budget (first page of a
cached 100k folder painted in under 300 ms) holds.

**The viewer in the app** (e2e, `BENCH_STAGE=P02`): first rows of the 100k folder 112–158 ms after the click
(127–143 ms in the records of 2026-09-30 and 2026-10-06, then from a toolbar button), the whole folder listed in
1.9–2.0 s (2.1 s), no long task; the 100k tile scroll at 7 ms a frame at p95 with 80 or 204 tiles mounted. **The
switch:** first 186 ms, later 4–5 ms, as before. A file that arrived in a commander panel's folder while the viewer
was on screen is on screen 0.87 s after the switch back (`…-e2e-switch.jsonl`).

**The SQLite fault.** Three of the twelve runs of the new benchmark, and two of four started with `go run`, ended
in an access violation inside `modernc.org/sqlite` (the sorter's free, an index row id), all while a query was
stepping; none of the twelve runs of the old build did. This is the intermittent fault carried from Stage 07
(`docs/viewer/stages/07-batch-and-metadata.md`). It is not from this stage's code, but it is no longer rare in
this benchmark, and the sample does not say whether the larger index makes it likelier. It needs the driver or
hardware decision that Stage 07 left open.

Tests: Go, all 30 packages (new: `internal/watch` 14 tests on a fake and the real backend, per-owner budgets in
`internal/query`, `internal/app/visibility_test.go`, `internal/fixture`), twice clean after one run that ended
without output. Desktop 272 (the router names the app and refuses `app.setVisible` from a renderer; `AppShell`),
contracts 202 (the `app.setVisible` golden frame). E2E on the final build: the app switch (4, one new), the
viewer's foundation (6), index (5), tiles (9) and editor (3) specs, and the commander's 54 tests, of which the four
stale lister tests fail as before (Stage P04).

Still open:

- the owner's word on the `flat-100k` scan above;
- the viewer's `jobs`, `media`, `polish`, `previews`, `viewer`, `workspace` and `theme` e2e specs are stale since
  C06 (Stage P04), so "its e2e suite passes" holds for the specs that run;
- a benchmark run with links, on a machine where the account may create them, and the Linux and macOS runs (CI);
- a hidden app's sessions are still refreshed in Go when a job changes its folder; the renderer holds the result
  back until it is shown (Stage P01). Deferring the refresh itself is not in this stage's scope.

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

- [x] implementation complete
- [x] tests complete (the stale viewer e2e specs are a Stage P04 item; Linux and macOS in CI)
- [x] benchmark complete (`stage-P02-2026-10-12-*`; no links on this machine)
- [ ] performance regression reviewed: paging, the viewer's first page, scrolling and the switch hold; the cold
      scan of `flat-100k` is 12–17 % slower against the 10 % allowed, which waits for the owner
- [x] docs/ADR updated (ADR-0026 accepted with amendments; ADR-0015, ADR-0017 and ADR-0020 amended)
