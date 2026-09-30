# UX / UI Design System

## Goal

Minimal, polished, desktop-native and power-user friendly.

## Three-pane workspace

```text
┌ Sidebar ──────────┬ Content ──────────────────────┬ Preview ─────────┐
│ Drives             │ Navigation toolbar            │ Preview controls │
│ Quick access       │ Breadcrumb                    │                  │
│ Bookmarks          │ Search / Sort / Filter        │ image / video    │
│ Recent             │ View mode                    │ zoom / playback  │
│ Lazy folder tree   │ Virtualized content          │ metadata         │
└────────────────────┴───────────────────────────────┴─────────────────┘
```

All dividers are draggable and layout state persists.

## Sidebar

- drives/volumes
- home
- Pictures/Videos/Desktop/Downloads where available
- bookmarks
- recent
- lazy folder tree

Never eagerly recurse through the full filesystem.

## Content toolbar

Recommended order:

back → forward → up → refresh → breadcrumb → search → sort → filter → view mode.

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

- Name
- Natural name
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

Support ascending/descending and secondary sort.

## View modes

- large thumbnails
- medium thumbnails
- small thumbnails
- compact list
- detailed list

Use tooltips so icon-only controls remain discoverable.

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

## Selection

Support:

- click
- Ctrl/Cmd click
- Shift click
- arrows
- Shift+arrows
- Ctrl/Cmd+A

## Context menus

Separate menus for:

- file
- folder
- multi-selection
- empty area

Use shadcn/ui primitives.

Potential actions:

Open, Open With, Copy, Cut, Paste, Rename, Delete, Move, Copy To, Properties, Favorite, Tag, Rating.

## Batch bar

When multiple items are selected:

```text
12 selected   Copy   Move   Delete   Tag   Favorite   More...
```

Progress should be inline/non-modal unless user input is needed.

## Visual language

Use Tailwind CSS + shadcn/ui.

Prefer:

- compact spacing
- clean typography
- clear selected/focused states
- low-noise surfaces
- consistent icons
- restrained motion

Avoid expensive backdrop blur and per-thumbnail animations on the scrolling surface.

## Future-ready UX

Prepare for:

- tags
- ratings
- favorites
- color labels
- collections
- effects
- crop/resize/rotate
- duplicate detection
- compare/slideshow
- custom shortcuts
