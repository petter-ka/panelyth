# Stage 02 — Thumbnail Pipeline + Cache

Status: **Complete** (2026-09-30)

## Objective

Generate and persist previews without blocking the UI.

## Scope delivered

| Stage plan item | Implementation |
|---|---|
| decoder abstraction | `internal/imaging`: `Decoder` interface + `Registry` (JPEG, PNG, GIF first frame, BMP, TIFF, WebP). Pure Go (ADR-0019). Two steps: `ProbeFile` reads the header (dimensions, EXIF orientation, 1.3 ms for 12 MP), then `Render` decodes |
| source identity | `path_key + size + mtime`, re-checked with `stat` before decoding. A file changed since indexing updates the index row and uses the new key, so a stale preview is never served |
| preview profiles | `grid-sm` 192, `grid-md` 384, `grid-lg` 768, `viewer-fit` 2560 (long edge, device pixels) |
| cache key | `sha256(cacheVersion, path_key, size, mtime, profile, transformVersion, jpegQuality)` in `internal/preview/key.go` |
| sharded cache paths | `<cache>/v1/thumbnails/ab/cd/<key>.<jpg\|png>` |
| SQLite cache index | `previews` and `preview_failures` in `index.db` (schema v2; the v1 index is recreated, per ADR-0016) |
| bounded worker pool | `clamp(NumCPU/2, 2, 8)` workers, plus a **pixel-weighted memory budget** (250 MP in flight) so one 100 MP image and eight 12 MP images cost the same |
| deduplicated jobs | one task per key; later requests join it (`Scheduler.Submit`) |
| priority queue | 4 levels (visible, overscan, forward, idle), FIFO in request order; a promoted task takes its new request position |
| cancellation/deprioritization | per-lane epochs: a newer request drops that lane's queued, un-requested work; the queue is bounded at 2,000 (worst priority evicted, overflow reported as `deferred`); shutdown cancels running work |
| atomic cache writes | temp file in `<cache>/v1/tmp` (same volume) → rename; tmp cleared at startup |
| cache cleanup | LRU down to 90 % of a 2 GB ceiling (`FASTVIEW_CACHE_MAX_BYTES`); orphan sweep of 16 of 256 shards per pass; first pass after 30 s, then every 30 min; never touches source files |
| controlled preview protocol | `fastview-thumb://t/<64-hex>.<jpg\|png>`. Electron main resolves only that exact form under the sidecar-announced `thumbnailRoot` (from `hello`) and serves it asynchronously with immutable caching. No sidecar round trip, no path input from the renderer |

Also delivered:

- **Hits need no call.** `query.page({ thumbProfile })` attaches cached thumbnails to page rows, so a revisited folder paints without any `preview.ensure` call.
- **Failure memory.** Corrupt and unsupported files fail **permanently for that key**; a replaced file gets a new key and is retried. Permission, missing-file and cache errors retry after 5 min, 1 min and 30 s.
- **Metadata as a by-product.** Decoded dimensions (display orientation) and a `meta_state` are written to `entries` in batches, which lays the groundwork for sorting by dimensions (Stage 05).
- **Events.** `preview.ready` events are batched by the coalescer's new append mode (≤ 500 items per event, 50 ms).
- **Renderer.** An external thumbnail store keyed by entry id (not React state), with one subscriber per row. The list shows 40 px thumbnails in fixed geometry with no reflow. A broken `<img>` triggers one forced regeneration. The per-entry identity (size and mtime) invalidates thumbnails of files modified in place.
- **Video posters remain stubbed.** Videos return `UNSUPPORTED_MEDIA` and the UI shows a "Video" tile. ADR-0018 (ffmpeg) is still a proposal, needed for Stage 06. *(Resolved in Stage 06: ADR-0018 accepted, and posters go through this pipeline.)*

## Deviations from CACHE-DESIGN.md

- **No WebP output:** Go has no standard-library WebP encoder (ADR-0019), so alpha previews are PNG. The encoder policy is isolated in `imaging.Encode`.
- **Cache hits are not verified with `stat` on every request.** A missing or corrupt file surfaces as an `<img>` error in the renderer, which then sends a forced ensure. That keeps hits at 0.01 ms per item.

## Bugs found while testing, and fixed

1. **Rows modified in place never refreshed (a Stage 01 bug).** Query sessions only bumped their version when the *id list* changed. A file replaced in place keeps its position, so the renderer never refetched it. Every change notification now produces a new version; this is throttled, so it costs at most one page refetch per 250 ms. The renderer's thumbnail store also compares source identity.
2. **Scheduler map race.** A worker finishing after a new task for the same key had registered would have deleted the new task from the dedup map. It now deletes only its own entry.
3. **Promoted tasks jumped the queue.** They kept their original sequence number. They now take the promoting request's order.
4. **Benchmark results overwritten (again).** `indexbench` wrote a fixed `stage-01` name and replaced the Stage 01 index JSON during this stage's regression run, the same class of mistake as in Stage 01. All benchmark writers now use `scripts/results.mjs`: `BENCH_STAGE` is required, and an existing file is never replaced (a numeric suffix is added). The Stage 01 index numbers remain in `docs/viewer/stages/01-file-index.md`.

## Tests

