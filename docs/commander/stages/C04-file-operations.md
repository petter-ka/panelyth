# Stage C04 — File Operations

Status: **Implementation done** (2026-10-06); the gate waits on the items under "Open". Track: commander.
Depends on: C03, P03 (both implementation done). Unblocks: C05.

## Objective

Copy, move, rename, create and delete between the panels, from the keyboard, with a background queue, conflict
questions and progress you can trust.

## Decisions applied

- ADR-0029 (engine v2: lanes, `ask`, pause, speed, ETA), ADR-0021 (trash, permanent delete, internal clipboard, name
  validation, index consistency), ADR-0027 (destinations resolved in Go).

## Scope

- **F5 / F6:** dialogs for copy and move of the marked entries (or the cursor entry) to the other panel's folder:
  editable destination, file mask, conflict policy, verify, **Copy** (start now) or **Queue**.
- **Shift+F5:** copy within the same folder under a new name. **Shift+F6 / F2:** rename in place (inline editor,
  extension not selected). **F7:** new folder; `a/b/c` creates the chain.
- **F8 / Delete:** trash. **Shift+F8 / Shift+Delete:** permanent delete after confirmation. Where the trash is
  unavailable, the dialog says so and offers permanent delete.
- **Queue panel:** a strip with the running job; Ctrl+J expands the list. Progress, speed, ETA, pause, resume,
  cancel, Details for failures.
- **Conflicts:** with `ask`, the job's dialog shows source and target (size, date, a thumbnail for media) with
  Overwrite, Overwrite all older, Skip, Rename, Rename existing, Cancel job, and "apply to all".
- **Drag and drop:** panel to panel (Shift moves), onto tabs and drive buttons, with the same dialog.
- **Clipboard:** Ctrl+C / Ctrl+X / Ctrl+V with the internal clipboard; copy names and full paths as text.
- **After an operation:** both panels refresh through invalidation; the cursor lands sensibly (on the new folder after
  F7, on the next entry after a delete, on the renamed entry after a rename).

## Non-goals

- Archive operations (C07), sync (C08), multi-rename (C09).

## APIs/contracts

- The P03 job contracts (`jobs.pause`, `jobs.resume`, `jobs.resolve`, `job.conflict`, speed and ETA).
- `fs.mkdir({ parentDirId, path })` creates a nested chain and returns the new entry id (new method; name validation
  per component).

## Tests

- Renderer: dialog defaults and keyboard flow; conflict dialog decisions; queue panel states.
- Go: nested mkdir (validation, existing components, permission errors).
- E2E: scenarios 8, 9 and 10 (`docs/commander/TESTING.md`).

## Benchmarks

`BENCH_STAGE=C04`: the P03 copy benchmarks started from the UI; renderer long tasks and panel navigation while copying.

## Acceptance criteria

- File-operation budgets pass (`docs/commander/PERFORMANCE.md`).
- Every conflict policy is reachable from the UI; pausing or cancelling takes effect within 200 ms.
- No long tasks in the renderer during copies; both panels stay navigable.

## Risks

- Users rely on F5/F6 muscle memory. A wrong default destination is costly, so the dialog always shows the
  destination and the item count before anything starts.

## Results (2026-10-06)

Built on the engine v2 of Stage P03 (ADR-0029, accepted):

- **Sidecar:** `fs.mkdir({ parentDirId, path })` creates a chain (`a/b/c`, either separator; each component checked,
  with Windows rules on FAT, exFAT and NTFS destinations; existing folders kept, a file in the way refused) and
  returns the first component's entry id, indexed at once so the panel can put its cursor on it;
  `fs.canTrash({ dirId })` tells the delete dialog whether the folder's volume has a trash. Copy and move jobs (and
  `clip.paste`) take `destinationDirId`, resolved in Go; copy and move take a file `mask` (the nameMask syntax;
  folders are walked and keep only matching files, a masked folder move moves only the matching files) and a `name`
  for a single item (Shift+F5).
- **Main and contracts:** the commander profile gains the file-operation methods; main refuses a commander copy,
  move or paste with a path destination (folder ids only, ADR-0027) and any job kind but copy, move, trash, delete and
  folder size; `copyLinks` is still added by main. `clipboard.copyPaths` takes `namesOnly` (copy names as text). The
  viewer keeps its path destinations.
