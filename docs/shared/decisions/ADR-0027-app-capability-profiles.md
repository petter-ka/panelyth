# ADR-0027 — App Capability Profiles: IPC Allowlists, Shell Actions and Launching

## Status

Proposed (2026-10-05). **The per-view allowlists are accepted (P01, 2026-10-05):** main maps the calling frame's
origin to its app and checks `APP_METHODS[app]`. **The launching part is accepted (Stage C05, 2026-10-06):** open,
programs after confirmation, the editor and file bytes through tokens, as built below. The command line is decided in
Stage C10. Revised the same day by ADR-0031: both apps run in one shell, so the profile belongs to each app
view (web contents), not to a separate app process.

## Context

- Electron main checks every renderer call against one allowlist (`RENDERER_METHODS`, ADR-0012). The viewer's
  guarantees include:
  - open and reveal act on entry ids that the sidecar resolves to paths, and the viewer only ever sees folders and
    media, so "open" can never launch an executable;
  - `media.resolve` serves only images and videos through the token protocol (ADR-0009);
  - nothing runs commands.
- The commander must open any file with its default app on Enter, start programs on request, run command lines, and
  read any file's bytes for its text/hex viewer and quick view.
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

- **Open (`shell.open`)** accepts any entry kind. It takes an entry id resolved by the sidecar, never a
  renderer-supplied path, and runs only from a user action (Enter, double-click, menu).
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
  one place (`shared/desktop/src/main/workspace.ts`).
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

## Why

- The viewer's guarantees stay intact inside the shared shell, while the commander gets the powers a file manager
  needs.
- Ids and descriptors keep path validation in one place: Go resolves, main acts.

## Consequences

- Router and e2e tests are per app view. Each view's e2e asserts its exact preload surface (the
  `shared/e2e/specs/viewer/foundation.spec.ts` pattern), and a commander-only method called from the viewer view is rejected.
- The command line is the most sensitive feature, so it comes last in the commander plan (Stage C10) and gets a
  security review.
