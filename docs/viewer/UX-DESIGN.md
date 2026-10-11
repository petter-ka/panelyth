# Viewer UX Design

The Panelyth viewer's workspace, tile view, focused viewer, preview pane, selection and menus. The visual system
shared with the commander is in `docs/shared/DESIGN-SYSTEM.md`.

## Goal

Minimal, polished, desktop-native and power-user friendly.

## Two-column workspace

```text
┌ Folder tree ───────────────┬ Content ───────────────────────────────┐
│ Drives                     │ Navigation toolbar                    │
│ Quick access               │ Breadcrumb                            │
│ Bookmarks                  │ Search / Sort / Filter                │
│ Recent                     │ Tile size                             │
│ Lazy folder tree           │ Tiles, left to right                  │
├────────────────────────────┤                                       │
│ Preview controls           │                                       │
│ image / video, zoom        │                                       │
│ playback and metadata      │                                       │
└────────────────────────────┴───────────────────────────────────────┘
```

The app switcher rail sits at the far left; the workspace begins beside it. The workspace's left column sits beside the
content pane. Its folder tree is above the preview. Drag the vertical divider to resize
the columns and the horizontal divider in the left column to resize the tree and preview. Both sizes persist with the
workspace. An icon button on the tree/preview divider collapses or restores the preview.

## App switcher rail

The left rail shows Viewer above Commander, with Viewer highlighted here. Selecting Commander switches to it in the
same window. The commander's active panel opens the viewer's folder with the cursor on the selected tile, and the
selection becomes its marks. Coming back, the viewer opens the commander's folder and selects the cursor entry if it
is a folder, image or video. Bookmarks, recent locations, theme, interface size and the file clipboard are shared.
Rules and options: `docs/shared/APP-SWITCHING.md`.

## Sidebar

- drives/volumes
- home
- Pictures/Videos/Desktop/Downloads where available
- bookmarks
- recent
- lazy folder tree

The folder tree keeps a sticky breadcrumb inside its scrolling area for the open folder. It remains at the top while
the tree scrolls up or down, keeps the filesystem root and last three ancestors visible, and puts intermediate folders
in the ellipsis menu. Selecting an ancestor opens that folder.

Never eagerly recurse through the full filesystem.

## Content toolbar

Two rows (Stage 05):

- **Navigation:** app switch (to the commander; shown in packaged builds) · sidebar toggle · back ·
  forward · up · refresh · breadcrumb (last four folders, earlier ones behind "…") · search · Open folder… · preview
  toggle.
- **View:** kind chips with counts (Folders / Images / Videos) · File types ▾ · Clear · spacer · Include subfolders ·
  Sort ▾ ("Name ↑ + Date created") · tile size S / M / L.

Keyboard: Alt+← / Alt+→ back and forward, Alt+↑ or Backspace up, F5 or Ctrl+R refresh, Ctrl+F search, Alt+Enter
properties.

## Search

Default scope is current folder.

Recommended behavior:

- Ctrl+F / Cmd+F
- debounce
- clear button
- recursive toggle
- result count when known
- indexed paging

## Sorting

Menu supports:

- Name (always natural: "IMG_2" before "IMG_10")
- Type
- Size
- Created
- Modified
- Accessed where available
- Dimensions
- Duration
- Favorite
- Rating
- Tags

Support ascending/descending and secondary sort. Folders always come first. Order options say what they mean for
the field: "A to Z", "Oldest first", "Largest first". Stage 05 ships Name, Date modified, Date created, Size, Type and
Dimensions; accessed time, duration, favorite, rating and tags arrive with their data (Stages 06–07).

## Tile view

The content area is always a tile view. There are **no list or table views** (product decision 2026-09-30,
BRS FR-11, ADR-0004).

```text
narrow window                     wide window
┌────┐ ┌────┐ ┌────┐              ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐
│    │ │    │ │    │   spare →    │    │ │    │ │    │ │    │ │    │ │    │
└────┘ └────┘ └────┘              └────┘ └────┘ └────┘ └────┘ └────┘ └────┘
name   name   name                name   name   name   name   name   name
┌────┐ ┌────┐ ┌────┐              ┌────┐ ┌────┐ …
```

- **Flow:** tiles sit next to each other left to right and wrap to the next line, in sort order. Folders come
  first.
- **Responsive, fixed size:** a tile keeps its size; a wider window or higher resolution fits **more tiles per
  row**. Tiles never stretch, rows are left-aligned, and spare width stays at the right edge.
