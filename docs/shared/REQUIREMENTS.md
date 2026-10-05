# Platform Requirements (shared)

Requirements that every app of the FastView product family inherits (ADR-0025). App-specific requirements live in:

- `docs/viewer/BRS.md`: the FastView viewer (FR-01–FR-19);
- `docs/commander/BRS.md`: FastView Commander (CFR-01…, CNFR-01…).

The IDs below come from the original FastView BRS, so the references in ADRs, stage documents and code stay valid.
New platform requirements continue the numbering (NFR-13…).

## 1. Functional requirements (platform)

### FR-20 — Design system

React uses:

- Tailwind CSS
- shadcn/ui
- design tokens
- minimal visual noise
- good spacing hierarchy
- subtle motion where useful
- visible focus states
- accessible dialogs/context menus/toolbars

Effects must not make scrolling or startup visibly slower. Specification: `docs/shared/DESIGN-SYSTEM.md`, ADR-0014.

### FR-21 — Cross-platform packaging

Build/package the product (both apps) for:

- Windows
- macOS
- Linux

Platform-specific paths, volume discovery and cache directories are abstracted. One package per OS contains the
shell with both apps and the sidecar (ADR-0031); a feature flag keeps the commander hidden until it ships.

### FR-22 — App switch and shared state

The two apps connect in the UI (ADR-0031, `docs/shared/APP-SWITCHING.md`):

- an icon at the top of each app, and Ctrl/Cmd+Shift+M, switch to the other app in the same window, instantly after
  the first time;
- the app being shown opens where the user was: the same folder (and so the same drive), the same entry under the
  cursor, and the same selection (up to 10,000 entries); each part can be turned off;
- shared between the apps: the last used app, theme and interface size, bookmarks (the commander's hotlist), recent
  locations, user metadata, listings and thumbnails, jobs and the internal file clipboard;
- each app keeps its own layout, views and sorts.

## 2. Non-functional requirements

### NFR-01 — Responsiveness

No filesystem, indexing, decoding, caching or batch operation blocks the renderer event loop.

### NFR-02 — Large folders

Target architecture supports hundreds of thousands of entries.

Do not:

- load all metadata into browser state
- mount all items in DOM
- eagerly generate all previews
- eagerly materialize the whole sidebar tree or a whole recursive listing

### NFR-03 — Memory

Keep the renderer DOM and in-memory image working set bounded.

Disk cache is the durable preview store.

### NFR-04 — IPC

Use asynchronous, typed, batch-oriented IPC.

Do not send normal thumbnail/video bytes, or file contents, through control-plane IPC.

### NFR-05 — Reliability

Interrupted scans/jobs are recoverable.

Corrupt cache entries are removable/regenerable.

### NFR-06 — Privacy

Core browsing, viewing and file management require no cloud service.

### NFR-07 — Security

Renderer has no arbitrary Node.js access.

Filesystem access uses narrow validated APIs. Each app's renderer gets only the capabilities its product needs
(NFR-14).

### NFR-08 — Accessibility

Primary workflows are fully usable with keyboard:

- navigation
- selection
- opening
- search
- sorting and view settings
- context menus where possible
- preview controls
- file operations and their dialogs

### NFR-09 — Persistence

Persist:

- pane/panel dimensions and collapse state
- view settings (viewer: tile size; commander: view mode and columns)
- sorting
- recent locations
- bookmarks
- theme
- user preferences
- shared state: the last used app, its folder and focused entry, and the carry-over options (FR-22)

### NFR-10 — Batch safety

Large file operations expose progress, cancellation where safe, per-item failures and final status.

### NFR-11 — Cross-platform filesystem behavior

Do not assume Windows drive letters or identical filesystem APIs across platforms.

### NFR-12 — Performance regression protection

Hot-path changes require a benchmark or before/after trace.

### NFR-13 — App isolation

Both apps share one shell and one sidecar (ADR-0031), but each app runs in its own renderer process (app view). A
renderer crash in one app reloads only that app view; a long job or a full queue never blocks the other app's UI; a
hidden app does no work.

### NFR-14 — Capability scoping

Each app view gets only the renderer methods and shell actions of its capability profile (ADR-0027). Main checks every
call against the profile of the calling web contents.
Actions take entry ids or selection descriptors resolved by the sidecar, never renderer-supplied paths.

## 3. Platform out of scope

- cloud sync, user accounts, online services
- a web backend for core features
- telemetry that leaves the machine
