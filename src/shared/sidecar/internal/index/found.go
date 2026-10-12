package index

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"maps"
	"path/filepath"
	"time"

	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/natsort"
	"panelyth/sidecar/internal/pathkey"
)

// Found is one entry found outside a folder listing (find results, Stage
// C06). Only matches are written, so a search over a large tree costs one
// row per result, not one per entry walked.
type Found struct {
	// Dir is the cleaned OS path of the folder holding the entry.
	Dir     string
	Kind    media.Kind
	Name    string
	Ext     string
	Size    int64
	MtimeNs int64
	BtimeNs int64
	Attrs   int
}

// FoundDirs caches folder path → index row across PutFound calls of one
// search, so each folder is looked up (or created) once.
type FoundDirs map[string]DirRef

// PutFound upserts found entries in one transaction, creating their folders
// (and the folders between them and an indexed ancestor) as unlisted rows.
// It returns the entries' ids in order. A found entry is written with its
// fresh stat; a folder's later listing reconciles it like any other row.
func (s *Store) PutFound(ctx context.Context, gen int64, items []Found, dirs FoundDirs) ([]int64, error) {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UnixMilli()
	upsert, dirState := tx.StmtContext(ctx, s.upsertDir), tx.StmtContext(ctx, s.dirState)
	// New folder rows join the cache only once the transaction commits.
	created := FoundDirs{}
	var ensure func(path string, depth int) (DirRef, error)
	ensure = func(path string, depth int) (DirRef, error) {
		if d, ok := dirs[path]; ok {
			return d, nil
		}
		if d, ok := created[path]; ok {
			return d, nil
		}
		key := pathkey.DirKey(path)
		var id int64
		err := tx.QueryRowContext(ctx, `SELECT id FROM entries WHERE path_key = ? AND kind = 0`, key).Scan(&id)
		if err == nil {
			d := DirRef{ID: id, Path: path, Key: key}
			created[path] = d
			return d, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return DirRef{}, err
		}
		if depth > 4096 {
			return DirRef{}, fmt.Errorf("folder chain too deep at %q", path)
		}
		var parentID any
		name := filepath.Base(path)
		if parent := filepath.Dir(path); parent != path {
			p, err := ensure(parent, depth+1)
			if err != nil {
				return DirRef{}, err
			}
			parentID = p.ID
		} else {
			name = path // filesystem root
		}
		if err := upsert.QueryRowContext(ctx, parentID, int(media.KindDir), name, key, natsort.Key(name), FoldName(name),
			"", 0, 0, 0, 0, gen, now).Scan(&id); err != nil {
			return DirRef{}, fmt.Errorf("add folder %q: %w", path, err)
		}
		if _, err := dirState.ExecContext(ctx, id, path); err != nil {
			return DirRef{}, err
		}
		d := DirRef{ID: id, Path: path, Key: key}
		created[path] = d
		return d, nil
	}

	ids := make([]int64, len(items))
	for i := range items {
		f := &items[i]
		parent, err := ensure(f.Dir, 0)
		if err != nil {
			return nil, err
		}
		isDir := f.Kind == media.KindDir
		key := pathkey.ChildKey(parent.Key, f.Name, isDir)
		if err := upsert.QueryRowContext(ctx, parent.ID, int(f.Kind), f.Name, key, natsort.Key(f.Name), FoldName(f.Name),
			f.Ext, f.Size, f.MtimeNs, f.BtimeNs, f.Attrs, gen, now).Scan(&ids[i]); err != nil {
			return nil, fmt.Errorf("add %q: %w", f.Name, err)
		}
		if isDir {
			path := joinPath(f.Dir, f.Name)
			if _, err := dirState.ExecContext(ctx, ids[i], path); err != nil {
				return nil, err
			}
			created[path] = DirRef{ID: ids[i], Path: path, Key: key}
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	maps.Copy(dirs, created)
	return ids, nil
}

// ParentPaths returns the OS path of each entry's folder (rows of search
// results and branch views show where an entry lives).
func (s *Store) ParentPaths(ctx context.Context, ids []int64) (map[int64]string, error) {
	out := make(map[int64]string, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	js, err := idsJSON(ids)
	if err != nil {
		return nil, err
	}
	rows, err := s.r.QueryContext(ctx, `SELECT e.id, pd.path FROM entries e JOIN dir_state pd ON pd.entry_id = e.parent_id
		WHERE e.id IN (SELECT value FROM json_each(?))`, js)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var path string
		if err := rows.Scan(&id, &path); err != nil {
			return nil, err
		}
		out[id] = path
	}
	return out, rows.Err()
}

// Exists returns which of ids are still in the index.
func (s *Store) Exists(ctx context.Context, ids []int64) (map[int64]bool, error) {
	out := make(map[int64]bool, len(ids))
	const chunk = 5000
	for lo := 0; lo < len(ids); lo += chunk {
		js, err := idsJSON(ids[lo:min(lo+chunk, len(ids))])
		if err != nil {
			return nil, err
		}
		rows, err := s.r.QueryContext(ctx, `SELECT id FROM entries WHERE id IN (SELECT value FROM json_each(?))`, js)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			out[id] = true
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}
