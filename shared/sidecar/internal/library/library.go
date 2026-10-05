// Package library owns library.db: durable user data in the config directory
// (ADR-0016). Unlike index.db it is never discarded; schema changes are
// forward migrations.
package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// migrations are applied in order; never edit a released entry.
var migrations = []string{
	// 1: workspace settings, bookmarks, recent folders (Stage 05).
	`CREATE TABLE settings (
		key        TEXT PRIMARY KEY,
		value_json TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	) WITHOUT ROWID;
	CREATE TABLE bookmarks (
		id         INTEGER PRIMARY KEY,
		path       TEXT NOT NULL UNIQUE,
		label      TEXT NOT NULL,
		position   REAL NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE TABLE recent (
		path_key       TEXT PRIMARY KEY,
		path           TEXT NOT NULL,
		last_opened_at INTEGER NOT NULL,
		open_count     INTEGER NOT NULL DEFAULT 1
	) WITHOUT ROWID;
	CREATE INDEX recent_by_time ON recent(last_opened_at DESC);`,
	// 2: favorites, ratings and tags of files (Stage 07, ADR-0021). Rows
	// exist only for annotated files and are keyed like index.db entries.
	`CREATE TABLE items (
		id         INTEGER PRIMARY KEY,
		path_key   TEXT NOT NULL UNIQUE,
		favorite   INTEGER NOT NULL DEFAULT 0,
		rating     INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE tags (
		id         INTEGER PRIMARY KEY,
		name       TEXT NOT NULL,
		name_fold  TEXT NOT NULL UNIQUE,
		created_at INTEGER NOT NULL
	);
	CREATE TABLE item_tags (
		item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
		tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
		PRIMARY KEY (item_id, tag_id)
	) WITHOUT ROWID;
	CREATE INDEX item_tags_by_tag ON item_tags(tag_id, item_id);`,
	// 3: color labels and collections (Stage 08, ADR-0022). A label is one
	// of seven fixed colors (0 = none). Collection membership is keyed by
	// path_key on its own, so it survives an item losing all its metadata.
	`ALTER TABLE items ADD COLUMN label INTEGER NOT NULL DEFAULT 0 CHECK (label BETWEEN 0 AND 7);
	CREATE TABLE collections (
		id         INTEGER PRIMARY KEY,
		name       TEXT NOT NULL,
		name_fold  TEXT NOT NULL UNIQUE,
		position   REAL NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE TABLE collection_items (
		collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
		path_key      TEXT    NOT NULL,
		position      REAL    NOT NULL,
		added_at      INTEGER NOT NULL,
		PRIMARY KEY (collection_id, path_key)
	) WITHOUT ROWID;
	CREATE INDEX collection_items_by_key ON collection_items(path_key);`,
}

// Limits keep user-controlled data bounded.
const (
	MaxSettingKey   = 128
	MaxSettingBytes = 64 << 10
	MaxBookmarks    = 500
	MaxRecent       = 50
)

var (
	ErrNotFound     = errors.New("library: not found")
	ErrInvalid      = errors.New("library: invalid input")
	ErrTooManyItems = errors.New("library: too many bookmarks")
)

// Library is safe for concurrent use.
type Library struct{ db *sql.DB }

// Open opens or creates library.db and applies pending migrations.
func Open(path string) (*Library, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+
		"?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // tiny, write-light database: one connection serializes everything
	l := &Library{db: db}
	if err := l.migrate(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate library.db: %w", err)
	}
	return l, nil
}

func (l *Library) migrate() error {
	if _, err := l.db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		return err
	}
	var current int
	if err := l.db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&current); err != nil {
		return err
	}
	if current > len(migrations) {
		return fmt.Errorf("library.db is from a newer FastView (schema %d > %d)", current, len(migrations))
	}
	for v := current + 1; v <= len(migrations); v++ {
		tx, err := l.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[v-1]); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration %d: %w", v, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`, v, time.Now().UnixMilli()); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// SchemaVersion reports the applied migration count (tests, diagnostics).
func (l *Library) SchemaVersion() (int, error) {
	var v int
	err := l.db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&v)
	return v, err
}

// Close releases the database.
func (l *Library) Close() error { return l.db.Close() }

