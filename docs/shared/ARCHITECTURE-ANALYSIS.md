# Architecture Analysis & Stage 00 Preparation

> **Historical document** (Stage 00 preparation, 2026-09-30). It was written for the single viewer app. Paths were
> updated when the docs moved into `docs/` (2026-10-05, ADR-0025); the content was not. Current architecture:
> `docs/shared/ARCHITECTURE.md`; current budgets: `docs/shared/PERFORMANCE.md` and the app performance documents.

Status: **Proposal — pending review.** Nothing here overrides an accepted ADR until it is written up as one.
The decisions this document asks for are listed in §11–§12.

Update after Stage 00: M6, M7, M8 and M15 were accepted as ADR-0011 to ADR-0014.
Update after Stage 01: C1, C2, C3/C4 and C6 were accepted by default as ADR-0015, ADR-0016, ADR-0017 and
ADR-0019, and M1 as ADR-0020. The memory budget in §10.4 was recalibrated against a measured empty-Electron floor.
Update after Stage 06: C5 was accepted as ADR-0018 (ffmpeg/ffprobe subprocesses), and the Stage 06 half of C7 was merged.

Inputs read: `CLAUDE.md`, `docs/viewer/BRS.md`, `docs/README.md`, `docs/*` (ARCHITECTURE, PERFORMANCE, CACHE-DESIGN, UX-DESIGN,
DOMAIN-API, TESTING, FEATURE-MATRIX, PRODUCT-PRINCIPLES), `decisions/ADR-0001…0010`, `docs/ROADMAP.md`,
`docs/DEVELOPMENT-STAGES.md`, `stages/*`, `.claude/agents/*`, `.claude/commands/*`.

Environment observed on 2026-09-30: Windows 11, i9-13900K, 64 GB RAM, Node 22.18, pnpm 10.28, git 2.43.
**Go is not installed**, and the folder is **not a git repository**.

---

## 1. Monorepo structure

```text
panelyth/
├── package.json                 root scripts only (dev, build, lint, typecheck, test, bench)
├── pnpm-workspace.yaml          apps/*, packages/*
├── tsconfig.base.json           strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
├── eslint.config.js             flat config, typescript-eslint, react-hooks
├── .prettierrc                  { "semi": false, "singleQuote": false }
├── .editorconfig  .gitignore  .gitattributes (eol=lf, *.go text)
│
├── apps/
│   ├── desktop/                 Electron main + preload (TypeScript)
│   │   ├── src/main/
│   │   │   ├── index.ts         app lifecycle, single-instance lock
│   │   │   ├── window.ts        BrowserWindow + secure webPreferences, nav/permission guards
│   │   │   ├── appProtocol.ts   app://panelyth  (serves renderer dist in production)
│   │   │   ├── sidecar/
│   │   │   │   ├── SidecarProcess.ts   spawn, supervise, restart w/ backoff, shutdown
│   │   │   │   ├── frames.ts           length-prefixed frame encoder/decoder
│   │   │   │   └── RpcClient.ts        pending map, timeouts, cancel, event fan-out
│   │   │   ├── ipc/
│   │   │   │   ├── router.ts    ipcMain.handle('fv:invoke'), sender validation, allowlist
│   │   │   │   └── validate.ts  param validators for renderer input
│   │   │   ├── protocols/       (stage 02+) thumb.ts, media.ts
│   │   │   ├── log.ts           rotating file log (main + sidecar stderr)
│   │   │   └── paths.ts         dev vs packaged sidecar binary resolution
│   │   ├── src/preload/index.ts contextBridge → window.panelyth (bundled to one file: sandbox)
│   │   └── vite.config.ts       builds main (node/cjs) + preload (single file)
│   │
│   └── renderer/                React + TypeScript + Vite
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── app/             AppShell, providers, error boundary
│           ├── bridge/          typed wrapper over window.panelyth (only file touching it)
│           ├── features/        navigation/ search/ sorting/ selection/ preview/
│           │                    batch/ layout/ filesystem/ system/   (domain hooks + stores)
│           ├── components/
│           │   ├── ui/          shadcn primitives (added per stage as needed)
│           │   └── …            visual components consume feature hooks, never the bridge
│           ├── styles/          tailwind entry, tokens (CSS variables), light/dark
│           └── perf/            performance.mark helpers, dev overlay
│
├── packages/
│   └── contracts/               TS-only, zero runtime deps
│       └── src/
│           ├── rpc.ts           MethodMap: method → { params, result }
│           ├── events.ts        EventMap: channel → payload
│           ├── errors.ts        ErrorCode union + envelope
│           ├── domain.ts        ContentItem, QueryDescriptor, SelectionDescriptor, …
│           └── api.ts           PanelythApi (shape of window.panelyth)
│
├── native/
│   └── panelyth-go/
│       ├── go.mod
│       ├── cmd/panelyth-sidecar/main.go
│       ├── cmd/fixturegen/      deterministic fixture trees (stage 01+)
│       └── internal/
│           ├── rpc/             framing, envelope, dispatcher, cancellation
│           ├── app/             wiring, lifecycle, handler registration
│           ├── logging/         slog JSON → stderr (stdout is reserved for frames)
│           ├── workpool/        bounded pool abstraction
│           ├── platform/        cache/config dirs, OS specifics
│           └── (later) index/ scan/ query/ preview/ cache/ media/ jobs/ watch/ volumes/ library/
│
├── shared/e2e/                   Playwright `_electron` specs + perf specs
├── shared/bench/
│   ├── scripts/                 startup/idle/ipc harness
│   └── results/                 JSON results, committed (env + fixture + numbers)
├── scripts/build-sidecar.mjs    go build → shared/desktop/resources/bin/<os>-<arch>/
├── docs/  decisions/  stages/   (existing)
```

Notes:

- `shared/desktop` and `viewer/renderer` stay separate packages as the Stage 00 document says. That rules out the
  single-package `electron-vite` layout. Both packages build with plain Vite (main/preload in library mode),
  which satisfies the "Vite-based Electron setup" rule.
- `shared/contracts` is the only thing the renderer and desktop share. The renderer never imports from
  `shared/desktop`.
- Go stays a single module with `internal/` packages. The sidecar is a single static binary per OS/arch.

---

## 2. Electron + React + Go architecture

```text
 Renderer (sandboxed, contextIsolation)          Main process                      Go sidecar
 ─────────────────────────────────────          ────────────                      ──────────
 React components                                                                 
   │ feature hooks / stores                                                       
   ▼                                                                               
 bridge ── window.panelyth.* ──► preload ──ipc invoke──► router ──frames/stdin──► rpc dispatcher
                                  (typed,              (validate sender,         ├─ handlers (bounded
                                   no ipcRenderer)      method allowlist,        │   in-flight)
                                                        params, mint tokens)     ├─ index/SQLite
 <img src="panelyth-thumb://…">  ◄──── protocol.handle ◄── derived cache path    ├─ scheduler/workers
 <video src="panelyth-media://…"> ◄─── protocol.handle ◄── token → path (Go)     └─ jobs
 onEvent(ch, cb) ◄── webContents.send('fv:event') ◄── RpcClient ◄──frames/stdout── event coalescer
                                                        sidecar stderr ──► log file
```

