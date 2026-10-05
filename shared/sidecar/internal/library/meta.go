package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// User metadata of files: favorite, 0–5 rating, tags (ADR-0021) and a color
// label (ADR-0022). Rows are keyed by index path_key; an item without any of
// them is deleted, so the tables only grow with what the user annotated.

// Limits for user-controlled metadata.
const (
	MaxTagName = 64
	MaxTags    = 10_000
	MaxRating  = 5
	// MaxLabel is the highest color label (1..7 = red, orange, yellow, green,
	// blue, purple, gray; 0 = none). The order is part of the contract.
	MaxLabel = 7
	// ChunkSize is the number of items written per transaction.
	ChunkSize = 1000
)

// ErrTooManyTags is returned when creating a tag beyond MaxTags.
var ErrTooManyTags = errors.New("library: too many tags")

// Tag is a tag with the number of items carrying it.
type Tag struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// Annotation is what the library knows about one path key.
type Annotation struct {
	Favorite bool
	Rating   int
	Label    int
	Tags     []string // display names, alphabetical
}

// FoldTag is the comparison form of a tag name.
func FoldTag(name string) string { return strings.ToLower(norm.NFC.String(strings.TrimSpace(name))) }

// CleanTag trims and validates a tag name.
func CleanTag(name string) (string, error) {
	name = norm.NFC.String(strings.TrimSpace(name))
	if name == "" || len([]rune(name)) > MaxTagName {
		return "", ErrInvalid
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", ErrInvalid
		}
	}
	return name, nil
}

func keysJSON(keys []string) string {
	b, _ := json.Marshal(keys)
	return string(b)
}

// chunked runs fn over keys in transactions of ChunkSize, reporting each
// finished chunk so a job can show progress and stop between chunks.
func (l *Library) chunked(ctx context.Context, keys []string, done func(n int), fn func(tx *sql.Tx, chunk string) error) error {
	for lo := 0; lo < len(keys); lo += ChunkSize {
		part := keys[lo:min(lo+ChunkSize, len(keys))]
		tx, err := l.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if err := fn(tx, keysJSON(part)); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		if done != nil {
			done(len(part))
		}
	}
	return nil
}

const ensureItemsSQL = `INSERT INTO items (path_key, updated_at)
	SELECT value, ? FROM json_each(?) WHERE true
	ON CONFLICT (path_key) DO NOTHING`

// pruneSQL drops items that no longer carry any metadata.
const pruneSQL = `DELETE FROM items WHERE path_key IN (SELECT value FROM json_each(?))
	AND favorite = 0 AND rating = 0 AND label = 0 AND NOT EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = items.id)`

// SetFavorite sets or clears the favorite flag of every key.
func (l *Library) SetFavorite(ctx context.Context, keys []string, value bool, done func(int)) error {
	return l.setColumn(ctx, keys, "favorite", boolInt(value), done)
}

// SetRating sets the 0–5 rating of every key (0 clears it).
func (l *Library) SetRating(ctx context.Context, keys []string, rating int, done func(int)) error {
	if rating < 0 || rating > MaxRating {
		return ErrInvalid
	}
	return l.setColumn(ctx, keys, "rating", rating, done)
}

