package index

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"panelyth/sidecar/internal/media"
)

// idsJSON passes an id set as one bound parameter (json_each), so statements
// over large selections need neither chunking nor huge placeholder lists.
func idsJSON(ids []int64) (string, error) {
	b, err := json.Marshal(ids)
	return string(b), err
}

// Summary aggregates a set of entries (selection count and size). Folder
// sizes are not recursive: folders count, their contents only once a folder
// size was calculated (Stage C02, dirSize jobs).
type Summary struct {
	Count  int   `json:"count"`
	Bytes  int64 `json:"bytes"`
	Dirs   int   `json:"folders"`
	Images int   `json:"images"`
	Videos int   `json:"videos"`
}

// Summarize counts ids that still exist.
func (s *Store) Summarize(ctx context.Context, ids []int64) (Summary, error) {
	var sum Summary
	if len(ids) == 0 {
		return sum, nil
	}
	js, err := idsJSON(ids)
	if err != nil {
		return sum, err
	}
	rows, err := s.r.QueryContext(ctx, `SELECT kind, COUNT(*), COALESCE(SUM(CASE kind WHEN 0 THEN COALESCE(dir_size_bytes, 0) ELSE size_bytes END), 0) FROM entries
		WHERE id IN (SELECT value FROM json_each(?)) GROUP BY kind`, js)
	if err != nil {
		return sum, err
	}
	defer rows.Close()
	for rows.Next() {
		var kind, n int
		var bytes int64
		if err := rows.Scan(&kind, &n, &bytes); err != nil {
			return sum, err
		}
		sum.Count += n
		sum.Bytes += bytes
		switch media.Kind(kind) {
		case media.KindDir:
			sum.Dirs = n
		case media.KindImage:
			sum.Images = n
		case media.KindVideo:
			sum.Videos = n
		}
	}
	return sum, rows.Err()
}

// EntryPath is an entry's OS path.
type EntryPath struct {
	ID   int64
	Kind media.Kind
	Path string
}

// EntryPaths returns OS paths for ids in the given order; ids that no longer
// exist are skipped.
func (s *Store) EntryPaths(ctx context.Context, ids []int64) ([]EntryPath, error) {
	if len(ids) == 0 {
		return []EntryPath{}, nil
	}
	js, err := idsJSON(ids)
	if err != nil {
		return nil, err
	}
	rows, err := s.r.QueryContext(ctx, `SELECT e.id, e.kind, e.name, d.path, pd.path FROM entries e
		LEFT JOIN dir_state d ON d.entry_id = e.id
		LEFT JOIN dir_state pd ON pd.entry_id = e.parent_id
		WHERE e.id IN (SELECT value FROM json_each(?))`, js)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := make(map[int64]EntryPath, len(ids))
	for rows.Next() {
		var p EntryPath
		var kind int
		var name string
		var own, parent sql.NullString
		if err := rows.Scan(&p.ID, &kind, &name, &own, &parent); err != nil {
			return nil, err
		}
		p.Kind = media.Kind(kind)
		switch {
		case p.Kind == media.KindDir && own.Valid:
			p.Path = own.String
		case parent.Valid:
			p.Path = joinPath(parent.String, name)
		default:
			continue // orphan row (parent never indexed); cannot be located
		}
		byID[p.ID] = p
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]EntryPath, 0, len(byID))
	for _, id := range ids {
		if p, ok := byID[id]; ok {
			out = append(out, p)
		}
	}
	return out, nil
}

// EntryDetail is everything the index knows about one entry (properties).
type EntryDetail struct {
	ID       int64
	Kind     media.Kind
	Name     string
	Ext      string
	Path     string
	Size     int64
	MtimeNs  int64
	BtimeNs  int64
	Width    int // 0 = unknown
	Height   int
	ParentID int64
	// Folders only; Listed is false until the folder was listed once.
	Listed     bool
	ChildDirs  int
	ChildMedia int
}

// Entry loads one entry's details.
func (s *Store) Entry(ctx context.Context, id int64) (EntryDetail, error) {
	var d EntryDetail
	var kind, state sql.NullInt64
	var w, h, parent sql.NullInt64
	var childDirs, childMedia sql.NullInt64
	err := s.r.QueryRowContext(ctx, `SELECT e.id, e.kind, e.name, e.ext, e.size_bytes, e.mtime_ns, e.btime_ns,
		e.width, e.height, e.parent_id, d.listing_state, d.child_dirs, d.child_media
		FROM entries e LEFT JOIN dir_state d ON d.entry_id = e.id WHERE e.id = ?`, id).
		Scan(&d.ID, &kind, &d.Name, &d.Ext, &d.Size, &d.MtimeNs, &d.BtimeNs, &w, &h, &parent, &state, &childDirs, &childMedia)
	if errors.Is(err, sql.ErrNoRows) {
		return d, ErrNotFound
	}
	if err != nil {
		return d, err
	}
	d.Kind = media.Kind(kind.Int64)
	d.Width, d.Height, d.ParentID = int(w.Int64), int(h.Int64), parent.Int64
	d.Listed = state.Valid && state.Int64 == ListingComplete
	d.ChildDirs, d.ChildMedia = int(childDirs.Int64), int(childMedia.Int64)
	paths, err := s.EntryPaths(ctx, []int64{id})
	if err != nil {
		return d, err
	}
	if len(paths) == 0 {
		return d, ErrNotFound
	}
	d.Path = paths[0].Path
	return d, nil
}
