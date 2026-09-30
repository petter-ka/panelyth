# BRS — FastView Business Requirements Specification

## 1. Product definition

FastView is a native-feeling desktop image and video viewer/browser for Windows, macOS and Linux.

It is optimized for browsing local collections, especially folders containing tens or hundreds of thousands of files.

## 2. Primary user outcome

A user selects a folder and can start browsing immediately without waiting for complete filesystem indexing or eager thumbnail generation.

## 3. Functional requirements

### FR-01 — Folder opening

The user can open a folder through:

- native Open Folder dialog
- drag and drop
- recent folders

Results become visible incrementally.

### FR-02 — Image/video discovery

Supported image and video files are detected and indexed.

The media/decoder layer must be extensible without changing the React data model.

### FR-03 — Virtualized content

The content area is virtualized.

Only visible rows plus bounded overscan are mounted.

This applies to thumbnail, compact-list and detailed-list views where practical.

### FR-04 — Infinite paging

When scrolling approaches the end of the loaded page, the next page is requested.

The UI never needs to mount the full directory.

### FR-05 — Persistent preview cache

Generated image thumbnails and video poster frames are cached on the user's OS cache drive.

The cache survives app restarts and invalidates when source identity changes.

### FR-06 — Three-pane workspace

Default desktop layout:

```text
┌───────────────┬──────────────────────────────────┬──────────────────┐
│ Sidebar       │ Content                          │ Preview          │
│               │                                  │                  │
│ Drives        │ Current folder                   │ Selected image   │
│ Bookmarks     │ grid/list                        │ or video player  │
│ Folder tree   │ search/sort/filter               │ metadata         │
│ Recent        │                                  │                  │
└───────────────┴──────────────────────────────────┴──────────────────┘
```

The three primary panes are independently resizable.

Requirements:

- sidebar width can be changed
- content/preview boundary can be changed
- preview width can be changed
- minimum/maximum widths
- drag separators feel immediate
- pane sizes persist
- layout reset is available
- secondary panes can collapse at narrow window widths

### FR-07 — Sidebar navigation

The left sidebar provides:

- available drives/volumes
- home
- common user folders where available
- bookmarks/favorites
- recent folders
- expandable folder tree
- current-folder highlight

The folder tree must load lazily and must not recursively materialize the whole filesystem.

### FR-08 — Content navigation

The content surface provides:

- back
- forward
- up/parent
- refresh/rescan
- breadcrumb path
- open folder with Enter
- mouse double-click
- keyboard arrow navigation
- Home/End
- Page Up/Page Down
- Escape
- platform-appropriate Backspace / Alt+Left navigation

Mouse and keyboard operations should have consistent semantics.

### FR-09 — Search in selected folder

Search is scoped to the current folder by default.

Features:

- filename query
- type/extension filter
- optional recursive search
- filter chips
- clear
- keyboard focus shortcut
- debounce
- incremental result paging

Search is index-backed through Go/SQLite.

### FR-10 — Sorting

Current-folder content can be sorted by:

- name
- natural filename
- extension/type
- size
- created time where available
- modified time
- accessed time where available
- dimensions
- duration
- favorite
- rating
- tags
- folder/file type

Sorting supports ascending/descending and secondary sort keys.

### FR-11 — View modes

Content pane supports:

- large thumbnails
- medium thumbnails
- small thumbnails
- compact list
- detailed list/table

Thumbnail sizes are profile-driven and map to cache profiles.

### FR-12 — Selection

Support:

- single selection
- Ctrl/Cmd click
- Shift click
- keyboard selection
- Ctrl/Cmd+A

Selection remains stable while paging/index events arrive.

### FR-13 — Image preview

Preview pane supports:

- fit to window
- actual size
- zoom in
- zoom out
- reset zoom
- pan when zoomed
- architecture-ready rotate/flip

### FR-14 — Video playback

Preview pane supports local video playback with:

- poster frame
- play/pause
- seek
- duration
- volume
- mute
- playback position
- fullscreen-ready architecture

Video data must not be copied into React state.

### FR-15 — File properties

Properties include, where available:

- filename
- full path
- type
- size
- created
- modified
- dimensions
- duration
- media metadata

Architecture should allow later EXIF, codec, color profile, checksum and permission details.

### FR-16 — Context menus

Different context menus exist for:

- file
- folder
- multi-selection
- empty content area

Possible actions:

- Open
- Open with default system application
- Copy
- Cut
- Paste
- Rename
- Delete
- Move to
- Copy to
- Properties
- Favorite
- Tag
- Rating

Destructive operations require appropriate confirmation.

### FR-17 — Batch operations

Support multi-item actions:

- copy
- move
- delete
- rename
- favorite
- tag
- rating
- copy/export paths

