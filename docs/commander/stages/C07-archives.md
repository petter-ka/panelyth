# Stage C07 — Archives

Status: **Planned**. Track: commander. Depends on: C06. Unblocks: C08.

## Objective

Enter archives like folders, copy files out of them, and pack and unpack, safely and in the background.

## Decisions applied

- **ADR-0030** (proposed; this stage decides it): stdlib formats, optional 7-Zip, archive session source, safety
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

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