Process responsibilities, which tighten the wording in ARCHITECTURE.md:

| Concern | Owner | Notes |
|---|---|---|
| Window, lifecycle, dialogs, menus, shell.openPath | Main | Native context menus are optional; shadcn ones are the default |
| Protocol handlers (`app:`, `panelyth-thumb:`, `panelyth-media:`) | Main | Async streaming of files only. No lookups, decisions or transforms |
| Sidecar spawn/supervise/restart | Main | |
| Request routing + input validation | Main | Main is a thin validating relay, not a business layer |
| Known user folders (Pictures, Videos…) | Main | `app.getPath()`: cheap and already cross-platform |
| Volumes, scanning, index, queries, metadata, previews, cache, jobs, watching | Go | |
| Navigation history, selection, layout, view state, virtualizer | Renderer | |

Security baseline (Stage 00):

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`
- The production renderer loads from the privileged custom scheme `app://panelyth/`, not `file://`, with a path-traversal guard
- Strict CSP: `default-src 'self'; img-src 'self' panelyth-thumb: data:; media-src panelyth-media:`
- `will-navigate` is blocked, `setWindowOpenHandler` denies, and a permission request handler denies all
- `ipcMain.handle` checks `event.senderFrame` origin against the app origin
- The preload is a single bundled file because sandboxed preloads cannot `require` local modules

Why every call goes through main instead of a direct renderer↔Go channel: ADR-0002 uses stdio, and only main
owns the child. The extra hop costs one JSON parse and one structured clone per message. Stage 00 measures
that cost (§10.4). If it ever matters, the fallback is to forward frame payloads as opaque strings with header-only
parsing in main. That change would not touch contracts.

---

## 3. IPC protocol design

### 3.1 Layers

1. **Renderer ↔ main**: one invoke channel `fv:invoke(method, params)` plus one push channel `fv:event`.
   The preload exposes **typed namespaced functions** that it generates from the contracts method list, for example
   `panelyth.system.ping()`, plus `panelyth.onEvent(channel, cb) → unsubscribe`. There is no generic escape hatch.
   Main rejects any method that is not on the allowlist.
2. **Main ↔ Go**: framed messages on stdin/stdout.

### 3.2 Framing (main ↔ Go)

```text
┌────────────┬──────────────────────────────┐
│ u32 BE len │ UTF-8 JSON payload (len bytes)│
└────────────┴──────────────────────────────┘
```

- Frames are length-prefixed rather than NDJSON. That makes them robust to stray newlines, cheap to skip, and gives a hard size limit.
- Maximum frame size is **4 MiB**. A larger frame is a protocol error, and the connection is reset.
- JSON is the MVP codec. The codec sits behind an interface, so MessagePack can be evaluated in Stage P05 with numbers.
- **Go never writes anything but frames to stdout.** Logs go to stderr as slog JSON, and main writes them to a rotating file.

### 3.3 Envelope

```ts
// main → Go
{ t: "req", id: number, m: "files.page", p: {...}, deadlineMs?: number }
{ t: "cancel", id: number }                        // cancels in-flight request id (ctx cancel)

// Go → main
{ t: "res", id: number, ok: true,  r: {...} }
{ t: "res", id: number, ok: false, e: { code: ErrorCode, message: string, retryable: boolean, details?: {...} } }
{ t: "evt", ch: "index.progress", seq: number, p: {...} }   // already coalesced by Go
{ t: "hello", protocol: 1, pid, version, cacheRoot, capabilities: {...} }  // first frame, handshake
```

