# Stage C07 — Archives

Status: **Implementation done** (2026-10-07); the gate waits on the items under "Open". Track: commander. Depends on:
C06. Unblocks: C08.

## Objective

Enter archives like folders, copy files out of them, and pack and unpack, safely and in the background.

## Decisions applied

- **ADR-0030** (accepted in this stage, with an "As built" section): stdlib formats, optional 7-Zip, archive session source, safety
  rules. ADR-0029 (jobs), ADR-0019 (no cgo; external tools as subprocesses).

## Scope

- **Browse:** zip (stored, deflate, ZIP64, UTF-8 names), tar, tar.gz/tgz, tar.bz2 and single `.gz` files through the
  archive session source. Enter opens an archive; Backspace at its root returns to the containing folder with the
  cursor on the archive.
- **View:** F3 and quick view extract the single entry to `<cache>/tmp` (bounded size), view it through the token
  protocol, and delete it afterwards.
- **Copy out:** F5 from an archive panel starts an extract job into the other panel's folder.
- **Pack (Alt+F5):** zip or tar.gz, compression level, "delete originals afterwards", into the other panel's folder.
- **Unpack (Alt+F9):** whole archives, optionally each into its own subfolder. **Test (Alt+Shift+F9):** integrity.
- **7-Zip (optional):** discovered like ffmpeg; list, extract and test 7z, rar and others; create 7z.
- **Safety:** zip-slip and absolute-path rejection, size and ratio warnings, link handling, temp-file cleanup.

## Non-goals

- Changing archives in place (delete, rename or add inside a zip).

## APIs/contracts

- `archive.open({ entryId }) → { archiveId, queryId }`, `archive.close(archiveId)`; job kinds `extract`, `pack`,
  `testArchive`.

## Tests

- Go: every format; ZIP64; UTF-8 and legacy names; zip-slip, absolute paths and bombs; links in tar; the 7-Zip adapter
  with and without the tool.
- The viewer's session benchmarks after the session-source change (regression gate).
- E2E: scenario 13.

## Benchmarks

`BENCH_STAGE=C07`: list a 100k-entry zip; extract a 1 GB tar.gz against the OS's tool; pack 10k files; memory per open
archive.

## Acceptance criteria

- Archive budgets pass (`docs/commander/PERFORMANCE.md`); the viewer's sessions are unchanged.
- No extraction can write outside its target folder.
- ADR-0030 is accepted.

## Risks

- 7-Zip licensing (LGPL with the unRAR restriction) for bundling; decided in Stage C11.

## Results (2026-10-07)

- **Engine (Go, `internal/archive`):** readers for zip (stored, deflate, ZIP64, UTF-8 and code-page-437 names), tar,
  tar.gz, tar.bz2 and single .gz files; a compact listing (folders the archive does not store are created; a
  folder's size is the sum of its files); the extractor (safe paths, partial files renamed into place, conflict
  decisions, links created last and only inside the target, a file writing beyond its stored size stops); pack (zip
  with pooled deflate writers, tar.gz, 7z through the tool); test (reads every entry, checksums verified); the
  7-Zip adapter (list, extract through a staging folder inside the target, test, create 7z); the session source and
  the manager of open archives (ids from their own range, views extracted to `<cache>/tmp/archive`).
- **Sessions (amends ADR-0017):** a source may supply its rows (`query.ItemSource`) and say it serves one folder;
  archive pages are built from the listing, never from `index.db`.
- **Jobs (ADR-0029):** `extract` (copy out of an archive panel, or unpack whole archives, optionally each into a
  folder named after it), `pack` (name, zip / tar.gz / 7z, level 0–9, "delete originals afterwards", which deletes
  only entries packed completely) and `testArchive`, in the volume lanes, with the usual conflict policies (ask,
  replace, older, skip, keep both, rename existing). New rows for what was written reach the index at once.
- **Contracts and main:** `archive.open`, `archive.close`, `archive.check`, `archive.tools` (commander only),
  `query.open { archiveId, archiveDirId }`, the job kinds and their parameters, item codes `UNSAFE_PATH`, `CORRUPT`,
  `ENCRYPTED`, `TOO_LARGE`; validation in main, the viewer refused archive methods and jobs, golden frames.
  `file.resolve`, `media.resolve`, `entry.path`, `props.get` and `selection.info` accept archive entry ids.
- **Commander:** Enter (or Ctrl+PgDn) on an archive opens it in the panel; the path bar shows
  `folder\archive.zip\inner`; ".." and Backspace go up inside the archive and, at its root, back to the folder with
  the cursor on the archive. F3, quick view and Enter on a file view it through its temporary extraction. F5 copies
  out (the copy dialog says so, has a links option and shows the size and bomb warnings); F6, F8, F7, F2, F4,
  Shift+F4, Ctrl+C/X/V say "Archives are read-only here" and start nothing; nothing is copied, pasted or dropped into
  an archive panel. Alt+F5 packs (the name follows the format; 7z only with 7-Zip), Alt+F9 unpacks (size checked
  first; "each archive into its own folder"; links option), Alt+Shift+F9 tests and announces the result. An archive
  that can't be opened says why; without 7-Zip, 7z/rar files open with their default app and the notice says so.
  Folders inside archives come with their size; Space and Alt+Shift+Enter start no size job there.

Deviations from the scope above:

