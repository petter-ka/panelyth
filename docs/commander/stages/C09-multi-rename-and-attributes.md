# Stage C09 — Multi-Rename, Attributes and Properties

Status: **Planned**. Track: commander. Depends on: C08. Unblocks: C10.

## Objective

Rename many files at once with a live preview and an undo, change attributes and timestamps, and size every folder
in a panel.

## Decisions applied

- ADR-0021 (rename validation, index consistency; the viewer's `{name}{n:000}` syntax stays), ADR-0029 (jobs).

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

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
