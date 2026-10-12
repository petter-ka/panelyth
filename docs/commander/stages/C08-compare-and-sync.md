# Stage C08 — Compare, Synchronize and Checksums

Status: **Implementation done** (2026-10-11); the gate waits on the items under "Open". Track: commander. Depends on:
C07. Unblocks: C09.

## Objective

Answer "what's different between these two places?" and fix it: compare directories, synchronize trees, compare
files by content, and create or verify checksums.

## Decisions applied

- ADR-0029 (sync actions and hashing run as jobs; amended with an "As built (Stage C08)" section), ADR-0017 (a diff
  session source; amended), ADR-0026 (all scope), ADR-0027 (roots and entries by id, commander-only methods and jobs).

## Scope

- **Compare directories (Shift+F2):** marks entries that are unique or newer in each panel, by name, size and date.
  Options: a time tolerance (2 s for FAT, a 1 h DST option) and ignoring dates.
- **Synchronize directories:** a recursive compare job between two roots, by name, size, date and optionally content;
  a result table (→, ←, =, ≠, ×) with filters and per-row direction overrides; asymmetric mode (left to right only);
  apply as copy and delete jobs in the queue.
- **Compare files by content:** identical or not for any two files (streamed); a side-by-side text diff for text files
  up to 50 MB.
- **Checksums:** create SHA-256, SHA-1, MD5 or CRC32 files (one per file or one list); verify `.sha256`, `.sha1`,
  `.md5` and `.sfv` files with a result list.

## Non-goals

- Three-way merges; scheduled sync.

## APIs/contracts

- `compare.dirs(spec) → { compareId, queryId }` (a diff session); job kinds `sync`, `hashCreate`, `hashVerify`,
  `compareFiles`.

## Tests

- Go: compare rules (tolerances, missing on either side, content mode), sync plans per direction, hashing against
  known vectors, verify with missing and corrupt files.
- E2E: scenario 14 on the `sync-pair` fixture.

## Benchmarks

`BENCH_STAGE=C08`: compare two 100k-entry trees; hashing throughput against the OS's tool; text diff of two 10 MB files.

## Acceptance criteria

- Compare budgets pass (`docs/commander/PERFORMANCE.md`).
- A sync never deletes anything without showing it in the result table first.

## Risks

- Date semantics across file systems (FAT 2 s resolution, DST). Mitigation: explicit options, defaults shown in the
  dialog.

## Results (2026-10-11)

- **Compare (Go, `internal/compare`):** the date rules (tolerance, the one-hour DST option, dates ignored); the flat
  compare behind Shift+F2 (`Marks`: unique, newer, and both files of a pair with one date and two sizes; folders are
  never marked); the recursive compare: a bounded pool of folder readers lists both sides of each folder and merges
  them by name (case folded as the platform compares names), with a row per file and per folder that exists on one
  side only (so empty folders are created and removed too). Links, special files and unfinished copies are counted
  and left out. A folder or entry that cannot be read is left out on **both** sides, so its other side never looks
  one-sided. With contents, pairs of the same size are read side by side (`EqualFiles`, two pooled 1 MiB buffers): the
  same bytes are equal whatever their dates; other bytes take the direction of the dates.
- **The diff session (amends ADR-0017):** a compare's rows are a `query.Source` with its own rows, in their own id
  range (from 3·2^51, above index and archive ids), ordered by folder and natural name and filtered by the symbol of
  their action (→ ← = ≠ ×). `query.page` rows carry `diff { dir, state, action, left, right }`. A compare holds at
  most 500,000 rows (about 95 bytes each) and says when it stopped there; at most 4 compares are kept.
- **Directions and the plan:** every row starts with a direction: the newer file wins and one-sided entries are
  copied across; left to right only makes the right side a copy of the left (a newer file on the right is replaced,
  what exists only there is deleted). `compare.setAction` changes the selected rows (a selection descriptor of the
  diff session); a copy needs its source, a file never replaces a folder, and only one-sided entries can be deleted.
  `compare.plan` says what a sync of the **shown** rows would do, with a version that changes with every change of
  the filter or of a direction.
- **Jobs (ADR-0029, `internal/jobs/compare.go`):** `sync` applies the plan the user confirmed (an older plan
  version is refused): new folders and copies first, in the plan's order, then the deletes, deepest first. Right
  before it is touched, every entry is checked against what the compare saw (present or absent, size and date): one
  that changed fails as `CHANGED` and is left alone. Copies keep their dates (the engine v2 copy), so the trees
  compare as equal afterwards. Deletes go to the trash in batches of 200, or are permanent on request; a folder is
  removed only when it is empty. `hashCreate` hashes in one streamed pass with a pooled 1 MiB buffer and writes
  `sum *path` lines (`path SUM` for .sfv) through a partial file, one file beside each file or one list with paths
  relative to its folder. `hashVerify` reads the list forms of the sha256sum family, the BSD form and .sfv; every
  listed file is an item (`CHECKSUM_MISMATCH`, `NOT_FOUND`, `UNSAFE_PATH` for entries that leave the list's folder,
  `CORRUPT` for a list that cannot be read, never taken for a shorter one). `compareFiles` streams two files:
  done when identical, a `DIFFERENT` item (sizes, or the first differing byte) otherwise. All four run in volume
  lanes with pause, cancel and progress; new and removed entries reach the index at once.
