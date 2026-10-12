# ADR-0015 — Directory-Centric Index and Scan Scope

## Status

Accepted (Stage 01), by default: adopted from `docs/shared/ARCHITECTURE-ANALYSIS.md` C1 when Stage 01 was started
without objection. Revisit if the product owner decides otherwise.

Refined 2026-10-05 by ADR-0026 (accepted in Stage P02, 2026-10-12): the index stores every entry with attribute
flags, and these rules describe the `media` query scope the viewer uses. The commander queries the `all` scope.
What this costs the viewer was measured in Stage P02: nothing for a folder of media, the extra rows for a folder
with other files (ADR-0026, "Consequences").

## Context

The Stage 01 draft said "recursive scan" of the opened folder, and ARCHITECTURE.md modelled a scan root with
`relative_path`. The product, though, is a file explorer: back/up navigation, folders as content items, a lazy
folder tree, and recursive search as an *option*. Recursively scanning `C:\` because someone opened it would
break FR-07 and NFR-02.

## Decision

- The index mirrors the filesystem as **one `entries` table** holding directories and supported media files,
  linked by `parent_id`. It has a single id space, which listing, selection and batch operations share.
- **Opening a folder lists only its direct children** (a shallow listing). **Recursive indexing** of a
  subtree runs only when the user asks for it ("Include subfolders"). It is bounded, cancellable and batched.
- Every directory has its own listing generation. A listing upserts what it sees with `seen_gen = gen`. When
  that directory's listing **completes**, rows under it with an older generation are deleted. A cancelled or
  failed listing deletes nothing, so interrupted scans are always safe (NFR-05).
- When a folder is reopened, its existing rows are served immediately and a new generation reconciles them in the
  background.
- A directory entry's `path_key` is its identity (`UNIQUE`). A folder first opened directly is stored as a root,
  and it is relinked under its parent when the parent is listed later.
- Media detection at scan time uses the **extension only**. Opening 100k files to sniff magic bytes would dominate
  scan time. Content sniffing and metadata happen lazily in the preview pipeline (Stage 02).
- Scan-time policy (Stage 01; see ADR-0020 for watching):
  - Hidden entries (dot-names, and the Windows hidden/system attribute) are skipped.
  - Symbolic links and junctions are never followed and not listed. Cycle-safe recursion comes for free.
  - Unreadable directories are recorded (`dir_state.error_code`) and skipped. The rest of the scan continues.
  - Non-media files are not stored. `dir_state` counts them so the UI can say how many were hidden.

## Consequences

- Recursive views query a subtree by `path_key` range. Directory `path_key`s end in `/`, so the range is
  `[prefix, prefix with the trailing '/' replaced by '0')`.
- Renaming a directory rewrites the descendants' `path_key`s (a batch operation in Stage 07).

## Decided in Stage P04 (2026-10-12): what a `path_key` folds, and names Windows rewrites

- **A key folds what the platform's filesystems fold, by platform and not by volume.** Case is folded on Windows and
  macOS (NTFS and APFS as formatted by default) and kept on Linux. Unicode is normalized (NFC) **on macOS only**:
  APFS and HFS+ treat the composed and the decomposed form of a name as one file, so one key must cover both; NTFS,
  ext4 and the other filesystems of Windows and Linux keep them as two files, and a key that merged them showed one
  of the two (found by `TestComposedAndDecomposedNames`). Until this stage the key was NFC everywhere.
  `library.db` rows of names whose stored form was not NFC, on Windows and Linux, are keyed anew (the product has
  not shipped; no migration).
- **Per-volume and per-folder detection is not built.** A key is made from a path, or from a parent's key and a
  name, in the scanner and in every job, with no volume at hand; making the rule a property of each folder would put
  a lookup on those paths and change the identity of entries when a volume is mounted or a folder's flag changes.
  What this costs is rare and bounded, and it is tested: in a folder marked case-sensitive on Windows, or on a
  case-sensitive APFS volume, two names that differ only in case share one row (the scan completes and shows one of
  them); on a case-insensitive volume under Linux (FAT, exFAT, SMB), a folder reached by a path typed in another
  case is listed under a second key. Revisit if either shows up in real use; the owner may ask for it sooner.
- **Comparing two folders pairs names by `NameKey`**: NFC on every platform, case by the platform. The two sides may
  be volumes of different systems, where a name copied from a Mac is decomposed on one side and composed on the
  other.
- **A name read from a folder is opened as it is written.** Windows rewrites some paths before it opens them: a
  name ending in a dot or a space loses it ("photo.jpg." opens "photo.jpg", another file if there is one), and a
  device name opens the device ("NUL"). Such names exist on disks (written by WSL, git or another system). The
  index and the folder tree join a listed name with `fsx.JoinName`, which gives the path the `\\?\` prefix where
  Windows itself says it would open something else (`GetFullPathName`; which device names are affected depends on
  the Windows version), and everything joined below such a folder keeps the prefix. The key, the volume id and the
  breadcrumbs ignore the prefix, so a folder has one identity however its path is spelled. The Recycle Bin refuses
  such an item with a reason (ADR-0021); reading and deleting are tested, and every other action gets the same
  path. Cost: about 10 ns per joined name (`BenchmarkJoinName`). Copying such a name to a Windows volume is refused
  by the name rules, as before.
