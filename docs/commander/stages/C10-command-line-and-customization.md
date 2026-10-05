# Stage C10 — Command Line, Tools and Customization

Status: **Planned**. Track: commander. Depends on: C09. Unblocks: C11.

## Objective

Finish the power-user surface: a command line, user commands and a toolbar, the thumbnails view, and complete
settings. The command line is the most sensitive feature and gets a security review.

## Decisions applied

- **ADR-0027** (command-line part decided here): `shell.run` only on an explicit user action; recorded in test mode.
- ADR-0028 (thumbnails view), ADR-0022 (keymap), ADR-0025 (shared tile components).

## Scope

- **Command line:** runs a command through the OS shell in the active panel's folder; history (Alt+F8, persisted);
  Ctrl+K focuses it; Ctrl+Enter inserts the cursor name and Ctrl+Shift+Enter its full path; `cd <path>` changes the
  panel's folder; Esc clears. Output is not captured (it opens in the OS's console when the command needs one).
- **User commands and external tools:** a command, its parameters (`%P` path, `%N` cursor name, `%S` marked names,
  `%L` a list file of marked paths, `%T` the other panel's path) and a working folder; reachable from the toolbar, the
  keymap and the context menu.
- **Toolbar:** customizable buttons (icon, label, command) in the app bar, after the switch icon (which stays first
  and can't be removed); the function-key bar can be hidden.
- **Thumbnails view (Ctrl+Shift+F1):** the viewer's tile components move to `packages/media-ui`; the panel shows tiles
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
  recorded under `FASTVIEW_TEST_SHELL=record`.
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

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