Operations run asynchronously with progress and per-item errors.

### FR-18 — Favorites/tags/ratings

Data model supports:

- favorite flag
- 0–5 rating
- multiple tags
- future collections/albums

### FR-19 — UX states

Provide useful states for:

- loading
- empty
- error
- permission denied
- unsupported format
- indexing in progress
- preview unavailable
- batch progress

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

Effects must not make scrolling or startup visibly slower.

### FR-21 — Cross-platform packaging

Build/package for:

- Windows
- macOS
- Linux

Platform-specific paths, volume discovery and cache directories are abstracted.

## 4. Non-functional requirements

### NFR-01 — Responsiveness

No filesystem, indexing, decoding, caching or batch operation blocks the renderer event loop.

### NFR-02 — Large folders

Target architecture supports hundreds of thousands of entries.

Do not:

- load all metadata into browser state
- mount all items in DOM
- eagerly generate all previews
- eagerly materialize the whole sidebar tree

### NFR-03 — Memory

Keep the renderer DOM and in-memory image working set bounded.

Disk cache is the durable preview store.

### NFR-04 — IPC

Use asynchronous, typed, batch-oriented IPC.

Do not send normal thumbnail/video bytes through control-plane IPC.

### NFR-05 — Reliability

Interrupted scans/jobs are recoverable.

Corrupt cache entries are removable/regenerable.

### NFR-06 — Privacy

Core browsing/viewing requires no cloud service.

### NFR-07 — Security

Renderer has no arbitrary Node.js access.

Filesystem access uses narrow validated APIs.

### NFR-08 — Accessibility

Primary workflows are fully usable with keyboard:

- navigation
- selection
- opening
- search
- sorting/view modes
- context menus where possible
- preview controls

### NFR-09 — Persistence

Persist:

- pane dimensions/collapse state
- view mode
- sorting
- recent locations
- bookmarks
- theme
- user preferences

### NFR-10 — Batch safety

Large file operations expose progress, cancellation where safe, per-item failures and final status.

### NFR-11 — Cross-platform filesystem behavior

Do not assume Windows drive letters or identical filesystem APIs across platforms.

### NFR-12 — Performance regression protection

Hot-path changes require a benchmark or before/after trace.

## 5. Product performance budgets

Engineering targets:

- visible grid stays fluid during normal scroll
- mounted tiles stay bounded
- search/sort scale through indexed paging
- visible thumbnails have priority
- duplicate thumbnail jobs collapse
- thumbnail concurrency is bounded
- panel resizing does not trigger mass re-rendering
- video playback does not freeze browsing

Exact budgets are validated against representative hardware and recorded in benchmark results.

## 6. Supported media

### Image MVP candidates

- JPEG/JPG
- PNG
- WebP
- GIF
- BMP
- TIFF

### Video MVP candidates

- MP4
- WebM
- other platform-supported local codecs/containers

Future:

- AVIF
- HEIF/HEIC
- RAW
- broader video codec coverage

## 7. UX requirements

### Workspace

Persistent three-pane desktop browser:

- left: filesystem/navigation
- center: content
- right: selected-media preview

### Content

Toolbar should expose:

- navigation
- breadcrumb
- search
- sort
- filter
- view mode

### Preview

Preview controls depend on media type.

### Keyboard-first

Core actions must work without mouse.

### Visual direction

Minimalistic, modern desktop UI using Tailwind + shadcn/ui.

Prefer custom performant components for virtualized content and media surfaces.

## 8. Search and sorting

Search/sort/filter are handled by the Go/SQLite index.

Query model includes:

- offset/limit
- multiple sort keys
- search query
- recursive flag
- media/type filters
- optional metadata filters

## 9. Future capabilities

Architecture should allow:

- favorites
- ratings
- tags
- collections/albums
- color labels
- rotate/flip
- crop/resize
- image effects/adjustments
- duplicate detection
- perceptual search
- richer video information
- custom metadata columns
- compare view
- slideshow
- fullscreen gallery
- multiple windows
- custom shortcuts
- drag-and-drop file operations
- plugin/extension points

## 10. Out of scope for initial release

- cloud photo sync
- user accounts
- online galleries
- AI image tagging
- full video editor
- video transcoding

## 11. Definition of success

FastView is successful when:

- large folders open incrementally
- revisiting a folder benefits from persistent preview caching
- the entire directory is never mounted as DOM
- search and sorting stay index-backed
- the sidebar stays lazy
- keyboard navigation is usable
- three panes resize without UI jank
- images and videos preview/play locally
- zoom/playback does not freeze browsing
- context menus and batch operations work for large selections
- CPU/disk work is observable and controllable
- future tags/ratings/favorites/effects can be added without re-architecting the core