- **Commander:** F5 / F6 open the copy and move dialog ("Copy 12 items (48 MB)", the other panel's folder as an
  editable destination, file mask, conflict policy with Ask as the default, verify; **Copy** starts at once, **Queue**
  waits for the jobs of its lane; an edited destination is opened in Go to get its folder id, and a wrong one is
  explained in the dialog). Shift+F5 copies the cursor entry here under a new name. F2 / Shift+F6 rename in place (the
  name selected without its extension; Go's validation message beside the row). F7 creates a folder or a chain; the
  cursor lands on it. F8 / Delete move to the trash; where there is none the dialog says so and offers permanent
  delete; Shift+F8 / Shift+Delete delete permanently after confirmation; the cursor lands on the next entry that is
  not deleted. Ctrl+C / Ctrl+X / Ctrl+V use the internal clipboard shared with the viewer (paste asks on conflicts);
  Ctrl+Shift+C and Ctrl+Alt+C copy full paths and names as text. Drag and drop: rows (the marks, or an unmarked row by
  itself) onto the other panel, a tab or a drive button open the copy dialog (Shift: move). The function-key bar runs
  F5–F8. Commands act on the marks or the cursor entry; marks are cleared once a job is queued.
- **Queue panel:** the shared queue (the viewer's jobs too; folder sizes stay in the status line): a strip with the
  asking, running or newest job; Ctrl+J or "+n more" lists every job with progress, speed, ETA, Start now, Pause,
  Resume, Cancel, Details for failures (`jobs.errors`) and Clear finished.
- **Conflicts:** a job that asks opens its dialog (source and target side by side with size, date and the newer one
  marked): Overwrite, Overwrite all older (applies to all), Skip, Rename, Rename existing, Cancel job, and "Apply to
  all conflicts in this job". Esc leaves the question in the queue ("Needs your decision"); only that job waits.
- **After an operation** the panels refresh through invalidation; a pending focus puts the cursor on the new folder,
  the renamed entry or the entry after the deleted ones once Go's invalidation brings it into the session.

Deviations from the scope above:

- The conflict dialog shows a type glyph, not a thumbnail: the commander's profile has no preview pipeline before
  Stage C05 (quick view) / C10 (thumbnails view).
- Dropping on a folder row (into that folder) is not built; drops go to a panel's folder, a tab or a drive.
- The e2e run does not move files to the real recycle bin (the trash dialog is opened and cancelled; trash itself is
  covered by P03's benchmark and the gated Go test).

Found and fixed while testing: the copy dialog's form remounted while typing a new name (its key included the name);
and the startup session restore, still waiting on `library.db`, could override a folder the user opened in the
meantime (it now leaves a panel alone once it has navigated; new renderer test).

Tests: Go all (new: `fs.mkdir` chains, existing components, a file in the way, invalid names, unknown parent and
permission denied on Unix; `fs.canTrash`; destinations by folder id; masked copies; a single item copied under a new
name; golden frames for `fs.mkdir`, `fs.canTrash` and a copy by folder id); contracts 63; desktop 98 (new: the
commander's file-operation profile, path destinations refused, `copyLinks` on paste); commander 75 (new: 15 in
`fileops.test.tsx` — dialog defaults and keyboard flow, Queue vs Copy, an edited and a wrong destination, Shift+F5,
drag to the other panel, trash unavailable, permanent delete and the next-entry cursor, F7 and its cursor, inline
rename with errors and Esc, the clipboard keys, the queue's states, the conflict dialog's decisions and Esc, failure
details, the function-key bar; plus the startup race in `navigation.test.tsx`); viewer 167 plus the 2 known
theme-label failures. E2E: `specs/commander/fileops.spec.ts` 4 of 4 (scenarios 8, 9 and 10 and the benchmark); all
commander specs 25 of 25 (the C02 benchmark failed once right after the copy benchmark's 2 GB of writes and passed
alone); the viewer's `jobs.spec.ts` unchanged.

Measurements (reference machine; `shared/bench/results/stage-C04-2026-10-06-e2e-fileops.jsonl`):

| Metric | Result | Budget |
|---|---|---|
| 10,000 × 10 KB copied from the UI (F5 → completed) | 2.1–3.2 s | P03 engine budgets |
| One 2 GB file copied from the UI | 0.63–0.77 s | P03 engine budgets |
| Renderer long tasks during both copies | 0 | none > 50 ms |
| Cursor key → moved, in a panel while copying | p95 7–8 ms | ≤ 1 frame |
| Enter a 1,000-entry folder in the other panel while copying | 106–112 ms | p95 < 150 ms (uncached) |
| Pause clicked → job paused (2 GB copy to an HDD) | 117 ms | < 200 ms |
| Copy engine throughput vs the OS's copy | see Stage P03's record | ≥ 90% large, ≤ 2× small |
| Commander bundle, JS minified | 478.2 KB (C03: 453.3 KB) | not budgeted |

## Open

- C03's and C02's NVDA pass, now also over the dialogs and the queue panel.

## Exit checklist

- [x] implementation complete
- [ ] tests complete (the NVDA pass, with C02's and C03's)
- [x] benchmark complete
- [x] performance regression reviewed (both apps)
- [x] docs/ADR updated
