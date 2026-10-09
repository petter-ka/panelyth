# BRS — Panelyth Commander Business Requirements Specification

Panelyth Commander (working title) is the second app of the Panelyth product (ADR-0025). It runs next to the viewer
in the same shell and window, and a left app rail switches between them with shared state (ADR-0031,
`docs/shared/APP-SWITCHING.md`). Requirements shared with the viewer (FR-20 design system, FR-21 packaging, FR-22 app
switch and shared state, NFR-01–NFR-14) are in `docs/shared/REQUIREMENTS.md` and apply here. IDs in this document:
`CFR-nn` (functional) and `CNFR-nn` (non-functional). Each requirement names the stage that delivers it
(`docs/commander/stages/`).

## 1. Product definition

A keyboard-first, dual-panel file manager for Windows, macOS and Linux in the style of Total Commander. It shows two
folders side by side and moves, copies, compares, renames, packs and inspects files between them. It runs on the
Panelyth platform: the Go sidecar, the Electron shell, the contracts and the design system.

## 2. Primary user outcome

The user works in two folders at once, mostly from the keyboard. Folders list immediately, even with 100k entries.
File operations run in the background with clear progress and never freeze the UI. Nothing happens to a file without
an explicit command.

## 3. Functional requirements

### CFR-01 — Dual panels (C00, C01)

- Two file panels side by side, each with its own location, sort, view, marks, history and tabs.
- One panel is active (highlighted header, visible cursor); Tab switches. The other panel is the default target of
  copy and move.
- The divider is resizable (50/50 by default; double-click resets) and persisted. Ctrl+U swaps the panels.

### CFR-02 — Listing (C01)

- Every entry is listed: folders, files of any type, links (shown, not followed), and hidden/system entries when
  enabled (ADR-0026).
- A `..` row leads to the parent folder.
- Columns in the Full view: Name, Ext, Size, Date (modified), Attr. Every column can be resized and reordered; users
  can fit widths to visible cells, hide/show columns, and pin columns to either side. The layout persists per panel.
- Folders come first. A folder's size shows `<DIR>` until calculated (CFR-14).
- Each panel has a status line: marked count and size of the total, and free space on the volume.

### CFR-03 — View modes (C01, C03, C10)

- **Full** (detailed columns, default; Ctrl+F2), **Brief** (names in columns; Ctrl+F1), **Thumbnails** (tiles using the
  shared preview cache; Ctrl+Shift+F1; Stage C10).
- The view is per panel tab and persisted.

### CFR-04 — Sorting (C01)

- By name (natural), extension, size and date; click a column header or Ctrl+F3 / F4 / F5 / F6. Clicking the active
  column again reverses the order.
- Folders always first, sorted by name. Sort is per tab and persisted.
- Sorting is index-backed (ADR-0008, ADR-0017); a panel never sorts a full listing in React.

### CFR-05 — Navigation (C01, C02)

- Enter opens a folder, enters an archive (CFR-19) or opens a file (CFR-17).
- Backspace or Ctrl+PgUp goes to the parent folder; Ctrl+\ to the root.
- The path bar is editable: type a path and press Enter.
- Alt+Left / Alt+Right go back and forward; history per panel (CFR-10).
- Ctrl+Left / Ctrl+Right open the folder under the cursor in the left or right panel.
- After going up, the cursor lands on the folder just left.

### CFR-06 — Cursor and marking (C02)

- The cursor and the marked set are separate (ADR-0028). Commands act on the marked set, or on the cursor entry when
  nothing is marked.
