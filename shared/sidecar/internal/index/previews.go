package index

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"fastview/sidecar/internal/media"
)

// Source is what the preview pipeline needs to know about an entry.
type Source struct {
	ID      int64
	Kind    media.Kind
	Ext     string
	PathKey string
	Size    int64
	MtimeNs int64
	Path    string // absolute OS path
}

// PreviewRow is one cached preview.
type PreviewRow struct {
	Key      []byte
	EntryID  int64
	Profile  string
	Format   string
	Width    int
	Height   int
	ByteSize int64
}

// Failure is a recorded generation failure. RetryAfter 0 means permanent.
type Failure struct {
	Code       string
	Attempts   int
	RetryAfter int64 // unix ms
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func idArgs(ids []int64) []any {
	a := make([]any, len(ids))
	for i, id := range ids {
		a[i] = id
	}
	return a
}

func keyArgs(keys [][]byte) []any {
	a := make([]any, len(keys))
	for i, k := range keys {
		a[i] = k
	}
	return a
}

// chunks splits n items into ranges of at most size.
func chunks(n, size int) [][2]int {
	var out [][2]int
	for lo := 0; lo < n; lo += size {
		out = append(out, [2]int{lo, min(lo+size, n)})
	}
	return out
}

// Sources loads preview sources for ids (images and videos only; other ids
// are skipped, so media.resolve never serves other files).
func (s *Store) Sources(ctx context.Context, ids []int64) (map[int64]Source, error) {
	out := make(map[int64]Source, len(ids))
	for _, c := range chunks(len(ids), 900) {
		part := ids[c[0]:c[1]]
		rows, err := s.r.QueryContext(ctx, `SELECT e.id, e.kind, e.ext, e.path_key, e.size_bytes, e.mtime_ns, d.path, e.name
			FROM entries e JOIN dir_state d ON d.entry_id = e.parent_id
			WHERE e.kind IN (1, 2) AND e.id IN (`+placeholders(len(part))+`)`, idArgs(part)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var src Source
			var kind int
			var dir, name string
			if err := rows.Scan(&src.ID, &kind, &src.Ext, &src.PathKey, &src.Size, &src.MtimeNs, &dir, &name); err != nil {
				rows.Close()
				return nil, err
			}
			src.Kind = media.Kind(kind)
			src.Path = joinPath(dir, name)
			out[src.ID] = src
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// LookupPreviews returns cached previews by key (hex of key -> row).
func (s *Store) LookupPreviews(ctx context.Context, keys [][]byte) (map[string]PreviewRow, error) {
	out := make(map[string]PreviewRow, len(keys))
	for _, c := range chunks(len(keys), 900) {
		part := keys[c[0]:c[1]]
		rows, err := s.r.QueryContext(ctx, `SELECT cache_key, COALESCE(entry_id, 0), profile, format, width, height, byte_size
			FROM previews WHERE cache_key IN (`+placeholders(len(part))+`)`, keyArgs(part)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var p PreviewRow
			if err := rows.Scan(&p.Key, &p.EntryID, &p.Profile, &p.Format, &p.Width, &p.Height, &p.ByteSize); err != nil {
				rows.Close()
				return nil, err
			}
			out[string(p.Key)] = p
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// LookupFailures returns recorded failures by key.
func (s *Store) LookupFailures(ctx context.Context, keys [][]byte) (map[string]Failure, error) {
	out := map[string]Failure{}
	for _, c := range chunks(len(keys), 900) {
		part := keys[c[0]:c[1]]
		rows, err := s.r.QueryContext(ctx, `SELECT cache_key, code, attempts, COALESCE(retry_after, 0)
			FROM preview_failures WHERE cache_key IN (`+placeholders(len(part))+`)`, keyArgs(part)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var k []byte
			var f Failure
			if err := rows.Scan(&k, &f.Code, &f.Attempts, &f.RetryAfter); err != nil {
				rows.Close()
				return nil, err
			}
			out[string(k)] = f
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// PutPreview records a generated preview and clears any failure for its key.
func (s *Store) PutPreview(ctx context.Context, p PreviewRow) error {
	now := time.Now().UnixMilli()
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO previews (cache_key, entry_id, profile, format, width, height, byte_size, created_at, last_accessed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (cache_key) DO UPDATE SET entry_id = excluded.entry_id, format = excluded.format, width = excluded.width,
		height = excluded.height, byte_size = excluded.byte_size, last_accessed_at = excluded.last_accessed_at`,
		p.Key, p.EntryID, p.Profile, p.Format, p.Width, p.Height, p.ByteSize, now, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM preview_failures WHERE cache_key = ?`, p.Key); err != nil {
		return err
	}
	return tx.Commit()
}

// PutFailure records a failure; retryAfter 0 marks it permanent for the key.
func (s *Store) PutFailure(ctx context.Context, key []byte, code string, retryAfter int64) error {
	var ra any
	if retryAfter > 0 {
		ra = retryAfter
	}
	_, err := s.w.ExecContext(ctx, `INSERT INTO preview_failures (cache_key, code, attempts, last_attempt_at, retry_after)
		VALUES (?, ?, 1, ?, ?)
		ON CONFLICT (cache_key) DO UPDATE SET code = excluded.code, attempts = preview_failures.attempts + 1,
		last_attempt_at = excluded.last_attempt_at, retry_after = excluded.retry_after`,
		key, code, time.Now().UnixMilli(), ra)
	return err
}

// ForgetPreviews deletes cache rows and failure records (forced regeneration,
// cleanup).
func (s *Store) ForgetPreviews(ctx context.Context, keys [][]byte) error {
	if len(keys) == 0 {
		return nil
	}
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, c := range chunks(len(keys), 900) {
		args := keyArgs(keys[c[0]:c[1]])
		ph := placeholders(len(args))
		if _, err := tx.ExecContext(ctx, `DELETE FROM previews WHERE cache_key IN (`+ph+`)`, args...); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM preview_failures WHERE cache_key IN (`+ph+`)`, args...); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// TouchPreviews bumps last_accessed_at for LRU; callers batch.
func (s *Store) TouchPreviews(ctx context.Context, keys [][]byte) error {
	if len(keys) == 0 {
		return nil
	}
	now := time.Now().UnixMilli()
	for _, c := range chunks(len(keys), 900) {
		args := append([]any{now}, keyArgs(keys[c[0]:c[1]])...)
		if _, err := s.w.ExecContext(ctx, `UPDATE previews SET last_accessed_at = ? WHERE cache_key IN (`+
			placeholders(c[1]-c[0])+`)`, args...); err != nil {
			return err
		}
	}
	return nil
}

// PreviewBytes is the total size of cached previews.
func (s *Store) PreviewBytes(ctx context.Context) (int64, error) {
	var n sql.NullInt64
	err := s.r.QueryRowContext(ctx, `SELECT SUM(byte_size) FROM previews`).Scan(&n)
	return n.Int64, err
}

// OldestPreviews returns the least recently used previews.
func (s *Store) OldestPreviews(ctx context.Context, limit int) ([]PreviewRow, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT cache_key, profile, format, byte_size FROM previews
		ORDER BY last_accessed_at, cache_key LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PreviewRow
	for rows.Next() {
		var p PreviewRow
		if err := rows.Scan(&p.Key, &p.Profile, &p.Format, &p.ByteSize); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// UpdateIdentity records a changed source file (seen at preview time before
// the next scan) and resets its metadata.
func (s *Store) UpdateIdentity(ctx context.Context, id, size, mtimeNs int64) error {
	_, err := s.w.ExecContext(ctx, `UPDATE entries SET size_bytes = ?, mtime_ns = ?, meta_state = 0,
		width = NULL, height = NULL, duration_ms = NULL WHERE id = ?`, size, mtimeNs, id)
	return err
}

// Dimension is a decoded source size (display orientation).
type Dimension struct {
	ID            int64
	Width, Height int
	DurationMs    int64 // videos; 0 = unknown (kept as it was)
	State         int   // meta_state: 1 ok, 2 unsupported, 3 corrupt
}

// SetDimensions stores decoded dimensions in one transaction.
func (s *Store) SetDimensions(ctx context.Context, dims []Dimension) error {
	if len(dims) == 0 {
		return nil
	}
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	st, err := tx.PrepareContext(ctx, `UPDATE entries SET width = ?, height = ?, meta_state = ?,
		duration_ms = COALESCE(?, duration_ms) WHERE id = ?`)
	if err != nil {
		return err
	}
	defer st.Close()
	for _, d := range dims {
		var w, h any
		if d.Width > 0 {
			w, h = d.Width, d.Height
		}
		var dur any
		if d.DurationMs > 0 {
			dur = d.DurationMs
		}
		if _, err := st.ExecContext(ctx, w, h, d.State, dur, d.ID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