// SetLabel sets the color label of every key (0 clears it).
func (l *Library) SetLabel(ctx context.Context, keys []string, label int, done func(int)) error {
	if label < 0 || label > MaxLabel {
		return ErrInvalid
	}
	return l.setColumn(ctx, keys, "label", label, done)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// setColumn's column is one of the constants above, never user input.
func (l *Library) setColumn(ctx context.Context, keys []string, column string, value int, done func(int)) error {
	now := time.Now().UnixMilli()
	return l.chunked(ctx, keys, done, func(tx *sql.Tx, chunk string) error {
		if value != 0 {
			if _, err := tx.ExecContext(ctx, ensureItemsSQL, now, chunk); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE items SET `+column+` = ?, updated_at = ?
			WHERE path_key IN (SELECT value FROM json_each(?))`, value, now, chunk); err != nil {
			return err
		}
		if value == 0 {
			_, err := tx.ExecContext(ctx, pruneSQL, chunk)
			return err
		}
		return nil
	})
}

// EnsureTag returns a tag's id, creating it when create is set.
func (l *Library) EnsureTag(ctx context.Context, name string, create bool) (int64, error) {
	clean, err := CleanTag(name)
	if err != nil {
		return 0, err
	}
	var id int64
	err = l.db.QueryRowContext(ctx, `SELECT id FROM tags WHERE name_fold = ?`, FoldTag(clean)).Scan(&id)
	if err == nil || !errors.Is(err, sql.ErrNoRows) {
		return id, err
	}
	if !create {
		return 0, ErrNotFound
	}
	var n int
	if err := l.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM tags`).Scan(&n); err != nil {
		return 0, err
	}
	if n >= MaxTags {
		return 0, ErrTooManyTags
	}
	err = l.db.QueryRowContext(ctx, `INSERT INTO tags (name, name_fold, created_at) VALUES (?, ?, ?) RETURNING id`,
		clean, FoldTag(clean), time.Now().UnixMilli()).Scan(&id)
	return id, err
}

// SetTag adds or removes one tag on every key. Removing the last use of a
// tag keeps the tag (it stays in the tag list until deleted explicitly).
func (l *Library) SetTag(ctx context.Context, keys []string, name string, add bool, done func(int)) error {
	tagID, err := l.EnsureTag(ctx, name, add)
	if errors.Is(err, ErrNotFound) {
		if done != nil {
			done(len(keys))
		}
		return nil // removing a tag nobody has
	}
	if err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	return l.chunked(ctx, keys, done, func(tx *sql.Tx, chunk string) error {
		if !add {
			if _, err := tx.ExecContext(ctx, `DELETE FROM item_tags WHERE tag_id = ? AND item_id IN
				(SELECT id FROM items WHERE path_key IN (SELECT value FROM json_each(?)))`, tagID, chunk); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, pruneSQL, chunk)
			return err
		}
		if _, err := tx.ExecContext(ctx, ensureItemsSQL, now, chunk); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO item_tags (item_id, tag_id)
			SELECT id, ? FROM items WHERE path_key IN (SELECT value FROM json_each(?))
			ON CONFLICT DO NOTHING`, tagID, chunk)
		return err
	})
}

// Tags lists every tag with its use count, alphabetically.
func (l *Library) Tags(ctx context.Context) ([]Tag, error) {
	rows, err := l.db.QueryContext(ctx, `SELECT t.id, t.name, COUNT(it.item_id) FROM tags t
		LEFT JOIN item_tags it ON it.tag_id = t.id GROUP BY t.id ORDER BY t.name_fold`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Tag{}
	for rows.Next() {
		var t Tag
		if err := rows.Scan(&t.ID, &t.Name, &t.Count); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// DeleteTag removes a tag from every item.
func (l *Library) DeleteTag(ctx context.Context, id int64) error {
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var keys []string
	rows, err := tx.QueryContext(ctx, `SELECT i.path_key FROM items i JOIN item_tags it ON it.item_id = i.id WHERE it.tag_id = ?`, id)
	if err != nil {
		return err
	}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, k)
	}
	rows.Close()
	res, err := tx.ExecContext(ctx, `DELETE FROM tags WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, pruneSQL, keysJSON(keys)); err != nil {
		return err
	}
	return tx.Commit()
}

// Annotations returns the metadata of the given keys (pages, properties);
// keys without any are absent from the map.
func (l *Library) Annotations(ctx context.Context, keys []string, withTags bool) (map[string]Annotation, error) {
	out := map[string]Annotation{}
	if len(keys) == 0 {
		return out, nil
	}
	rows, err := l.db.QueryContext(ctx, `SELECT id, path_key, favorite, rating, label FROM items
		WHERE path_key IN (SELECT value FROM json_each(?))`, keysJSON(keys))
	if err != nil {
		return nil, err
	}
	ids := map[int64]string{}
	for rows.Next() {
		var id int64
		var k string
		var a Annotation
		if err := rows.Scan(&id, &k, &a.Favorite, &a.Rating, &a.Label); err != nil {
			rows.Close()
			return nil, err
		}
		out[k] = a
		ids[id] = k
	}
	rows.Close()
	if err := rows.Err(); err != nil || !withTags || len(ids) == 0 {
		return out, err
	}
	idList := make([]int64, 0, len(ids))
	for id := range ids {
		idList = append(idList, id)
	}
	b, _ := json.Marshal(idList)
	trows, err := l.db.QueryContext(ctx, `SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
		WHERE it.item_id IN (SELECT value FROM json_each(?)) ORDER BY t.name_fold`, string(b))
	if err != nil {
		return nil, err
	}
	defer trows.Close()
	for trows.Next() {
		var id int64
		var name string
		if err := trows.Scan(&id, &name); err != nil {
			return nil, err
		}
		k := ids[id]
		a := out[k]
		a.Tags = append(a.Tags, name)
		out[k] = a
	}
	return out, trows.Err()
}

// ScopeRow is one annotated key inside a query scope.
type ScopeRow struct {
	Key      string
	Favorite bool
	Rating   int
	// FirstTag is the alphabetically first tag (folded), "" when untagged.
	FirstTag string
	// Match is true when the item carries every tag of the filter (always
	// true without a tag filter).
	Match bool
}

// Scope returns annotations of all keys in [lo, hi) (a folder subtree;
// ADR-0021: passed to the index query instead of ATTACH). tagFilter names
// tags an item must all carry; an unknown tag matches nothing.
func (l *Library) Scope(ctx context.Context, lo, hi string, tagFilter []string) ([]ScopeRow, error) {
	var tagIDs []int64
	for _, name := range tagFilter {
		id, err := l.EnsureTag(ctx, name, false)
		if errors.Is(err, ErrNotFound) || errors.Is(err, ErrInvalid) {
			id = -1 // matches nothing
		} else if err != nil {
			return nil, err
		}
		tagIDs = append(tagIDs, id)
	}
	tagJSON, _ := json.Marshal(tagIDs)
	rows, err := l.db.QueryContext(ctx, `SELECT i.path_key, i.favorite, i.rating,
		COALESCE((SELECT MIN(t.name_fold) FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id), ''),
		(SELECT COUNT(*) FROM item_tags it WHERE it.item_id = i.id AND it.tag_id IN (SELECT value FROM json_each(?))) = ?
		FROM items i WHERE i.path_key >= ? AND i.path_key < ?`, string(tagJSON), len(tagIDs), lo, hi)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ScopeRow{}
	for rows.Next() {
		var r ScopeRow
		if err := rows.Scan(&r.Key, &r.Favorite, &r.Rating, &r.FirstTag, &r.Match); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Rekey moves metadata from oldKey to newKey after a move or rename. For a
// folder (keys ending in '/') every descendant key is rewritten. Metadata
// already at the destination (a replaced file) is dropped first.
func (l *Library) Rekey(ctx context.Context, oldKey, newKey string) error {
	if oldKey == newKey {
		return nil
	}
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if strings.HasSuffix(oldKey, "/") {
		hi := oldKey[:len(oldKey)-1] + "0"
		if _, err := tx.ExecContext(ctx, `DELETE FROM items WHERE path_key >= ? AND path_key < ?`, newKey, newKey[:len(newKey)-1]+"0"); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE items SET path_key = ? || substr(path_key, ?)
			WHERE path_key >= ? AND path_key < ?`, newKey, len(oldKey)+1, oldKey, hi); err != nil {
			return err
		}
		if err := rekeyCollections(ctx, tx, oldKey, newKey, hi); err != nil {
			return err
		}
	} else {
		if _, err := tx.ExecContext(ctx, `DELETE FROM items WHERE path_key = ?`, newKey); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE items SET path_key = ? WHERE path_key = ?`, newKey, oldKey); err != nil {
			return err
		}
		if err := rekeyCollections(ctx, tx, oldKey, newKey, ""); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Forget deletes the metadata of permanently deleted keys (folder keys
// include their subtree).
func (l *Library) Forget(ctx context.Context, keys []string) error {
	files := slices.DeleteFunc(slices.Clone(keys), func(k string) bool { return strings.HasSuffix(k, "/") })
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, table := range []string{"items", "collection_items"} {
		if _, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE path_key IN (SELECT value FROM json_each(?))`, keysJSON(files)); err != nil {
			return err
		}
		for _, k := range keys {
			if strings.HasSuffix(k, "/") {
				if _, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE path_key >= ? AND path_key < ?`, k, k[:len(k)-1]+"0"); err != nil {
					return err
				}
			}
		}
	}
	return tx.Commit()
}
