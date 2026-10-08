# ADR-0030 — Archives as Folders: Browse, Extract and Pack

## Status

Accepted (2026-10-07, Stage C07). Proposed 2026-10-05. The decision below stands; "As built" records how it was
implemented and where it was refined.

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

## As built (Stage C07)

- **Package:** `shared/sidecar/internal/archive`: readers (zip, tar, tar.gz, tar.bz2, single .gz), the listing, the
  extractor, pack, test, the 7-Zip adapter, the session source and the manager of open archives.
- **Listing:** read once per open archive into compact entries (about 76 bytes per entry for a 100k-entry zip;
  budget 100). Folders the archive does not store are created from file paths; a folder's size is the sum of its
  files. Zip names without the UTF-8 flag that are not valid UTF-8 are read as code page 437. Entries with unsafe
  names are **not listed** (`rejected` in `archive.open`'s result) and never extracted.
- **Lifetime:** `archive.open({ entryId })` lists the archive and holds it until the first query session over it
  opens; from then on its sessions keep it open (a panel, a parked tab). It closes, and its viewed files are
  deleted, when the last session closes; an archive opened without a session follows after a minute. At most 16
  archives without sessions are kept. An unchanged archive opened again (the other panel) reuses its listing.
- **Contract (refined):** `archive.open` returns `{ archiveId, format, entries, rejected, bytes, packedBytes }`;
  the folders open with `query.open { archiveId, archiveDirId }` (0 = the root, else the folder's entry id), so the
  panel's sort, hidden setting and quick filter work as for folders. `archive.close` releases an open that never got
  a session. `archive.check` sizes an extraction (expanded bytes, free space, warnings); `archive.tools` says whether
  7-Zip was found. Job kinds `extract` (copy out of an archive panel, or unpack whole archives, optionally each into
  a folder named after it), `pack` (zip, tar.gz, or 7z with the tool; level 0–9; "delete originals afterwards") and
  `testArchive`.
- **Safety:** `CleanPath` rejects absolute paths, drive letters, UNC prefixes and `..`; `Join` checks containment
  again before anything is written. Files are written to a partial name and renamed into place. A file that writes
  more than its stored size stops (`TOO_LARGE`; the zip reader also checks sizes and CRCs). Links are created
  **after** every file and folder, so extraction never writes through one; a symbolic link is created only when its
  target stays inside the target folder, a hard link only to a file extracted by the same job; with the links
  option off they are skipped. Before an extraction the dialog shows `archive.check`'s warnings: "space" (more than
  the free space) and "ratio" (more than 100 times the compressed size and at least 1 GiB). Item codes
  `UNSAFE_PATH`, `CORRUPT`, `ENCRYPTED`, `TOO_LARGE`.
- **7-Zip:** found through `PANELYTH_7Z` (`off` disables it), next to the sidecar, `PATH` (`7z`, `7zz`, `7za`) and,
  on Windows, `Program Files\7-Zip`. Without it those formats open with their default app and the commander says
  why. With it, extraction runs into a hidden staging folder inside the target (a partial name, so a crash leaves
  nothing behind) and the staged entries are moved in through the same checks and conflict handling as the built-in
  formats. 7-Zip runs without a console window and without stdin, so a password prompt fails instead of hanging.
- **Viewing:** F3, quick view, and Enter (open with the default app) extract the one entry to
  `<cache>/tmp/archive/<archive>/<entry>/` (at most 1 GiB; 16 per archive, the oldest removed first). The files go
  when the archive closes, at shutdown, and at the next start.
- **Read-only:** move, delete, rename, new folder, new file, edit and the clipboard say so in archive panels; nothing
  is copied, pasted or dropped into one.

## Why

- The standard library covers the most common formats without cgo or extra binaries.
- A session source for archives reuses sorting, paging, marks and jobs without polluting the filesystem index.

## Consequences

- Another session source in the shared query layer, so the viewer's sessions must stay as fast as before (Stage C07
  regression check).
- Large archives cost memory while open: about 100 bytes per entry, so the 1-million-entry cap is roughly 100 MB.
- Shipping 7-Zip (LGPL, with the unRAR restriction) is a packaging and licensing decision for Stage C11, like ffmpeg in
  ADR-0018.
