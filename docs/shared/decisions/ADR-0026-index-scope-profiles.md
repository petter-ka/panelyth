# ADR-0026 — Index Scope: All Entries Stored, Filtered per Query

## Status

**Accepted with amendments (Stage P02, 2026-10-12).** Proposed 2026-10-05. It refines ADR-0015 for the commander.
Revised the same day by ADR-0031: one sidecar serves both apps, so the scope is chosen per query instead of per
process. The viewer sees exactly what it sees today. The amendments are in "As built" below; the measured cost is
in "Consequences".

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

### As built (Stage P02)

- **The sidecar learns the caller from main.** Electron main adds `app` to `dir.open`, `dir.openEntry`,
  `dir.openContaining` and `query.open`; a renderer cannot send it. Main tells the sidecar which app is on screen
  with `app.setVisible { app, seq }` at start, after a sidecar restart and on every switch; `seq` orders the
  calls, which the sidecar handles concurrently.
- **Three session owners, not two:** the viewer (8), the commander (24) and Electron main (8), which opens
  sessions of its own for a file opened from the OS. Eviction is per owner, by a use counter.
- **Watches are slots:** the viewer's one folder and each commander panel (its lane), at most four per app.
  Main's own folders are always watched. Until main names the visible app, every app's are.
- **Re-listing on show** covers only the folders that were not watched while the app was hidden (a folder both
  apps show stays watched), and waits for the watcher's quiet period, so a folder the app leaves at once is not
  listed for nothing.
- **A folder the commander opens outside a panel** (a typed destination, a compare root) is not watched.
- **Scan lanes are per app,** so an open by one app never cancels the other app's listing.

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
- **Measured in Stage P02** (Windows, 100,000 entries, against the scanner that stored media only): a folder of
  media only scans as before (+2–3 %); a folder with 10 % other files 12–17 % slower, which is its 11 % more rows
  (the stage allowed 10 %; per row the scanner is as fast); a folder with 40 % media takes 2.9 times as long
  (0.59 → 1.7 s), still in batches and stoppable. `query.page(256)` stays at 1.5 ms p95 at any offset in either
  scope; the viewer's `query.open` on a 100k folder went from 56 to 72 ms. `index.db` grows with the rows, about
  380 bytes each. Links were not in the benchmark: the reference machine's account cannot create them.
- Kind checks move to main: `shell.open` and the media token protocol check the entry kind against the calling app
  view's profile (ADR-0027).
- Code that assumed kinds ⊆ {dir, image, video} must handle `file` and `link` safely, even in the viewer, which never
  receives them with the `media` scope.

## Rejected

- **An in-memory listing service for the commander.** Fast for a single folder, but it duplicates sessions, selection,
  jobs and invalidation, and the apps couldn't share ids.
- **A scan scope per sidecar process.** It needs one sidecar per app, which ADR-0031 replaced with one shared sidecar.