- **Text diff (Go, `internal/textdiff`):** one pass per file records where its lines start and a hash per line (the
  text stays in the files: 4 bytes and one hash per line in memory); a patience diff on the line numbers (unique
  common lines as anchors, a Myers search bounded in steps and depth between them, a replaced block beyond that);
  rows of the side-by-side view are read from the files page by page. UTF-8, UTF-16 LE/BE (with or without a mark)
  and Windows-1252 are recognized; files in different encodings are compared by their decoded text; CR LF and LF
  lines compare as equal (the result says when the files still differ in bytes). Lines are cut at 4 KiB per row. A
  file that changed since the diff is refused, not misread.
- **Contracts and main:** `compare.dirs`, `compare.cancel`, `compare.close`, `compare.show`, `compare.setAction`,
  `compare.plan`, `compare.marks`, `diff.open`, `diff.page`, `diff.close` (commander only); the four job kinds and
  their parameters (a sync names a compare and a plan version: no selection, no paths); the `compare.progress`
  event; item codes `CHANGED`, `DIFFERENT`, `CHECKSUM_MISMATCH`; validation in main, the viewer refused the methods
  and the jobs, golden frames. `archive.IsID` got an upper bound, so compare row ids are neither index nor archive
  ids: a job started over a diff session's selection finds no file.
