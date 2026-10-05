# ADR-0016 — Disposable Index vs. Durable User Data

## Status

Accepted (Stage 01), by default: adopted from `docs/ARCHITECTURE-ANALYSIS.md` C2. Only `index.db` exists so
far; `library.db` arrives with the first user data (Stage 05: bookmarks, recent, settings).

## Implementation (Stage 05)

`library.db` exists: `internal/library`, with tables `settings` (JSON values; "workspace"), `bookmarks` (≤ 500) and
`recent` (keyed by `path_key`, newest 50 kept), plus `schema_migrations`. Migrations are forward-only and a newer
schema refuses to open rather than being altered. It opens in the background at sidecar start; if it can't be opened,
browsing works and user-data methods fail with DB_ERROR. `index.db` does not ATTACH it yet (Stage 07, sorting by user
data). `index.db` itself moved to schema v3 (`name_fold`, `btime_ns`) by recreation, as this ADR allows.

## Context

CACHE-DESIGN.md put the database under the OS cache root, which "can be safely deleted" and which macOS may
purge. Favorites, ratings, tags, bookmarks and settings (FR-18, NFR-09) must not live there.

## Decision

| Database | Location | Contents | Disposable |
|---|---|---|---|
| `index.db` | `<UserCacheDir>/FastView/v1/db/index.db` | filesystem mirror, scans, preview-cache index | yes: rebuilt on demand |
| `library.db` | `<UserConfigDir>/FastView/library.db` | favorites, ratings, tags, collections, bookmarks, recent, settings | no |

- `library.db` rows are keyed by `path_key`, and `index.db` attaches it for sorting and filtering by user data.
- Changing the index schema incompatibly bumps the cache version directory (`v1` → `v2`), and the old index is
  dropped lazily. `library.db` uses real migrations and is never discarded.
- Both use WAL, `synchronous=NORMAL`, `foreign_keys=ON`, one writer connection and a small read pool.
