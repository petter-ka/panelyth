# Platform Architecture (shared)

The Panelyth product has two apps on one platform: the **viewer** and **Panelyth Commander** (working title). One
Electron shell hosts both in one window, and one Go sidecar serves both (ADR-0025, ADR-0031). This document describes
the shared platform. App-specific architecture:

- `docs/viewer/ARCHITECTURE.md`: workspace, tile view, preview pane, focused viewer;
- `docs/commander/ARCHITECTURE.md`: dual panels, listing, file operations, lister, archives;
- `docs/shared/APP-SWITCHING.md`: the switch between the apps and the state they share.

## System overview

```text
┌──────────────────────── Panelyth shell: one Electron app ─────────────────────────┐
│ Main process                                                                      │
│  ├── window lifecycle, native dialogs, the app switch                             │
│  ├── secure IPC: one capability profile per app view (ADR-0027)                   │
│  ├── protocols: panelyth-thumb (previews), panelyth-media (token streams)         │
│  └── Go sidecar lifecycle                                                         │
│                                                                                   │
│ One window, one app view (WebContentsView) per app; one visible at a time         │
│  ├── viewer view:    preload/viewer    + viewer renderer (workspace, tiles)       │
│  └── commander view: preload/commander + commander renderer (panels, lists)       │
│      (created on the first switch, then kept alive hidden)                        │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │ async framed RPC over stdio (ADR-0012)
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ Go sidecar (src/shared/sidecar), one for both apps                                │
│                                                                                   │
│  Scanner ──► Index store (SQLite; all entries, scope per query: ADR-0026)         │
│      │                 │                                                          │
│      ▼                 ▼                                                          │
│  Metadata ─────────► Query sessions + selection descriptors + shared context      │
│      │                                                                            │
│      ▼                                                                            │
│  Preview scheduler ──► Decoders / ffmpeg ──► Disk cache                           │
│                                                                                   │
│  Job manager (copy, move, delete, rename, metadata; ADR-0021, ADR-0029)           │
│  Watcher (visible app's folders) · Library (user data, settings) · Volumes        │
└───────────────────────────────────────────────────────────────────────────────────┘
```

## Apps on the platform

| | Viewer | Commander |
|---|---|---|
| Renderer | `src/viewer/renderer` | `src/commander/renderer` (Stage C00) |
| App view | `preload/viewer` in `src/shared/desktop` | `preload/commander` in `src/shared/desktop` |
| Index scope per query | `media`: folders and supported media (ADR-0015) | `all`: every entry, with attributes (ADR-0026) |
| Capabilities | open folders and media only; no commands (ADR-0027) | open any file on a user action; programs after confirmation; command line (ADR-0027) |
| Content surface | tiles only (ADR-0004) | detailed and brief lists, thumbnails later (ADR-0028) |
| Data | shared: `<UserCacheDir>/Panelyth/` and `<UserConfigDir>/Panelyth/`; settings under `shared.*`, the viewer's keys, `commander.*` | (same) |

Shared code:

- `src/shared/desktop`: the shell (main process and one preload per app);
- `src/shared/contracts`: wire types, guards, golden fixtures (ADR-0012);
- `src/shared/ui` (Stage P01): design tokens, Tailwind theme, primitives (menus, dialogs, buttons, icons), notices, the
  app switcher rail;
- `src/shared/renderer-core` (Stage P01): bridge, page store, selection algebra, keymap, theme, settings and sidecar
  stores;
- `src/shared/media-ui` (Stage C05; the tile parts since Stage C10: geometry, thumbnail and cover stores, the
  preview frame `TileThumb`): `ImageViewer`, `VideoPlayer`, their request logic (viewer-fit previews, original
  URLs, video preferences) and zoom/transform math, behind a small port (`configureMedia`) that each app sets up with
  its own bridge; preview lanes are per app (per panel in the commander's Thumbnails view), so no view drops
  another's queued work. Each app keeps the tile itself (selection or cursor and marks, the name line, drag and drop).

## Responsibility boundaries

### React

Owns:

- visual state
- current folder view state
- the app's layout (viewer: workspace panes; commander: panels)
- selection and multi-selection
- view settings (viewer: tile size; commander: view mode and columns)
- sort/filter/search state
- content geometry (viewer: tiles per row; commander: rows and columns)
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
- the app views and the switch between them (ADR-0031)
- each app view's capability profile: which renderer methods and shell actions are allowed (ADR-0027)

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
- file operations (jobs)
- the shared context of the app switch (ADR-0031)

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

The content surface (tile, row or quick view) receives a cache identifier / preview URL.

Electron exposes a controlled preview protocol:

```text
panelyth-thumb://<cache-key>
```

The protocol handler resolves only known cache entries.

The renderer uses normal `<img>` elements so Chromium performs image loading and decoding.

## Database

SQLite is the source of truth for the local index.

> Superseded in detail by ADR-0015 (directory-centric `entries` table), ADR-0016 (`index.db` vs `library.db`)
> and ADR-0017 (query sessions). The implemented schema is `src/shared/sidecar/internal/index/schema.go`.
> The conceptual tables below are kept for history.

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
Go job manager (ADR-0021, ADR-0029)
   ├── queue: lanes per (source, destination) volume, 4 running, 256 queued, start now
   ├── pause / resume, conflict questions (ask → job.conflict → jobs.resolve)
   ├── engine: OS fast paths, pooled buffers, small files in flight on SSD lanes, verify
   ├── progress events (4 Hz, coalesced; speed and ETA)
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
