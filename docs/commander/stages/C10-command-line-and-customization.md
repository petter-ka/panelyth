# Stage C10 — Command Line, Tools and Customization

Status: **Implementation done** (2026-10-11); the gate waits on the items under "Open". Track: commander. Depends on:
C09. Unblocks: C11.

## Objective

Finish the power-user surface: a command line, user commands and a toolbar, the thumbnails view, and complete
settings. The command line is the most sensitive feature and gets a security review.

## Decisions applied

- **ADR-0027** (command-line part decided here, accepted in full with an "Implementation note (Stage C10)"):
  `shell.run` only on an explicit user action; recorded in test mode.
- ADR-0028 (thumbnails view; a note on the view as built), ADR-0022 (keymap), ADR-0025 (shared tile components).

## Scope

- **Command line:** runs a command through the OS shell in the active panel's folder; history (Alt+F8, persisted);
  Ctrl+K focuses it; Ctrl+Enter inserts the cursor name and Ctrl+Shift+Enter its full path; `cd <path>` changes the
  panel's folder; Esc clears. Output is not captured (it opens in the OS's console when the command needs one).
- **User commands and external tools:** a command, its parameters (`%P` path, `%N` cursor name, `%S` marked names,
  `%L` a list file of marked paths, `%T` the other panel's path) and a working folder; reachable from the toolbar, the
  keymap and the context menu.
- **Toolbar:** customizable buttons (icon, label, command) in a top app toolbar, independent of the left app switcher
  rail; the function-key bar can be hidden.
- **Thumbnails view (Ctrl+Shift+F1):** `@tanstack/react-virtual` tiles (ADR-0028); the viewer's tile components move
  to `src/shared/media-ui`; the panel shows tiles
  on the shared preview cache with the same cursor and marks. The viewer's tile budgets apply, and the viewer's suites
  must pass unchanged.
- **Settings:** Panels, Operations (default policies, verify), Confirmations, Editor and tools, Keys (shared dialog),
  Appearance (shared), and where letters go (quick search or command line).

## Non-goals

- A terminal emulator or output capture; plugins.

## APIs/contracts

- `shell.run({ command, dirId })` (main; the folder resolves in Go); user commands are stored in the commander's
  `library.db` and run through the same path.

## Tests

- Safety: commands never run without Enter or a button press; parameter expansion quotes paths correctly on each OS;
  recorded under `PANELYTH_TEST_SHELL=record`.
- E2E: scenario 17; thumbnails view scroll; settings persistence.
- The viewer's tile suites after the component move.

## Benchmarks

`BENCH_STAGE=C10`: thumbnails-view scroll (viewer tile budgets); command-line start cost; renderer bundle size.

## Acceptance criteria

- The security review of `shell.run` and user commands is recorded in the stage document, with no open findings.
- ADR-0027 is accepted in full.

## Risks

- Shell quoting differs per OS (cmd.exe, PowerShell, sh). Mitigation: one quoting function per shell, tested with
  hostile names.

## Results (2026-10-11)

- **Running a command (main, `src/shared/desktop/src/main/shellRun.ts`):** two calls, both commander-only and both
  answered in main.
  - `shell.run({ command, dirId, console? })`: the line the user typed. It goes to the shell as typed: `cmd.exe /d
    /v:off /s /c "<line>"` on Windows (no AutoRun commands, "!" is a character, the line exactly as written),
    `/bin/sh -c <line>` elsewhere. The working folder is the folder `dirId` names, resolved by the sidecar
    (`entry.path`); a file id is refused.
  - `shell.runTool({ toolId, dirId, otherDirId?, cursorId?, selection? })`: a user command. The call carries its id
    and entry ids. Main reads the command from `library.db` (`commander.tools`), asks the sidecar for the paths
    (`entry.path`, `selection.paths`), fills the placeholders and quotes every name.
  - Main logs each command (text, folder, the user command's id and name). Under `PANELYTH_TEST_SHELL=record`
    (unpackaged builds only) the start is recorded (`__panelythShellLog`: program, arguments, folder, added
    environment) and nothing runs.
- **Quoting, one function per shell:**
  - `sh`: single quotes, a quote inside written as `'\''`.
  - `cmd.exe`: a name never becomes command text. cmd expands `%NAME%` even inside quotes and has no escape for a
    percent sign on a command line, so each value travels in an environment variable (`PANELYTH_ARG0`…) that the
    text names (`"%PANELYTH_ARG0%"`). cmd replaces the reference once and does not read the result again. Backslashes
    before the closing quote are doubled (`C:\` would otherwise escape the quote for the program). A value with a
    quote or a line break is refused (no Windows file name has one).
  - A name alone that looks like an option (`-rf`) is passed as a path (`./-rf`, `.\-rf`).
- **Placeholders:** `%P` and `%T` (folders, ending with a separator), `%N`, `%S` (one argument per marked name; the
  cursor entry when nothing is marked), `%L` (a file in the profile's `command-lists` folder with the marked entries'
  full paths, one per line, UTF-8, removed a day later), `%%`. Neighbours are one argument (`%P%N` is the cursor
  entry's path); quotes written around a placeholder are dropped; `%NAME%` with a name of two or more characters stays
  the shell's own variable. A command line longer than the shell takes (8,000 characters for cmd.exe) is refused with
  a hint to use `%L`.
- **Command line (renderer, `features/cmdline.ts`, `CommandLine.tsx`):** a bar under the queue with the active
  panel's folder as its prompt. Enter runs the line; Shift+Enter runs it in a console window that stays open, and on
  an empty line opens that console in the panel's folder without running anything; Ctrl+K
  focuses it (and shows it when it is hidden); Ctrl+Enter and Ctrl+Shift+Enter add the cursor entry's name or full
  path as one word, at the caret or at the end; Alt+F8 or the ▾ button lists the last 50 lines
  (`commander.commandHistory`), and a picked line waits for Enter; Esc clears, Esc again or Tab, ↑, ↓ return to the
  files. `cd <folder>`, `cd /d`, `chdir`, `cd..`, `cd\`, `cd ~` and a drive alone (`d:`) change the panel's folder in
  the renderer and never reach the shell. A refusal is said above the line, which keeps its text.
- **User commands (`features/tools.ts`, Settings → Editor and tools):** a name, the command, its parameters, a working
  folder (empty: the panel's folder), an icon from twelve, and three switches (on the toolbar, in the menu of files,
  a console that stays open). Up to 50. Each is an action of the keymap (`tool:<id>`, group Tools in the shortcuts
  dialog), so it can take a key; bindings are stored with the other shortcuts.
- **Toolbar:** the quick-action bar is now the list in `commander.toolbar`: built-in actions, user commands and
  dividers, in the user's order (Settings → Toolbar: add, move, remove, reset). The default is the bar as it was.
  The toolbar, the command line and the function-key bar can each be hidden (Settings → Panels, and three actions
  without a default key).
- **Thumbnails view (`ThumbsView.tsx`, Ctrl+Shift+F1):** rows of fixed-size tiles on `@tanstack/react-virtual`,
  with the panel's cursor (an outline around the tile), marks (the accent frame, the name in the accent color with
  "•") and "..". The keys, quick search, the inline rename, the right button and drag and drop are the handlers the
  other views use. ←/→ move a tile, ↑/↓ a row. Pictures and videos show thumbnails from the shared preview cache;
  other files their type icon; folders the folder symbol. Tile size S/M/L in Settings → Panels and with Ctrl+wheel.
  Each panel has its own preview lane (`cmd-tiles-left`, `cmd-tiles-right`), and its pages ask for cached thumbnails
  only while tiles show.
- **Shared tile parts (`src/shared/media-ui/src/tiles`):** the tile geometry (`layout.ts`), the glyphs, the thumbnail
  store and the cover store (now created per view with a lane, on the media port) and the preview frame
  (`TileThumb`) moved from the viewer. The viewer's files of the same names re-export them or hold the viewer's one
  store, so nothing else in the viewer changed; `.tile-selected` moved to the shared stylesheet.
- **Settings (the Commander tab, five sections):** Panels (sizes, dates, hidden files, where letters go, right
  button, how media and documents open, tile size, the three bars), Operations (the conflict policy and "verify" the
  copy and move dialogs start with; the date rules of compares), Confirmations (ask before the trash; show the copy
  dialog on a drop; run programs with Enter), Editor and tools, Toolbar. Keys and Appearance stay the shared tabs.
- **Where letters go:** with "Go to the command line", a letter typed in a panel goes into the command line, which
  takes the focus; quick search then starts with Alt.
- 76 new messages in seven languages (ADR-0034); two retired.

Deviations from the scope above:

- **Enter runs without a console window.** A program with a window shows it; what a console program prints is not
  kept, and it is not seen: `cmd` and Enter shows nothing (the owner's first try, 2026-10-11). Shift+Enter (and a
  user command's "console" switch) runs the line in a console window that stays open; on an empty line it opens the
  console alone (added the same day, after Shift+Enter on the clicked, empty field did nothing). "The OS's console
  when the command needs one" would need the program started directly, not through the shell: through `cmd.exe`
  either every line opens a console or none does.
- **A second method, `shell.runTool`.** A user command is named by its id, and main builds its command line from ids.
  Building it in the renderer and sending it through `shell.run` would have put paths and quoting in the renderer.
- **cmd.exe and sh only.** PowerShell is not offered as the command line's shell.
- **No command runs in a network folder on Windows** (`\\server\share`): cmd.exe would fall back to the Windows
  folder. The line says so.
- **Folder tiles show the folder symbol**, not covers: `folder.covers` is not in the commander's profile.
- **Not from Total Commander:** `%M`, `%O`, `%E` and the `?` prompt in parameters; an icon file per button; several
  toolbars; drag and drop onto buttons.
- **Operations and Confirmations** hold what the commander has: one default conflict policy and "verify", the trash
  question, the drop dialog and the program question. A permanent delete always asks.

Measurements (reference machine, 32 threads, NVMe, warm cache; `src/shared/bench/results/stage-C10-2026-10-11-e2e-tools.jsonl`,
`stage-C10-2026-10-11-shell-start.json`):

| Metric | Result | Aim |
|---|---|---|
| Thumbnails view, 100,000 entries, 7 tiles a row (1920 px window), 5 s scroll over 158–177 thousand px (7 runs) | at most 77 tiles mounted; 0 long tasks; p95 frame 7–8 ms, longest gap 8–14 ms; 1 `preview.ensure` call; 29–32 `query.page` calls | the viewer's: ≤ 300 tiles, no long task > 50 ms, previews per settled range |
| Full view → Thumbnails view on that folder (Ctrl+Shift+F1 → first tiles) | 14–19 ms | — |
| The viewer's tile view after the move, 90,000 items, the same scroll (2 runs) | at most 80 tiles; 0 long tasks; p95 frame 7 ms, longest gap 15–21 ms; 1 `preview.ensure` call | the same |
| Enter → the command handed to the shell (IPC, the folder from Go, the start built; recorded, 35 calls a run, 7 runs) | median 0.5–0.7 ms; p95 0.7–1.1 ms | within a frame |
| The shell process started (`cmd.exe`, 30 starts) | median 1.5 ms; p95 1.5 ms | — |
| A command that does nothing (`rem`) started and ended | median 14.2 ms; p95 15.6 ms | — |
| Commander bundle, JS minified without the language files | 824.6 kB, gzip 246.4 kB (before the stage: 789.1 kB) | not budgeted |
| Commander CSS | 39.1 kB (before: 37.6 kB) | not budgeted |
| A language file | +5.4 to +7.2 kB (German 64.0 → 69.4 kB) | not budgeted |
| Viewer bundle after the tile move, JS minified | 600,976 bytes (before: 600,624); CSS unchanged | unchanged behavior |

## Security review (2026-10-11)

What was reviewed: `shellRun.ts`, the two validators, the commander's preload, the router's profile checks, the
renderer's two call sites, and the stored formats (`commander.tools`, `commander.toolbar`, `commander.commandHistory`).

| # | Question | Finding | State |
|---|---|---|---|
| 1 | Who can call `shell.run` and `shell.runTool`? | The commander's allowlist only; the viewer's profile has neither (router test, e2e). The full-screen media windows run on the commander's origin with its preload, so they could have called them: main now runs a command only for the commander's own view, and only while that view is the app shown. | closed (`allowed`, unit test, e2e: a call from the hidden commander is refused) |
| 2 | What crosses the bridge? | `shell.run`: one line of at most 2,048 characters without control characters, a folder id, a flag. `shell.runTool`: an id of the command, entry ids, a selection descriptor. No path, no program, no environment, no working folder; the preload copies the known fields only, and main refuses any other shape (router test, e2e). | closed |
| 3 | Where does it run? | In the folder the sidecar resolves from the id; it must be a folder. On Windows a network folder is refused. | closed |
| 4 | Which shell starts? | `cmd.exe` by its full path under `SystemRoot`, `/bin/sh`, `/usr/bin/osascript`. A bare `cmd.exe` would be searched in the working folder first, which is the folder being browsed. | closed |
| 5 | Can a file name become shell code in a user command? | Not through quoting: `sh` single quotes; for `cmd.exe` values travel in environment variables, which closes the percent-sign hole that quotes leave open. Tested by handing names such as `a&b %PATH% %COMSPEC%.txt`, `&& shutdown -s` and `'; rm -rf ~; echo '` to a real program through the real shell (Windows here; the `sh` set runs on the other platforms in CI). | closed |
| 6 | Can a file name become an option of the program? | A name alone that starts with "-" is passed as `./name`. | closed |
| 7 | Can the browsed folder decide which program a user command starts? | On Windows cmd.exe looks in the working folder before `PATH`. A user command whose program is named without a folder is refused when a file of that name (or the name with an executable extension) lies in the working folder. The check covers the first program of the command, not later ones behind `&&` in the user's own text. | closed |
| 8 | Where does a user command come from? | From `library.db` only, read by main when the command runs, through the same reader the renderer saves with (`readUserCommands`). The viewer cannot write `commander.*` settings (router test, e2e). | closed |
| 9 | The `%L` file | A new file with a random name in the profile's own folder, opened exclusively, readable by the user only; lists older than a day are removed on the next use. | closed |
| 10 | Does anything run without the user's Enter or button? | The renderer calls `shell.run` in one place (Enter in the command line's field) and `shell.runTool` in one (a user command's toolbar button, key or menu entry). Typing, leaving the field, switching panels, the history list and a picked history line run nothing (unit and e2e tests). Main cannot tell a key press from a call: what protects the renderer is context isolation, the sandbox and a content security policy without remote or inline scripts. | closed |
| 11 | Test mode | `PANELYTH_TEST_SHELL=record` is read in unpackaged builds only. | closed |

Decisions recorded with the review (not findings):

- **A typed line is the user's own shell text.** It runs as in a terminal opened in that folder; on Windows that
  includes cmd.exe looking in the folder first for a program typed without a path.
- **Commands are logged and remembered locally.** Main's log and the history in `library.db` keep the text of each
  line; a secret typed into the command line is in both.
- **What a command starts outlives the app.** A shell still waiting for its program ends with the app; the program
  does not.

## Test runs

- **Contracts** 91 (new: 7 on stored user commands). **Desktop** 151 and the benchmark (new: 30 in
  `shellRun.test.ts`: quoting, placeholders, the starts per platform, the console alone for an empty line, the
  handlers with their refusals, a real run with hostile names and a typed line through the real shell, the `%L`
  file; 1 in the router: the two methods for the commander, neither for the viewer, 20 refused shapes). **i18n** 26. **ui** 37. **media-ui** 20. **renderer-core**
  12. **docviewer** 15.
- **Viewer** 170, with no test file changed after the tile move.
- **Commander** 209 (new: 21 in `cmdline.test.tsx`: Enter and only Enter runs, Shift+Enter with a line and on the
  clicked, empty field, the inserted name and
  path, the history, `cd` in its forms, refusals, letters to the command line; user commands from the toolbar, a key
  and the menu with ids only, what is missing in words, adding and removing one in Settings; the toolbar's buttons
  changed and reset, the three bars hidden; the Operations and Confirmations settings; the Thumbnails view's bounded
  tiles, its preview requests, cursor, marks, rename and quick search, pages with thumbnails only while tiles show).
  Drag and drop and the right button in the Thumbnails view have no test of their own.
- **Go:** not changed in this stage; gofmt and vet clean.
- **By hand, commands really started (not recorded):** Shift+Enter on the clicked, empty field opened a visible
  `cmd.exe` console in the panel's folder, in the foreground; Shift+Enter and Enter with a line started their
  commands in the packaged build too.
- **E2E:** `specs/commander/tools.spec.ts` 6 of 6 (scenario 17; the calls refused from the viewer, from a hidden
  commander and with a path; a user command with hostile names and the settings after a restart; the Thumbnails
  view with real thumbnails; the viewer's tile view after the move; the benchmarks), three runs. The API list in
  `foundation.spec.ts` gained `shell.run` and `shell.runTool`. All commander specs and `switch.spec.ts` in one run:
  41 of 46. Four failures are the ones the C08 and C09 records list (the archives scenario and three specs of
  `viewers.spec.ts`); the fifth, `marks.spec.ts` "marks with keys, mouse and masks", failed once in that run and
  passed in four runs after it.
- **The viewer's `tiles.spec.ts`:** 0 of 9. Its tests cannot open a folder since Stage C06 (they click a toolbar
  button that is gone). The viewer's tile view was checked in the real app from `tools.spec.ts` instead, with the
  folder carried over by the app switch.
- **Lint and typecheck:** clean (Prettier still reports the two `showcase/` files it reported before).

## Open

- The NVDA pass of C02–C09, now also over the command line, the Thumbnails view and the new settings sections.
- Linux and macOS were not run here: the `sh` quoting with its hostile names and the real run are in the unit tests
  and run in CI; the console window on those systems (`x-terminal-emulator` or `TERMINAL`, Terminal through
  `osascript`) is built and unit-tested but has not opened on a real desktop.
- The viewer's e2e specs (open since C06): until they can open a folder, "the viewer's suites pass unchanged" holds
  for its unit suites and for the check in `tools.spec.ts` only.
- Console programs started with Enter are not seen. Showing a console only when the program is a console program
  needs the program started without the shell.
- Folder covers in the Thumbnails view (`folder.covers` for the commander's profile).
- Seen once while writing the e2e test: the viewer showed 75,263 of 90,000 items for a folder carried over while the
  commander was still listing it. Not investigated; the test now carries the folder over after the listing.

## Exit checklist

- [x] implementation complete
- [ ] tests complete (the NVDA pass, with C02's to C09's; Linux and macOS through CI; the viewer's e2e tile suite
      ran green on 2026-10-12, Stage P01)
- [x] benchmark complete
- [x] performance regression reviewed (commander: the Full and Brief views are unchanged, a page asks for thumbnails
  only in the Thumbnails view; viewer: its tile view runs on the moved parts within its budgets, bundle +352 bytes)
- [x] docs/ADR updated (ADR-0027 accepted in full; ADR-0028 noted)
