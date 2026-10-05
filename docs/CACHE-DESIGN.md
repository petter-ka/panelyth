# Preview Cache Design

> **Implemented in Stage 02** (`native/fastview-go/internal/preview`, `internal/imaging`,
> `apps/desktop/src/main/thumbProtocol.ts`). Deviations from this document:
> - Alpha previews are **PNG**, not WebP (no pure-Go WebP encoder, ADR-0019).
> - The key also includes the JPEG quality; the URL is `fastview-thumb://t/<key>.<jpg|png>`, resolved by Electron
>   main under the `thumbnailRoot` announced in the sidecar's `hello`.
> - Cache hits are not `stat`-verified per request; a broken file is reported by the renderer's `<img>` error
>   and regenerated with `preview.ensure({ force })`.
> - Failures: corrupt/unsupported are permanent for a key (a replaced file gets a new key); permission,
>   missing-file and cache errors retry after 5 min / 1 min / 30 s.
> - Cleanup: LRU to 90 % of a 2 GB default ceiling (`FASTVIEW_CACHE_MAX_BYTES`), orphan sweep 16 shards per pass.

## Goal

Keep generated grid previews on the user's drive so that:

- reopening a folder is fast
- revisiting images avoids repeated decode/resize work
- the application install directory stays clean
- cache can be safely deleted without losing source files

## Cache root

Use the OS-appropriate per-user cache directory from Go (`os.UserCacheDir()`).

Under it:

```text
<user-cache>/FastView/
  v1/
    thumbnails/
    previews/
    db/
    tmp/
```

Do not hardcode platform-specific directories in application code.

## Cache key

The key must include:

```text
version
normalized source identity
source file size
source modification timestamp
preview profile
resize algorithm version
encoder version
```

Recommended representation:

```text
sha256(
  cacheVersion +
  normalizedPath +
  size +
  mtimeNs +
  profileId +
  transformVersion
)
```

The path is not enough.

A file can be replaced in place while retaining the same filename.

## Directory layout

Use sharded paths:

```text
thumbnails/
  ab/
    cd/
      <full-key>.jpg
```

Sharding avoids huge single directories on some filesystems.

## Format policy

Start with a fast browser-friendly encoded preview.

Default:

- JPEG for photographic opaque images
- WebP for alpha/transparency when beneficial

Do not optimize for theoretical compression ratio at the expense of decode/scroll performance.

The encoder policy is isolated so it can be benchmarked and changed later.

Video posters (Stage 06, ADR-0018) use the same profiles, keys, cache and encoder policy. ffmpeg extracts and scales
one frame, and Go encodes it like an image preview.

Folder covers (Stage 08.6, ADR-0024) also use the same keys and cache. They are generated for at most four files per
visible folder, without index rows (`previews.entry_id = 0`), so opening the folder later finds them as hits.

## Cache tiers

### Tier 1 — persistent disk

Long-lived preview files.

### Tier 2 — browser/image cache

Chromium caches recently used image resources.

### Tier 3 — optional application memory

An intentionally bounded LRU for hot full-view previews or decode results.

Never create an unbounded in-memory image cache.

## Cache lookup

1. derive key
2. check SQLite cache index
3. verify cache file exists when required
4. return preview URL
5. on miss, enqueue generation
6. when generated, notify interested UI batches

## Request coalescing

Example:

```text
10 UI components request key X
          │
          ▼
      scheduler
          │
          ▼
      one decode
          │
          ▼
      one cache write
          │
       ┌──┴──┐
       ▼     ▼
      all   callers
```

Never start ten identical decode jobs.

## Failure behavior

A failed preview generation:

- is recorded
- does not poison future attempts forever
- may be retried for transient failures
- falls back to a generic placeholder in the UI

Corrupt cache files can be deleted and regenerated.

If ffmpeg/ffprobe are missing, video previews fail without a recorded failure, so posters appear once the tools are
installed (ADR-0018).

## Cleanup

Cache cleanup runs as a background maintenance job.

Possible policies:

- maximum cache size
- LRU by last accessed
- stale version cleanup

Start with a configurable size ceiling and LRU deletion.

Never delete a source image as part of cache cleanup.

## Atomic writes

Write previews to a temporary file and atomically rename into place.

This prevents partially-written images from being treated as valid cache entries.

## Security

The preview protocol must not allow arbitrary filesystem path injection.

A renderer-provided cache key must resolve through the known cache index or a path derived from a validated key.

## Versioning

Increment cache format version when:

- encoder changes incompatibly
- dimensions/transform contract changes
- cache key algorithm changes

Old cache versions can be removed lazily.
