# ADR-0027 — App Capability Profiles: IPC Allowlists, Shell Actions and Launching

## Status

**Accepted in full (Stage C10, 2026-10-11).** Proposed 2026-10-05. **The per-view allowlists are accepted (P01,
2026-10-05):** main maps the calling frame's origin to its app and checks `APP_METHODS[app]`. **The launching part is
accepted (Stage C05, 2026-10-06):** open, programs after confirmation, the editor and file bytes through tokens, as
built below. **The command line is accepted (Stage C10, 2026-10-11),** as built in the note at the end. Amended (2026-10-09): Commander routes Enter/double-click media to the shared overlay by default, with a
setting for the system default app. Revised by ADR-0031: both apps run in one shell, so the profile belongs to each
app view (web contents), not to a separate app process.

Amended 2026-10-12 (Stage 15, ADR-0035): `edit.eyes` (red pupils found in the picture of an edit session) joins the
viewer's profile; the commander's has none of the editor's methods.

Amended 2026-10-12 (Stage 16, ADR-0036): batch editing joins the viewer's profile: `batch.pickFolder`, `batch.plan`,
`batch.start`, `batch.undo`, `recipe.list`, `recipe.save` and `recipe.delete`. The destination folder of a batch is
picked in main's dialog and named to the renderer by a handle; the sidecar methods that take its path (`edit.plan`,
`edit.batch`) are main's alone, and `jobs.start` refuses the job kinds `edit` and `undoEdit`. The commander's
profile has none of these.

Amended 2026-10-12 (Stage 14, ADR-0035): `edit.fonts`, `asset.pick` and `asset.release` join the viewer's profile.
A picture for a watermark, a mask or a texture is chosen in main's native dialog; main gives the path to the
main-only `edit.assetAdd` and the renderer an id and a thumbnail token. No renderer method takes a path, and an
edit list names an asset by a content-hash id only. The commander's profile has none of these methods.

Amended 2026-10-12 (Stage 13, ADR-0035): `edit.probe`, `edit.thumbs` and `edit.colors` join the viewer's profile
under the same rules; `edit.thumbs` is answered in main (tokens for thumbnail files from the main-only
`edit.thumbFrames`). The commander's profile still has no `edit.*` method.

Amended 2026-10-12 (Stage 12, ADR-0035): the image editor's methods (`edit.open`, `edit.render`, `edit.info`,
`edit.estimate`, `edit.save`, `edit.close`, `edit.saved`, `edit.reveal`) are in the **viewer's** profile only. The
commander's profile has none of them; from its media overlay or the media window it may send
`app.switch { to: "viewer", edit: entryId }`, which shows the viewer and makes it open its editor. A renderer names
neither a path nor the session's owner: a "save as" destination comes from main's save dialog, a frame is a token
URL, and a saved file is shown in the file manager by job id.

## Context

- Electron main checks every renderer call against one allowlist (`RENDERER_METHODS`, ADR-0012). The viewer's
  guarantees include:
  - open and reveal act on entry ids that the sidecar resolves to paths, and the viewer only ever sees folders and
    media, so "open" can never launch an executable;
  - `media.resolve` serves only images and videos through the token protocol (ADR-0009);
  - nothing runs commands.
- The commander must open any file on Enter, use its shared media overlay for images and videos by default (or the system
  default app when selected in Settings), start programs on request, run command lines, and read any file's bytes for
  its text/hex viewer and quick view.
- Both apps share one main process and one sidecar (ADR-0031). The commander's powers must not reach the viewer's
  renderer, even if that renderer were compromised through a malicious media file, and they must stay explicit in the
  commander.

## Decision

### A capability profile per app view

- Each app view (`WebContentsView`) has a **capability profile**: the renderer methods it may call, the shell actions
  main performs for it and the entry kinds each action accepts.
- Main keys every incoming call by the sender's web contents, finds that view's profile, and rejects anything outside
  it. Contracts tag every method with the apps that may call it, and each app's preload exposes only its own methods.
  Main still validates every parameter (ADR-0012).
- The sidecar serves both apps and is reachable only through main, so main's per-view check is the gate. Kind checks
  for shell actions and the token protocol happen in main, on the kind the sidecar returns with the resolved path.

### Viewer profile

Unchanged: `shell.open` accepts folders and media only, `media.resolve` serves images and videos, and there is no
command execution. Added: `app.switch` and the shared-context methods (`docs/shared/APP-SWITCHING.md`).

### Commander profile

- **Open (`shell.open`)** accepts any entry kind. Commander routes images and videos to the shared `MediaViewerOverlay`
  default; `shell.open` opens those with the system default app when selected in Settings, and other file kinds use it
  directly. It takes an entry id resolved by the sidecar, never a renderer-supplied path, and runs only from a user
  action (Enter, double-click, menu).
- **Programs:** an entry flagged executable (ADR-0026 `attrs`) opens only after confirmation, by default. The setting
  "Run programs with Enter" offers ask (default), always and never.
- **File bytes** for the lister and quick view come through the media token protocol (ADR-0009), extended to every
  entry kind for this profile: read-only, HTTP Range, one token per file. No file bytes cross IPC.
