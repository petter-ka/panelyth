# Stage C08 — Compare, Synchronize and Checksums

Status: **Planned**. Track: commander. Depends on: C07. Unblocks: C09.

## Objective

Answer "what's different between these two places?" and fix it: compare directories, synchronize trees, compare
files by content, and create or verify checksums.

## Decisions applied

- ADR-0029 (sync actions and hashing run as jobs), ADR-0017 (a diff session source), ADR-0026 (all scope).

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

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
