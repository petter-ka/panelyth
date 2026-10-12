# Commander Feature Matrix

Total Commander features and where they land. "Platform" means shared work in a P-stage.

| Capability | Total Commander default | Stage | First release |
|---|---|---|---|
| Two panels, Tab to switch, swap panels | Tab, Ctrl+U | C00–C02 | ✓ |
| Switch to the viewer with shared folder, cursor and marks | — (Panelyth) Ctrl+Shift+M | C00–C02 | ✓ |
| Full (detailed) view with columns — TanStack Table + virtual rows | Ctrl+F2 | C01 | ✓ |
| Brief view (names in columns) | Ctrl+F1 | C03 | ✓ |
| Thumbnails view | Ctrl+Shift+F1 | C10 | ✓ |
| All entries incl. hidden/system, links | Ctrl+H toggles hidden (GNOME convention) | P02, C01 | ✓ |
| Sort by name / ext / date / size | Ctrl+F3 / F4 / F5 / F6 | C01 | ✓ |
| Cursor vs marks; Insert, Space, Shift+arrows | Insert, Space | C02 | ✓ |
| Mark by mask, unmark, invert, same extension | Num+, Num−, Num*, Alt+Num+ | C02 | ✓ |
| Quick search (type-ahead) | letters (TC: Ctrl+Alt+letters) | C02 | ✓ |
| Quick filter | Ctrl+S | C06 | ✓ |
| Back / forward / history list | Alt+Left / Alt+Right / Alt+Down | C02, C03 | ✓ |
| Folder tabs | Ctrl+T, Ctrl+W, Ctrl+Tab | C03 | ✓ |
| Tab bar with "+", rename, duplicate, reopen closed tab | — (Panelyth: Ctrl+Shift+T reopens) | C10.5 | ✓ |
| Saved tab sets (TC: save and load tabs to a file) | — | C10.5 | ✓ (named sets in `library.db`, no files) |
| Separate folder tree, one or one per panel | Ctrl+Shift+F8 | C10.5 | ✓ |
| Tree dialog; tree inside a panel | Alt+F10; Ctrl+F8 | — | later |
| Drive bar and drive menu with free space; a drive the other panel is on opens at that panel's folder | Alt+F1, Alt+F2 | C03 | ✓ |
| Directory hotlist (shared with the viewer's bookmarks) | Ctrl+D | C03 | ✓ |
| Copy / move to the other panel | F5 / F6 | P03, C04 | ✓ |
| Copy in place, rename in place | Shift+F5, Shift+F6 | C04 | ✓ |
| New folder (nested) | F7 | C04 | ✓ |
| Delete to trash / permanently | F8 / Shift+F8 | C04 | ✓ |
| Background queue, pause, conflicts dialog | — | P03, C04 | ✓ |
| Drag and drop between panels | — | C04 | ✓ |
| Folder size of the cursor / of all folders | Space / Alt+Shift+Enter | C02, C09 | ✓ |
| Quick view panel | Ctrl+Q | C05 | ✓ |
| Lister: text, hex, images, video | F3 | C05 | ✓ |
| External editor, new text file | F4, Shift+F4 | C05 | ✓ |
| Open media in the shared viewer overlay or system default | Enter / double-click; Commander setting | C05 | ✓ (overlay over Commander; close reveals the same session) |
| Open other files with default app; run programs | Enter | C05 | ✓ (program confirmation by default) |
| Find files (name, content, size, date, attributes) | Alt+F7 | C06 | ✓ |
| Feed results to panel | — | C06 | ✓ |
| Branch view (flat subtree) | Ctrl+B | C06 | ✓ |
| Browse zip / tar(.gz) as folders | Enter | C07 | ✓ |
| Pack / unpack / test archives | Alt+F5 / Alt+F9 / Alt+Shift+F9 | C07 | ✓ |
| 7z / rar | — | C07 | with external 7-Zip |
| Compare directories | Shift+F2 | C08 | ✓ |
| Synchronize directories | — | C08 | ✓ |
| Compare files by content (text diff) | — | C08 | ✓ |
| Compare several marked files; one marked file per panel; changes inside a line | — | C10.5 | ✓ |
| Checksums create / verify | — | C08 | ✓ |
| Multi-rename tool, undo last | Ctrl+M | C09 | ✓ |
| Change attributes and timestamps | — | C09 | ✓ |
| Properties | Alt+Enter | C09 | ✓ |
| Command line with history | Alt+F8 | C10 | ✓ |
| Function-key bar | — | C00 | ✓ |
| Toolbar, user commands, external tools | — | C10 | ✓ |
| Custom shortcuts | — | C02 (shared keymap) | ✓ |
| FTP / FTPS: connect, browse, transfer, saved connections | Ctrl+F, Ctrl+N, Ctrl+Shift+F | C10.5 | ✓ (ADR-0037; no server-to-server copy, no editing in place, no find or sync on a server) |
| SFTP / WebDAV / cloud | — | — | later |
| Plugin compatibility (WCX/WFX/WLX) | — | — | out of scope |
| Edit archives in place | — | — | later |
| OS file clipboard interop | Ctrl+C / Ctrl+V with Explorer | — | later, when portable |
