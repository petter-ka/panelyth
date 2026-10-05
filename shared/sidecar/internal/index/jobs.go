package index

import (
	"context"
	"database/sql"
	"time"

	"fastview/sidecar/internal/media"
	"fastview/sidecar/internal/natsort"
	"fastview/sidecar/internal/pathkey"
)

// Batch jobs (Stage 07, ADR-0021): the journal, resolving job targets, and
// the index edits for items a job changed on disk.

// JobStarted records a running job; JobEnded closes the record.
func (s *Store) JobStarted(ctx context.Context, kind, destPath string, total int) (int64, error) {
	res, err := s.w.ExecContext(ctx, `INSERT INTO jobs (kind, state, dest_path, total, started_at) VALUES (?, 'running', ?, ?, ?)`,
		kind, nullString(destPath), total, time.Now().UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) JobEnded(ctx context.Context, id int64, state string, done, failed int) error {
	_, err := s.w.ExecContext(ctx, `UPDATE jobs SET state = ?, done = ?, failed = ?, finished_at = ? WHERE id = ?`,
		state, done, failed, time.Now().UnixMilli(), id)
	return err
}

// RecoverJobs marks jobs that were running when the process died as
// interrupted and returns their destination folders (for partial-file
// cleanup). Old finished records are trimmed to the newest 200.
func (s *Store) RecoverJobs(ctx context.Context) ([]string, error) {
	rows, err := s.w.QueryContext(ctx, `UPDATE jobs SET state = 'interrupted', finished_at = ?
		WHERE state = 'running' RETURNING COALESCE(dest_path, '')`, time.Now().UnixMilli())
	if err != nil {
		return nil, err
	}
	var dests []string
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			rows.Close()
			return nil, err
		}
		if d != "" {
			dests = append(dests, d)
		}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	_, err = s.w.ExecContext(ctx, `DELETE FROM jobs WHERE id NOT IN (SELECT id FROM jobs ORDER BY id DESC LIMIT 200)`)
	return dests, err
}

// Target is an entry a job operates on.
type Target struct {
	ID       int64
	ParentID int64
	Kind     media.Kind
	Name     string
	Path     string
	Key      string
	Size     int64
}

// Targets resolves ids (in order; missing ids are skipped).
func (s *Store) Targets(ctx context.Context, ids []int64) ([]Target, error) {
	paths, err := s.EntryPaths(ctx, ids)
	if err != nil || len(paths) == 0 {
		return []Target{}, err
	}
	js, err := idsJSON(ids)
	if err != nil {
		return nil, err
	}
	rows, err := s.r.QueryContext(ctx, `SELECT id, COALESCE(parent_id, 0), name, path_key, size_bytes FROM entries
		WHERE id IN (SELECT value FROM json_each(?))`, js)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type extra struct {
		parent int64
		name   string
		key    string
		size   int64
	}
	byID := make(map[int64]extra, len(paths))
	for rows.Next() {
		var id int64
		var e extra
		if err := rows.Scan(&id, &e.parent, &e.name, &e.key, &e.size); err != nil {
			return nil, err
		}
		byID[id] = e
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]Target, 0, len(paths))
	for _, p := range paths {
		e, ok := byID[p.ID]
		if !ok {
			continue
		}
		out = append(out, Target{ID: p.ID, ParentID: e.parent, Kind: p.Kind, Name: e.name, Path: p.Path, Key: e.key, Size: e.size})
	}
	return out, nil
}

// DirByPath returns an indexed directory by its clean OS path.
func (s *Store) DirByPath(ctx context.Context, cleanPath string) (DirInfo, error) {
	return s.dirByKey(ctx, pathkey.DirKey(cleanPath))
}

// Moved describes an entry that now lives elsewhere (move or rename). The
// row keeps its id; a folder's descendants are re-keyed.
type Moved struct {
	ID       int64
	ParentID int64
	Kind     media.Kind
	Name     string
	Ext      string
	// OldKey/NewKey are path keys; directory keys end in '/'.
	OldKey, NewKey string
	// OldPath/NewPath are OS paths (used for folders' dir_state).
	OldPath, NewPath string
}

// Changes are the index edits of one job flush.
type Changes struct {
	Removed []int64
	Moved   []Moved
}

// Empty reports whether there is nothing to apply.
func (c Changes) Empty() bool { return len(c.Removed) == 0 && len(c.Moved) == 0 }