- **Sizes** (CSS px):

  | Size | Tile / thumbnail box | Gap | Name line |
  |---|---|---|---|
  | Small | 120 × 120 | 8 | 12 px text |
  | Medium (default) | 180 × 180 | 12 | 13 px text |
  | Large | 260 × 260 | 16 | 13 px text |

  Tiles per row = `max(1, floor((width − 32 + gap) / (tile + gap)))`. With medium tiles: 1000 px → 5,
  1600 px → 8, 2400 px → 12. The content area has 16 px padding on each side.
- **Tile anatomy:** every tile keeps a fixed square slot. Image and video previews preserve their aspect ratio
  (`contain`, never cropped) and leave unused space transparent; folder covers fill the square. Folder and unsupported
  tiles use a symbol in the same slot. Loading tiles show the `skeleton` color, with no shimmer animation. The name is
  one ellipsized line, with the full name, size and date in the tooltip.
- **Focus and selection:** a selected tile's fitted image or video preview gets a 4 px `accent` (amber) border with
  an `accent` glow and a drop shadow, so it reads at a glance on any picture; glyph fallbacks and folder covers use
  the square slot. The name uses `text` on a subtle selected background (not when file names are hidden). Keyboard
  focus alone is a thin dashed ring, so focus and selection stay distinguishable.
- **Keyboard:** ←/→ move one tile, ↑/↓ one row, Home/End, Page Up/Down, Enter opens, Space selects.
- **Tile size control:** a three-state segmented control (S / M / L) at the end of the content toolbar, with
  tooltips. Ctrl/Cmd + scroll wheel steps through sizes.

Use tooltips so icon-only controls remain discoverable.

## Focused viewer (Stage 04)

Opened with Enter or double-click on an image tile; a full-window overlay on the neutral canvas.

- Toolbar (chrome): **← Folder** · name · position (`7 / 120`) · Previous · Next · **Fit** · **1:1** · − · zoom % · + ·
  rotate left · rotate right · flip. The active zoom mode and an active flip are shown with the amber accent.
- Rotate (R / Shift+R) and flip (H) change the view only, never the file, and reset on the next image (Stage 08).
- Keyboard: ←/→ and Page Up/Down step, Home/End first/last image, + / − zoom, 0 fit, 1 actual size, Esc or Backspace back to
  the folder (the last image shown is selected and scrolled into view).
- Mouse: wheel zooms around the cursor by default; it can instead step through images, with Ctrl + wheel retaining zoom.
  Drag pans when the image is larger than the window; double-click on the focused image closes the viewer.
- 100 % is one image pixel per screen pixel. Fit never enlarges small images. Above 200 % pixels render crisp
  (`image-rendering: pixelated`) for inspection.
- Loading is progressive and never blank: tile thumbnail → sharp preview → original (only when zoomed past the preview).
- Errors say what happened ("The file was moved or deleted", "damaged or in a format Panelyth can't read") and offer
  **Try again**; navigation keeps working.

## Settings (Stage 08.5)

The status bar opens a tabbed settings dialog with Viewer, Appearance and Shortcuts sections. Viewer preferences use
switch controls for on/off choices and segmented controls for startup folder and mouse-wheel behavior. The startup
folder can be the last used folder, a chosen folder, or the platform Home place. Escape closes the focused image viewer
or leaves video fullscreen; outside those contexts it asks to close the app when confirmation is enabled. Appearance
offers a theme choice and S / M / L font and spacing sizes; the size scales text, padding and margins across the UI while
keeping thumbnail dimensions fixed. The selected size is stored locally and applied before the first render.

The overwrite preference applies to the explicit “Paste and overwrite conflicts” action; regular paste and Copy to / Move
to keep both files on name conflicts. The save reminder preference is stored for a future image-edit flow; current image
transforms change display only.

## Preview pane

Images:

- fit
- 1:1
- zoom -
- zoom +
- reset
- pan when zoomed

Videos:

- play/pause
- seek
- duration
- volume
- mute
- fullscreen-ready

Stage 06: the pane follows the selection once it settles (150 ms), so walking the tiles with a held arrow key doesn't load
every item it passes. A multi-selection shows "N items selected", and a folder shows its name. The header holds the name
and, for images, **Fit** · **1:1** · − · % · + (keys + − 0 1 while the pane has focus). For images, wheel zoom, drag to
pan and double-click to toggle fit work as in the focused viewer. A line under the preview shows dimensions · duration · size · type.

Videos show the cached poster, with a centered play button until the first play. The control bar is Play/Pause ·
`0:12 / 1:05` · seek slider · mute · volume (hidden when the pane is narrower than 320 px) · full screen. Keys when the
  player has focus: Space/K play/pause, ←/→ ±5 s, ↑/↓ volume, M mute, F full screen, Home/End, and Esc leaves full screen.
