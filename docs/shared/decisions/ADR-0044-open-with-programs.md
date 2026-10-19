# ADR-0044 — "Open With" Programs from Settings

## Status

Accepted (2026-10-19), at the owner's request, outside the stage list, like ADR-0039 and ADR-0040. Amends ADR-0027
(three new main methods in the viewer's and the commander's profiles and one more in the viewer's; the viewer may
hand a folder, a picture or a video to a program the user chose) and ADR-0031 (one more shared setting,
`shared.programs`). Amended the same day (owner request): the folder that is open and the folders of the viewer's
folder tree get the programs too, and a name is saved as it is typed.

## Context

- The owner wants programs set in Settings, listed in the context menu of files and folders, each opening the item
  with that program ("Open with GIMP", "Open with Code").
- The viewer opens folders and media with the system default app only (`shell.open`, ADR-0027), and runs nothing.
  The commander has user commands (Stage C10) that can sit in its entry menu, but a user command is a command line
  with placeholders, run through the OS shell, and the commander's alone.
- ADR-0027: renderers name entries by id and never send paths for actions; main resolves ids through Go. Main
  already starts one program the user configured, the commander's F4 editor: detached, without a shell, with the
  file's path as its only argument.
- A viewer renderer compromised by a malicious media file must not gain a way to run a program of its choosing.
  `shared.*` settings are written by both apps, and main relays them to every view.

## Decision

- **One list for both apps**, `shared.programs` in `library.db`: `{ v: 1, programs: [{ id, name, path, target }] }`,
  at most 20, `target` one of `files`, `folders`, `both` (`src/shared/contracts/src/programs.ts`). Settings has a
  tab of its own, **Open with**, in the viewer's and the commander's settings (Panelyth System has none).
- **Only main writes the list.** `library.setSetting` of `shared.programs` is refused for every app. Three main
  methods, in both profiles:
  - `programs.add {}`: main's native file dialog picks the program (`.exe`/`.com` on Windows, an app bundle or an
    executable file on macOS, an executable file on Linux); main names it after its file and appends it. The
    renderer never sends a program path.
  - `programs.update { programs: [{ id, name, target }] }`: the list in its new order. Names and targets change;
    a program left out is removed; paths stay as main stored them, and unknown ids are dropped.
  - `programs.open { programId, entryId }`: main reads the program from `library.db` and the entry's path and kind
    from Go (`entry.path`), checks the target (a folder or a file), checks the program still exists, and starts it
    **detached, without a shell, with the entry's path as its only argument**. On macOS an app bundle is started
    with `open -a <bundle> <path>`.
  - `programs.openFolder { programId, path }` (viewer only): a folder of the folder tree, whose rows are paths
    rather than indexed entries, as for `shell.revealPath`. Main checks the path is absolute and an existing folder
    (never a macOS app bundle) and starts the program as above. The commander's folders are entries: it uses
    `programs.open`.
- **Names save as they are typed** (after a 400 ms pause), and at once on Enter, Esc, leaving the field or closing
  Settings, like every other setting (ADR-0039). An emptied name is not saved.
- **Who may call.** `programs.open` and `programs.openFolder` come from the calling app's own view while it is the app on screen (as
  `shell.runTool`); the media and document windows are refused. `programs.add` and `programs.update` come from the
  app's view or the settings window it opened.
- **The viewer's profile still limits what it hands over:** folders, pictures and videos, never an entry flagged as
  a program (as `shell.open`). The commander hands over any entry of this computer; entries inside an archive or on
  a server have no path and get no programs.
- **Menus.** The viewer's tile menu (one entry selected) and the full-screen viewer's menu list "Open with <name>"
  after "Open with default app"; the menu of the tile view's empty area lists the folder programs for the folder
  that is open, and the folder tree's menu lists them after "Show in file manager". The commander's entry menu lists
  them after Open, for the entry under the cursor. Each lists the programs whose target fits the entry. A refusal is
  shown as the app's notice.
- **Logging and tests.** Main logs each start (the program's id and name, the entry's kind). Under
  `PANELYTH_TEST_SHELL=record` the start is recorded as a `launch`; `PANELYTH_TEST_PROGRAM_PATH` answers the dialog
  in unpackaged builds.

## Why

- A program path that comes only from main's dialog means a renderer, even a compromised one, can start nothing
  but what the user picked, and only with an indexed entry's path as its argument. No shell parses the call, so a
  file name cannot add arguments or commands.
- One shared list follows the product family's shared state (bookmarks, appearance): a program set in either app
  is offered in both.
- Kept apart from the commander's user commands: those stay the place for parameters, marked files and consoles.

## Consequences

- The viewer can start programs the user chose. That widens ADR-0027's "nothing runs commands" for the viewer, in
  the bounded form above: no arguments of its own, no shell, folders and media only.
- One entry at a time; several selected files to one program, arguments per program and an extension filter are
  open.
- The settings window's writes reach every view through `settings.changed`, which main sends after each change of
  the list.
- Measured (2026-10-19, `pnpm bench:bundle`, before and after on e1c803b): the viewer's JS grows by 5.3 KB
  (0.6 %, 1.7 KB gzipped), the commander's by 5.5 KB (0.5 %), Panelyth System's by 4.6 KB (the shared Settings
  dialog includes the tab; System never shows it). Each app view loads `library.get` once more at start, off the
  first paint. `src/shared/bench/results/stage-P06-2026-10-19-petter-bundle.json` (before) and `-bundle-2.json`.
- Tests: contract parsing (`src/shared/contracts/test/programs.test.ts`), main's handlers and the router rules
  (`src/shared/desktop/test/programs.test.ts`, `router.test.ts`), the Settings tab
  (`src/shared/ui/src/programs.test.tsx`), the tile and entry menus, and the e2e spec
  `src/shared/e2e/specs/viewer/programs.spec.ts`.
