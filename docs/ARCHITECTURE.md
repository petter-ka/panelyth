# Architecture

## System overview

```text
┌─────────────────────────────────────────────────────────────┐
│ Electron                                                     │
│                                                             │
│  Main Process                                               │
│   ├── Window lifecycle                                      │
│   ├── Native dialogs                                        │
│   ├── Secure IPC                                             │
│   ├── Custom preview protocol                               │
│   └── Go sidecar lifecycle                                  │
│                                                             │
│  Preload                                                    │
│   └── typed, minimal API                                     │
│                                                             │
│  React Renderer                                              │
│   ├── resizable 3-panel workspace                            │
│   ├── filesystem sidebar + lazy tree                         │
│   ├── virtualized grid/list                                  │
│   ├── search/sort/filter controls                            │
│   ├── image/video preview pane                               │
│   ├── selection/navigation                                   │
│   ├── batch action UI                                        │
│   └── UI state                                               │
└──────────────────────────────┬──────────────────────────────┘
                               │ async RPC / IPC
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Go sidecar                                                  │
│                                                             │
│  Scanner ──► Index store (SQLite)                           │
│      │                 │                                    │
│      ▼                 ▼                                    │
│  Metadata ─────────► Query API                              │
│      │                                                      │
│      ▼                                                      │
│  Thumbnail scheduler ──► Decoder ──► Disk cache             │
│                              │                              │
│                              └────────► preview/full image  │
└─────────────────────────────────────────────────────────────┘
```

## Responsibility boundaries

### React

Owns:

- visual state
- current folder view state
- three-panel layout state
- selection and multi-selection
- view mode
- sort/filter/search state
- grid dimensions
- keyboard interactions
- zoom/playback UI state
- theme
- context menus
- batch-operation UI/progress
- virtualizer state

React does not own:

- directory recursion
- full file index
- image decoding
- disk cache
- OS path discovery

### Electron main

Owns:

- lifecycle
- BrowserWindow
- native dialogs
- window state
- preload registration
- secure protocol handling
- start/stop of the Go sidecar

Electron main does not own:

- image scanning
- recursive directory work
- image conversion
- SQLite business logic

### Go sidecar

Owns:

- directory scanning
- file identity
- image capability detection
- metadata extraction
- persistent index
- thumbnail scheduling
- image decode/resize
- persistent preview cache
- cache cleanup
- file watching

## Workspace layout

The UI uses three primary panes:

1. `SidebarPane`
   - drives/volumes
   - bookmarks
   - recent locations
   - lazy folder tree

2. `ContentPane`
   - toolbar
   - breadcrumb/navigation
   - search
   - sort/filter/view mode
   - virtualized file/folder content

3. `PreviewPane`
   - image viewer or video element
   - zoom/fit controls
   - item metadata
   - batch-independent selection context

Pane resize state is persisted locally and managed entirely in React/UI state.

## Domain services

Keep domain-level hooks/services separate from visual components:

```text
navigation/
search/
sorting/
selection/
preview/
batch/
layout/
filesystem/
```

Visual components should consume domain hooks rather than call Electron APIs directly.

## IPC design

Use typed request/response methods.

Examples:

```text
folder.open(path)
folder.cancel(scanId)

files.page({
  folderId,
  offset,
  limit,
  sort: [{ field, direction }],
  search,
  filters,
  recursive
})

files.count(folderId)

thumbnails.ensure({
  items: [{ fileId, profile }]
})

viewer.preview(fileId, profile)
viewer.metadata(fileId)
```

Prefer batch operations.

Avoid:

```text
getFile(1)
getFile(2)
getFile(3)
...
```

Use:

```text
getFiles({ offset, limit })
```

## Sidecar transport

MVP transport:

- Go launched as a child process by Electron
- control plane over stdin/stdout using a framed request/response protocol
- Electron main handles process lifecycle and protocol exposure
- renderer never knows or controls the child process directly

The transport can later be replaced without changing the React domain API.

## Preview URL strategy

Never transport thumbnail bytes through React state.

The grid receives a cache identifier / preview URL.

Electron exposes a controlled preview protocol:

```text
fastview-thumb://<cache-key>
```

The protocol handler resolves only known cache entries.

The renderer uses normal `<img>` elements so Chromium performs image loading and decoding.

## Database

SQLite is the source of truth for the local index.

Conceptual tables:

### files

- id
- folder_id
- relative_path
- normalized_path
- filename
- extension
- size_bytes
- mtime_ns
- width
- height
- media_kind
- scan_generation
- created_at

### folders

- id
- absolute_path
- normalized_path
- generation
- last_scan_started_at
- last_scan_completed_at

### preview_cache

- cache_key
- file_id
- profile_id
- source_size
- source_mtime_ns
- width
- height
- byte_size
- disk_path
- last_accessed_at
- created_at

## Folder scanning

Scanning is incremental:

1. open folder
2. create scan generation
3. enumerate directory entries
4. cheaply identify image candidates
5. write batches to SQLite
6. send batched update notifications
7. generate previews only on demand/prefetch
8. finish scan generation

The browser may continue querying while a scan is active.

## Change detection

Use:

- file size
- modification timestamp
- normalized absolute path

Optional later enhancement:

- fast content hash for difficult file systems or unreliable timestamps

The preview cache key must include source identity + preview profile.

## Error model

Backend errors are categorized:

- invalid path
- permission denied
- unsupported image
- corrupt image
- cache error
- database error
- cancelled
- internal error

UI should be able to show per-item failures without failing the entire folder.

## Concurrency

Each subsystem has an explicit limit:

- scan workers
- metadata workers
- thumbnail workers
- cache cleanup workers

Use backpressure.

Do not allow the number of pending decode jobs to grow without a ceiling.


## View model

Represent content items using compact metadata records:

```ts
type ContentItem = {
  id: string
  kind: "file" | "folder"
  name: string
  extension?: string
  sizeBytes?: number
  modifiedAt?: number
  width?: number
  height?: number
  durationMs?: number
  mediaKind?: "image" | "video" | "other"
  isFavorite?: boolean
  rating?: number
}
```

The renderer should receive only fields required by the active view.

Detailed metadata is loaded on demand for the preview/properties surface.

## Batch operation architecture

```text
React action
   │
   ▼
batch API
   │
   ▼
Go job manager
   ├── worker queue
   ├── progress events
   └── cancellation
```

Progress events are batched.

The user should be able to continue browsing while a batch operation is in progress, subject to file-system consistency rules.

## File watching

Directory watchers update the Go index.

The renderer receives coalesced change sets:

```text
created[]
updated[]
removed[]
moved[]
```

Never emit one UI event per filesystem event when thousands arrive together.
