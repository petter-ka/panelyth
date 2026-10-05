# Stage C04 — File Operations

Status: **Planned**. Track: commander. Depends on: C03, P03. Unblocks: C05.

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

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
