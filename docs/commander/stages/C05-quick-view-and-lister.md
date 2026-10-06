# Stage C05 — Quick View, Lister, Open and Edit

Status: **Implementation done** (2026-10-06); the gate waits on the items under "Open". Track: commander.
Depends on: C04 (implementation done). Unblocks: C06.

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

## Results (2026-10-06)

- **Shared media components:** `ImageViewer`, `VideoPlayer`, their request logic (`viewerImages`), the video
  preferences store and the zoom and transform math moved (with history) to `shared/media-ui`. The package reaches
  the sidecar through a small port (`configureMedia`: open media, ensure previews, open with the default app,
  `preview.ready`) that each app configures with its own bridge. The viewer keeps its old module paths as re-exports
  (`features/viewer/viewerImages.ts`, `features/media/video.ts`), so its suites run unchanged; preview lanes are free
  strings now, and the commander uses its own (`cmd-quick`, `cmd-lister`).
- **Sidecar:** `file.resolve` (main only) resolves any indexed regular file (links followed, folders refused) with
  its kind, a MIME type for media and the size. `entry.path` reports `program` (`fsx.IsProgram`: executables,
  scripts, installers, shortcuts and control panel items by extension on Windows; the execute bit, scripts, packages,
  `.desktop` files and app bundles elsewhere). `fs.mkfile({ parentDirId, name })` creates an empty file (an existing
  one is kept; a folder of that name or an invalid name is refused) and indexes it at once. Golden frames for
  `file.resolve` and `fs.mkfile`; `fixturegen -text-log-bytes … -encodings` writes the `text-2g` and `encodings`
  fixtures.
- **Main and contracts:** `VIEWER_METHODS` / `COMMANDER_ONLY_METHODS` (`file.open`, `shell.edit`, `fs.mkfile`);
  the commander profile also gains `media.open`, `preview.ensure`, `props.get` and `shell.open`, and its preload the
  `preview.ready` event. Main handlers receive the calling app. `shell.open` keeps the viewer on folders and media
  (now also refusing programs, such as macOS app bundles) and opens any kind for the commander, programs only with
  `allowProgram`. `shell.edit` starts the editor from `commander.settings.editor` (absolute path, existing file),
  detached and without a shell, else Notepad / `open -t` / `xdg-open` (Linux refuses programs without an editor).
  `file.open` mints a token bound to the commander's origin; non-media bytes are `application/octet-stream` with
  `nosniff`; the media scheme is `corsEnabled` and answers `Range` preflights; only the commander's CSP allows
  `fetch()` of token URLs. Main refuses `commander.*` settings from the viewer's view. ADR-0027's launching part is
  accepted.
- **Commander:** Ctrl+Q shows quick view in place of the other panel (the panel stays mounted and inert) and follows
  the active panel's cursor once it rests 150 ms: images and videos with the shared components, text from the first
  window with the detected encoding, hex plus properties for binary files, properties for folders. Tab moves into the
  quick view and back. F3 opens the lister, a full window: Text (wrap, eight encodings, Ctrl+F find with F3 /
  Shift+F3, ASCII case-insensitive by default), Hex, Image, Video (1–4; unavailable modes are disabled), N / P for the
  panel's next and previous file, Esc back with the cursor unchanged, a byte-offset scroll bar and the position.
  Text and hex read 64 KiB chunks through the token URL (a 4 MiB LRU per file); lines over 4 KiB show as segments.
  Encoding detection: BOM, UTF-16 without a mark, UTF-8 validity, then Windows-1252; zero or many control bytes mean
  binary. Enter opens a file with its default app; a program asks first (Cancel focused) per Settings → "Run programs
  with Enter" (ask, always, never). F4 edits the cursor file, Shift+F4 creates a text file, opens it in the editor and
  puts the cursor on it. Settings gain "Run programs with Enter" and "Editor (F4)"; the function-key bar runs F3 and
  F4; the lister's keys are a remappable `lister` scope.

Deviations from the scope above:

- Lines longer than 16 KiB start approximately when scrolling up (the backward search window); forward reading is
  exact. Find matches ASCII letters case-insensitively; other letters match exactly.
