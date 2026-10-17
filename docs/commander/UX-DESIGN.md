# Commander UX Design

Panelyth Commander's layout, panels, dialogs and keyboard model. The visual system (tokens, themes, typography,
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
  name and a lock glyph when locked. A drive button (and a drive in the drive menu) opens the drive at the **other
  panel's folder** when the other panel is on that drive, as in Total Commander: one click puts both panels in the
  same place. Any other drive opens at its root, and so does the same button when the panel already shows that
  folder. A place of the drive menu (Home, Documents) always opens that folder.
- **Path bar:** the full path and the active mask (`*.*`, or the quick filter). Click it or press Alt+D (as in Explorer) to edit;
  Enter navigates; Esc cancels. A branch view or fed search results show an accent "Branch view" or "Search results: …"
  chip before the path (click or Backspace returns to the folder); the quick filter (Ctrl+F, or Ctrl+S) is edited in a field
  after the path, filters as you type (plain text, matched anywhere in a name, words in order; a mask such as `*.jpg`
  still works), and stays as a chip until clicked or cleared with Esc. Rows from other folders
  show that folder, relative to the panel's, muted before the name.
- **Count by type:** an icon in the path bar, beside `/` and `..`, opens a menu of the panel's folders and each
  extension's files, the most common first (at most 50 extensions; the rest as "Other types"). It is counted only
  when opened, since a branch view or a large archive takes a while, and again only once the listing has changed. The
  counts leave the quick filter out, so every type stays to choose from: ticking up to three extensions filters the
  panel to them (the quick filter becomes `*.jpg;*.png`), the menu stays open meanwhile, a fourth is disabled until
  one is unticked, and "Show all types" clears them. A typed filter is replaced by the first type ticked.
- **Column header:** Name, Ext, Size, Date, Attr (the Full view is a TanStack Table, ADR-0028). The sort column shows
  ↑ or ↓; clicking a header sorts in Go, never in the browser. Widths and layouts persist per panel. Drag a column
  header's edge to resize it; headers themselves do not drag. Double-click the edge to fit the header and
  currently virtualized cells. Right-click a header to sort, move, hide or show columns (drag the entries of the "Show columns" list to reorder them), reset widths and pin columns
  to the logical start or end. Name always stays visible.
- **Rows:** fixed height per interface size (S 20 px, M 22 px, L 26 px).
  - a 16 px type icon in the macOS style, filled and in color: a blue folder, a picture, a film frame, a music note,
    a PDF page, an archive, a text page, a program, a link and a blank page for everything else. Picture and video
    icons also cover formats the index does not treat as media (avi, wmv, heic, svg and so on). The icons are drawn
    in the repository and shared through one SVG sprite, so a row holds only a reference; hidden and system entries
    show them faded (no per-file OS icons in the first release);
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

As built: Ctrl+Shift+F1. Fixed-size tiles flow left to right, as many a row as the panel is wide. The cursor is an
outline around the tile (accent in the active panel); a marked tile has the accent frame and its name in the accent
color with "•". ←/→ move a tile, ↑/↓ a row. Pictures and videos show their thumbnail, other files their type icon,
folders the folder symbol. Tile size S, M or L in Settings → Panels, or Ctrl+wheel.

### Tab bar, folder tree and connections (Stage C10.5)

Details and keys: `docs/commander/stages/C10.5-tabs-tree-ftp-compare.md`.

- **Tab bar:** always shown (Settings → Panels can hide it while a panel has one tab), with a "+" button after the
  last tab and × on the active tab (on hover on the others). A double-click renames a tab. The tab menu has Rename,
  Duplicate, Lock, Close, Close others, Close tabs to the right, Reopen closed tab, Save tabs… and Tab sets… (one
  dialog to open a set in place of the tabs or after them, and to rename and remove sets).