`ErrorCode` extends ARCHITECTURE.md's error model: `INVALID_ARGUMENT | INVALID_PATH | NOT_FOUND |
PERMISSION_DENIED | UNSUPPORTED_MEDIA | CORRUPT_MEDIA | CACHE_ERROR | DB_ERROR | CANCELLED | BUSY |
TIMEOUT | SIDECAR_UNAVAILABLE | PROTOCOL_MISMATCH | INTERNAL`.

### 3.4 Rules

- Request IDs are monotonic per connection. Main keeps a pending map with a per-method default timeout.
- A renderer `AbortSignal` becomes a `cancel` frame. Long-running work such as scans and jobs has its own domain id
  (`scanId`, `jobId`) and a domain-level cancel method, because it outlives the request that started it.
- Go caps **in-flight requests** with a semaphore (for example 64). Beyond that it replies `BUSY`. That is the protocol-level backpressure.
- One writer goroutine serializes frames. Responses are never dropped. Events coalesce per channel, where the
  latest value wins for progress and sets are unioned for ready/changed. They flush on a timer of about 50 ms for previews and
  about 250 ms for progress.
- Responses are bounded by design: pages have `limit ≤ 1000` and error lists are paged.
- **Sidecar crash**: pending requests reject with `SIDECAR_UNAVAILABLE`. Main restarts the sidecar with backoff and gives up after
  3 failures in 60 s. It emits `sidecar.status`, and the renderer re-issues its current query.
- **Shutdown**: main sends `system.shutdown` and waits up to 2 s. It then closes stdin and waits up to 1 s before killing the process. Go treats **stdin EOF as
  shutdown**, so it never outlives Electron, not even after an Electron crash.

### 3.5 Method surface

The method set refines DOMAIN-API.md. Each method is introduced by the stage that needs it.

| Namespace | Methods | Stage |
|---|---|---|
| system | `ping`, `info`, `shutdown` (main-only) | 00 |
| dialog | `openFolder` (main-only handler) | 01 |
| dir | `open(path) → {dirId, scanId}`, `cancelScan(scanId)`, `children(dirId) → dirs` (tree) | 01/05 |
| query | `open(QueryDescriptor) → {queryId, version, total}`, `page(queryId, offset, limit, fields)`, `indexOf(queryId, entryId)`, `close(queryId)` | 01/03 |
| preview | `ensure({epoch, profile, items:[{id, prio}]})` | 02 |
| media | `open(entryId) → {url, kind, mime}` (main mints token) | 04/06 |
| props | `get(entryId)` | 05 |
| volumes | `list()` | 05 |
| library | `bookmarks.*`, `recent.*`, `settings.get/set` | 05 |
| jobs | `start(JobSpec) → {jobId}`, `cancel`, `resolveConflict`, `errors(jobId, offset, limit)` | 07 |

Events: `sidecar.status`, `index.progress`, `query.invalidated {queryId, version, total}`,
`preview.ready [{id, profile, url, w, h} | {id, profile, failed: code}]`, `dir.changed`, `job.progress`, `job.state`.

`preview.getUrl(cacheKey)` from DOMAIN-API.md is **removed**. The URL can be derived, so it needs no round trip (see §5).

---

## 4. SQLite schema

### 4.1 Two databases (see contradiction C2)

| DB | Location | Content | Disposable? |
|---|---|---|---|
| `index.db` | `<UserCacheDir>/Panelyth/v1/db/` | filesystem mirror, scans, preview cache index | **Yes.** Rebuildable |
| `library.db` | `<UserConfigDir>/Panelyth/` (same root as Electron `userData`) | favorites, ratings, tags, collections, bookmarks, recent, settings | **No.** User data |

`index.db` attaches `library.db` (`ATTACH … AS lib`) so it can sort and filter by rating, favorite and tags.
Pragmas for both: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `temp_store=MEMORY`,
`busy_timeout=5000`. Go uses one writer connection, which serializes all batched writes, plus a small read pool.

### 4.2 `index.db`

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);          -- schema_version, created_by

CREATE TABLE volumes (
  id             INTEGER PRIMARY KEY,
  volume_key     TEXT NOT NULL UNIQUE,     -- serial/UUID where available, else mount path
  mount_path     TEXT NOT NULL,
  label          TEXT,
  fs_type        TEXT,
  case_sensitive INTEGER NOT NULL          -- drives path_key folding
);

-- One row per directory AND per supported media file: single id space for listing/selection/batch.
CREATE TABLE entries (
  id           INTEGER PRIMARY KEY,
  parent_id    INTEGER REFERENCES entries(id) ON DELETE CASCADE,  -- NULL for roots
  volume_id    INTEGER REFERENCES volumes(id),
  kind         INTEGER NOT NULL,           -- 0 dir, 1 image, 2 video
  name         TEXT NOT NULL,              -- as returned by the OS
  path_key     TEXT NOT NULL UNIQUE,       -- normalized comparison key, '/'-separated, dirs end with '/'
  name_fold    TEXT NOT NULL,              -- case-folded, for search + case-insensitive sort
  name_nat     BLOB NOT NULL,              -- precomputed natural-sort key (digit runs zero-padded)
  ext          TEXT NOT NULL DEFAULT '',   -- lowercase, no dot
  format       INTEGER,                    -- sniffed: jpeg/png/webp/gif/bmp/tiff/mp4/webm/…
  size_bytes   INTEGER,
  mtime_ns     INTEGER,
  btime_ns     INTEGER,                    -- birth time where the OS provides it
  atime_ns     INTEGER,                    -- where available; not trusted for anything but display/sort
  file_key     TEXT,                       -- OS file identity (volume serial+file index / dev+inode)
  width        INTEGER,
  height       INTEGER,
  duration_ms  INTEGER,
  orientation  INTEGER,                    -- EXIF orientation 1..8
  meta_state   INTEGER NOT NULL DEFAULT 0, -- 0 pending, 1 ok, 2 unsupported, 3 corrupt, 4 error
  seen_gen     INTEGER NOT NULL,           -- listing generation that last saw this entry
  indexed_at   INTEGER NOT NULL,
  UNIQUE (parent_id, name)
);
CREATE INDEX entries_parent_nat   ON entries(parent_id, kind = 0 DESC, name_nat);   -- default listing
CREATE INDEX entries_parent_mtime ON entries(parent_id, mtime_ns);
CREATE INDEX entries_parent_size  ON entries(parent_id, size_bytes);
CREATE INDEX entries_parent_kind  ON entries(parent_id, kind, ext);
-- subtree (recursive search): path_key >= 'c:/photos/' AND path_key < 'c:/photos0'  ('/'+1 = '0')

CREATE TABLE dir_state (
  entry_id        INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  listing_state   INTEGER NOT NULL,        -- 0 never, 1 partial, 2 complete, 3 error
  listing_gen     INTEGER NOT NULL DEFAULT 0,
  child_count     INTEGER,
  has_subdirs     INTEGER,                 -- NULL = unknown (tree shows optimistic expander)
  last_listed_at  INTEGER,
  error_code      TEXT
);

CREATE TABLE scans (
  id           INTEGER PRIMARY KEY,
  root_id      INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  recursive    INTEGER NOT NULL,
  generation   INTEGER NOT NULL,
  state        INTEGER NOT NULL,           -- running, completed, cancelled, failed, interrupted
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  entries_seen INTEGER NOT NULL DEFAULT 0,
  errors       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE previews (
  cache_key        BLOB PRIMARY KEY,       -- 32-byte sha256
  entry_id         INTEGER,                -- advisory only, no FK: cache outlives index rows
  profile          INTEGER NOT NULL,
  format           INTEGER NOT NULL,       -- jpeg / png / webp
  width            INTEGER NOT NULL,
  height           INTEGER NOT NULL,
  byte_size        INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL        -- touched in batches, not per hit
) WITHOUT ROWID;
CREATE INDEX previews_lru ON previews(last_accessed_at);

CREATE TABLE preview_failures (
  cache_key       BLOB PRIMARY KEY,
  error_code      TEXT NOT NULL,
  attempts        INTEGER NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  retry_after     INTEGER                  -- NULL = permanent (corrupt/unsupported) until identity changes
) WITHOUT ROWID;
```

Scan semantics: a listing increments the generation, upserts batches of about 500 rows per transaction through prepared
statements, and then deletes rows with `seen_gen < gen` under that parent. That delete runs **only when the listing completes**.
A cancelled or interrupted scan therefore never deletes anything, which covers NFR-05. When a folder is revisited, the stale rows are shown
immediately while a new generation reconciles them.

### 4.3 `library.db`

```sql
CREATE TABLE items (                        -- only exists for files the user annotated
  id          INTEGER PRIMARY KEY,
  path_key    TEXT NOT NULL UNIQUE,         -- joins to index.entries.path_key
  file_key    TEXT,                         -- helps re-link after external moves (future)
  favorite    INTEGER NOT NULL DEFAULT 0,
  rating      INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  color_label INTEGER,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_fold TEXT NOT NULL UNIQUE, color INTEGER);
CREATE TABLE item_tags (item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                        tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
                        PRIMARY KEY (item_id, tag_id)) WITHOUT ROWID;
CREATE INDEX item_tags_by_tag ON item_tags(tag_id, item_id);
CREATE TABLE collections (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE collection_items (collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                               item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                               position REAL NOT NULL, PRIMARY KEY (collection_id, item_id)) WITHOUT ROWID;
CREATE TABLE bookmarks (id INTEGER PRIMARY KEY, path TEXT NOT NULL, label TEXT, position REAL NOT NULL);
CREATE TABLE recent (path_key TEXT PRIMARY KEY, path TEXT NOT NULL, last_opened_at INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
```

When Panelyth itself moves or renames a file, it rewrites `library.items.path_key` in the same job step. Re-linking after
external moves through `file_key` is future work.

