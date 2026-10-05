package index

// schemaVersion is stored in meta. index.db is disposable (ADR-0016): an
// incompatible version is not migrated; the file is recreated.
// v2: preview cache tables (Stage 02); v3: name_fold, btime_ns (Stage 05);
// v4: duration_ms, meta_state (Stage 07, ADR-0021); v5: every entry with
// attrs, dir_size_bytes (Stage P02, ADR-0026). The jobs table is created with
// IF NOT EXISTS and needs no bump of its own.
const schemaVersion = 5

// Directories and all other entries share one table and id space (ADR-0015,
// ADR-0026); queries choose their scope (media or all).
// The "kind <> 0" expression puts directories first in every ordering and is
// part of each listing index so ORDER BY can walk the index. Dimensions have no
// index: they are mostly unknown until previews exist, and the in-memory sort
// of 100k rows opens in ~60 ms (indexbench, Stage 05).
const schemaSQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY,
  parent_id   INTEGER REFERENCES entries(id) ON DELETE CASCADE,
  kind        INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  path_key    TEXT    NOT NULL UNIQUE,
  name_nat    TEXT    NOT NULL,
  name_fold   TEXT    NOT NULL,
  ext         TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  mtime_ns    INTEGER NOT NULL DEFAULT 0,
  btime_ns    INTEGER NOT NULL DEFAULT 0,
  width       INTEGER,
  height      INTEGER,
  duration_ms INTEGER,
  meta_state  INTEGER NOT NULL DEFAULT 0,
  attrs       INTEGER NOT NULL DEFAULT 0,
  dir_size_bytes INTEGER,
  seen_gen    INTEGER NOT NULL,
  indexed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_parent_nat   ON entries(parent_id, kind <> 0, name_nat);
CREATE INDEX IF NOT EXISTS entries_parent_mtime ON entries(parent_id, kind <> 0, mtime_ns);
CREATE INDEX IF NOT EXISTS entries_parent_size  ON entries(parent_id, kind <> 0, size_bytes);
CREATE INDEX IF NOT EXISTS entries_parent_btime ON entries(parent_id, kind <> 0, btime_ns);

CREATE TABLE IF NOT EXISTS dir_state (
  entry_id       INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  path           TEXT    NOT NULL,
  listing_gen    INTEGER NOT NULL DEFAULT 0,
  listing_state  INTEGER NOT NULL DEFAULT 0,
  child_dirs     INTEGER NOT NULL DEFAULT 0,
  child_media    INTEGER NOT NULL DEFAULT 0,
  skipped        INTEGER NOT NULL DEFAULT 0,
  last_listed_at INTEGER,
  error_code     TEXT
);

-- Preview cache index (CACHE-DESIGN.md, ADR-0003). cache_key is the 32-byte
-- sha256 of source identity + profile + transform version; entry_id is
-- advisory (cache rows outlive index rows until cleanup).
CREATE TABLE IF NOT EXISTS previews (
  cache_key        BLOB PRIMARY KEY,
  entry_id         INTEGER,
  profile          TEXT    NOT NULL,
  format           TEXT    NOT NULL,
  width            INTEGER NOT NULL,
  height           INTEGER NOT NULL,
  byte_size        INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS previews_lru ON previews(last_accessed_at);

-- Failed generations. retry_after NULL = permanent for this key (corrupt or
-- unsupported); a changed source file gets a new key and is retried.
CREATE TABLE IF NOT EXISTS preview_failures (
  cache_key       BLOB PRIMARY KEY,
  code            TEXT    NOT NULL,
  attempts        INTEGER NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  retry_after     INTEGER
) WITHOUT ROWID;

-- Batch job journal (Stage 07, ADR-0021): only what startup recovery needs.
-- (Schema v4 recreates older index.db files; see schemaVersion.)
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT    NOT NULL,
  state       TEXT    NOT NULL,
  dest_path   TEXT,
  total       INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS scans (
  id          INTEGER PRIMARY KEY,
  root_id     INTEGER NOT NULL,
  recursive   INTEGER NOT NULL,
  generation  INTEGER NOT NULL,
  state       INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  dirs_listed INTEGER NOT NULL DEFAULT 0,
  entries     INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0
);
`

// dir_state.listing_state
const (
	ListingNever    = 0
	ListingPartial  = 1
	ListingComplete = 2
	ListingError    = 3
)

// scans.state
const (
	ScanRunning     = 0
	ScanCompleted   = 1
	ScanCancelled   = 2
	ScanFailed      = 3
	ScanInterrupted = 4
)

const upsertEntrySQL = `
INSERT INTO entries (parent_id, kind, name, path_key, name_nat, name_fold, ext, size_bytes, mtime_ns, btime_ns, attrs, seen_gen, indexed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (path_key) DO UPDATE SET
  parent_id   = excluded.parent_id,
  kind        = excluded.kind,
  attrs       = excluded.attrs,
  name        = excluded.name,
  name_nat    = excluded.name_nat,
  name_fold   = excluded.name_fold,
  ext         = excluded.ext,
  meta_state  = CASE WHEN entries.size_bytes <> excluded.size_bytes OR entries.mtime_ns <> excluded.mtime_ns
                     THEN 0 ELSE entries.meta_state END,
  width       = CASE WHEN entries.size_bytes <> excluded.size_bytes OR entries.mtime_ns <> excluded.mtime_ns
                     THEN NULL ELSE entries.width END,
  height      = CASE WHEN entries.size_bytes <> excluded.size_bytes OR entries.mtime_ns <> excluded.mtime_ns
                     THEN NULL ELSE entries.height END,
  duration_ms = CASE WHEN entries.size_bytes <> excluded.size_bytes OR entries.mtime_ns <> excluded.mtime_ns
                     THEN NULL ELSE entries.duration_ms END,
  size_bytes  = excluded.size_bytes,
  mtime_ns    = excluded.mtime_ns,
  btime_ns    = excluded.btime_ns,
  seen_gen    = excluded.seen_gen,
  indexed_at  = excluded.indexed_at`

const upsertDirStateSQL = `
INSERT INTO dir_state (entry_id, path) VALUES (?, ?)
ON CONFLICT (entry_id) DO UPDATE SET path = excluded.path`