- **Folder tree:** a pane left of the panels that follows the active panel, or one left of each panel
  (Ctrl+Shift+F8 cycles off, one, two; Shift+Tab moves into it). Rows have the panel's row height, an expand arrow
  and the name; the panel's folder is highlighted, and the tree's own cursor is the panel cursor's outline. The
  tree sits on `chrome`, like the bars, and is dimmed while its panel is in an archive, on search results or on a
  connection.
- **Connections (Ctrl+Shift+N):** a dialog with the list of saved connections (groups as sections; Enter connects, F4
  edits, Delete removes after a question) and buttons Quick connect…, New…, Edit…, Duplicate, Remove and Connect
  (primary). New and Edit open the connection's form in the same place: name, group, server, port, encryption,
  user, password (a field that is never filled in: "A password is stored" is its placeholder), "Save the password",
  the folder on the server, a folder of this computer for the other panel, and the advanced options. Where the
  computer has no secret store the form says so in place of the checkbox. **Quick connect (Ctrl+N)** is the
  server part of that form with Connect, and "Save this connection…".
- **Questions of a connect** are dialogs of their own, one at a time: "Connecting to …" with Cancel; the password
  (it says when the server refused the last one); a certificate that can't be verified, with who it was issued to
  and its SHA-256 fingerprint in pairs of digits, and the buttons Cancel (focused), Trust this time and Always
  trust this certificate. A certificate that is not the one accepted before is said in the title and in the
  warning color.
- **A connected panel** shows `ftp://user@host/path` in the path bar after a marker: "FTPS" in the accent color,
  or "Not encrypted" in the warning color, each with a tooltip. Entries whose names were left out are counted next
  to it. The drive bar has an "FTP" button (pressed while connected), the connection's name where the drive's
  would be, and Disconnect (Ctrl+Shift+F). The tab is called by the connection.
- **Waiting and lost connections:** a listing the server takes long over shows "Waiting for the server…" with Stop
  at the panel's lower edge after 0.4 s (Esc stops too); the panel keeps what it showed. A tab whose connection is
  not open (after a restart, or once it closed) shows "Not connected", the address, **Connect** and "Show the
  folder of this computer" in place of the rows.
- **Transfers:** F5 and F6 open the copy dialog as "Download …" or "Upload …" (or "Move … from / to the server");
  an upload's destination is the folder the server's panel shows and is not edited. F8 on a server always asks:
  "Delete … on the server? A server has no trash."
- **Not on a connection:** the commands that need files of this computer say "This is not available on a
  connection. Copy the files to this computer first." in the status bar and open nothing.
- **Compare several files:** the result list uses the synchronize table's row style: name, the two sizes and dates,
  and a word for the result (different, missing), never color alone. Shift+N and Shift+P in the diff step to the
  next and previous differing pair.

## Function-key bar

F3 View · F4 Edit · F5 Copy · F6 Move · F7 New folder · F8 Delete. Every label is a button, paired
with a compact action icon and a keycap so the bar is easy to scan while still teaching the keymap. While Shift or Alt
is held, the labels change to those variants (Shift+F5 Copy here, Shift+F6 Rename, Shift+F8 Delete permanently,
Alt+F5 Pack, Alt+F7 Find, …).

Above the panels, a toolbar of icon buttons: by default Find files, quick filter, branch view, compare and
synchronize directories, quick view, refresh, the directory hotlist and rename. Tooltips show each action's current
shortcut; quick view, branch view, quick filter and the Thumbnails view expose their active state.

As built (Stage C10): the buttons are the user's (Settings → Toolbar): any action of the panels or the shell, any of
their own commands, and dividers, in their order; Reset brings the default back. The toolbar, the command line and the
function-key bar can each be hidden (Settings → Panels).

### User commands (Stage C10)

