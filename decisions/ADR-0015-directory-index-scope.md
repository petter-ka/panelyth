# ADR-0015 — Directory-Centric Index and Scan Scope

## Status

Accepted (Stage 01), by default: adopted from `docs/ARCHITECTURE-ANALYSIS.md` C1 when Stage 01 was started
without objection. Revisit if the product owner decides otherwise.

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
