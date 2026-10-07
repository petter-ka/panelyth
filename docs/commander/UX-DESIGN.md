# Commander UX Design

FastView Commander's layout, panels, dialogs and keyboard model. The visual system (tokens, themes, typography,
motion, interface size, keymap foundation) is shared: `docs/shared/DESIGN-SYSTEM.md`.

## Goal

Dense, calm and fast. Two places at once, every command one key away, and nothing happening that the user didn't ask
for. People coming from Total Commander find their keys where they expect them.

## Layout

```text
+------+----------------------------------------------------------------+
| [V]  | [C:] [D:] [E:]  412 GB free  |  [C:] [D:]  1.2 TB free             |
| [C]  | Photos | Work | +             |  Backup | +                        |
|      | C:\Users\me\Pictures          |  D:\Backup                         |
|      | Name               Ext Size     |  Name          Ext Size            |
|      | ..                            |  ..                                  |
|      | Trip 2026           <DIR>      |  2025          <DIR>               |
|      | IMG_0001.jpg        2.1 MB     |  notes.txt     4 KB                |
|      | IMG_0002.jpg        2.3 MB     |                                      |
|      | video_01.mp4        88 MB      |                                      |
|      | 2 of 1,204 marked              |  0 of 87 marked                     |
|      | Copying 1,204 files... [Pause]  |                                      |
|      | F3 View  F4 Edit  F5 Copy...    |                                      |
+------+----------------------------------------------------------------+
```

- The left app rail shows both app icons, Viewer above Commander, with Commander selected. The other icon switches apps; Ctrl/Cmd+Shift+M does the same (`docs/shared/APP-SWITCHING.md`).
- Two panels share the width (50/50 by default). Drag the divider to resize; double-click resets it.
- The queue strip appears only while jobs exist. The command line and the function-key bar can be hidden.

## App switcher rail

- A narrow full-height bar on the left, shared with the viewer. Viewer is first, Commander second; the current app is highlighted and the other app's icon switches to it. The switch tooltip includes the current keymap chord.
- Selecting Viewer opens the active panel's folder with the cursor entry selected (if it can show it) and the marks it can show (`docs/shared/APP-SWITCHING.md`).
- Coming back from the viewer, the active panel opens the viewer's folder with the cursor on its selected tile; the inactive panel doesn't change.

## Panels

- **Active panel:** a 2 px `accent` line on top of its header, and the cursor bar drawn in full. The inactive panel's
  cursor is a 1 px muted outline, so the user always sees where Tab will land.
- **Drive and tab bar:** drive buttons with the current one pressed, free space, and folder tabs. Tabs show the folder
  name and a lock glyph when locked.
- **Path bar:** the full path and the active mask (`*.*`, or the quick filter). Click it or press Alt+D (as in Explorer) to edit;
  Enter navigates; Esc cancels. A branch view or fed search results show an accent "Branch view" or "Search results: …"
  chip before the path (click or Backspace returns to the folder); the quick filter (Ctrl+S) is edited in a field
  after the path, filters as you type, and stays as a chip until clicked or cleared with Esc. Rows from other folders
  show that folder, relative to the panel's, muted before the name.
- **Column header:** Name, Ext, Size, Date, Attr (the Full view is a TanStack Table, ADR-0028). The sort column shows
  ↑ or ↓; clicking a header sorts in Go, never in the browser. Widths and layouts persist per panel. Drag a column
  header to reorder it, or drag its edge to resize it. Double-click the edge to fit the header and
  currently virtualized cells. Right-click a header to sort, move, hide or show columns, reset widths and pin columns
  to the logical start or end. Name always stays visible.
- **Rows:** fixed height per interface size (S 20 px, M 22 px, L 26 px).
  - a compact type glyph (folder, image, video, archive, text, program, link, other), color-coded with the shared
    label palette; marked entries use the selection accent, and hidden or system entries use muted glyphs (no
    per-file OS icons in the first release);
  - a subtle `raised` surface on hover; the cursor keeps its outline and marked entries keep their accent;
  - name and extension in separate columns; folders show `<DIR>` in Size until calculated;
  - size, date and attributes use muted secondary text; sizes use B/KB/MB/GB units by default, with a setting to
    switch to exact bytes with thousands separators. Dates use relative labels such as "today" and "yesterday" by
    default (switchable in code to the configured locale or ISO format); attributes are `rhsa` on Windows and
    permissions (`rwxr-xr-x`) on Unix;
    numbers use tabular numerals;
  - hidden and system entries in `muted` text; links with a link glyph.
- **Cursor and marks:** the cursor is a `raised` bar with an `accent` outline; marked entries use `accent` text and a
  `•` in the gutter, so marks never rely on color alone. The cursor and the marks are independent (ADR-0028).