Settings → Editor and tools → "Add a command…": a name, the command as it would be typed, its parameters, a working
folder (empty: the panel's folder), an icon, and whether it shows on the toolbar, in the menu of files, and runs in a
console window that stays open. In the parameters `%P` is this panel's folder, `%T` the other panel's, `%N` the name
under the cursor, `%S` the marked names and `%L` a file listing the marked paths; `%P%N` is the full path under the
cursor. Names are quoted for the user. A command can take a key in Keyboard shortcuts → Tools. When a command needs
a file and there is none, the status bar says so.

## Command line (Stage C10)

The prompt shows the active panel's path. Enter runs the command there; Alt+F8 opens its history; Ctrl+Enter inserts
the cursor name and Ctrl+Shift+Enter the full path; Esc clears. `cd <path>` changes the active panel's folder.

As built: Enter runs the line without a console window (a program with a window shows it); Shift+Enter runs it in a
console window that stays open, and on an empty line opens that console in the panel's folder. The field says so
while it is empty. Ctrl+K puts the keys into the line (and shows it
when it is hidden); Tab, ↑, ↓ or a second Esc return them to the files. The history (Alt+F8 or the ▾ button) lists the
last 50 lines, newest first; a picked line waits for Enter. `cd` also takes `..`, `\`, `~`, `/d` and, on Windows, a
drive alone (`d:`). When a command cannot run (a network folder on Windows, a folder that is gone), the reason shows
above the line and the line stays.

## Queue panel (Stage C04)

A strip above the command line; click or press Ctrl+J to expand it into a list. Each job: what it does ("Copying
1,204 files to Backup"), progress, speed, ETA, and Pause / Resume / Cancel. A job waiting for a conflict decision says
"Needs your decision" and opens its dialog when clicked. Finished jobs with failures keep a Details button.

**Progress dialog (2026-10-17, owner request).** By default a copy, move, delete, paste, drop, pack or unpack
started in this window shows its progress in a modal dialog over the panels: what it does, the current item, the
bar, speed and time left, and Pause / Resume and Cancel. The panels wait while it is up. The **down arrow** in its
title bar (or Esc) minimizes it: the job goes on in the strip, as every job did before, and the job's **up arrow**
there brings the dialog back. The dialog closes by itself when the job ends. A job that ends within 300 ms never
shows it, so a quick delete does not flash. A conflict question shows instead of it while it is asked; put aside
(Esc), the dialog says "Needs your decision". **Queue** in the copy dialog starts the job in the strip at once, and
jobs started elsewhere (the viewer, sync, multi-rename, checksums) stay in the strip. Settings → Operations → "Show
the progress of file operations in a dialog" turns the dialog off.

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
- **Rename in place (Shift+F6, F2):** inline editor on the row; the name is selected without the extension. A
  click on the name of the row that has the cursor, in the active panel, opens it too (as in Explorer and Finder),
  500 ms after the click when no second click followed: a double-click still opens the entry, and a click that
  moves the cursor only moves it. A drag, a key or the wheel cancels it; not in an archive.
- **Find files (Alt+F7, Stage C06):** General (masks, start folders, depth, text, case, whole words, encoding),
  Advanced (size, date, attributes), Results (streaming list; Feed to panel, Go to file, Stop).
- **Multi-rename (Ctrl+M, Stage C09):** mask fields with placeholder buttons, search and replace, case, counter; a
  live preview table (old name → new name), conflicts highlighted; Start and Undo last.
  As built: for the marks, or the cursor entry. A name mask and an extension mask (`[N]` and `[E]` to begin with);
  placeholder buttons (`[N]`, `[N1-5]`, `[E]`, `[C]`, `[Y]-[M]-[D]`, `[h][m][s]`) write into the mask used last, at the
  caret; Search for / Replace with, with Regular expression and Match case; Case (unchanged, all lowercase, ALL
  UPPERCASE, first letter, first letter of each word); the counter's start, step and digits. The preview lists every
  entry as old name → new name and says in words why one is not renamed: Unchanged (muted), Same name twice, Name is
  taken, Names are exchanged (warning color), Invalid name (danger color, the reason as a tooltip). A line below sums
  up ("3 of 12 names will change · 1 name is not free") and "Show the first one" scrolls to the first problem. A mask
  or an expression that cannot be used says why under its field; the rows stay as they were. Start is available when
  at least one name changes: what is not free is left out and listed when the job ends. The job runs in the queue and
  the result is announced ("Renamed 12 items."). Undo last appears when there is a multi-rename to take back (its
  tooltip says how many names, in which folder); it is also a command of its own without a default key.
- **Change attributes (Stage C09):** from the entry menu (no default key; it can be bound), for the marks or the cursor
  entry. On Windows four boxes (Read-only, Hidden, System, Archive); elsewhere a grid of Owner, Group and Others by
  Read, Write and Execute. Every box has three states: ✓ sets, empty clears, – leaves it as it is (the start). For
  one entry a line says what it has now. Modified and Accessed take a date and time, with Now; an empty date stays as
  it is. "Also everything inside the folders" applies the change below them. Change starts the job.
- **Properties (Alt+Enter, Stage C09):** the rows the viewer's properties show (type, location, size, dimensions,
  content of a folder, dates), with the attributes or permissions and, for a link, where it points; for marks, what
  they are and their total size. Buttons: Change attributes…, Checksums… (the Create checksums dialog for the same
  entries) and Done.
- **Synchronize directories (Stage C08):** left and right roots, compare options, a result table with a direction
  arrow per row (→, ←, =, ≠, ×), filters, and Synchronize.
  As built: opened from the quick action bar or the folder menu (no default key; it can be bound). Options: left to
  right only, compare contents, dates within 2 seconds or exact, ignore a one-hour difference, ignore dates.
  Compare, Stop and Compare again show progress in a status line. Five filter buttons carry the symbol and its count;
  the equal rows are hidden at first. Rows show the name with its folder below the roots, then size and date of each
  side around the symbol; a copy that replaces a newer file is in the warning color, the side a delete removes is
  struck through in the danger color. Arrow keys move, Shift extends, Ctrl+A selects all; → and ← set the direction,
  = leaves a row alone, Delete deletes a one-sided entry, Backspace restores the default (five buttons do the same).
  Synchronize… replaces the table with a confirmation: what is copied each way with sizes, folders created, entries
  deleted per side, newer files replaced, and "Delete permanently instead of moving to the trash". The job then runs
  in the queue and the dialog closes.
- **Compare by content (Stage C08):** from the entry menu. Two marked files, or the cursor file against the file of
  the same name in the other panel (else that panel's cursor file). Text files: two columns with line numbers,
  changed lines in the warning tint, lines on one side only in the danger and success tints, a summary ("3
  differences", "identical", "differ only in line ends or encoding"), Previous / Next difference (P / N). Other
  files: "identical" or "different" with progress while they are read.
- **Create checksums (Stage C08):** from the entry menu, for the marks or the cursor entry: the algorithm (SHA-256,
  SHA-1, MD5, CRC32 as .sfv), one checksum file beside each file or one named list in the panel's folder. **Verify
  checksums** starts at once on the marked checksum files or the one under the cursor; the result is announced, and
  files that did not verify open as a list.

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
  editor. Enter or double-click on an image or video opens the shared media overlay directly over Commander, keeping
  its workspace mounted underneath; closing the image or video reveals the same Commander session.
  Settings → "Open images and videos with" can use
  the system default app instead. Shift+F4 asks for a name (`new.txt`, the name selected without its extension).

### Document window (ADR-0033)

- **PDFs and text files** (by extension or conventional name) open in a window of their own, a child of the shell
  window, on Enter, double-click and F3. Settings → Panels → "Open PDFs and text files with" can keep the system
  default app instead (then F3 shows the lister again). Other files are unchanged.
- **PDF:** a page strip (thumbnails), page jump, fit width / fit page / zoom, rotate, find with marks on the matches,
  night mode, password prompt. **Text:** line numbers, find, wrap, text size, encoding and line ending shown; the first
  16 MiB of a larger file, with a note. Ctrl+F finds, Enter / Shift+Enter or F3 step, Ctrl+± zoom, Esc closes find.
- The window is read-only and has no connection to the app: it can only read the one file it was opened for.

## Git (ADR-0043)

A panel on a folder inside a Git repository says so, and shows what Git knows about each entry. The installed Git
does the work; without it there is no Git UI. Settings → Panels → "Show Git status in the folders of a repository"
turns it all off.

- **Path bar badge:** a pill with the branch icon and the branch (or the commit, when detached), tinted with the
  accent. A dot after it is green with no changes, amber with changes, red with conflicts. Its tooltip names the
  repository, the branch and the number of changes. A click opens the branch menu.
- **Rows** (all three views): a changed entry's name takes its state's colour, and a letter follows it at the end
  of the name cell.
  - The colours: `warning` for modified, `success` for added, renamed and untracked, `danger` for deleted and
    conflicted. Ignored entries are dimmed and get no letter.
  - The letters: M, A, D, R, U, ! (conflicted). A fully staged change sits on a soft tint of its colour.
  - A folder with changes inside shows a small glowing dot instead of a letter.
  - A marked row keeps the accent of its mark; the letter stays.
  - Search results and the branch view show no marks; their rows are not one folder's children.
- **Git bar** (above the status line, 28 px):
  - The branch and a chevron open the branch menu.
  - The sync button: ↓ behind and ↑ ahead. A click pulls, pushes, or fetches when there is nothing either way. A
    branch without an upstream shows "Publish branch" instead.
  - "Merging", "Rebasing" and the like appear as a red chip while Git is in the middle of one.
  - The change counts: ! conflicts, ● changed, ✓ staged, + untracked. A click opens the commit dialog.
  - Commit (the accent button) and More (⋯): Stage, Unstage, Discard changes…, Pull, Pull with rebase, Pull with
    merge, Push, Fetch, Switch branch…, New branch…, History…, Refresh Git status, Copy branch name and Go to the
    top folder.
  - Narrow panels hide the labels and keep the icons (a container query).
- **Runs** (pull, push, fetch, commit, switch…) run in the background, one per repository at a time.
  - While one runs, the bar shows its verb ("Pulling…"), Git's phase and percent, a thin accent line filling along
    its bottom edge (sliding when Git gives no percent), and Stop.
  - A success says so once in the status bar ("Pushed main", "Committed: [main 1a2b3c4] Fix").
  - A failure stays in the bar, in red, until dismissed. It says what it means: diverged branches get "Pull with
    rebase" and "Pull with merge" buttons, a rejected push gets "Pull". Sign-in problems, local changes in the way,
    a missing remote or upstream, and a folder Git doesn't trust are explained in words.
- **Branch menu:** a search field, then the local branches (the current one ticked) and the remote ones, each with
  its last commit's age, then "New branch…". Choosing a remote branch makes a local branch that tracks it, or
  switches to the local one of that name.
- **Commit dialog** (Ctrl+Shift+G):
  - "Commit to main", then the changes in two lists, Staged and Changes, with counts and "Stage all" / "Unstage
    all". A tick stages or unstages one at once; it shows the new state before Git answers.
  - Then the message (the first line is the summary; past 72 characters a quiet warning) and "Amend the last
    commit".
  - The footer says what Commit will do ("Staged changes to commit: 2", or "Nothing is staged: all 5 changes will
    be staged and committed.") next to Cancel, Commit and push, and Commit. Ctrl+Enter commits; Ctrl+Shift+Enter
    also pushes.
  - A failed commit (a hook) shows Git's words in the dialog, and the message is kept.
- **Discard changes…** asks first. Tracked files go back to their last commit; untracked files are never deleted,
  and the result says how many were kept.
- **History…:** the last 50 commits on a line of dots, each with its subject, branches and tags, author and age; a
  click copies the hash.
- **Freshness:** the status is read again when the folder or its entries change, when the commander comes back on
  screen, when the window gets the focus (a commit made in a terminal), after each run, and on Ctrl+R. Nothing polls.

## Default keyboard map

Total Commander-compatible defaults in the shared keymap (ADR-0022, scopes `panels`, `lister`, `dialogs`). Every
entry is remappable.

| Keys | Command | Stage |
|---|---|---|
| Tab | Switch active panel | C00 |
| ↑ ↓ PgUp PgDn Home End | Move the cursor | C01 |
| Enter | Open folder / archive; open media in Viewer or other files with their default app | C01, C05, C07 |
| Backspace, Ctrl+PgUp | Parent folder | C01 |
| Ctrl+\ | Root of the drive | C02 |
| Ctrl+F3 / F4 / F5 / F6 | Sort by name / extension / date / size | C01 |
| Ctrl+F1 / Ctrl+F2 / Ctrl+Shift+F1 | Brief / Full / Thumbnails view | C03 / C01 / C10 |
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
| Alt+F7 / Ctrl+F or Ctrl+S / Ctrl+B | Find files / quick filter / branch view | C06 |
| Alt+F5 / Alt+F9 / Alt+Shift+F9 | Pack / unpack / test archives | C07 |
| Ctrl+PgDn | Open the archive under the cursor (Enter does too; Backspace at its root leaves it) | C07 |
| Shift+F2 | Compare directories | C08 |
| Ctrl+M | Multi-rename (Undo the last multi-rename and Change attributes have no default key) | C09 |
| Alt+Shift+Enter / Alt+Enter | Size of all folders / properties | C09 |
| Ctrl+K, Alt+F8 | Focus the command line, command history | C10 |
| Ctrl+Enter / Ctrl+Shift+Enter | Add the cursor entry's name / full path to the command line | C10 |
| Enter / Shift+Enter (in the command line) | Run the line / run it in a console window (fixed keys) | C10 |
| Ctrl+Shift+T | Reopen the closed tab | C10.5 |
| Ctrl+Shift+F8 / Shift+Tab | Folder tree: off / one / one per panel; go to the tree | C10.5 |
| Ctrl+Shift+N / Ctrl+N / Ctrl+Shift+F | Connections / quick connect / disconnect | C10.5 |
| Ctrl+Shift+G / Ctrl+Shift+B | Git: commit / switch branch (Stage, Unstage, Discard, Pull, Push, Fetch and History have no default key) | ADR-0043 |
| F1, Ctrl+/ | Keyboard shortcuts (shared dialog) | C02 |
| Ctrl+Shift+M | Switch to the viewer (shared `shell` scope) | C00 |
| Alt+F4 | Exit | C00 |

Quick search uses plain letters, so letter keys never trigger other commands in a panel. Total Commander's
Ctrl+Alt+letters works as an alias, and a setting sends letters to the command line instead (classic Total
Commander): Settings → Panels → Typed letters → "Go to the command line"; quick search then starts with Alt.

## Mouse

- Click moves the cursor; Ctrl+click toggles a mark; Shift+click marks a range (the viewer's additive Shift rules,
  Stage 08.6).
- Right-click moves the cursor and toggles the mark; dragging with the right button marks the rows passed over (or
  unmarks them, when the first row was marked). Holding the right button still for half a second opens the context
  menu instead, and leaves the marks alone; a small ring beside the pointer fills while the button is held. Settings → "Right mouse button" switches to "Opens the menu" (a
  right-click opens it at once).
- The context menu lists the panel's commands with their shortcuts (open, view, edit, copy, move, rename,
  multi-rename, delete, the clipboard, copy paths and names, pack, unpack, compare and checksums, new folder, refresh,
  change attributes, properties). Like the keys, it acts on the marked entries,
  or on the cursor entry when nothing is marked; its heading says which. On ".." and the empty area it lists the
  folder's commands (paste, new folder, new text file, refresh, mark all, invert). The Menu key and Shift+F10 open it
  for the cursor entry.
- Double-click opens.
- Drag from one panel to the other copies (Shift moves); dropping on a tab or a drive button targets that folder.
  The same drag carries the files to other apps (ADR-0040); entries of an archive or a connection drag only inside
  the app.

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
