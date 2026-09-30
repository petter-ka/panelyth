# Preview Cache Design

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
