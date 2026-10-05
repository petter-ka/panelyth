# Stage C05 — Quick View, Lister, Open and Edit

Status: **Planned**. Track: commander. Depends on: C04. Unblocks: C06.

## Objective

Look inside files without leaving the panels: a quick view that follows the cursor, a full-window lister for text,
hex, images and videos, an external editor, and opening files with their default apps, safely.

## Decisions applied

- **ADR-0027** (launching part decided here): open any file on a user action; programs ask first; file bytes through
  the token protocol only.
- ADR-0009 (token protocol, Range), ADR-0003 and the preview cache, ADR-0025 (shared media components).

## Scope

- **Shared media components:** move `ImageViewer`, `VideoPlayer` and their request logic (`viewerImages`, video
  preferences) from the viewer into `shared/media-ui`. The viewer's suites must pass unchanged (regression gate).
- **Quick view (Ctrl+Q):** the other panel shows the cursor entry after it settles (150 ms): images and videos with
  the shared components; text (the first window, encoding detected); other files as hex plus properties.
- **Lister (F3):** full window; Text (wrap, encodings, Ctrl+F find), Hex, Image, Video (1–4 switch modes); N / P next and
  previous file; Esc returns with the cursor unchanged. Text and hex read byte windows through the token protocol;
  the scroll position maps to a byte offset, so huge files open instantly with bounded memory.
- **Open (Enter):** opens a file with its default app (`shell.open` for any kind in the commander profile). Programs
  ask first (setting: ask, always, never).
- **Edit (F4):** opens the file in the configured editor (default: the OS default app for text). **Shift+F4:** asks
  for a name, creates the text file and opens it.

## Non-goals

- A built-in editor; editing inside archives (C07 handles viewing only).

## APIs/contracts

- `media.open` (or a new `file.open`) returns a token URL, size and a MIME guess for any entry kind in the commander
  profile; the viewer's profile still serves images and videos only.
- `shell.open` checks kinds per profile; `shell.openWith({ entryId, app })` for the editor (main; the editor path comes
  from settings, never from the renderer).

## Tests

- Renderer: encoding detection (BOM, UTF-8 validity, single-byte fallback); line splitting inside byte windows; quick
  view settle logic.
- E2E: scenario 11; safety tests (program confirmation; the viewer still cannot open non-media; recorded shell
  actions only).
- The viewer's media and viewer suites after the `media-ui` move.

## Benchmarks

`BENCH_STAGE=C05`: quick view follow (cursor settles → image shown); lister open and scroll on `text-2g`; memory while
scrolling the lister.

## Acceptance criteria

- Quick view and lister budgets pass (`docs/commander/PERFORMANCE.md`).
- The viewer's behavior and numbers are unchanged after the component move.
- ADR-0027's launching part is accepted.

## Risks

- Moving components can change the viewer's bundle or behavior. Mitigation: move first with no changes, measure, then
  extend.

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
