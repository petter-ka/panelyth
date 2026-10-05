package library

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Collections (albums) group files from anywhere by path_key (ADR-0022).
// Stage 08 delivers the data model and this store; the UI and RPCs come
// with the feature. Membership follows files through moves and renames
// (Rekey) and is dropped on permanent delete (Forget), like annotations.

// Limits for collections.
const (
	MaxCollectionName = 128
	MaxCollections    = 1_000
)

// ErrTooManyCollections is returned when creating beyond MaxCollections.
var ErrTooManyCollections = errors.New("library: too many collections")

// Collection is a named, ordered set of files.
type Collection struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// Collections lists collections in display order with their sizes.
func (l *Library) Collections(ctx context.Context) ([]Collection, error) {
	rows, err := l.db.QueryContext(ctx, `SELECT c.id, c.name, COUNT(ci.path_key) FROM collections c
		LEFT JOIN collection_items ci ON ci.collection_id = c.id GROUP BY c.id ORDER BY c.position, c.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Collection{}
	for rows.Next() {
		var c Collection
		if err := rows.Scan(&c.ID, &c.Name, &c.Count); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// cleanCollectionName trims and validates a collection name (NFC, no
// control characters, at most MaxCollectionName characters).
func cleanCollectionName(name string) (string, error) {
	clean := norm.NFC.String(strings.TrimSpace(name))
	if clean == "" || len([]rune(clean)) > MaxCollectionName || strings.ContainsFunc(clean, unicode.IsControl) {
		return "", ErrInvalid
	}
	return clean, nil
}

// CreateCollection appends a collection; names are unique case-insensitively.
func (l *Library) CreateCollection(ctx context.Context, name string) (Collection, error) {
	clean, err := cleanCollectionName(name)
	if err != nil {
		return Collection{}, err
	}
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return Collection{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var n int
	var maxPos sql.NullFloat64
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*), MAX(position) FROM collections`).Scan(&n, &maxPos); err != nil {
		return Collection{}, err
	}
	if n >= MaxCollections {
		return Collection{}, ErrTooManyCollections
	}
	c := Collection{Name: clean}
	err = tx.QueryRowContext(ctx, `INSERT INTO collections (name, name_fold, position, created_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (name_fold) DO NOTHING RETURNING id`,
		clean, FoldTag(clean), maxPos.Float64+1, time.Now().UnixMilli()).Scan(&c.ID)
	if errors.Is(err, sql.ErrNoRows) {
		return Collection{}, ErrInvalid // the name is taken
	}
	if err != nil {
		return Collection{}, err
	}
	return c, tx.Commit()
}

// RenameCollection changes a collection's name.
func (l *Library) RenameCollection(ctx context.Context, id int64, name string) error {
	clean, err := cleanCollectionName(name)
	if err != nil {
		return err
	}
	res, err := l.db.ExecContext(ctx, `UPDATE collections SET name = ?, name_fold = ? WHERE id = ?`, clean, FoldTag(clean), id)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return ErrInvalid
		}
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteCollection removes a collection (its files are untouched).
func (l *Library) DeleteCollection(ctx context.Context, id int64) error {
	res, err := l.db.ExecContext(ctx, `DELETE FROM collections WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// AddToCollection appends keys (in order) that are not members yet.
func (l *Library) AddToCollection(ctx context.Context, id int64, keys []string, done func(int)) error {
	if err := l.collectionExists(ctx, id); err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	return l.chunked(ctx, keys, done, func(tx *sql.Tx, chunk string) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO collection_items (collection_id, path_key, position, added_at)
			SELECT ?, j.value, (SELECT COALESCE(MAX(position), 0) FROM collection_items WHERE collection_id = ?) + j.key + 1, ?
			FROM json_each(?) j WHERE true
			ON CONFLICT DO NOTHING`, id, id, now, chunk)
		return err
	})
}

// RemoveFromCollection drops keys from a collection.
func (l *Library) RemoveFromCollection(ctx context.Context, id int64, keys []string, done func(int)) error {
	return l.chunked(ctx, keys, done, func(tx *sql.Tx, chunk string) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM collection_items WHERE collection_id = ?
			AND path_key IN (SELECT value FROM json_each(?))`, id, chunk)
		return err
	})
}

// CollectionKeys returns a collection's members in order (at most limit).
func (l *Library) CollectionKeys(ctx context.Context, id int64, limit int) ([]string, error) {
	if err := l.collectionExists(ctx, id); err != nil {
		return nil, err
	}
	rows, err := l.db.QueryContext(ctx, `SELECT path_key FROM collection_items WHERE collection_id = ?
		ORDER BY position, path_key LIMIT ?`, id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

func (l *Library) collectionExists(ctx context.Context, id int64) error {
	var one int
	err := l.db.QueryRowContext(ctx, `SELECT 1 FROM collections WHERE id = ?`, id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// rekeyCollections follows a move or rename inside Rekey's transaction.
// hi is the end of the old folder's key range ("" for a file). Memberships
// of a replaced destination are dropped first, as with annotations.
func rekeyCollections(ctx context.Context, tx *sql.Tx, oldKey, newKey, hi string) error {
	if hi == "" {
		if _, err := tx.ExecContext(ctx, `DELETE FROM collection_items WHERE path_key = ?`, newKey); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE collection_items SET path_key = ? WHERE path_key = ?`, newKey, oldKey)
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM collection_items WHERE path_key >= ? AND path_key < ?`,
		newKey, newKey[:len(newKey)-1]+"0"); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE collection_items SET path_key = ? || substr(path_key, ?)
		WHERE path_key >= ? AND path_key < ?`, newKey, len(oldKey)+1, oldKey, hi)
	return err
}