- The e2e run has no video in the lister or quick view (making one needs ffmpeg); the renderer tests cover both with
  the shared `VideoPlayer`, and the viewer's media suite covers the player itself.
- Video volume and mute persist in the viewer only (its `player` setting); the commander keeps them per session.

Found and fixed while testing: a commander token URL could be `fetch()`ed from the viewer's page when handed to it
(the request carried no `Origin`, so the per-token origin check never applied); the CSP is now per app. Also, the
viewer could write `commander.*` settings, so it could have planted the editor that F4 starts.

Measurements (reference machine; `shared/bench/results/stage-C05-2026-10-06-e2e-viewers.jsonl`; `text-2g` is a
2,147,483,724-byte log):

| Metric | Result | Budget |
|---|---|---|
| Quick view: cursor settles → image shown (cached preview), 30 images | p95 10–11 ms | p95 < 100 ms |
| Lister: open the 2 GB log (F3 → first screen) | 19–21 ms | < 200 ms |
| Lister: End on the 2 GB log | 5–6 ms | — |
| Lister: PageDown, 200 times | p95 7 ms | ≤ 1 frame per key |
| Lister: jump by the scroll bar, 10 positions | p95 14 ms | — |
| Renderer long tasks while opening and scrolling | 0 | none > 50 ms |
| JS heap while scrolling the 2 GB log | 9.1–9.7 → 17.4–18.2 MB | bounded (byte windows) |
| Viewer bundle, JS minified, after the move | 542.9 KB (before: 542.3 KB); CSS unchanged | unchanged behavior |
| Commander bundle, JS minified | 527.9 KB (C04: 478.2 KB) | not budgeted |

## Test runs

- **Go:** all packages pass (new: `file.resolve` for text, image, folder, deleted and unknown entries; the program
  flag; the execute bit; `fs.mkfile` create, keep, invalid names, a folder in the way, unknown parent; golden frames
  for both). One earlier full run failed without naming a package and passed twice on rerun (the machine's
  intermittent faults, see `docs/DEVELOPMENT-STAGES.md`).
- **Contracts** 65; **desktop** 107 (new: the commander's open, edit, file and new-file methods and their
  validation; the viewer refused them and `commander.*` settings; `shell.open` per profile with `allowProgram`;
  `shell.edit` with an editor, without one per platform, and its refusals; file tokens bound to the commander's
  origin; the per-app CSP); **media-ui** 5 (the zoom math, moved); **ui** 26; **renderer-core** 12.
- **Commander** 105 (new: 15 in `text.test.ts` — detection, UTF-8 validity, CRLF, UTF-16 boundaries, long-line
  segments, back navigation, the bounded chunk cache, find across chunks and encodings; 15 in `viewers.test.tsx` —
  the settle logic, quick view per kind and while the cursor moves, Tab, following the active panel, the lister's
  modes and encodings, N / P, Esc, find, bounded reads on an 8 MiB file, Enter, the program confirmation and its
  setting, F4, Shift+F4).
- **Viewer** 162 plus the 2 known theme-label failures (`AppShell.test.tsx` expects "dark", the status bar shows
  "Dark"; unchanged by this stage).
- **E2E:** `specs/commander/viewers.spec.ts` 5 of 5 (scenario 11 in two parts, the safety tests — the safety test
  5 of 5 repeated — the benchmark, the token protocol); the full suite 73 of 78 in one run: the two theme-label tests
  (known), and the C04 copy scenario, the viewer's full-screen Esc test and the tile-width test, which all three
  passed on rerun.
- **Lint:** ESLint shows only the two pre-existing viewer errors (`SettingsDialog.tsx`, `startupFolder.test.ts`);
  Prettier only the pre-existing `shared/renderer-core/src/pageStore.test.tsx`; gofmt and vet clean.

## Open

- The NVDA pass of C02–C04, now also over quick view and the lister.

## Exit checklist

- [x] implementation complete
- [ ] tests complete (the NVDA pass, with C02's to C04's)
- [x] benchmark complete
- [x] performance regression reviewed (both apps)
- [x] docs/ADR updated