- **Commander:** Shift+F2 marks both panels and says how many (the date rules are in Settings and in the synchronize
  dialog; 2 s by default). **Synchronize directories** (quick action bar, folder menu, bindable): the two panels'
  folders (editable; a typed folder is resolved to its id), left to right only, compare contents, the date rules;
  Compare / Stop / Compare again with progress; filter buttons per symbol with counts; a virtualized table (name
  with its folder below the roots, size and date of both sides, the symbol; a copy over a newer file and the side a
  delete removes stand out); directions for the cursor row or the selected rows by key (→ ← = Delete Backspace) or
  button; Synchronize… opens a confirmation that lists what is copied each way, created, deleted and replaced
  although newer, with "Delete permanently instead of moving to the trash"; the job goes to the queue. **Compare by
  content** (entry menu, bindable): two marked files, else the cursor file against the file of that name in the
  other panel, else against the other panel's cursor file; a side-by-side view with line numbers, changed, removed
  and added rows, N / P for the next and previous difference; files that are not text or too large get "identical"
  or "different" from a `compareFiles` job with progress. **Checksums** (entry menu, bindable): a create dialog
  (algorithm, one beside each file or one named list in the panel's folder), verify for the marked checksum files
  or the one under the cursor; the result is announced, and what did not verify opens as the job's list. Seven
  languages for every new message (ADR-0034).

Deviations from the scope above:

- A sync is **one** `sync` job (copies, then deletes), not separate copy and delete jobs: it is the unit the user
  confirmed, and it pauses and cancels as one.
- The text diff is not a job: `diff.open` compares in Go within the call (tens of milliseconds for 10 MB) and
  `diff.page` serves rows. Only files without a text diff use the `compareFiles` job.
- Shift+F2 is `compare.marks` (both sessions in one call), not a diff session.
- The filter is a state of the compare (`compare.show`), not a second session: one session per compare, re-listed
  at once when the filter or a direction changes.
- Date tolerance is "exact" or 2 s (the wire takes any value up to 60 s).
- Compare by content pairs files by the rule above; Total Commander's "first marked file of each panel" is not
  offered.

Found and fixed while testing: the e2e launcher passed `ELECTRON_RUN_AS_NODE` on when the tests are started from a
VS Code extension host, and Electron then failed to launch; the launcher drops it. The commander's API list in
`foundation.spec.ts` had missed the document window and the media window methods since ADR-0033; it is current again.

Measurements (reference machine, 32 threads, warm cache; `src/shared/bench/results/stage-C08-2026-10-11-petter-compare-2.json`,
`-compare.json` (the first run after generating the fixture), `stage-C08-2026-10-11-e2e-compare.jsonl`). The OS tool
is Windows' `certutil -hashfile`.

| Metric | Result | Budget |
|---|---|---|
| Compare two 100k-file trees by name, size and date (Go; 202,055 entries in 2,066 folders, 100,971 rows) | 241–249 ms | < 3 s |
| The same by folder readers: 1 / 2 / 4 / 8 / 16 | 1,701 / 870 / 449 / 257 / 186 ms (8 chosen) | — |
| Memory per compare row | 92–99 bytes | — |
| In the app: Compare → first rows of the table (100k trees; three runs of three) | 240–337 ms; 24 rows mounted | < 3 s |
| The same with contents (about 98,000 pairs of tiny files read) | 2.5–2.6 s; 31.9 s on the first run after the fixture was written | — |
| SHA-256 of a 1 GiB file | 1,910 MB/s; certutil 1,468 MB/s: 1.30× | compared |
| SHA-1 | 2,031 MB/s; certutil 782 MB/s: 2.60× | compared |
| MD5 | 987 MB/s; certutil 641 MB/s: 1.54× | compared |
| CRC32 | 6,607 MB/s (no OS tool) | — |
| Text diff of two 10 MB files (150,039 lines, 58 changed places) | 18–20 ms; a page of 200 rows 0.04 ms | — |

Earlier stages' in-app benchmarks ran with this build (`stage-C00` … `stage-C07-2026-10-11-e2e-*.jsonl`) and
stay within their budgets: 100k folder → first rows 154 ms with no long task, scroll p95 7 ms with 56 rows mounted,
tab switch p95 18 ms, 10,000 small files copied from the UI in 4.2 s with no long task, quick filter on 100k 42 ms,
the 100k-entry zip in under a second.

Eight folder readers are the default where neither root is on a disk that seeks (one reader per compare there);
sixteen were faster here but give less per reader. Hashing is one file at a time: at these rates the disk, not the
hash, bounds it.

## Test runs

- **Go:** all packages pass; gofmt and vet clean. New: `internal/compare` (date rules, default and allowed
  directions, the flat compare, trees with every kind of difference, exact and ignored dates, contents, the mirror,
  filters, directions, plans and stale plans, unreadable folders, links, the manager's lifecycle, cancel, ids),
  `internal/checksum` (FIPS, RFC 1321 and CRC-32 vectors, hooks, round trips, the list forms, damaged lists, entries
  that leave the folder), `internal/textdiff` (rows per kind of change, line ends, five encodings, binary and too
  large files, cut lines, a changed file, page bounds, 200 random pairs rebuilt from their rows, 20,000 lines with
  three edits, unrelated files within the step budget), `jobs` (sync both ways, the mirror with a trash stand-in,
  changed entries left alone, only shown rows, no trash, a missing root, validation, checksums created per file and
  as lists and verified with a changed, a missing, an escaping entry and a damaged list, compare by content) and
  `app` (the session, filter, directions, plan and sync through the RPC, bad roots, marks, the text diff, the jobs);
  golden frames for the new methods and the event.
- **Contracts** 82; **desktop** 119 (compare methods and jobs validated, the viewer refused, the event forwarded);
  **i18n** 26 (113 new messages in seven languages); **ui** 33; **media-ui** 20; **renderer-core** 12;
  **docviewer** 15; **viewer** 170.
- **Commander** 171 (new: 23 in `compare.test.tsx`: Shift+F2 with each date rule, the synchronize dialog from
  compare to the queued job, filters, directions, the confirmation, a stale plan, bad roots, close and cancel, the
  text diff, same-named files, identical and different binary files, checksums created and verified, helpers).
- **E2E:** `specs/commander/compare.spec.ts` 2 of 2 (scenario 14 and the 100k benchmark), three times in a row. All commander
  and switch specs in one run: 33 of 39. Four failures are the same on the commit before this stage (the archives
  scenario and three viewer specs still expect F3 and Enter to open the lister and the program dialog; text files
  open in the document window since ADR-0033). Two (`listing.spec.ts` 100k, `navigation.spec.ts` bookmarks) passed
  when run again on their own.
- **Lint and typecheck:** clean (Prettier still reports the two `showcase/` files it reported before).

## Open

- The NVDA pass of C02–C07, now also over the synchronize dialog, the text diff and the checksum dialog.
- A sync checks each entry's size and date exactly as the compare read them. That holds on NTFS (the tests and
  scenario 14); it still needs a run on FAT/exFAT and on a network share, where a listing and a single lookup may
  report dates differently (Stage P04's volume items). A mismatch only ever leaves the entry alone.
- A sync interrupted by a crash can leave partial files below its roots: the startup recovery cleans the
  destination's top folder only. Compares leave them out.
- The text diff shows whole lines: no marking inside a changed line, no editing, and the view widens to the longest
  line only as its pages load.
- The four commander e2e specs that predate the document window (above), and the viewer's e2e specs (open since C06).
- Linux and macOS were not run here; CI runs the suites there (the OS hash tools of the benchmark differ).

## Exit checklist

- [x] implementation complete
- [ ] tests complete (the NVDA pass, with C02's to C07's; a FAT/exFAT and network run of a sync)
- [x] benchmark complete
- [x] performance regression reviewed (commander; for the viewer, `query.page` gains one map lookup per page and
  nothing else on its paths changed)
- [x] docs/ADR updated (ADR-0017 and ADR-0029 amended)