Double-clicking the video area enters or leaves fullscreen. In the preview pane, image double-click still toggles fit.
Enter on a video tile plays it in the pane (opening the pane if it was collapsed). Double-click on a video tile plays it
in a full-window app overlay; Esc returns to the pane and playback continues. The overlay does not depend on native
fullscreen support. Images keep opening the focused viewer. Volume and mute carry over to the next video for the session. Video tiles show the poster with a small
play badge.

Failures say what happened: "This video can't be played here" names the codec ("H.265 (HEVC) video isn't supported
by the built-in player.") and offers **Open with default app**; a moved file offers **Try again**; a damaged file says
so. The focused viewer suspends the pane (a playing video stops).

## Selection

Support:

- click
- Ctrl/Cmd click
- Shift click
- arrows
- Shift+arrows
- Ctrl/Cmd+A

Stage 05: selected tiles have the amber outline. The status bar shows "N selected, size". Clicking empty space or
pressing Esc clears the selection. Right-clicking an unselected tile selects it first; right-clicking a selected tile
keeps the selection.

Stage 08.6: Shift+click and Shift+arrows select from the anchor (the last clicked tile) to the target **on top of** what
was selected when the anchor was set. Earlier Ctrl/Cmd+click picks stay selected, and moving the Shift end only changes
that range. After a plain click, nothing else is selected, so Shift behaves as usual. Ctrl/Cmd+Shift adds the range to
everything currently selected, including earlier Shift ranges. Pressing on a tile inside a
multi-selection keeps the selection so it can be dragged; releasing without a drag selects only that tile.

## Context menus

Separate menus for:

- file
- folder
- multi-selection
- empty area

Use shadcn/ui primitives.

Stage 05 lists only actions that work now. Tile: Open, Open with default app, Show in file manager, Copy path(s),
Select all, Properties. Empty area: Sort by ▸, Tile size ▸, Refresh, Select all, Folder properties. Sidebar: Open,
Show in file manager, Copy path, Add/Remove bookmark, Refresh.

Stage 08.6 adds: **Play** and **Play full screen** for a video; **Copy picture** for one image (also Ctrl/Cmd+C, see
below); **Copy name**. The viewer gets a right-click menu (Copy picture, Copy path, Open with default app, Show in file
manager, Rotate, Flip, Back to folder) and a Copy picture button.

**Copying.** Ctrl/Cmd+C on one selected image, or in the viewer, puts the picture itself on the OS clipboard, upright
(EXIF orientation applied), so it pastes into editors, documents and chats. The selection also goes to Panelyth's file
clipboard, so Ctrl/Cmd+V in another folder still copies the file. With several items selected, Ctrl/Cmd+C copies files
only. A short message near the bottom confirms the copy, or says why it failed; "Copying picture…" shows only when it
takes more than 200 ms.

Potential actions:

Open, Open With, Copy, Cut, Paste, Rename, Delete, Move, Copy To, Properties, Favorite, Tag, Rating.

## Batch bar

When multiple items are selected:

```text
12 selected   Copy   Move   Delete   Tag   Favorite   More...
```

Progress should be inline/non-modal unless user input is needed.

## Visual language, theme and typography

Shared by both apps: `docs/shared/DESIGN-SYSTEM.md` (visual language, themes and tokens, contrast, typography, motion,
keyboard foundation, interface size). The viewer applies it as follows:

- Media sits on `canvas`: the content body (tiles) and the preview body. Navigation and controls sit on `chrome`.
- The accent marks keyboard focus, selected tiles and the single primary action in a view.
- No transitions on the scrolling surface or on tiles.

## Keyboard (Stage 08)

- Every command key comes from the shared keymap (`docs/shared/DESIGN-SYSTEM.md`, "Keyboard foundation"; ADR-0022).
- **F6 / Shift+F6** move focus between the sidebar, the content and the preview (collapsed panes are skipped).

## Color labels (Stage 08)

Seven labels (red, orange, yellow, green, blue, purple, gray) from the tile menu's **Label** submenu. A tile shows a
small dot in its badge (top left, beside favorite and rating), so tile geometry is unchanged. Properties shows the
label by name. Label colors are tokens tuned per theme for non-text contrast; they are never used for chrome.

## Future-ready UX

Prepare for:

- tags
- ratings
- favorites
- color labels
- collections
- effects
- crop/resize/rotate (the editor: `docs/viewer/IMAGE-EDITOR.md` §5, Stages 12–16)
- duplicate detection
- compare/slideshow
- custom shortcuts
