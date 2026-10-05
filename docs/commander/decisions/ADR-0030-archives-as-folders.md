# ADR-0030 — Archives as Folders: Browse, Extract and Pack

## Status

Proposed (2026-10-05). Decided in Stage C07.

## Context

- Total Commander users enter archives like folders, copy files out of them, and pack selections into new archives.
- Go's standard library reads and writes zip and tar, writes gzip, and reads bzip2. 7z and RAR need outside code.
- ADR-0019 forbids cgo and allows external tools as subprocesses (the ffmpeg pattern of ADR-0018).
- Listings, marks and jobs are built on query sessions and entry ids (ADR-0017, ADR-0026). Archive entries are not
  filesystem entries and must not be written into `index.db`.

## Decision

### Formats

| Format | Browse | Extract | Create | Engine |
|---|---|---|---|---|
| zip (stored, deflate; ZIP64; UTF-8 names) | ✓ | ✓ | ✓ | Go stdlib |
| tar, tar.gz / tgz | ✓ | ✓ | ✓ | Go stdlib |
| tar.bz2, .gz (single file) | ✓ | ✓ | — | Go stdlib |
| 7z, rar and others | ✓ | ✓ | 7z only | optional external 7-Zip (`7z`/`7zz`) |

- 7-Zip is discovered like ffmpeg: an environment override, then next to the sidecar, then `PATH`. Without it, those
  formats are listed as plain files, and the UI says why they can't be opened.

### Archives as virtual folders

- Entering an archive opens a **read-only virtual listing** in Go: the archive's entry id plus an inner path.
- Archives use the **session-source interface** that Stage C06 adds to the query layer for find results (an ADR-0017
  amendment). An archive listing is read once per open archive, kept in memory, and sorted and paged in Go. Archive
  entries get ids from a separate range, so selection descriptors are unambiguous. Nothing is written to `index.db`.
- Listings are capped (1 million entries), and an archive is closed when no session uses it.

### Operations

- **Copy out** (F5 from an archive panel) is an extract job in the ADR-0029 queue, into the other panel's folder.
- **Pack** (Alt+F5) is a job that creates a zip or tar.gz from the marked entries, with a compression level and a
  "delete originals afterwards" option.
- **Unpack** (Alt+F9) extracts whole archives into the target folder. **Test** verifies integrity.
- Changing an archive in place (delete, rename or add inside a zip) is out of scope for the first version.

### Safety

- Extraction rejects absolute paths and `..` components (zip-slip) and never writes outside the target folder.
- It warns before extracting when the expanded size exceeds the free space, or exceeds the compressed size by a large
  factor (zip bombs).
- Links stored in tar archives are created as links inside the target folder, or skipped (an option). They are never
  followed during extraction.
- Viewing a file inside an archive (F3, quick view) extracts that one entry to `<cache>/tmp` (bounded size) and serves
  it through the token protocol (ADR-0027). The file is removed when the viewer closes or the app exits.

## Why

- The standard library covers the most common formats without cgo or extra binaries.
- A session source for archives reuses sorting, paging, marks and jobs without polluting the filesystem index.

## Consequences

- Another session source in the shared query layer, so the viewer's sessions must stay as fast as before (Stage C07
  regression check).
- Large archives cost memory while open: about 100 bytes per entry, so the 1-million-entry cap is roughly 100 MB.
- Shipping 7-Zip (LGPL, with the unRAR restriction) is a packaging and licensing decision for Stage C11, like ffmpeg in
  ADR-0018.