### 4.4 Query sessions (see contradiction C3)

`query.open(descriptor)` runs one `SELECT id … WHERE … ORDER BY …` and stores the ordered ids as a Go
`[]int64`. For 100k entries that is 800 KB, and a 1M-entry recursive search is 8 MB. The session is capped per window and evicted LRU.

- `query.page(queryId, offset, limit)` takes the slice window and runs `SELECT … WHERE id IN (…)`. Every offset costs the same, including deep ones,
  which avoids SQLite's O(offset) `OFFSET` scan.
- `total` is known immediately. The virtualizer needs it to size the scrollbar.
- While a scan is live, Go re-materializes on a debounce that backs off from 250 ms to 1 s, bumps `version` and emits
  `query.invalidated`. The renderer refetches **only the pages it currently holds**.
- Selection is by entry id, so it stays stable across versions (FR-12).
- The page response includes a `thumb` URL for the requested profile when a cache entry already exists (§5.4). Revisiting a
  cached folder therefore paints thumbnails with **zero** `preview.ensure` calls.

Sorting uses precomputed columns: `name_nat` for natural order, `name_fold` for name order, and `width*height` for dimensions. Arbitrary multi-key sorts rely on SQLite's
temp B-tree over one folder's rows. That must be benchmarked in Stage 01 at 100k rows, with a target under 150 ms.
Filename search uses `name_fold LIKE` within a folder. For recursive search over large trees, an FTS5 trigram index is introduced **only if**
the Stage 05 benchmark shows LIKE is too slow.

---

## 5. Preview / cache architecture

### 5.1 Layout

This follows CACHE-DESIGN.md with a URL scheme added.

```text
<UserCacheDir>/Panelyth/v1/
  db/index.db
  thumbnails/ab/cd/<64-hex>.jpg|.png|.webp
  previews/ab/cd/<64-hex>.jpg          (viewer-fit, video posters)
  tmp/                                 (cleared at startup; same volume → atomic rename)
```

### 5.2 Key

`sha256(cacheVersion ‖ path_key ‖ size ‖ mtime_ns ‖ profileId ‖ transformVersion)`.
`transformVersion` covers the decoder, resizer, EXIF-orientation handling and encoder settings.

### 5.3 Profiles

This fixes contradiction C11. Profiles are defined in **device pixels on the long edge**. The renderer picks the smallest profile that is at least
`tileCssPx × devicePixelRatio`.

| id | long edge | use |
|---|---|---|
| `grid-sm` | 192 | small and medium tiles at 1× |
| `grid-md` | 384 | small and medium tiles at 2×, large tiles at 1× |
| `grid-lg` | 768 | large tiles at 2× |
| `viewer-fit` | 2560 (cap) | preview pane when the original is not browser-displayable or is huge |
| `poster` | 768 | video poster frame |

### 5.4 Flow

```text
renderer visible range settles (≈80 ms idle / low velocity)
  → preview.ensure({ epoch, profile, items: [{id, prio}] })      ONE call per range change
Go:
  for each id: stat-free identity from index row → key → in-memory known-key set / previews table
     hit  → returned inline in the response {id, url}; last_accessed touched in a batched write
     miss → scheduler.enqueue(key, prio, epoch)   (joins existing job if key in flight)
scheduler: dedup map[key]*job, 4 priority classes (visible, overscan, forward-buffer, background),
           bounded queue (≈2k, drop lowest prio on overflow), new epoch demotes stale not-started jobs
workers:   N = clamp(runtime.NumCPU()/2, 2, 8) AND a megapixel-weighted semaphore
           (a 100 MP decode ≈ 400 MB RGBA; memory budget, not just count)
job:       open → re-stat (size/mtime still match?) → decode (ctx checks) → orient → resize
           → encode → write tmp → rename → batched DB insert → coalesced preview.ready event
```

URL format: `panelyth-thumb://t/<64-hex>.<ext>`. The main-process protocol handler:

1. validates against `^[0-9a-f]{64}\.(jpg|png|webp)$`,
2. derives `<cacheRoot>/thumbnails/<h[0:2]>/<h[2:4]>/<name>`, where `cacheRoot` comes from the Go `hello` frame and never from the renderer,
3. streams the file asynchronously with a long `Cache-Control` header. The key is content-addressed, so it never goes stale.

The handler needs no Go round trip and no DB lookup. That satisfies "a path derived from a validated key" in CACHE-DESIGN.md. If
cleanup deleted a file that is still referenced, the `<img>` gets a 404, and the renderer calls `ensure` again once for that id.

### 5.5 Failures, cleanup, integrity

- Transient failures such as I/O errors or `BUSY` get `retry_after` with backoff. Corrupt and unsupported files are permanent **for that key**.
  Because the key includes size and mtime, fixing the file automatically clears the failure.
- Cleanup runs as a background job at startup and every 30 minutes. It enforces a size ceiling (default 2 GB, configurable) by LRU, deleting in batches of 500:
  file first, then row. An incremental orphan sweep covers one shard directory per tick, which bounds the directory walk.
  Old `vN/` roots are deleted lazily.
- A corrupt cache file is detected on decode error in Chromium (`<img>` error → `ensure` with `force: true`) or by a size
  mismatch against the row. The row is dropped and the file regenerated.

---

## 6. Virtualized tile view architecture

> Revised 2026-09-30 by product decision (ADR-0004): **tiles only**, flowing left to right with a **fixed tile
> size**; a wider window fits more tiles per row. No list or table views. Spec: `docs/viewer/stages/03-tile-view.md`.

```text
ContentPane
 └─ TileView          useVirtualizer, count = ceil(total / perRow), estimateSize = rowHeight (fixed per size)
      └─ TileRow (memo, rowIndex) ── positioned by translateY, tiles left-aligned (flex, fixed widths)
           └─ Tile (memo, itemIndex) ── useSyncExternalStore(pageStore.item(i)), selection.isSelected(id)
```

- **Geometry**: `perRow = max(1, floor((width − 32 + gap) / (tile + gap)))` with fixed `tile` per size (120 / 180 / 260
  CSS px) and `gap` (8 / 12 / 16). Tiles keep their width; spare width stays at the right edge. `rowHeight = tile +
  nameLine + gap`. The width comes from one `ResizeObserver`; rows re-render only when `perRow` changes, so pane
  dragging costs no React work per pixel.
- **Scroll anchoring**: when `perRow` changes, the first visible **item index** is preserved, not the pixel offset.
- **Data outside React state**: `PageStore` is a plain module object with a bounded LRU of pages (page size 256, about
  24 pages kept). Tiles subscribe to their own index. A page arrival notifies only subscribers of that page. React never holds the list.