- **Command line (`shell.run`, Stage C10):** runs a command through the OS shell, with an indexed folder as the working
  directory, only after Enter in the command line or a tool button. Main logs every command. Under
  `PANELYTH_TEST_SHELL=record` it records instead of running.
- Plus `app.switch` and the shared-context methods.

### Both profiles

- Actions take entry ids or selection descriptors, never paths from the renderer. Display paths are fine. The shared
  context carries ids and descriptors only.
- No Node in the renderer, no raw `ipcRenderer`, and context isolation and the sandbox stay on for every app view.

## Implementation note (Stage C05)

- **Profiles in code:** `VIEWER_METHODS` (the viewer's list), `COMMANDER_ONLY_METHODS` (`file.open`, `shell.edit`,
  `fs.mkfile`) and `COMMANDER_METHODS`; main handlers receive the calling app, so `shell.open` applies the profile in
  one place (`src/shared/desktop/src/main/workspace.ts`).
- **Programs:** the sidecar's `entry.path` reports `program` (`fsx.IsProgram`): on Windows executables, scripts,
  installers, shortcuts and control panel items by extension; elsewhere the execute bit, scripts, packages and
  `.desktop` files, and macOS app bundles (folders that `open` launches). The viewer's `shell.open` refuses programs
  even among folders. The commander's `shell.open` refuses them without `allowProgram` (`PERMISSION_DENIED`,
  `details.reason: "program"`); the commander then asks (Cancel has the focus), refuses with a message ("never"), or
  sends `allowProgram` up front ("always"). The setting lives in `commander.settings.runPrograms`.
- **Editor (F4):** `shell.edit` takes an entry id only; main reads the editor path from `commander.settings.editor`
  (absolute, an existing file) and starts it detached without a shell, with the file path as its only argument.
  Without one: Notepad on Windows, `open -t` on macOS; on Linux `xdg-open` for documents, and an editor is required
  for programs (`xdg-open` could run them). Main refuses `library.setSetting` of `commander.*` keys from the viewer's
  view, so a compromised viewer cannot plant an editor for the commander to start.
- **File bytes:** `file.open` → `file.resolve` (main-only; any regular file, links followed, folders refused) → a
  token bound to the commander's origin. Non-media files are served as `application/octet-stream` with `nosniff`.
  `fetch()` of token URLs is allowed by the commander's CSP only (`connect-src 'self' panelyth-media:`); the viewer's
  CSP keeps `connect-src 'self'`. A request whose `Origin` is not the minting app's gets 403. The e2e test shows the
  viewer cannot read a commander token even when handed its URL.

## Implementation note (Stage C10)

- **Two methods, both commander-only and answered in main:** `shell.run({ command, dirId, console? })` for a line
  typed in the command line, and `shell.runTool({ toolId, dirId, otherDirId?, cursorId?, selection? })` for a user
  command. The second was added to the decision above: a user command is named by its id, main reads it from
  `library.db` (`commander.tools`) and fills its placeholders from ids the sidecar resolves, so the renderer never
  builds a command line from paths.
- **Only the commander's own view, while it is shown:** main runs a command when the call comes from the commander's
  app view (`WebContentsView`) and the commander is the visible app. The media windows share the commander's origin
  and preload; they are refused, as is a hidden commander.
- **The shell:** `cmd.exe` by its full path with `/d /v:off /s /c` on Windows, `/bin/sh -c` elsewhere, with the
  folder of `dirId` (resolved in Go, a folder) as the working folder. A typed line is passed as typed. Enter runs it
  without a console window; the `console` flag (Shift+Enter, or a user command's switch) opens a console that stays
  open (`start` on Windows, the terminal emulator on Linux, Terminal on macOS). An empty line is accepted only with
  that flag: the console opens in the folder and nothing runs.
- **File names in user commands** are quoted by one function per shell (`quoteSh`, `quoteCmd`). For cmd.exe a value
  travels in an environment variable that the command text names, because cmd expands percent signs inside quotes. A
  name that looks like an option is passed as a path. On Windows a user command is refused when its program, named
  without a folder, also exists in the working folder.
- **Accepted with the decision:** a typed line resolves programs as the shell does (cmd.exe looks in the working
  folder first); commands are logged by main and kept in the command history, both local; the programs a command
  starts are not ended with the app.
- **Test mode:** under `PANELYTH_TEST_SHELL=record` (unpackaged builds) the start is recorded and nothing runs.
- The security review is in `docs/commander/stages/C10-command-line-and-customization.md`.

## Why

- The viewer's guarantees stay intact inside the shared shell, while the commander gets the powers a file manager
  needs.
- Ids and descriptors keep path validation in one place: Go resolves, main acts.

## Consequences

- Router and e2e tests are per app view. Each view's e2e asserts its exact preload surface (the
  `src/shared/e2e/specs/viewer/foundation.spec.ts` pattern), and a commander-only method called from the viewer view is rejected.
- The command line is the most sensitive feature, so it comes last in the commander plan (Stage C10) and gets a
  security review (recorded in the Stage C10 document, no open findings).