- **Status line:** "2 of 1,204 marked · 4.4 MB of 2.4 GB" plus free space; while listing: "Listing… 12,400 entries so
  far" with a Stop button.

### Brief view

Names only, in fixed-width columns that flow top to bottom and then into the next column; ←/→ move between columns.

### Thumbnails view (Stage C10)

The viewer's tile components on the shared preview cache, inside the panel, with the same cursor and marks.

## Function-key bar

F3 View · F4 Edit · F5 Copy · F6 Move · F7 New folder · F8 Delete. Every label is a button, paired
with a compact action icon and a keycap so the bar is easy to scan while still teaching the keymap. While Shift or Alt
is held, the labels change to those variants (Shift+F5 Copy here, Shift+F6 Rename, Shift+F8 Delete permanently,
Alt+F5 Pack, Alt+F7 Find, …).

Above it, a compact quick-action toolbar provides icon buttons for Find files, quick filter, branch view, quick view,
refresh, the directory hotlist and rename. Tooltips show each action's current shortcut; quick view, branch view and
quick filter expose their active state.

## Command line (Stage C10)

The prompt shows the active panel's path. Enter runs the command there; Alt+F8 opens its history; Ctrl+Enter inserts
the cursor name and Ctrl+Shift+Enter the full path; Esc clears. `cd <path>` changes the active panel's folder.

## Queue panel (Stage C04)

