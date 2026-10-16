# ADR-0042 — Panelyth System, the Third App

## Status

Accepted (2026-10-16), at the owner's request, outside the stage list, like ADR-0040 and ADR-0041. Amends
ADR-0025 (a third app in the family), ADR-0027 (a third capability profile) and ADR-0031 (a third app view in the
shell and on the rail).

## Context

- The owner asked for a third app on the rail, apart from the viewer and the commander: a dashboard about the
  computer (CPU, graphics, memory, operating system) and its volumes (free space), with charts, and a simple
  search across several volumes at once.
- It works in the commander's scope: every volume and every file, not the viewer's media-only scope (ADR-0026).
- ADR-0031 hosts each app as a view in one shell window, created on first use; ADR-0027 checks every call against
  the profile of the origin it comes from. The viewer is `app://panelyth/`, the commander `app://commander/`.
- The sidecar already has what the volumes and the search need: `fs.volumes` (free and total bytes per volume) and
  `find.start` (up to 16 roots; its result is a query session paged like a folder). Hardware details are not in the
  sidecar; Electron's main process has them (Node's `os`, `app.getGPUInfo`).

## Decision

- **A third app, "Panelyth System"** (`AppId` `"system"`), served from `app://system/` out of its own renderer
  package `src/system/renderer`, with its own preload (`system.cjs`) and profile `SYSTEM_METHODS`. Its view is
  created on first use and kept, as the commander's is. The rail shows Viewer, Commander, System; Ctrl+Shift+M still
  switches between the viewer and the commander, and System is opened from the rail.
- **Its profile is narrow:** the app basics (switch, about, settings, status), the shared appearance settings,
  `fs.volumes`, `find.start` / `find.cancel`, paging its own search results (`query.page`, `query.close`), opening
  a found file's folder (`dir.openContaining`) and publishing the shared context, and two main methods:
  - `system.hardware`: OS name and version, the computer's name, uptime, CPU model, cores, threads and clock, total
    memory, and the graphics adapters as Chromium sees them (name, vendor, driver). Read once.
  - `system.load`: CPU time per core and free memory, sampled by the dashboard once a second while it is visible
    (the renderer turns two samples into a load); nothing runs while it is hidden.
  No file operations, no jobs, no opening or running files: those stay the commander's.
- **The sidecar** knows a third owner, `system`, with a small session budget (4), and accepts its shared context.
  Its searches are owned by it, not by the commander.
- **Search** is simple: a name (plain text, matched anywhere in a name, as the commander's quick filter) on the
  volumes ticked, hidden files left out, results listed as they arrive with live counts, Stop at any time. A result
  opens in the commander: System publishes the result's folder and the file as the shared context and switches;
  the commander applies a context from System as it does the viewer's.
- **Charts** are drawn with SVG in the app (rings, bars, a load history); no chart library is added.

## Consequences

- Memory: a third renderer only once System is opened.
- Performance: nothing while hidden; while shown, one main call a second (two `os` calls, no disk access) and a
  re-render of the load charts only.
- The capability boundary is tested like the others: the profile list, main's checks, and an e2e check that the
  System view sees only its API.
- Volume space comes from the sidecar's existing volume listing (a volume that does not answer shows as not ready).