- **Page loading**: a range change from the virtualizer requests any missing pages in `[first − 1 page, last + 1 page]`. Requests are
  deduplicated and cancelled with `AbortSignal` when the range moves away. During a high-velocity scroll, metadata loads for the landing range only
  after a short idle period, and thumbnails load only when the range is stable. This keeps "scrolling independent from data fetching".
- **Thumbnails**: the tile renders `<img decoding="async" width height>` when `item.thumb` exists, and a static placeholder otherwise.
  There is no per-tile IPC, animation or `backdrop-filter`. Tiles use `contain: strict`.
- **Overscan**: 2 rows. The mounted-tile budget is ≤ 300, asserted in e2e.
- **Selection model**: `SelectionStore` holds an anchor plus either an explicit `Set<id>` or ranges in query-index space
  (`Ctrl+A` = `[0, total)`). Tiles read `isSelected(id)` through a selector. Batch operations send a `SelectionDescriptor`
  `{ queryId, version, ranges, include[], exclude[] }` that Go resolves. The renderer never sends 100k ids (C4).
- **Keyboard**: a roving active index (←/→ ±1, ↑/↓ ±perRow), `aria-activedescendant`, and `scrollToIndex` that turns item
  index into row. For assistive technology the tile view uses the ARIA `grid` pattern (`aria-rowcount`,
  `aria-rowindex`), because two-dimensional arrow-key navigation needs it. Visually it is a tile flow, not a table.
- React 19 + TanStack Virtual: `useFlushSync: false`, and backend events are applied inside `startTransition`.

---

## 7. Three-pane UI architecture

```text
AppShell
 ├─ TitleBar/Toolbar region (content toolbar lives inside ContentPane per UX-DESIGN)
 ├─ ResizablePanelGroup (shadcn Resizable → react-resizable-panels)
 │   ├─ SidebarPane   min 180 / max 480 / collapsible
 │   │    ├─ Volumes + QuickAccess (main-provided known folders) + Bookmarks + Recent
 │   │    └─ FolderTree  flattened visible-node list, virtualized, children via dir.children on expand
 │   ├─ ContentPane   flexible, min 320
 │   │    ├─ NavToolbar: back · forward · up · refresh · Breadcrumb · Search · Sort · Filter · ViewMode
 │   │    ├─ ContentView (§6)
 │   │    └─ BatchBar (when selection > 1) + inline job progress
 │   └─ PreviewPane   min 240 / max 60% / collapsible
 │        ├─ ImagePreview | VideoPreview | FolderSummary | EmptyState
 │        └─ MetadataPanel (props.get on demand)
 └─ StatusBar: indexing progress, sidecar status, counts
```

- **State**: small independent stores (see M6: Zustand is recommended) for `layout`, `navigation` (history stack of back/forward;
  renderer-only), `query` (descriptor + queryId), `selection`, `preview`, `jobs` and `settings`. Components use selectors, and there is no
  app-wide context that re-renders the grid.
- **Resize**: the panel library updates flex styles. The grid reacts only through its ResizeObserver breakpoint logic. The layout is
  persisted to `library.settings` on `onLayout`, debounced by 500 ms. Below about 1000 px the preview pane auto-collapses, and below about 720 px the sidebar does too.
- **Selection → preview** is debounced by about 100 ms, so holding an arrow key doesn't start a decode for every item.
- **Context menus**: shadcn `ContextMenu`, with four variants (file, folder, multi, empty) driven by the selection store. Destructive items
  open an `AlertDialog`.
- **Drag and drop of a folder** (FR-01): the preload exposes `getPathForFile(file)` through `webUtils.getPathForFile`, because `File.path` no longer exists under sandbox.
- Tailwind and CSS-variable tokens arrive in Stage 00 as the "theme shell". shadcn primitives are added by whichever stage first needs them (C8).

---

## 8. Video playback architecture

```text
selection (video) → media.open(entryId)
  main → Go media.resolve(entryId): entry exists, kind=video, re-stat → {path, size, mtime, mime}
  main mints 128-bit random token → bounded LRU map (≈256) token → {path, size}
  renderer ← { url: "panelyth-media://m/<token>", poster: "panelyth-thumb://…" }
<video src=url poster=poster preload="metadata">
  panelyth-media handler: parses Range → fs.open + createReadStream(start,end) → 206 + Content-Range
```

- The scheme is registered privileged with `{ standard, secure, stream: true, supportFetchAPI }`. Range support is implemented
  **explicitly** rather than relying on `net.fetch(file://)`, because seeking depends on it.
- The renderer never supplies a path. A token dies with the LRU entry and with the window.
- The same path serves **original images** for browser-native formats (JPEG, PNG, WebP, GIF, BMP) in the viewer. TIFF and future
  formats use Go's `viewer-fit` profile instead (M9).
- Controls are custom (shadcn Slider/Button). Time display updates from `timeupdate`, which fires at about 4 Hz, in local component state only.
  On selection change: `pause()`, remove `src`, `load()`, which releases the decoder.
- Capability handling: `canPlayType` is a hint only. `MediaError` codes map to a "Can't play this format" state with
  "Open with default app" (`shell.openPath`, main).
- **Posters and duration/dimensions** (C5): the Go stdlib cannot decode video. The recommendation is to bundle **ffprobe/ffmpeg**
  (an LGPL build per OS/arch) and have Go invoke it as a subprocess from a dedicated pool of 1–2 workers with timeouts. Without it, the UI degrades
  to a generic video tile with duration taken from the `<video>` metadata. This needs an ADR (licensing, packaging size, per-OS testing).
- The container element is fullscreen-ready (`requestFullscreen`), and controls stay in the DOM layer.

---

## 9. Batch operation architecture

```text
BatchBar / ContextMenu → jobs.start({ kind, selection: SelectionDescriptor, destination?, options })
Go JobManager
  ├─ resolve selection → item list (streamed into job_items journal, bounded memory)
  ├─ plan (same-volume move = rename; cross-volume move = copy+verify+delete)
  ├─ worker(s): 1 per destination volume for copy/move (avoid HDD thrash), N for metadata ops
  ├─ per item: execute → update index.db (batched tx) → update library.db path_keys
  ├─ conflicts: policy chosen up front (ask | skip | overwrite | keep-both);
  │             "ask" → job state awaiting_input + job.state event → jobs.resolveConflict(applyToAll?)
  ├─ cancellation: between items, and between copy chunks (partial "*.panelyth-partial" removed)
  └─ events: job.progress coalesced ≤ 4 Hz {done, total, bytesDone, bytesTotal, current, errorCount}
             job.state on transitions; per-item errors pulled via jobs.errors(jobId, offset, limit)
```

- Job journal tables (`jobs`, `job_items`) live in `index.db`. On startup, jobs left `running` are marked `interrupted` and
  shown with their partial result (NFR-05). Automatic resume is not in scope.