| Suite | Count | New in this stage |
|---|---|---|
| Go | 16 packages | imaging (fit, JPEG render, EXIF rotate 6, orientation corner map for 2–8, PNG alpha stays PNG, unsupported / corrupt / truncated / 400 MP header refused, fast YCbCr path ≈ generic path), scheduler (10 identical requests → 1 decode, priority order + promotion, epoch drops stale work per lane, queue bound + eviction, fresh task after completion), service (generate → hit → restart hit, modified source miss, changed-without-rescan identity update, corrupt cache file forced regeneration, corrupt source and video fail permanently and are not retried, LRU + orphan cleanup never touches sources), key, disk cache, coalescer batching, golden frames for `preview.ensure`, `preview.ready` and pages with thumbs |
| Contracts | 20 | preview guards (thumb URL prefix, failed-code union, ≤ 500 items per event) |
| Desktop | 53 | `preview.ensure` / `thumbProfile` validation, `fastview-thumb` URL → path resolution (rejects wrong host, short or uppercase key, other extensions, traversal, encoded traversal, nested paths, query strings, other schemes) |
| Renderer | 47 | one batched ensure per page, folders never requested, ready/failed/other-profile events, page thumbs need no ensure, broken image regenerates once, folder switch forgets thumbs, in-place modification re-requests |
| E2E | 17 | Stage 02: incremental thumbnails then cache hits after restart (0 generated), modified image gets a new thumbnail, corrupt cache file regenerated, protocol refuses missing/foreign URLs |

## Benchmarks

Environment: Windows 11, i9-13900K (32 threads), 64 GB, NVMe, Go 1.27.0. Two runs of each. Results:
`shared/bench/results/stage-02-2026-09-30-petter-{previews,startup,index}.json` and `stage-02-2026-09-30-e2e-previews.jsonl`.

### Generation (`BENCH_STAGE=02 pnpm bench:previews`, 120 × 12 MP JPEG → `grid-md` 384 px)

| Workers | Throughput | Latency p50 / p95 (all 120 queued at once) | CPU cores busy | Disk writes |
|---|---|---|---|---|
| 1 | 7.3–13.5 img/s | 4.5–8.2 s / 8.5–15.7 s | 1.1 | 0.1–0.2 MB/s |
| 2 | 16.6–26.8 img/s | 2.3–3.7 s / 4.3–6.9 s | 2.0–2.1 | 0.3–0.4 MB/s |
| 4 | 33.1–48.6 img/s | 1.3–1.9 s / 2.4–3.5 s | 4.2 | 0.5–0.8 MB/s |
| 8 (default on this machine) | 65.2–78.8 img/s | 0.8–1.0 s / 1.4–1.8 s | 7.6–8.1 | 1.0–1.2 MB/s |

Scaling is near-linear and CPU-bound (cores busy ≈ workers), so there is no lock or I/O bottleneck. The first run was slower, probably from a cold OS file cache. Single-image render (Go benchmark): 12 MP → 192 px 58 ms, → 384 px 69 ms, → 768 px 114 ms. Average preview size is 16 KB (synthetic images; real photos will be larger).

### Cache

| Metric | Result |
|---|---|
| `preview.ensure` of 100 cached items (hit path) | p50 0.5–1.0 ms, p95 1.0–1.5 ms (≈ 0.01 ms/item) |
| Page thumb lookup for 100 rows (`query.page` with `thumbProfile`) | p95 0.5–1.2 ms |
| Coalescing: 200 requests for 20 images | 20 decodes, 180 joined, 20 ready items |

### In the app (e2e, 150 × 1600×1200 images, 100-row page)

| Metric | Result |
|---|---|
| Click → first thumbnail decoded on screen (cold cache) | 290–311 ms |
| Click → all 100 thumbnails on screen (cold) | 538–570 ms, in 5–6 `preview.ready` events |
| Long tasks while generating | 0 |
| After restart: all 100 thumbnails on screen | 294–296 ms, **0 generated** (all attached to the page) |

### Regressions checked

- **Startup:** ready-to-show p50 231 ms. Sidecar `hello` p50 119 ms (Stage 01: 112 ms), because the disk cache opens before the handshake. Idle memory 337 MB (+38.5 MB over empty Electron). Ping p95 0.6 ms. Sidecar exit p95 10 ms. All budgets pass.
- **Index:** throughput and paging are unchanged or better (cold 75k entries/s in a warm-cache run, page p95 ≤ 1.6 ms, query open 37–91 ms). The Go-runtime memory peak was 46 MB, within the 32 MB SQLite page-cache bound plus the base.

## Acceptance criteria

- [x] visible thumbnails appear incrementally (first thumbnail ~300 ms, full page ~550 ms, 5–6 batches)
- [x] repeated requests coalesce (200 → 20 decodes; one task per key)
- [x] restart produces cache hits (0 generations after restart, thumbnails attached to the page)
- [x] modified source produces a cache miss (new key from size/mtime; also when changed before a rescan)
- [x] corrupt cache item can be regenerated (renderer `<img>` error → forced ensure; e2e with a garbage file)

## Risks and follow-ups

- Pure-Go JPEG decoding dominates cost: about 70 ms per 12 MP image per core. Candidates behind the decoder interface, if the budget needs them (ADR-0019 requires numbers first): DCT-scaled decoding (libjpeg-turbo), or using embedded EXIF thumbnails for `grid-sm`.
- The cleanup pass at 30 s and then every 30 min is untested against a multi-GB cache in the app; the service tests cover the logic at small scale.
- On a 4-core laptop the default is 2 workers (about 15–25 img/s). Stage 03's visible-range prioritization matters more there. Stage P05 should measure on low-end hardware.
- Video posters (ADR-0018) are unresolved. *(Resolved in Stage 06.)*
- The first-page list is still the Stage 01 bounded table. Stage 03 replaces it with the virtualized tile view (tiles left to right, more per row on wider windows) and picks `grid-sm`/`grid-md`/`grid-lg` by tile size and DPR.

## Exit checklist

- [x] implementation complete
- [x] tests complete
- [x] benchmark complete
- [x] performance regression reviewed
- [x] docs/ADR updated