- Insert marks and moves down; Space marks (and calculates a folder's size); Shift+arrows mark a range.
- Num+ marks by mask (dialog: `*.jpg;*.png`), Num− unmarks by mask, Num* inverts, Ctrl+A / Ctrl+Num+ marks all,
  Ctrl+Num− unmarks all, Alt+Num+ marks all files with the cursor's extension.
- Mouse: click moves the cursor; Ctrl+click toggles a mark; Shift+click marks a range. A setting switches to
  right-button marking (classic Total Commander).
- Marks are selection descriptors (ADR-0017), so marking 100k entries costs one range.

### CFR-07 — Quick search and quick filter (C02, C06)

- Typing letters in a panel jumps to the first matching name (prefix, then substring; `*` and `?` wildcards). Arrow
  keys move between matches; Esc ends the search.
- Quick filter (Ctrl+S) shows only matching entries until cleared (Stage C06).

### CFR-08 — Tabs (C03)

- Folder tabs per panel: Ctrl+T new tab, Ctrl+W close, Ctrl+Tab / Ctrl+Shift+Tab cycle; tabs can be reordered and
  locked. Tabs and their locations persist.

### CFR-09 — Drives and places (C03)

- A drive bar per panel and a drive menu (Alt+F1 left, Alt+F2 right) with labels, free and total space, and removable
  and network markers. Home and common user folders are listed too.
- A disconnected or empty drive shows a clear state and never blocks the other panel.

### CFR-10 — Hotlist and history (C03)

- Directory hotlist (Ctrl+D): add the current folder, open, edit, group. The hotlist is the viewer's bookmark list
  (one list in the shared `library.db`; the commander adds groups), so a folder bookmarked in either app appears in
  both. Recent locations are shared the same way (ADR-0031).
- Folder history per panel (Alt+Down shows the list), persisted.

### CFR-11 — Copy and move (C04)

- F5 copies and F6 moves the marked entries (or the cursor entry) to the other panel's folder.
- The dialog shows the destination (editable), a file mask, the conflict policy (ask, overwrite, skip, overwrite older,
  rename, …), "verify after copy", and "queue" vs "start now".
- Shift+F5 copies within the same folder under a new name.
- Drag and drop between panels copies (Shift: move), with the same dialog.

### CFR-12 — Rename, new folder, delete (C04)

- Shift+F6 (and F2) renames in place, with name validation (ADR-0021).
- F7 creates a folder; a path such as `a/b/c` creates the whole chain.
- F8 or Delete moves to the trash. Shift+F8 or Shift+Delete deletes permanently, after confirmation. Where the trash
  is unavailable (removable or network drives, ADR-0021), the dialog says so and offers permanent delete.

### CFR-13 — Operation queue (C04)

- Copy, move, delete, pack and extract run as background jobs in lanes (ADR-0029), shown in a queue panel with
  progress, speed, ETA, pause, resume and cancel.
- Conflicts with the "ask" policy show a dialog for that job only; others keep running.
- Finished jobs list their per-item failures.

### CFR-14 — Folder sizes (C02, C09)

- Space on a folder calculates its total size in the background; Alt+Shift+Enter calculates every folder in the panel.
  Sizes appear in the Size column and the status line; the calculation is cancellable.

### CFR-15 — Quick view (C05)

- Ctrl+Q turns the other panel into a quick view of the entry under the cursor: images and videos (the shared viewer
  components and preview cache), text (the first part of the file, encoding detected), other files as hex and
  properties. It follows the cursor after the selection settles.

### CFR-16 — Lister (C05)

- F3 opens a full-window viewer for the cursor entry: text (streamed and virtualized; large files open instantly;
  wrap; encodings), hex, images and videos. N / P step to the next and previous file; Esc returns.

### CFR-17 — Open, edit and run (C05)

- Enter or double-click on an image or video opens it in the built-in Viewer by default: images open in the focused
  image viewer and videos start in the full-window player. Viewer prepares the media surface before the app switch, so
  its workspace is not flashed behind the media. Closing the image or leaving video playback returns to Commander.
  Settings can route images and videos to the system default app instead.
- Other files open with their default app. Programs need confirmation by default (ADR-0027).
- F4 opens the file in the configured external editor (default: the OS's default app for text). Shift+F4 creates a new
  text file and opens it.

### CFR-18 — Find files and branch view (C06)

- Alt+F7 finds files by name masks (with exclusions), in subfolders to a chosen depth, by text content (case, whole
  words, encoding), size, date and attributes. Results stream in and are cancellable.
- "Feed to panel" shows the results as a panel listing that supports every command.
- Ctrl+B (branch view) lists all files of the current folder and its subfolders in one flat listing.

### CFR-19 — Archives (C07)

- zip and tar(.gz) are browsed like folders (ADR-0030): view, copy out, quick view.
- Alt+F5 packs the marked entries; Alt+F9 unpacks; archives can be tested. 7z, rar and others work when 7-Zip is
  available.
- Extraction is safe: no paths outside the target, warnings for archives that expand beyond the free space.

### CFR-20 — Compare and synchronize (C08)

- Compare directories (Shift+F2) marks entries that are unique or newer in each panel.
- Synchronize directories compares two trees by name, size, date (with tolerance) and optionally content, shows the
  differences with a direction for each, and applies them as jobs.
- Compare files by content: identical or not for any file, and a side-by-side text diff for text files.

### CFR-21 — Checksums (C08)

- Create checksum files (SHA-256, SHA-1, MD5, CRC32) for marked files, and verify existing ones.

### CFR-22 — Multi-rename (C09)

- Ctrl+M opens the multi-rename tool: a name mask with placeholders (`[N]` name, `[N1-5]` part, `[E]` extension,
  `[C]` counter with start, step and digits, `[Y][M][D][h][m][s]` dates), search and replace (plain or regular
  expression), case conversion, and a live preview that shows conflicts. It applies as one job, and the last
  multi-rename can be undone.

### CFR-23 — Attributes and properties (C09)

- Change attributes (Windows: read-only, hidden, system, archive; Unix: permissions) and timestamps for marked entries.
- Alt+Enter shows properties (the shared properties dialog).

### CFR-24 — Command line (C10)

- A command line under the panels runs commands in the active panel's folder through the OS shell, with history
  (Alt+F8). Ctrl+Enter inserts the cursor name; Ctrl+Shift+Enter inserts its full path. `cd <path>` changes the panel's
  folder. Commands run only on Enter (ADR-0027).

### CFR-25 — Function-key bar, toolbar and user commands (C00, C10)

- The bottom bar shows F3 View, F4 Edit, F5 Copy, F6 Move, F7 New folder, F8 Delete, Alt+F4 Exit; each is clickable.
- A customizable toolbar and user-defined commands (external programs with parameters such as the path, the cursor
  name or a list file of marked entries) come in Stage C10.

### CFR-26 — Settings and session (C00, C03, C10)

- Persist, in the shared `library.db` under `commander.*` keys: panel split, panel locations, tabs, views, sorts,
  column widths, hidden-files toggle, per-panel history, keymap overrides, confirmations, `mediaOpen`, the external
  editor and the function-bar visibility. Theme, interface size, bookmarks and recent locations are shared with the
  viewer.
- On start, both panels reopen where the user left them.

### CFR-27 — Drag and drop and clipboard (C04)

- Drag and drop between the panels, onto tabs and onto drive buttons.
- Ctrl+C / Ctrl+X / Ctrl+V use the platform's internal file clipboard (ADR-0021) across panels, tabs and the two
  apps: copy in the viewer, paste in the commander (ADR-0031). Copy names
  and full paths as text. OS file-clipboard interop is out of scope until it is portable.

### CFR-28 — UX states (all stages)

Useful states for: loading, empty folder, permission denied, path not found, drive not ready, network unavailable,
archive unreadable, operation failed per item, queue busy, and listing in progress.

### CFR-29 — Switch to the viewer (C00, C01, C02)

- A left app rail highlights the Commander icon; selecting Viewer, or pressing Ctrl/Cmd+Shift+M, switches to the
  viewer in the same window (FR-22).
- The viewer opens the active panel's folder, selects the cursor entry if it can show it, and takes over the marks it
  can show. Coming back, the active panel opens the viewer's folder with the cursor on its selected tile.
- Rules, options and budgets: `docs/shared/APP-SWITCHING.md`.

## 4. Non-functional requirements

### CNFR-01 — Keyboard first

Every command is reachable from the keyboard. The defaults follow Total Commander; every command is remappable
through the shared keymap (ADR-0022). Mouse use is complete but secondary.

### CNFR-02 — Listing latency

Entering a folder paints its first rows fast enough to feel instant, at any folder size, without blocking input
(budgets in `docs/commander/PERFORMANCE.md`).

### CNFR-03 — Cursor latency

Moving the cursor, including with a held key, costs at most one frame. Quick view and status updates wait until the
cursor settles.

### CNFR-04 — File-operation throughput

Copies run close to the OS's own speed with constant memory, and never block either panel (ADR-0029).

### CNFR-05 — Safety

- Destructive operations confirm; delete goes to the trash by default.
- Nothing runs without an explicit command; programs need confirmation by default (ADR-0027).
- Recursive operations never follow links. Archive extraction never writes outside the target.

### CNFR-06 — Panel independence

A slow listing, an unreadable drive or a running job in one panel never stalls the other panel or the command line.

### CNFR-07 — Accessibility

The Full view follows the ARIA grid pattern and the Brief view the listbox pattern. The cursor, marks, the active
panel and job progress are announced to screen readers.

## 5. Out of scope for the first release

- FTP, SFTP, WebDAV and cloud storage
- plugins (Total Commander WCX/WFX/WLX compatibility)
- a built-in text editor
- a terminal emulator
- changing files inside archives in place
- OS file-clipboard interop
- network share administration
- file encryption

## 6. Relationship to the viewer

| Shared with the viewer (platform) | Commander only |
|---|---|
| sidecar, index, query sessions, selection descriptors, jobs, watcher, preview cache, decoders | `all` index scope, archive sources, find, compare, checksums, rename engine extensions |
| Electron shell and window, IPC, protocols, security model | the commander capability profile: open any file, programs, command line |
| the app switch and shared state: folder, focus, selection, bookmarks, recent, appearance, clipboard (FR-22) | the commander's own layout, panels, tabs, views and sorts |
| design system, keymap, theme, settings, properties dialog | dual panels, lists, queue panel, lister, function-key bar |
| image viewer and video player components (from Stage C05) | quick view and lister composition |

## 7. Definition of success

Panelyth Commander is successful when:

- both panels list large folders immediately and move the cursor without lag;
- every core Total Commander workflow (navigate, mark, copy, move, rename, delete, find, pack, compare) works from the
  keyboard;
- file operations run in the background at close to OS speed and can be paused, resumed and cancelled;
- the viewer is unaffected: same features, same budgets.