- Copies are written to a temp name and renamed, and mtime is preserved. The index is updated only for items that succeeded.
- Metadata operations (favorite, tag, rate) run as one `library.db` transaction per chunk of 1000. They use the same job API so the UX stays uniform.
- Browsing continues during a job. Affected folders receive `dir.changed`, which leads to `query.invalidated`.
- Delete, clipboard and rename-pattern semantics are open decisions (M3, M4).

---

## 10. Testing and benchmarking strategy

### 10.1 Layers

| Layer | Tooling | Focus |
|---|---|---|
| Go unit | `go test`, table tests, `-race` (CI Linux; Windows needs a C toolchain) | framing, dispatcher, cancellation, workpool, path_key, key derivation, scheduler dedup, SQL |
| Go integration | fixture trees via `cmd/fixturegen`, temp cache dirs | scan→query→preview→restart→hit, in-place replace → miss, corrupt cache → regen |
| Go bench | `go test -bench -benchmem`, `benchstat` for before/after | scan files/s, batch insert latency, `query.page` p95 at deep offsets, decode+resize per format/size, cache hit |
| Contracts | golden JSON fixtures emitted by Go tests, validated by TS tests | TS ↔ Go drift (M7) |
| Renderer unit | Vitest + RTL + jsdom | range→pages, geometry math, selection algebra, keyboard nav, stores, error states |
| Desktop unit | Vitest (node) | frame codec (split/merged chunks), RpcClient timeouts/cancel/restart, validators, protocol path derivation |
| E2E | Playwright `_electron.launch` | TESTING.md scenarios 1–10, security assertions (no `require`, no `ipcRenderer` on window) |
| Perf E2E | Playwright + CDP tracing, `PerformanceObserver('longtask')`, DOM node counts | scroll 100k, mounted tiles ≤ budget, long tasks during scroll, open-to-first-result |

### 10.2 Fixtures

`fixturegen` produces deterministic trees: `small` (100), `large` (10k), `huge` (100k, including tiny real JPEGs
plus zero-byte extension-only files for scan-only benchmarks), `mixed` (unsupported, corrupt, repeated names, unicode/case
collisions), and `churn` (files mutated during a scan). Fixtures are generated into the scratch or temp directory, never committed.

### 10.3 Results

`shared/bench/results/<stage>-<date>-<host>.json` holds `{env, fixture, metric, p50, p95, n, commit}`. The `/benchmark` command
compares the latest result against the stored baseline. Missing measurements are reported as missing and never estimated.

### 10.4 Provisional numeric budgets

> The calibrated budgets now live in `docs/shared/PERFORMANCE.md` (platform) and `docs/viewer/PERFORMANCE.md`
> (viewer). The table below is the original proposal.

These fix contradiction C10. The numbers are proposed and get calibrated in Stage 00 and Stage 01 on this machine plus one low-end machine.

| Metric | Budget |
|---|---|
| Cold start → window shown | < 1.0 s |
| Cold start → sidecar `hello` | < 500 ms |
| Idle memory, all processes, empty app | < 400 MB absolute **and** < 60 MB over an empty Electron window (recalibrated in Stage 00: Electron 44 alone idles at ~300 MB on Windows) |
| `system.ping` round trip renderer→Go→renderer | p95 < 3 ms |
| `query.page(256)` at any offset, 100k folder | p95 < 25 ms |
| Open cached 100k folder → first page painted | < 300 ms |
| Mounted tiles | ≤ 300 |
| Long tasks during continuous scroll | none > 50 ms |
| Thumbnail cache hit → painted | p95 < 50 ms |
| Sidecar clean shutdown | < 1 s |

---

## 11. Contradictions and missing decisions

### Must resolve before Stage 01 (they shape contracts and schema)