A strip above the command line; click or press Ctrl+J to expand it into a list. Each job: what it does ("Copying
1,204 files to Backup"), progress, speed, ETA, and Pause / Resume / Cancel. A job waiting for a conflict decision says
"Needs your decision" and opens its dialog when clicked. Finished jobs with failures keep a Details button.

## Dialogs

All dialogs are keyboard-complete: Enter confirms, Esc cancels, Alt+underlined letters reach every field.

- **Copy / Move (F5 / F6):** "Copy 12 files (48 MB) to:" with the other panel's folder, editable; file mask; conflict
  policy (Ask, Overwrite, Skip, Overwrite older, Rename new, Rename existing); Verify after copy; buttons **Copy**
  (start now) and **Queue**.
- **Conflict:** source and target side by side (name, size, date, a thumbnail for media), the newer one marked.
  Buttons: Overwrite, Overwrite all older, Skip, Rename, Rename existing, Cancel job; "Apply to all conflicts in this
  job".
- **Delete (F8 / Shift+F8):** count and size; trash vs permanent stated in the title. Permanent delete shows the
  danger color; where the trash is unavailable, the dialog says so and offers permanent delete.
- **New folder (F7):** one field; `a/b/c` creates the chain.
- **Rename in place (Shift+F6, F2):** inline editor on the row; the name is selected without the extension.
- **Find files (Alt+F7, Stage C06):** General (masks, start folders, depth, text, case, whole words, encoding),
  Advanced (size, date, attributes), Results (streaming list; Feed to panel, Go to file, Stop).
- **Multi-rename (Ctrl+M, Stage C09):** mask fields with placeholder buttons, search and replace, case, counter; a
  live preview table (old name → new name), conflicts highlighted; Start and Undo last.
- **Synchronize directories (Stage C08):** left and right roots, compare options, a result table with a direction
  arrow per row (→, ←, =, ≠, ×), filters, and Synchronize.

## Quick view and lister (Stage C05)

- **Quick view (Ctrl+Q):** the other panel shows the cursor entry: image or video (shared components, fit, zoom, play),
  text (first window, encoding detected), or hex plus properties for other files. It follows the cursor after it
  settles.
- **Lister (F3):** full window. Modes: Text (wrap toggle), Hex, Image, Video, chosen by type and switchable with 1–4.
  N / P show the next and previous file; Ctrl+F finds in text; Esc returns to the panels with the cursor unchanged.
- As built (Stage C05): Tab moves into the quick view and back; quick view always shows in the inactive panel. The
  lister's header has the modes (unavailable ones disabled), the encoding, Wrap (W), Find and Close; F3 / Shift+F3
  find the next and previous match; its footer shows the position. Enter on a program asks "Run this program?" with
  Cancel focused (Settings → "Run programs with Enter": ask, always, never); Settings → "Editor (F4)" names the
  editor. Shift+F4 asks for a name (`new.txt`, the name selected without its extension).

## Default keyboard map

Total Commander-compatible defaults in the shared keymap (ADR-0022, scopes `panels`, `lister`, `dialogs`). Every
entry is remappable.

| Keys | Command | Stage |
|---|---|---|
| Tab | Switch active panel | C00 |
| ↑ ↓ PgUp PgDn Home End | Move the cursor | C01 |
| Enter | Open folder / archive / file | C01, C05, C07 |
| Backspace, Ctrl+PgUp | Parent folder | C01 |
| Ctrl+\ | Root of the drive | C02 |
| Ctrl+F3 / F4 / F5 / F6 | Sort by name / extension / date / size | C01 |
| Ctrl+F1 / Ctrl+F2 | Brief / Full view | C03 / C01 |
| Ctrl+H | Show hidden and system files | C01 |
| Ctrl+R | Refresh | C01 |
| Alt+D | Edit the path | C01 |
| Insert, Space | Mark (Space also sizes a folder) | C02 |
| Shift+↑ / Shift+↓ | Mark while moving | C02 |
| Num+ / Num− / Num* | Mark by mask / unmark by mask / invert | C02 |
| Ctrl+A, Ctrl+Num+ / Ctrl+Num− | Mark all / unmark all | C02 |
| Alt+Num+ | Mark all with the cursor's extension | C02 |
| letters | Quick search | C02 |
| Ctrl+U | Swap panels | C02 |
| Ctrl+← / Ctrl+→ | Open the cursor folder in the left / right panel | C02 |
| Alt+← / Alt+→ / Alt+↓ | Back / forward / history list | C02 / C03 |
| Alt+F1 / Alt+F2 | Drive menu, left / right | C03 |
| Ctrl+T / Ctrl+W / Ctrl+Tab | New tab / close tab / next tab | C03 |
| Ctrl+D | Directory hotlist | C03 |
| F5 / F6 | Copy / move to the other panel | C04 |
| Shift+F5 / Shift+F6, F2 | Copy here / rename | C04 |
| F7 | New folder | C04 |
| F8, Delete / Shift+F8, Shift+Delete | Trash / delete permanently | C04 |
| Ctrl+C / Ctrl+X / Ctrl+V | Internal file clipboard | C04 |
| Ctrl+Shift+C / Ctrl+Alt+C | Copy full paths / names as text | C04 |
| Ctrl+J | Queue panel | C04 |
| Ctrl+Q | Quick view | C05 |
| F3 / F4 / Shift+F4 | Lister / edit / new text file | C05 |
| Alt+F7 / Ctrl+S / Ctrl+B | Find files / quick filter / branch view | C06 |
| Alt+F5 / Alt+F9 / Alt+Shift+F9 | Pack / unpack / test archives | C07 |
| Ctrl+PgDn | Open the archive under the cursor (Enter does too; Backspace at its root leaves it) | C07 |
| Shift+F2 | Compare directories | C08 |
| Ctrl+M | Multi-rename | C09 |
| Alt+Shift+Enter / Alt+Enter | Size of all folders / properties | C09 |
| Ctrl+K, Alt+F8, Ctrl+Enter | Focus the command line, command history, insert cursor name | C10 |
| F1, Ctrl+/ | Keyboard shortcuts (shared dialog) | C02 |
| Ctrl+Shift+M | Switch to the viewer (shared `shell` scope) | C00 |
| Alt+F4 | Exit | C00 |

Quick search uses plain letters, so letter keys never trigger other commands in a panel. Total Commander's
Ctrl+Alt+letters works as an alias, and a setting sends letters to the command line instead (classic Total
Commander).

## Mouse

- Click moves the cursor; Ctrl+click toggles a mark; Shift+click marks a range (the viewer's additive Shift rules,
  Stage 08.6). A setting switches to right-button marking (classic Total Commander).
- Double-click opens. Right-click opens the context menu for the marked entries.
- Drag from one panel to the other copies (Shift moves); dropping on a tab or a drive button targets that folder.

## States and messages

Each state says what happened and what to do: "Drive D: is not ready" (Retry), "You don't have permission to open
this folder" (Go up), "This folder no longer exists" (Go to parent), "The network location is unavailable" (Retry).
An error in one panel never changes the other panel.

## Accessibility

- Full view: ARIA grid (rows, columns, `aria-selected` for marks, `aria-activedescendant` for the cursor). Brief view:
  listbox. Panel headers are landmarks. Tab switches panels, Ctrl+K focuses the command line
  and Ctrl+J the queue (F6 is Move, as in Total Commander).
- The status line and job progress are live regions, throttled so a fast copy doesn't flood the screen reader.
- Focus is always visible; marks never rely on color alone.

## Applying the design system

- Lists, quick view and the lister body sit on `canvas`; bars, headers and the function-key bar sit on `chrome`;
  dialogs and menus on `raised`.
- `accent` is reserved for the active panel line, the cursor outline, marks and each dialog's primary button.
- No motion on lists or rows. Dialogs and menus use the shared enter motion; everything respects
  `prefers-reduced-motion`.