// ApplyChanges writes a job's edits in one transaction. Removing a folder
// cascades to its indexed subtree (parent_id ON DELETE CASCADE).
func (s *Store) ApplyChanges(ctx context.Context, c Changes) error {
	if c.Empty() {
		return nil
	}
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if len(c.Removed) > 0 {
		js, err := idsJSON(c.Removed)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM entries WHERE id IN (SELECT value FROM json_each(?))`, js); err != nil {
			return err
		}
	}
	for _, m := range c.Moved {
		if err := applyMove(ctx, tx, m); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func applyMove(ctx context.Context, tx *sql.Tx, m Moved) error {
	isDir := m.Kind == media.KindDir
	if m.OldKey != m.NewKey {
		// Whatever the index still holds at the destination is stale (a
		// replaced file, or a folder deleted outside FastView).
		if isDir {
			lo, hi := pathkey.SubtreeRange(m.NewKey)
			if _, err := tx.ExecContext(ctx, `DELETE FROM entries WHERE (path_key = ? OR (path_key >= ? AND path_key < ?)) AND id <> ?`,
				m.NewKey, lo, hi, m.ID); err != nil {
				return err
			}
		} else if _, err := tx.ExecContext(ctx, `DELETE FROM entries WHERE path_key = ? AND id <> ?`, m.NewKey, m.ID); err != nil {
			return err
		}
	}
	var parent any
	if m.ParentID > 0 {
		parent = m.ParentID
	}
	if _, err := tx.ExecContext(ctx, `UPDATE entries SET parent_id = ?, kind = ?, name = ?, path_key = ?, name_nat = ?,
		name_fold = ?, ext = ? WHERE id = ?`,
		parent, int(m.Kind), m.Name, m.NewKey, natsort.Key(m.Name), FoldName(m.Name), m.Ext, m.ID); err != nil {
		return err
	}
	if !isDir {
		return nil
	}
	if m.OldKey != m.NewKey {
		lo, hi := pathkey.SubtreeRange(m.OldKey)
		if _, err := tx.ExecContext(ctx, `UPDATE entries SET path_key = ? || substr(path_key, ?)
			WHERE path_key >= ? AND path_key < ? AND id <> ?`, m.NewKey, len(m.OldKey)+1, lo, hi, m.ID); err != nil {
			return err
		}
	}
	// dir_state paths of the folder and its indexed subfolders. A case-only
	// rename keeps the key, so select by the (new) key range either way.
	lo, hi := pathkey.SubtreeRange(m.NewKey)
	_, err := tx.ExecContext(ctx, `UPDATE dir_state SET path = ? || substr(path, ?)
		WHERE entry_id IN (SELECT id FROM entries WHERE path_key = ? OR (path_key >= ? AND path_key < ?))
		AND substr(path, 1, ?) = ?`,
		m.NewPath, len(m.OldPath)+1, m.NewKey, lo, hi, len(m.OldPath), m.OldPath)
	return err
}

// MetaSource is an entry whose metadata (dimensions, duration) is unknown.
type MetaSource struct {
	ID    int64
	Kind  media.Kind
	Ext   string
	Path  string
	Size  int64
	Mtime int64
}

// MetaPending returns, in the given order, ids whose metadata has not been
// extracted yet (files with meta_state 0).
func (s *Store) MetaPending(ctx context.Context, ids []int64) ([]MetaSource, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	js, err := idsJSON(ids)
	if err != nil {
		return nil, err
	}
	rows, err := s.r.QueryContext(ctx, `SELECT e.id, e.kind, e.ext, d.path, e.name, e.size_bytes, e.mtime_ns
		FROM entries e JOIN dir_state d ON d.entry_id = e.parent_id
		WHERE e.id IN (SELECT value FROM json_each(?)) AND e.kind IN (1, 2) AND e.meta_state = 0`, js)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := map[int64]MetaSource{}
	for rows.Next() {
		var m MetaSource
		var kind int
		var dir, name string
		if err := rows.Scan(&m.ID, &kind, &m.Ext, &dir, &name, &m.Size, &m.Mtime); err != nil {
			return nil, err
		}
		m.Kind, m.Path = media.Kind(kind), joinPath(dir, name)
		byID[m.ID] = m
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]MetaSource, 0, len(byID))
	for _, id := range ids {
		if m, ok := byID[id]; ok {
			out = append(out, m)
		}
	}
	return out, nil
}

// ParentDirs returns the distinct parent ids and keys of ids (change routing
// for query sessions after metadata jobs).
func (s *Store) ParentDirs(ctx context.Context, ids []int64) (map[int64]string, error) {
	out := map[int64]string{}
	if len(ids) == 0 {
		return out, nil
	}
	js, err := idsJSON(ids)
	if err != nil {
		return nil, err
	}
	rows, err := s.r.QueryContext(ctx, `SELECT DISTINCT p.id, p.path_key FROM entries e JOIN entries p ON p.id = e.parent_id
		WHERE e.id IN (SELECT value FROM json_each(?))`, js)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var key string
		if err := rows.Scan(&id, &key); err != nil {
			return nil, err
		}
		out[id] = key
	}
	return out, rows.Err()
}

// KeyOf returns the path key for a child of a directory key.
func KeyOf(dirKey, name string, isDir bool) string { return pathkey.ChildKey(dirKey, name, isDir) }
