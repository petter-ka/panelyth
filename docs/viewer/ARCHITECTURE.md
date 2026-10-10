# Viewer Architecture

The Panelyth viewer is one app of the product (ADR-0025). It runs on the shared platform described in
`docs/shared/ARCHITECTURE.md`: an app view in the Panelyth shell with the viewer capability profile (ADR-0027,
ADR-0031), the sidecar it shares with the commander (queried with the `media` scope, ADR-0026), and a React renderer.
This document covers what is specific to the viewer.

## Renderer composition

```text
React renderer (src/viewer/renderer)
 ├── resizable two-column workspace with stacked preview (ADR-0023)
 ├── filesystem sidebar + lazy folder tree
 ├── virtualized tile view (left-to-right, responsive; ADR-0004)
 ├── search/sort/filter controls
 ├── image/video preview pane
 ├── focused image viewer (overlay)
 ├── selection/navigation
 ├── batch action UI (jobs panel, dialogs)
 └── UI state (Zustand stores per feature, ADR-0011)
```

## Workspace layout

The workspace uses two columns and three content areas:

1. Left column, with `SidebarPane` above `PreviewPane`
   - drives/volumes
   - bookmarks
   - recent locations
   - lazy folder tree
   - selected image/video preview, zoom/fit controls and metadata

2. `ContentPane` on the right
   - toolbar
   - breadcrumb/navigation
   - search
   - sort/filter/tile size
   - virtualized tile view of folders and media (no list/table views, ADR-0004)

The outer divider sizes the left column and content. A nested divider sizes the folder tree and preview. Both layouts are
persisted with the workspace and managed entirely in React/UI state.

## Tile view

- Fixed-size tiles flow left to right; tiles per row come from the content width (ADR-0004,
  `docs/viewer/stages/03-tile-view.md`). Virtualization is by row with a constant row height per tile size.
- Page data comes from the page store (`useSyncExternalStore`), filled by `query.page` over a query session
  (ADR-0017). Thumbnails are requested once per settled range with `preview.ensure` and arrive as `preview.ready`
  events with `panelyth-thumb:` URLs.
- Folder tiles show up to four covers found by a shallow, bounded read in Go (`folder.covers`, ADR-0024).
- Budgets and rendering strategy: `docs/viewer/PERFORMANCE.md`.

## Preview pane and focused viewer

- The pane follows the settled selection (150 ms), embeds the shared `ImageViewer` for images and the `VideoPlayer`
  for videos (Stage 06). The focused viewer is a full-window overlay that reuses `ImageViewer` (Stage 04).
- Images load progressively: tile thumbnail → `viewer-fit` preview → original through a `panelyth-media:` token URL
  when zoomed past the preview (ADR-0009). Videos always play from a token URL with HTTP Range.
- Both components move to a shared package when the commander's quick view needs them (Stage C05).

## Selection, clipboard and jobs

- Selection is an ADR-0017 descriptor: ranges plus explicit includes and excludes. Shift ranges are added on top of
  the selection that existed when the anchor was set (Stage 08.6).
- Ctrl+C fills the internal file clipboard (ADR-0021) and, for one image, puts the picture on the OS clipboard:
  Go decodes it into a temp PNG, and main hands that to Electron's clipboard (Stage 08.6). No pixels cross IPC.
- Copy, move, trash, delete, rename and metadata changes are jobs (ADR-0021).

## Switching to the commander

- The left app switcher rail and Ctrl/Cmd+Shift+M show the commander in the same window
  (ADR-0031, `docs/shared/APP-SWITCHING.md`).
- On switch, the viewer publishes its context: the open folder (or, for recursive views and search results, the folder
  of the selected entry), the selected entry and the selection (`context.publish`).
- When shown, it reads the commander's context (`context.get`): it opens that folder if needed, selects the cursor
  entry if it can show it, and takes over the marks it can show (`selection.fromContext`).
- While hidden it does no work: no paging, no thumbnail requests, no watching; when shown it refreshes the open
  folder.

## Viewer-only rules

- Tiles only: no list or table views (ADR-0004).
- The viewer never opens or runs non-media files (ADR-0027 viewer profile).
- Media sits on the `canvas` color, controls on `chrome` (`docs/shared/DESIGN-SYSTEM.md`).
