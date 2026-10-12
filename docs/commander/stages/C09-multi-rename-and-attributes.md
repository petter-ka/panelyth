# Stage C09 — Multi-Rename, Attributes and Properties

Status: **Implementation done** (2026-10-11); the gate waits on the items under "Open". Track: commander. Depends on:
C08. Unblocks: C10.

## Objective

Rename many files at once with a live preview and an undo, change attributes and timestamps, and size every folder
in a panel.

## Decisions applied

- ADR-0021 (rename validation, index consistency; the viewer's `{name}{n:000}` syntax stays; amended with an "As built
  (Stage C09)" section: one engine, the two-step case rename, batched metadata), ADR-0029 (jobs; amended with an "As
  built (Stage C09)" section: the three job kinds, the undo journal, batched folder sizes), ADR-0027 (selections and
  entry ids, commander-only methods and jobs).

## Scope

- **Multi-rename (Ctrl+M):** name and extension masks with placeholders (`[N]`, `[N2-5]`, `[E]`, `[C]` with start,
  step and digits, `[Y]`, `[M]`, `[D]`, `[h]`, `[m]`, `[s]`), search and replace (plain or regular expression, Go RE2
  syntax), case conversion. A live, paged preview (old → new) highlights conflicts and invalid names. It applies as one
  job, and the last multi-rename can be undone (a journal of old and new names).
- **One engine:** the Go rename engine gains the Total Commander syntax; the viewer keeps its syntax. Both compile to
  the same internal plan.
- **Attributes and timestamps:** Windows read-only, hidden, system and archive; Unix permissions; modified and
  accessed times; optionally recursive. Applied as jobs.
- **Folder sizes:** Alt+Shift+Enter sizes every folder in the panel (C02's size job, batched).
- **Properties (Alt+Enter):** the shared properties dialog, extended with attributes, link targets and a checksum
  button.

## Non-goals

- Renaming inside archives; ID3 or EXIF placeholders (later, through metadata extraction).

## APIs/contracts

- `rename.preview({ selection, plan, offset, limit })` (paged); job kinds `multiRename` (with an undo journal),
  `undoRename`, `setAttributes`.

## Tests

- Go: every placeholder, counters, regular expressions, conflicts (within the batch and with existing files),
  invalid names per OS, undo after a partial failure.
- E2E: scenario 15.

## Benchmarks

`BENCH_STAGE=C09`: preview and apply on 10k files; folder sizes for a panel of 1,000 folders.

## Acceptance criteria

- The preview updates within one frame of typing for the visible rows; applying 10k renames keeps the UI responsive.
- An undo restores every renamed file that still exists under its new name.

## Risks

- Case-only renames on case-insensitive file systems need a two-step rename. Covered by tests per OS.

## Results (2026-10-11)

- **The rename engine (Go, `internal/rename`):** one `Plan` compiled from either syntax. `ParseViewer` takes the
  viewer's `{name}`, `{n}`, `{n:000}` pattern with its rules (a token is required, the extension is kept);
  `Compile` takes the commander's masks: `[N]` and `[E]` with character ranges (`[N2-5]`, `[N2-]`, `[N2,3]`,
  `[N2]`), `[C]` with the dialog's start, step and digits or inline (`[C10+2:3]`), `[Y] [M] [D] [h] [m] [s]` from the
  modification time, `[[]` and `[]]` for brackets; search and replace (plain, or RE2 with `$1`; case ignored unless
  asked); case (lower, upper, first letter, first letter of each word). A plan that cannot be compiled says which
  field is wrong and why.
