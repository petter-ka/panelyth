# Commander UX Design

FastView Commander's layout, panels, dialogs and keyboard model. The visual system (tokens, themes, typography,
motion, interface size, keymap foundation) is shared: `docs/shared/DESIGN-SYSTEM.md`.

## Goal

Dense, calm and fast. Two places at once, every command one key away, and nothing happening that the user didn't ask
for. People coming from Total Commander find their keys where they expect them.

## Layout

```text
┌ [▦] ─────────────────────────────────────── app bar ─────────────────────────────────┐
├ [C:] [D:] [E:]  412 GB free ───────────────┬ [C:] [D:]  1.2 TB free ─────────────────┤
│ Photos │ Work │ +                           │ Backup │ +                              │
│ C:\Users\me\Pictures                 *.*    │ D:\Backup                       *.*    │
│ Name ↑               Ext   Size  Date   Attr│ Name ↑               Ext   Size  Date   │
│ ..                                          │ ..                                     │
│ ▸ Trip 2026                <DIR> 10-04 ----│ ▸ 2025                     <DIR> 09-30 │
│ • IMG_0001           jpg  2.1 MB 10-04 -a--│   notes              txt   4 KB  09-12 │
│ • IMG_0002           jpg  2.3 MB 10-04 -a--│                                        │
│   video_01           mp4   88 MB 10-03 -a--│                                        │
│ 2 of 1,204 marked · 4.4 MB of 2.4 GB        │ 0 of 87 marked                         │
├─────────────────────────────────────────────┴────────────────────────────────────────┤
│ Copying 1,204 files to D:\Backup — 2.1 of 6.3 GB · 412 MB/s · 0:12 left  [Pause] [×] │
│ C:\Users\me\Pictures> _                                                               │
│ F3 View   F4 Edit   F5 Copy   F6 Move   F7 New folder   F8 Delete   Alt+F4 Exit       │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

- The app bar on top holds the switch icon (`[▦]`, the viewer glyph) at the top left; it switches to the viewer
  (`docs/shared/APP-SWITCHING.md`). Stage C10's toolbar joins this bar later.
- Two panels share the width (50/50 by default). Drag the divider to resize; double-click resets it.
- The queue strip appears only while jobs exist. The command line and the function-key bar can be hidden.

## App bar and the switch to the viewer

- A slim bar on `chrome` above both panels, as tall as the viewer's navigation toolbar, so the switch icon sits on the
  same spot in both apps.
- For now it holds only the switch icon: the viewer glyph (2 × 2 picture tiles), tooltip "Switch to Viewer
  (Ctrl+Shift+M)". The viewer opens the active panel's folder with the cursor entry selected (if it can show it) and
  the marks it can show (`docs/shared/APP-SWITCHING.md`).
- Coming back from the viewer, the active panel opens the viewer's folder with the cursor on its selected tile; the
  inactive panel doesn't change.

## Panels

- **Active panel:** a 2 px `accent` line on top of its header, and the cursor bar drawn in full. The inactive panel's
  cursor is a 1 px muted outline, so the user always sees where Tab will land.
- **Drive and tab bar:** drive buttons with the current one pressed, free space, and folder tabs. Tabs show the folder
  name and a lock glyph when locked.
- **Path bar:** the full path and the active mask (`*.*`, or the quick filter). Click it or press Alt+D (as in Explorer) to edit;
  Enter navigates; Esc cancels.
- **Column header:** Name, Ext, Size, Date, Attr (the Full view is a TanStack Table, ADR-0028). The sort column shows
  ↑ or ↓; clicking a header sorts in Go, never in the browser. Columns resize by dragging their edge and persist per
  panel; hiding and reordering columns can come later from the same table model.
- **Rows:** fixed height per interface size (S 20 px, M 22 px, L 26 px).
  - a type glyph (folder, image, video, archive, text, program, link, other; no per-file OS icons in the first
    release);
  - name and extension in separate columns; folders show `<DIR>` in Size until calculated;
  - size in bytes with thousands separators (a setting switches to KB/MB/GB); date as a locale short date and time;
    attributes as `rhsa` on Windows and permissions (`rwxr-xr-x`) on Unix; numbers use tabular numerals;
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

F3 View · F4 Edit · F5 Copy · F6 Move · F7 New folder · F8 Delete · Alt+F4 Exit. Every label is a button. While
Shift or Alt is held, the labels change to those variants (Shift+F5 Copy here, Shift+F6 Rename, Shift+F8 Delete
permanently, Alt+F5 Pack, Alt+F7 Find, …), so the bar teaches the keymap.

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
| Ctrl+J | Queue panel | C04 |
| Ctrl+Q | Quick view | C05 |
| F3 / F4 / Shift+F4 | Lister / edit / new text file | C05 |
| Alt+F7 / Ctrl+S / Ctrl+B | Find files / quick filter / branch view | C06 |
| Alt+F5 / Alt+F9 / Alt+Shift+F9 | Pack / unpack / test archives | C07 |
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
