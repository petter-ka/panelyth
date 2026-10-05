# ADR-0027 — App Capability Profiles: IPC Allowlists, Shell Actions and Launching

## Status

Proposed (2026-10-05). The per-view allowlists are decided in Stage P01, launching files in Stage C05 and the command
line in Stage C10. Revised the same day by ADR-0031: both apps run in one shell, so the profile belongs to each app
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
  `FASTVIEW_TEST_SHELL=record` it records instead of running.
- Plus `app.switch` and the shared-context methods.

### Both profiles

- Actions take entry ids or selection descriptors, never paths from the renderer. Display paths are fine. The shared
  context carries ids and descriptors only.
- No Node in the renderer, no raw `ipcRenderer`, and context isolation and the sandbox stay on for every app view.

## Why

- The viewer's guarantees stay intact inside the shared shell, while the commander gets the powers a file manager
  needs.
- Ids and descriptors keep path validation in one place: Go resolves, main acts.

## Consequences

- Router and e2e tests are per app view. Each view's e2e asserts its exact preload surface (the
  `tests/e2e/specs/foundation.spec.ts` pattern), and a commander-only method called from the viewer view is rejected.
- The command line is the most sensitive feature, so it comes last in the commander plan (Stage C10) and gets a
  security review.