- **Resolving a batch (`rename.Resolve`):** names every entry (the counter follows the selection's order) and decides
  per entry: renamed, unchanged, invalid, or a conflict (the same name twice in the batch, a name an entry that keeps
  its name has, names exchanged in a cycle, or waiting for a name that is never freed). The rest is ordered so no
  rename needs a temporary name. The preview and the job use this one function.
- **Jobs (ADR-0029, `internal/jobs/rename.go`, `attrs.go`):** `multiRename` renames what Resolve allows, fails the
  rest per item and records what it renamed. `undoRename` takes that journal back, last first: an entry that is gone
  (`NOT_FOUND`) or whose old name is taken again (`ALREADY_EXISTS`) stays as it is; a cancelled undo keeps what it did
  not reach. `setAttributes` sets and clears the Windows attributes or the permission bits and sets dates, optionally
  below the selected folders (children first), and never touches or follows a link. The viewer's `rename` job runs on
  the same code. Renamed entries keep their ids; user metadata follows in one `library.db` transaction per batch.
- **The two-step case rename (`fileops.Rename`):** "photo.jpg" → "Photo.JPG" on a volume that ignores case goes
  through a temporary name and is taken back if the second step fails; a hard link under the other spelling is left
  alone.
- **Folder sizes:** the `dirSize` job writes its sizes and tells the open listings once per batch (500 items or
  250 ms) instead of once per folder.
- **RPC (`internal/app/rename.go`):** `rename.preview` resolves the whole batch on each call and returns a page, the
  counts and the first problem; the entries of the previewed selection and their folders' names are kept between calls
  (one selection, dropped after a minute or when the job starts; folders beyond 2,000,000 names are looked up on disk
  instead). `rename.undoInfo` says what can be undone. `props.get` gains `attrs`, `permissions` (null on Windows) and
  `linkTarget`.
- **Contracts and main:** `rename.preview`, `rename.undoInfo` (commander only); the three job kinds with their
  parameters (a plan is exactly its ten fields; an undo takes nothing; attribute bits to set and to clear never
  overlap); validation in main, the viewer refused the methods and the jobs, golden frames.
- **Commander:** Ctrl+M opens **Multi-rename** for the marks or the cursor entry: the two masks with placeholder
  buttons, search and replace, case, counter, and a virtualized preview (old name → new name, with "Same name twice",
  "Name is taken", "Names are exchanged", "Invalid name" in words), a summary line with "Show the first one", Start
  and Undo last. **Change attributes** (entry menu, bindable): three-state boxes for the four Windows attributes or
  the nine permission bits, the two dates with Now, and "Also everything inside the folders". **Properties**
  (Alt+Enter, entry menu): the rows of the viewer's dialog, now in `src/shared/ui` and used by both apps, with
  attributes or permissions and the link target, and buttons for the attributes and the checksum dialogs. "Undo the
  last multi-rename" is also a command of its own. The queue names the new jobs; results are announced and failures
  open as the job's list. Seven languages for every new message (ADR-0034).

Deviations from the scope above:

- `rename.preview` names the **whole batch** on every call (conflicts depend on all of it) and pages only the answer.
  It is fast enough for that (below); a selection is limited to 100,000 entries.
- A second method, `rename.undoInfo`, tells the dialog whether there is something to undo.
- The undo journal is in the sidecar's **memory**: it does not survive a restart.
- Entries that **exchange names** (a ↔ b) are conflicts, as ADR-0021 decided for the viewer; the preview says so.
- The checksum button of the properties opens the **Create checksums** dialog of Stage C08 for the same entries; a
  checksum is not shown inside the properties (a call that hashes a large file would outlast the 10 s request limit).
- After a **recursive** attribute change the index rows of the selected entries are current at once; rows of entries
  below them follow with the next listing of their folder.
- Names are validated for the **platform**, not for the volume: a name FAT refuses on Linux is found by the job.
- Not taken from Total Commander: ranges counted from the end (`[N-5]`), the case placeholders (`[U]`, `[L]`), a
  two-digit year, and several search terms separated by `|`.
- Alt+Shift+Enter existed since C02; this stage batches its writes. Folders are still walked one at a time.

Measurements (reference machine, 32 threads, NVMe, warm cache; `src/shared/bench/results/stage-C09-2026-10-11-petter-rename.json`,
`stage-C09-2026-10-11-e2e-rename.jsonl`):

| Metric | Result | Aim |
|---|---|---|
| Preview of 10,000 files in Go: first call (entries from the index, the folder's names, naming) | 31–38 ms | — |
| The same, every later call: a counter mask / dates, an expression and a case | 3.0–4.5 ms / 6.5–9.9 ms | one frame |
| In the app: Ctrl+M → first rows of the preview (10,000 marked; 9 runs) | 39–53 ms; 20 rows mounted | — |
| In the app: a key press in the mask → the rows in view show the new names (14 key presses a run) | median 8.9–10.1 ms; the first key press after opening 17.7–20.2 ms; one other of 117 at 17.9 ms | ≤ 16 ms |
| Applying 10,000 renames, Go alone | 2.2–2.4 s (4,200–4,600 files/s), 20–21 listing refreshes | — |
| The same in the app (5 runs) | 2.6–5.0 s; no long task in the renderer in any run | UI responsive |
| Undoing them: Go alone / in the app | 3.6 s / 4.1–7.1 s | — |
| Sizes of a panel of 1,000 folders (20 files each), Go alone | 42–52 ms, 2 listing refreshes (before: 1,000) | — |
| The same in the app | 45–86 ms (236 ms on the first run after the fixture was written) | — |
| Index writes for those sizes: one transaction per folder / one for all | 11.6 ms / 1.0 ms | — |

- The preview follows typing within a frame, except the first key press after the dialog opens.
- One transaction of user metadata per batch instead of one per file: the in-app rename took 5.2–6.4 s in the four
  runs before it and 2.6–5.0 s in the five after. The runs vary too much to put a number on the gain, and what still
  separates the app from the 2.2 s of the job alone was not profiled; the folder being watched and listed again while
  it is renamed is the likely part.

## Test runs

- **Go:** all packages pass; gofmt and vet clean; `GOOS=linux` and `GOOS=darwin` build and vet. New: `internal/rename`
  (10: every placeholder and range, bad masks per field, plain and regular-expression search, case, the viewer's
  pattern, duplicates, existing names, invalid names, chains and their order, cycles, case-only names per platform,
  folders apart), `jobs` (12: a multi-rename with dates, counter, expression and case and its undo, every kind of
  conflict, a swap, the chain, the viewer's rename without a journal, undo after a partial failure with a vanished
  entry and a retaken name, a cancelled undo keeping the rest, the journal's rules, case-only renames, metadata
  following; dates, Windows attributes or permission bits, recursive, links skipped, validation, sizes of 300
  folders), `app` (3: preview pages, counts, conflicts, plan errors per field, the job and its undo through the RPC,
  attributes and properties, a link's target), `fileops` (the two-step case rename, a failed second step, hard
  links where case matters), `library` (a batch of re-keys in order); golden frames for the two methods and the
  extended properties.
- **Contracts** 84; **desktop** 120 (the preview and the three jobs validated, the viewer refused); **i18n** 26 (72
  new messages in seven languages); **ui** 37 (the shared properties rows); **viewer** 170.
- **Commander** 188 (new: 17 in `rename.test.tsx`: the dialog from Ctrl+M to the queued job and its result, marks with
  counter, search and case, conflicts and invalid names in words, plan errors, one request at a time while typing,
  bounded rows and pages for 5,001 entries, the undo from the dialog and as a command, failures listed, Esc; Windows
  attributes and permission bits, nothing to change, the job a dialog asks for; properties with attributes, a link
  and marks; the queue's texts).
- **E2E:** `specs/commander/rename.spec.ts` 2 of 2 (scenario 15 and the 10k benchmark), three times in a row and
  again on the final build. All commander specs in one run: 34 of 38. The four failures are the ones the C08 record
  lists as older than that stage (the archives scenario and three specs of `viewers.spec.ts` still expect F3 and Enter
  to open the lister and the program dialog; text files open in the document window since ADR-0033). The API list in
  `foundation.spec.ts` gained `rename`.
- **Lint and typecheck:** clean (Prettier still reports the two `showcase/` files it reported before).

## Open

- The NVDA pass of C02–C08, now also over the multi-rename, attributes and properties dialogs.
- Linux and macOS were not run here: the permission bits, the case-sensitive branches of the rename tests and the
  two-step rename on a case-insensitive macOS volume run in CI. A case-only rename on FAT/exFAT and on a network share
  was not tried (Stage P04's volume items).
- The undo journal ends with the sidecar. A journal that survives a restart needs a table and a decision on how long
  it is valid.
- The first key press after the dialog opens takes 18–20 ms; the in-app rename takes up to twice the job's own
  time and varies from run to run (above). Both for Stage P05.
- Rows below a folder show old attributes after a recursive change until their folder is listed again.
- The four commander e2e specs that predate the document window and the viewer's e2e specs (open since C06 and C08).

## Exit checklist

- [x] implementation complete
- [ ] tests complete (the NVDA pass, with C02's to C08's; Linux and macOS through CI)
- [x] benchmark complete
- [x] performance regression reviewed (commander; for the viewer: its batch rename runs on the shared engine with
  the same results, properties render through the shared rows, and nothing on its listing or thumbnail paths changed)
- [x] docs/ADR updated (ADR-0021 and ADR-0029 amended)