- `archive.open` returns the archive's id and counts, not a `queryId`: the panel opens its folders with `query.open
  { archiveId, archiveDirId }`, so sort, hidden and quick filter work unchanged (ADR-0030 "As built").
- The temporary file of a viewed entry is removed when the archive closes (its last session), when more than 16
  entries of one archive were viewed, at shutdown or at the next start; not when the lister closes.
- Entries with unsafe names are not listed at all (the count is in `archive.open`'s result), so they can't be
  selected; unpacking a whole archive reports each one as `UNSAFE_PATH`.

Found and fixed while measuring: packing a zip created a deflate compressor (about 1 MB of state) per entry; pooling
them per level made packing 10k files 2.8 times faster (1.66 s → 0.60 s).

Measurements (reference machine, 32 threads, warm cache; `shared/bench/results/stage-C07-2026-10-07-petter-archives-2.json`,
`-archives.json` before the pooling fix, `stage-C07-2026-10-07-e2e-archives.jsonl`,
`stage-C07-2026-10-07-petter-sessions.json`). The OS tool is Windows' `tar.exe` (bsdtar).

| Metric | Result | Budget |
|---|---|---|
| List a 100k-entry zip (Go) | 40–53 ms | < 1 s |
| Memory per open archive (100k-entry zip) | 75–76 bytes per entry | ≤ 100 bytes |
| In the app: Enter on the 100k-entry zip → first rows | 60–66 ms | < 1 s |
| Extract a 1 GiB tar.gz | 2.82–2.97 s (363 MB/s); `tar -xzf` 1.69–1.83 s: 0.60× | compared |
| List the same tar.gz (decompression only) | 2.38–2.43 s | — |
| Pack 10k files of 4 KiB, zip level 6 | 0.60–0.62 s; `tar -a -cf` 0.79–0.84 s: 1.32× | compared |
| Pack 10k files of 4 KiB, tar.gz level 6 | 0.30–0.34 s; `tar -czf` 0.44–0.46 s: 1.46× | compared |
| Viewer sessions, open and page 10k (Go, HEAD vs C07) | 20.33 → 20.25 ms, allocations equal | unchanged |

Extraction of tar.gz is bounded by Go's gzip decompression (listing alone takes 2.4 of the 2.8 s); a pipelined
writer could gain at most the remaining 15 %. It stays open below rather than optimized without a profile showing it
matters.

## Test runs

- **Go:** all packages pass; gofmt and vet clean. New: `internal/archive` (every format, ZIP64 with 70,001
  entries, UTF-8 and code-page-437 names, zip-slip, absolute and drive-letter paths in zip and tar, links inside,
  outside, absolute and hard in tar, links off, a zip bomb that lies about its size, damaged and truncated archives,
  conflicts, cancel, pack round trips, the manager's sessions, handles and views, entry ids, memory per entry, the
  7-Zip adapter against a fake tool and without the tool; a real 7-Zip test that skips here), `jobs` (unpack, pack
  with delete, test, copy out with an asked conflict, a changed archive) and `app` (an archive as a folder through
  the RPC, errors with reasons, unpack, pack and test through `jobs.start`); golden frames for the new methods.
- **Contracts** 72; **desktop** 109 (archive methods and jobs validated, the viewer refused); **ui** 26;
  **media-ui** 5; **renderer-core** 12; **viewer** 164.
- **Commander** 121 (new: 8 in `archives.test.tsx`: entering and leaving, read-only commands, copy out with
  warnings, nothing into an archive, damaged and 7-Zip-less archives, pack, unpack and test).
- **E2E:** `specs/commander/archives.spec.ts` 2 of 2, four times in a row (scenario 13 and the 100k benchmark). All
  commander and switch specs in one run: 30 of 37. Six failures came from cached fixtures in `%TEMP%` that had lost
  their files while their markers stayed; one was the C00 foundation spec's list of the commander's API, which now
  has `archive` (updated). With the stale markers removed (the fixtures were regenerated), the five affected spec
  files passed in a rerun, 24 of 24.
- **Lint and typecheck:** clean (four known `react-hooks/incompatible-library` warnings for TanStack Virtual).

Fixed while testing (regressions of `82b78e4`, the function-key icons): the function keys' accessible names had
lost their space ("F5Copy"); they are labelled "F5 Copy" again. The quick-action bar's "Quick filter" button made
the quick-filter field's label ambiguous in a unit test and the C06 e2e spec; both now ask for the text box.

## Open

- A run with a real 7-Zip on the reference machine (`TestRealSevenZip` and opening a .7z/.rar in the app); 7-Zip is
  not installed here, and installing software is left to the owner.
- Extracting a tar.gz runs at 0.60× the OS's tar (Go's gzip); no budget is set for it.
- The NVDA pass of C02–C06, now also over the pack and unpack dialogs.
- The viewer's e2e specs still use the removed "Open folder…" toolbar button (open since C06); the viewer's session
  regression was checked with Go benchmarks instead.
- The `%TEMP%` fixtures can lose their files while keeping their markers (seen in C06 and C07); `ensureFixture`
  should check a sample file, not only the marker.

## Exit checklist

- [x] implementation complete
- [ ] tests complete (the NVDA pass, with C02's to C06's; a real 7-Zip run)
- [x] benchmark complete
- [x] performance regression reviewed (commander; the viewer's sessions through Go benchmarks)
- [x] docs/ADR updated (ADR-0030 accepted, ADR-0017 amended)