// Settings returns all settings as raw JSON values.
func (l *Library) Settings(ctx context.Context) (map[string]json.RawMessage, error) {
	rows, err := l.db.QueryContext(ctx, `SELECT key, value_json FROM settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]json.RawMessage{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = json.RawMessage(v)
	}
	return out, rows.Err()
}

// SetSetting stores one JSON value (validated, size-limited).
func (l *Library) SetSetting(ctx context.Context, key string, value json.RawMessage) error {
	if key == "" || len(key) > MaxSettingKey || len(value) > MaxSettingBytes || !json.Valid(value) {
		return ErrInvalid
	}
	_, err := l.db.ExecContext(ctx, `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		key, string(value), time.Now().UnixMilli())
	return err
}

// Bookmark is a pinned folder.
type Bookmark struct {
	ID    int64  `json:"id"`
	Path  string `json:"path"`
	Label string `json:"label"`
}

// Bookmarks returns bookmarks in display order.
func (l *Library) Bookmarks(ctx context.Context) ([]Bookmark, error) {
	rows, err := l.db.QueryContext(ctx, `SELECT id, path, label FROM bookmarks ORDER BY position, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Bookmark{}
	for rows.Next() {
		var b Bookmark
		if err := rows.Scan(&b.ID, &b.Path, &b.Label); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// AddBookmark appends a folder (idempotent per path).
func (l *Library) AddBookmark(ctx context.Context, path, label string) (Bookmark, error) {
	if path == "" || len(path) > 32767 || len(label) > 256 {
		return Bookmark{}, ErrInvalid
	}
	if label == "" {
		label = filepath.Base(path)
	}
	var n int
	if err := l.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM bookmarks`).Scan(&n); err != nil {
		return Bookmark{}, err
	}
	var existing Bookmark
	err := l.db.QueryRowContext(ctx, `SELECT id, path, label FROM bookmarks WHERE path = ?`, path).Scan(&existing.ID, &existing.Path, &existing.Label)
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Bookmark{}, err
	}
	if n >= MaxBookmarks {
		return Bookmark{}, ErrTooManyItems
	}
	res, err := l.db.ExecContext(ctx, `INSERT INTO bookmarks (path, label, position, created_at)
		VALUES (?, ?, COALESCE((SELECT MAX(position) FROM bookmarks), 0) + 1, ?)`, path, label, time.Now().UnixMilli())
	if err != nil {
		return Bookmark{}, err
	}
	id, _ := res.LastInsertId()
	return Bookmark{ID: id, Path: path, Label: label}, nil
}

// RemoveBookmark deletes one bookmark; ErrNotFound if it did not exist.
func (l *Library) RemoveBookmark(ctx context.Context, id int64) error {
	res, err := l.db.ExecContext(ctx, `DELETE FROM bookmarks WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// RecentFolder is a recently opened folder.
type RecentFolder struct {
	Path         string `json:"path"`
	LastOpenedAt int64  `json:"lastOpenedAt"`
}

// TouchRecent records an opened folder and keeps only the newest MaxRecent.
func (l *Library) TouchRecent(ctx context.Context, pathKey, path string) error {
	now := time.Now().UnixMilli()
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO recent (path_key, path, last_opened_at) VALUES (?, ?, ?)
		ON CONFLICT (path_key) DO UPDATE SET path = excluded.path, last_opened_at = excluded.last_opened_at,
		open_count = recent.open_count + 1`, pathKey, path, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM recent WHERE path_key NOT IN
		(SELECT path_key FROM recent ORDER BY last_opened_at DESC LIMIT ?)`, MaxRecent); err != nil {
		return err
	}
	return tx.Commit()
}

// Recent returns up to limit folders, newest first.
func (l *Library) Recent(ctx context.Context, limit int) ([]RecentFolder, error) {
	if limit <= 0 || limit > MaxRecent {
		limit = MaxRecent
	}
	rows, err := l.db.QueryContext(ctx, `SELECT path, last_opened_at FROM recent ORDER BY last_opened_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RecentFolder{}
	for rows.Next() {
		var r RecentFolder
		if err := rows.Scan(&r.Path, &r.LastOpenedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
