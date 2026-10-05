# ADR-0026 — Index Scope: All Entries Stored, Filtered per Query

## Status

Proposed (2026-10-05). Decided in Stage P02. It refines ADR-0015 for the commander. Revised the same day by ADR-0031:
one sidecar serves both apps, so the scope is chosen per query instead of per process. The viewer sees exactly what
it sees today.

## Context

- ADR-0015 stores folders and supported media only. It skips hidden entries and links at scan time, and counts other
  files so the viewer can say how many it doesn't show. Query sessions (ADR-0017), selection descriptors, jobs
  (ADR-0021), the watcher (ADR-0020) and the preview pipeline all work on index entry ids.
- A file manager lists every entry: all file types, hidden and system files (behind a toggle), and symbolic links and
  junctions (shown, never followed), with size, dates and attributes. Its search, branch view, compare/sync and file
  operations work on any file.
- Both apps run on one sidecar and share one index (ADR-0031), so a folder listed by one app is ready in the other, and
  selections can move between the apps as ids.
- Options:
  1. A separate in-memory listing service for the commander.
  2. A scan scope per sidecar process (the first version of this ADR; ruled out by ADR-0031's single sidecar).
  3. One index that stores every entry, with the scope chosen per query.

## Decision

### Store every entry; choose the scope per query (option 3)

- The scanner stores every directory entry, with attribute flags. Links are listed via `Lstat`, never followed; a
  link's target is read lazily for display.
- `kind` gains `file` (any file that is not supported media) and `link` (symlink, junction, alias). Media files keep
  `image` and `video`, so the commander previews and sorts them like the viewer.
- New `entries` columns (an `index.db` schema bump by recreation, as ADR-0016 allows):
  - `attrs`, a bit set: hidden, system, read-only, archive (Windows), executable (Unix mode bits; on Windows the
    `PATHEXT` extensions), link;
  - `size_bytes` for every file (media already has it); folders keep `NULL` until a folder-size job fills
    `dir_size_bytes` (Stage C02, on demand);
  - `ext_fold`, the case-folded extension for sorting by extension.
- The query descriptor gains `scope`:

  | Scope | Used by | Returns |
  |---|---|---|
  | `media` (default) | viewer | folders and supported media; hidden entries and links excluded, as ADR-0015 shows them today |
  | `all` | commander | every entry; hidden and system entries only with `showHidden` |

  The default keeps the viewer's requests unchanged. The viewer's "N other files not shown" count comes from the same
  rows.
- More descriptor fields for the commander: `showHidden`, `nameMask` (a wildcard list for the panel quick filter, for
  example `*.jpg;*.png`) and the sort fields `ext` and `attrs`.

### Sessions and watching in one sidecar

- Sessions have a budget per app inside the one sidecar: 8 for the viewer, 24 for the commander (2 panels × visible
  tabs, find results, branch views, compare). Each app evicts only its own least-recently-used sessions.
- The sidecar watches the folders of the **visible** app only (ADR-0020): the viewer's open folder, or the folder of
  each visible commander panel. A hidden app's folders are re-listed when it is shown again (ADR-0031).
- Recursive listings (branch view, find by name) reuse ADR-0015's bounded, cancellable recursive indexing.

## Why

- Sessions, selection descriptors, jobs, invalidation, watching and previews already work on index ids. One index for
  both apps keeps every one of them, and lets the folder and the selection move between the apps as ids.
- Storing hidden entries with flags keeps the listing the single source of truth and makes the toggle instant.
- A per-query scope keeps the viewer's behavior and API unchanged.

## Consequences

- The viewer's index also holds the non-media entries of the folders it opens. Folders of pictures are almost all media,
  so they cost about the same; folders with many other files cost more to scan. Stage P02 measures it and keeps the
  viewer inside its budgets.
- Scan throughput is re-measured with all entries, including `Lstat` for links and attribute reads. On Windows the
  directory read already returns attributes.
- Kind checks move to main: `shell.open` and the media token protocol check the entry kind against the calling app
  view's profile (ADR-0027).
- Code that assumed kinds ⊆ {dir, image, video} must handle `file` and `link` safely, even in the viewer, which never
  receives them with the `media` scope.

## Rejected

- **An in-memory listing service for the commander.** Fast for a single folder, but it duplicates sessions, selection,
  jobs and invalidation, and the apps couldn't share ids.
- **A scan scope per sidecar process.** It needs one sidecar per app, which ADR-0031 replaced with one shared sidecar.