- **C1 — Index scope model.** Stage 01 says "recursive scan" of the opened folder, and ARCHITECTURE's `folders`/`relative_path`
  model assumes a scan root. The product, however, is an explorer: it has back/up navigation, folders as content items, a lazy tree and a
  recursive-search *option*. Recursively scanning `C:\` because a user opened it would violate FR-07 and NFR-02.
  **Proposal**: a directory-centric index (§4.2). Opening a folder performs a **shallow** listing. Recursive indexing of a subtree
  runs only when recursive search is enabled or the user opts into background indexing, bounded and cancellable. → ADR-0015 (proposed).
- **C2 — User data stored in a disposable cache.** CACHE-DESIGN puts `db/` under the OS cache root ("cache can be safely
  deleted"), and the OS may purge `~/Library/Caches`. Favorites, ratings, tags, bookmarks, recent items and settings (FR-18, NFR-09) would be
  lost. **Proposal**: split `index.db` (cache) from `library.db` (config dir), keyed by `path_key` (§4.1). → ADR-0016 (proposed).
- **C3 — Offset paging vs live scans vs stable selection.** Offset/limit over a table that grows while scanning shifts
  rows under the user, and SQLite `OFFSET` is O(n) at depth. **Proposal**: query sessions with a materialized ordered id list
  plus versioned invalidation (§4.4). → ADR-0017 (proposed).
- **C4 — Batch APIs take `ids[]`.** DOMAIN-API's `batch.copy(ids, …)` conflicts with invariant 9 (large payloads) for
  Ctrl+A on 100k items. **Proposal**: a `SelectionDescriptor` that Go resolves (§6, §9). This belongs in ADR-0017.
- **C5 — Video posters and metadata have no mechanism.** ADR-0009 gives poster generation to Go, and Go cannot decode video.
  **Proposal**: bundle an ffmpeg/ffprobe subprocess with graceful degradation. → ADR-0018 (proposed), which covers licensing and packaging size.
- **C6 — Native dependency / cgo policy is missing.** CACHE-DESIGN wants WebP output, but Go has no stdlib WebP *encoder*.
  Stdlib JPEG has no DCT-scaled decode, which is slow for 24 MP+ sources, and it ignores EXIF orientation. The SQLite driver choice (cgo `mattn` vs
  pure-Go `modernc`) depends on the same policy. **Proposal**: MVP is **pure Go, CGO_ENABLED=0**, using `modernc.org/sqlite`, stdlib and
  `golang.org/x/image` decoders, JPEG output for opaque images and PNG for alpha. WebP output and libjpeg-turbo/libvips are deferred to
  Stage P05 behind the decoder/encoder interfaces and adopted only with benchmark evidence. → ADR-0019 (proposed), which also amends CACHE-DESIGN.

### Stage-plan inconsistencies

- **C7 — Duplicate stage documents.** `05-filesystem-ux.md` and `05-navigation-search.md` are near-duplicates.
  So are `06-media-playback.md` and `06-video-playback.md`. Three stub files say "Stage moved". **Proposal**: keep one canonical file per stage
  and delete or merge the rest. *(Stage 05: merged into `05-filesystem-ux.md`. Stage 06: merged into `06-media-playback.md`.)*
- **C8 — Scope overlaps between stages:**
  - View modes: Roadmap Phase 3 and DEVELOPMENT-STAGES ("content views") include lists. The Stage 03 document covers only the grid, and Stage 05 repeats all view modes. *(Resolved 2026-09-30: list and table views were removed from the product; Stage 03 is the tile view, ADR-0004.)*
  - Image zoom/pan appears in both Stage 04 and Stage 06.
  - Video posters: DEVELOPMENT-STAGES lists them in Stage 02 ("thumbnail + poster pipeline"). The Stage 02 document covers images only, and Stage 06 has them.
  - Video detection: Roadmap Phase 1 includes it, while the Stage 01 document says "image files".
  - Drives: Roadmap Phase 1 includes them, and so does Stage 05.
  - Tailwind and shadcn: Stage 08 introduces them, but Stage 00 needs a "theme shell" and Stage 05 needs Resizable, ContextMenu and Dialog.
  - Benchmark harness: Roadmap Phase 0 includes it, and the Stage 00 document omits it.

  **Proposal**:
  - Stage 01 indexes images and videos (sniffing only, no video probing). Drives move to Stage 05.
  - Stage 02 builds the pipeline for images, with the poster hook stubbed. Stage 06 adds the ffmpeg-backed posters.
  - Stage 03 covers the tile view with three sizes. ~~Lists move to Stage 05.~~ Lists and tables were removed (ADR-0004).
  - Stage 04 builds the reusable `ImageViewer` (fit/1:1/zoom/pan). Stage 06 only embeds it in the pane and adds video.
  - Tailwind tokens arrive in Stage 00. shadcn primitives arrive per stage. Stage 08 refines.
  - The benchmark harness is added to Stage 00.
- **C9 — Two viewing surfaces?** Stage 04's "full viewer" (open, close/back) predates the Stage 05 preview pane. It is undecided
  whether a focused or fullscreen viewer mode exists in addition to the pane. **Proposal**: yes. A focused viewer overlay
  (Enter/double-click on an image) exists alongside the pane, and both reuse `ImageViewer`.
- **C10 — Stage gates depend on budgets that have no numbers.** PERFORMANCE.md deliberately leaves budgets unnumbered, but a gate needs a
  "benchmark passes" criterion. **Proposal**: the provisional table in §10.4, recalibrated per stage.
- **C11 — Profiles don't match view modes.** PERFORMANCE.md defines `grid-sm`/`grid-md` for three tile sizes and has no DPR rule and no
  poster profile. **Proposal**: §5.3.

### Missing decisions (smaller; can be decided in the stage that needs them)

- **M1 — File watching.** `fsnotify` is not recursive on Linux (inotify watch limits). On macOS it uses kqueue with **one fd per
  file**, which is unusable for 100k-file folders. Proposal: watch only the current folder plus expanded tree nodes, non-recursively. Use FSEvents
  on macOS if cgo is allowed later, otherwise fall back to polling or refresh on focus. → ADR in Stage 01.
- **M2 — Path semantics.**
  - Case folding for `path_key` depends on the volume's case sensitivity.
  - macOS NFD vs NFC: store the OS form and normalize the key to NFC.
  - Windows long paths (`\\?\`) and UNC shares need handling.
  - Symlinks and junctions: list them, never follow them during recursion, and detect cycles by `file_key`.
  - Hidden files: hidden by default, with a toggle.
  - Unsupported files: **not shown**. Content lists folders and supported media, and a count of hidden files is shown.
- **M3 — Delete semantics.** Trash vs permanent is undecided, and so is the owner of the trash operation. Electron's `shell.trashItem` is simple, but it puts
  file operations in main, which conflicts with ADR-0010. Go needs per-OS trash code (Win `IFileOperation`/`SHFileOperationW` through syscall,
  the freedesktop spec on Linux, and cgo or AppleScript on macOS). Proposal: trash is the default, permanent delete is Shift+Delete with confirmation, and Go
  owns the operation. The macOS approach needs a decision in the cgo ADR.
- **M4 — Copy/Cut/Paste.** It is undecided whether the clipboard is internal-only or OS file clipboard (Explorer/Finder interop is not portable in Electron).
  The rename-pattern syntax is undefined, and so is whether undo exists. Proposal: an internal clipboard for MVP, `{name}{n:000}.{ext}`-style tokens, and no undo in MVP.
- **M5 — Settings persistence.** ARCHITECTURE says pane state is "managed entirely in React", while NFR-09 requires persistence and names no
  store. Proposal: `library.settings`, loaded once at startup and written with a debounce. Stage 00 may use `localStorage` for the theme only.
- **M6 — Renderer store.** "Use selectors for global stores" implies a store library, and no ADR exists. Proposal: **Zustand**
  (about 1 KB, selector-based) plus `useSyncExternalStore` for `PageStore`.
- **M7 — Contract source of truth.** TS types and Go structs will drift. Proposal: TS `shared/contracts` is canonical, Go
  mirrors it by hand, and golden JSON fixtures produced by Go tests are type-checked or validated in TS. There is also a protocol version in `hello`.
- **M8 — Build and packaging tooling.** This covers Vite for main and preload, the packager choice (electron-builder vs Forge, a Stage P04 decision),
  and the sidecar location in `resources/bin/<os>-<arch>/`.
- **M9 — What the viewer displays.** *(Implemented in Stage 04 as proposed; see `docs/viewer/stages/04-viewer.md`.)* Proposal: originals through `panelyth-media:` for browser-native formats up to a pixel cap of
  about 50 MP, with Go's `viewer-fit` for TIFF, huge images and future formats. The viewer shows the cached grid thumbnail instantly and swaps after `img.decode()`.
- **M10 — Sort semantics.** "Sort by tags" is undefined (proposal: the first tag alphabetically, untagged last). Created and accessed times are
  unreliable on some platforms and filesystems, and the UI shows "—".
- **M11 — Main serves files through protocols.** Clarify in ADR-0003/0009 that async streaming of a Go-derived or validated path is
  allowed in main. It is not "business logic".
- **M12 — Multi-window (future).** Query sessions and media tokens are owned per `webContents` and released when the window closes.
- **M13 — DOMAIN-API cleanups.** `navigate.back/forward` are renderer-local. `ContentItem.id` should be `number`, not `string`.
  ARCHITECTURE's `files.created_at` is ambiguous, so split it into `btime_ns` and `indexed_at`.
- **M14 — Environment.** Install Go (current stable). Run `git init`. `go test -race` on Windows needs a C toolchain, or race tests run in
  CI on Linux.
- **M15 — shadcn/Tailwind has no ADR.** CLAUDE.md requires an ADR for UI libraries. BRS mandates them, so this is paperwork.
  Include a note on `react-resizable-panels` (pulled in by shadcn Resizable) in it.

---

## 12. Stage 00 implementation plan

### Preconditions (blocking)

1. Go toolchain is installed and on PATH (`go version` works in both shells).
2. `git init` has been run and the initial docs are committed, so Stage 00 has a clean diff baseline.
3. Decisions confirmed: M6 (Zustand), M7 (TS-canonical contracts + golden fixtures), M8 (Vite for all three bundles).
   C1–C6 do **not** block Stage 00, but they should be accepted as ADRs before Stage 01.

### Scope

**Repo**
- `pnpm-workspace.yaml`, root `package.json` scripts: `dev`, `build`, `build:sidecar`, `lint`, `typecheck`, `test`,
  `test:go`, `test:e2e`, `bench:startup`
- `tsconfig.base.json` (strict), ESLint flat config, Prettier (`semi: false`), `.editorconfig`, `.gitignore`, `.gitattributes`
- `scripts/build-sidecar.mjs`: `go build -trimpath` for the host OS/arch, output to `shared/desktop/resources/bin/<os>-<arch>/`

**shared/contracts**
- `rpc.ts` (`system.ping`, `system.info`), `events.ts` (`sidecar.status`), `errors.ts`, `api.ts` (`PanelythApi`)

**Go (`shared/sidecar`)**
- `internal/rpc`: frame reader/writer (4 MiB cap), envelope types, dispatcher with generic
  `Register[P, R]`, in-flight semaphore, per-request context and `cancel` frames, and a single writer goroutine with an event coalescer skeleton
- `internal/logging`: slog JSON handler to stderr, with level from a flag or environment variable
- `internal/workpool`: bounded workers plus a bounded queue, `Submit(ctx, fn) error` (`ErrQueueFull`, `ErrClosed`),
  `Close(ctx)` drain. Priorities come in Stage 02
- `internal/platform`: resolve (not yet create) the cache and config roots
- `internal/app`: sends the `hello` frame, registers `system.ping` → `{ pong: true, serverTimeNs }` and `system.info` →
  `{ version, goVersion, pid, uptimeMs, protocol, heapBytes }`, and shuts down on `system.shutdown`, stdin EOF or SIGINT/SIGTERM
  (cancel root ctx, drain handlers ≤ 2 s, exit 0)
- `cmd/panelyth-sidecar/main.go`

**Electron (`shared/desktop`)**
- `window.ts`: secure `webPreferences`, CSP, navigation/window-open/permission guards, `ready-to-show`
- `appProtocol.ts`: `app://panelyth/` serves renderer `dist` in production, with a traversal guard
- `sidecar/`: `SidecarProcess` (spawn with `windowsHide`, stderr → log, status machine, restart with backoff, ordered
  shutdown), `frames.ts` (chunk-boundary-safe decoder), `RpcClient` (pending map, timeouts, AbortSignal → cancel, rejects everything on exit)
- `ipc/router.ts`: `fv:invoke` with sender-origin check and method allowlist. `fv:event` broadcast
- `preload/index.ts`: `contextBridge.exposeInMainWorld('panelyth', { system: { ping, info }, onEvent })`
- `log.ts`: size-capped rotating log in `app.getPath('logs')`
- Single-instance lock. Quit path: `before-quit` → preventDefault → sidecar shutdown → `app.exit()`

**React (`viewer/renderer`)**
- Vite + React + TS strict, Tailwind with CSS-variable tokens and light/dark/system theme (theme stored in `localStorage` for now)
- `bridge/`: the only module that touches `window.panelyth`
- `AppShell`: a **static** three-region layout (resizing arrives in Stage 05). Sidebar placeholder, content empty state
  ("Open a folder", disabled until Stage 01), `GridPlaceholder`, preview placeholder
- `StatusBar`: sidecar status from `sidecar.status` plus the measured ping round trip
- `perf/marks.ts`: `performance.mark('app:first-render')` etc., which e2e reads
- Error boundary

**Tests**
- Go:
  - frame round-trip, including split/merged chunks and oversize rejection
  - dispatcher: unknown method, panics recovered to `INTERNAL`, cancel, `BUSY` at the in-flight limit
  - workpool: bounded, `ErrQueueFull`, drain on close, no goroutine leak via `runtime.NumGoroutine`
  - shutdown on stdin EOF (subprocess test)
- Desktop (Vitest/node):
  - frame decoder with fuzzed chunking
  - RpcClient timeout, cancel and exit rejection
  - router rejects unknown methods and foreign senders
- Renderer (Vitest/RTL): AppShell renders its empty state, StatusBar shows the ping result through a mocked bridge, and the theme toggles
- E2E (Playwright `_electron`):
  - the app starts and the window shows
  - the renderer calls `ping` successfully
  - `window.require`, `window.process` and `window.ipcRenderer` are undefined
  - killing the sidecar → the status shows restarting → ping works again
  - quitting the app leaves no sidecar process
- A static check that no `sendSync` or `ipcRenderer.sendSync` appears anywhere, enforced as an ESLint `no-restricted-syntax` rule

**Benchmarks (`shared/bench/scripts/startup.ts`, results → `shared/bench/results/stage-00-*.json`)**
- Launch → `ready-to-show` → `app:first-render` → sidecar `hello` (10 runs, p50/p95)
- Idle memory after 10 s: `app.getAppMetrics()` summed, plus sidecar RSS
- `system.ping` round trip: 1000 sequential and 1000 with 32 concurrent (p50/p95/p99)
- Echo throughput for a 64 KB payload, a dev-only method compiled out of production, which sizes main-process relay cost for future pages
- Sidecar shutdown latency
- Go: `BenchmarkFrameRoundTrip`, `BenchmarkDispatchPing`, `BenchmarkWorkpoolSubmit`

### Non-goals (Stage 00)

Folder opening, scanning, SQLite, previews, custom thumbnail/media protocols, resizable panes, shadcn components, packaging.

### Acceptance (from `docs/viewer/stages/00-foundation.md`, plus the harness)

- [ ] app starts (dev and production build)
- [ ] React can call `ping`
- [ ] Electron starts and terminates Go, with no orphan after quit or crash
- [ ] Go tests pass, `gofmt` is clean and `go vet` is clean
- [ ] renderer and desktop typecheck and lint
- [ ] no synchronous IPC (lint rule + e2e)
- [ ] startup, idle-memory and ping baselines recorded in `shared/bench/results/`

### Risks

- Sandboxed preload bundling: it must be a single CJS file with no local requires. This is covered by e2e.
- Windows process tree: if stdin-EOF shutdown fails, a job object or `taskkill /T` is the fallback. This is covered by e2e.
- Choosing tool versions happens at implementation time. They are recorded in `package.json`/`go.mod`, not in the docs.

### Docs to update at Stage 00 exit

`docs/viewer/stages/00-foundation.md` (rewritten to STAGE-TEMPLATE plus the checklist), `docs/DEVELOPMENT-STAGES.md` (00 done → 01 active),
`docs/ROADMAP.md`, the new ADRs for M6/M7/M8 and the ADR for shadcn/Tailwind, and `shared/bench/results/`.
