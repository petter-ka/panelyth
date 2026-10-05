// Package index owns index.db: the disposable SQLite mirror of the
// filesystem (ADR-0005, ADR-0015, ADR-0016).
package index

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"fastview/sidecar/internal/media"
	"fastview/sidecar/internal/natsort"
	"fastview/sidecar/internal/pathkey"

	_ "modernc.org/sqlite"
)

// ErrNotFound is returned when an id does not exist in the index.
var ErrNotFound = errors.New("index: not found")

var errIncompatible = errors.New("index: incompatible schema")

// Store wraps one writer connection (all writes serialize through it) and a
// small pool of read-only connections; WAL lets them run concurrently.
type Store struct {
	w, r *sql.DB
	log  *slog.Logger

	upsertFile *sql.Stmt
	upsertDir  *sql.Stmt
	dirState   *sql.Stmt
	reconcile  *sql.Stmt
	finish     *sql.Stmt
	failDir    *sql.Stmt

	genMu   sync.Mutex
	nextGen int64
}

// Row is one listed directory entry to upsert.
type Row struct {
	ParentID int64
	// ParentKey is the parent's path key; not stored, used for change routing.
	ParentKey string
	Kind      media.Kind
	Name      string
	PathKey   string
	Ext       string
	Size      int64
	MtimeNs   int64
	BtimeNs   int64 // creation time; 0 where the platform has none
	Attrs     int   // fsx.Attr* bits
	// Path is the OS path; stored for directories so they can be re-listed.
	Path string
}

// Finish closes a directory listing. Complete listings reconcile: children
// not seen in this generation are deleted (ADR-0015).
type Finish struct {
	DirID      int64
	DirKey     string
	State      int
	ChildDirs  int
	ChildMedia int
	Skipped    int
	ErrCode    string
}

// DirRef identifies a directory row created or updated by Commit.
type DirRef struct {
	ID    int64
	Path  string
	Key   string
	Attrs int
}

// DirInfo describes a directory known to the index.
type DirInfo struct {
	ID           int64
	Path         string
	Key          string
	Name         string
	ListingState int
	LastListedAt int64 // unix ms, 0 if never
	ChildDirs    int
	ChildMedia   int
	Skipped      int
}

// Open opens (or creates) index.db at path. A corrupt or incompatible file is
// discarded and recreated: the index is a cache.
func Open(path string, log *slog.Logger) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create index dir: %w", err)
	}
	s, err := open(path, log)
	if err == nil {
		return s, nil
	}
	log.Warn("index unusable; recreating", "path", path, "err", err)
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if rmErr := os.Remove(path + suffix); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
			return nil, fmt.Errorf("remove broken index: %w", rmErr)
		}
	}
	return open(path, log)
}

// Page caches are bounded: 16 MB for the writer, 4 MB per reader (4
// readers), so the index can never hold more than 32 MB of cache.
func dsn(path string, readOnly bool) string {
	q := "_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_pragma=temp_store(MEMORY)"
	if readOnly {
		q += "&_pragma=query_only(1)&_pragma=cache_size(-4000)"
	} else {
		q += "&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=cache_size(-16000)"
	}
	return "file:" + filepath.ToSlash(path) + "?" + q
}

func open(path string, log *slog.Logger) (*Store, error) {
	w, err := sql.Open("sqlite", dsn(path, false))
	if err != nil {
		return nil, err
	}
	w.SetMaxOpenConns(1)
	w.SetMaxIdleConns(1)
	s := &Store{w: w, log: log}
	if err := s.migrate(); err != nil {
		_ = w.Close()
		return nil, err
	}
	r, err := sql.Open("sqlite", dsn(path, true))
	if err != nil {
		_ = w.Close()
		return nil, err
	}
	r.SetMaxOpenConns(4)
	r.SetMaxIdleConns(4)
	s.r = r
	if err := s.prepare(); err != nil {
		_ = s.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	if _, err := s.w.Exec(schemaSQL); err != nil {
		return err
	}
	var v string
	err := s.w.QueryRow(`SELECT value FROM meta WHERE key = 'schema_version'`).Scan(&v)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if _, err := s.w.Exec(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`, strconv.Itoa(schemaVersion)); err != nil {
			return err
		}
	case err != nil:
		return err
	case v != strconv.Itoa(schemaVersion):
		return fmt.Errorf("%w: have %s, want %d", errIncompatible, v, schemaVersion)
	}
	// Scans that were running when the process died are recorded as such.
	if _, err := s.w.Exec(`UPDATE scans SET state = ? WHERE state = ?`, ScanInterrupted, ScanRunning); err != nil {
		return err
	}
	var maxGen sql.NullInt64
	if err := s.w.QueryRow(`SELECT MAX(g) FROM (SELECT MAX(listing_gen) AS g FROM dir_state UNION ALL SELECT MAX(generation) FROM scans)`).Scan(&maxGen); err != nil {
		return err
	}
	s.nextGen = maxGen.Int64 + 1
	return nil
}

func (s *Store) prepare() (err error) {
	p := func(q string) *sql.Stmt {
		if err != nil {
			return nil
		}
		var st *sql.Stmt
		st, err = s.w.Prepare(q)
		return st
	}
	s.upsertFile = p(upsertEntrySQL)
	s.upsertDir = p(upsertEntrySQL + " RETURNING id")
	s.dirState = p(upsertDirStateSQL)
	s.reconcile = p(`DELETE FROM entries WHERE parent_id = ? AND seen_gen < ?`)
	s.finish = p(`UPDATE dir_state SET listing_gen = ?, listing_state = ?, child_dirs = ?, child_media = ?,
		skipped = ?, last_listed_at = ?, error_code = NULL WHERE entry_id = ?`)
	s.failDir = p(`UPDATE dir_state SET listing_state = ?, last_listed_at = ?, error_code = ? WHERE entry_id = ?`)
	return err
}

// Close releases all connections.
func (s *Store) Close() error {
	var errs []error
	for _, st := range []*sql.Stmt{s.upsertFile, s.upsertDir, s.dirState, s.reconcile, s.finish, s.failDir} {
		if st != nil {
			errs = append(errs, st.Close())
		}
	}
	if s.r != nil {
		errs = append(errs, s.r.Close())
	}
	errs = append(errs, s.w.Close())
	return errors.Join(errs...)
}

// NextGeneration returns a new, never-reused listing generation.
func (s *Store) NextGeneration() int64 {
	s.genMu.Lock()
	defer s.genMu.Unlock()
	g := s.nextGen
	s.nextGen++
	return g
}

// Commit writes rows and listing finishes in one transaction. It returns the
// directory rows it touched (with ids) so recursive scans can descend.
func (s *Store) Commit(ctx context.Context, gen int64, rows []Row, finishes []Finish) ([]DirRef, error) {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UnixMilli()
	upsertFile, upsertDir, dirState := tx.Stmt(s.upsertFile), tx.Stmt(s.upsertDir), tx.Stmt(s.dirState)
	var dirs []DirRef
	for i := range rows {
		r := &rows[i]
		args := []any{r.ParentID, int(r.Kind), r.Name, r.PathKey, natsort.Key(r.Name), FoldName(r.Name), r.Ext, r.Size, r.MtimeNs, r.BtimeNs, r.Attrs, gen, now}
		if r.Kind != media.KindDir {
			if _, err := upsertFile.ExecContext(ctx, args...); err != nil {
				return nil, fmt.Errorf("upsert %q: %w", r.Name, err)
			}
			continue
		}
		var id int64
		if err := upsertDir.QueryRowContext(ctx, args...).Scan(&id); err != nil {
			return nil, fmt.Errorf("upsert dir %q: %w", r.Name, err)
		}
		if _, err := dirState.ExecContext(ctx, id, r.Path); err != nil {
			return nil, err
		}
		dirs = append(dirs, DirRef{ID: id, Path: r.Path, Key: r.PathKey, Attrs: r.Attrs})
	}

	reconcile, finish, failDir := tx.Stmt(s.reconcile), tx.Stmt(s.finish), tx.Stmt(s.failDir)
	for _, f := range finishes {
		if f.State != ListingComplete {
			if _, err := failDir.ExecContext(ctx, f.State, now, nullString(f.ErrCode), f.DirID); err != nil {
				return nil, err
			}
			continue
		}
		if _, err := reconcile.ExecContext(ctx, f.DirID, gen); err != nil {
			return nil, err
		}
		if _, err := finish.ExecContext(ctx, gen, f.State, f.ChildDirs, f.ChildMedia, f.Skipped, now, f.DirID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return dirs, nil
}

func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// EnsureDir returns the index entry for an absolute, cleaned directory path,
// creating it (linked to its parent when the parent is indexed) if needed.
func (s *Store) EnsureDir(ctx context.Context, cleanPath string) (DirInfo, error) {
	key := pathkey.DirKey(cleanPath)
	if info, err := s.dirByKey(ctx, key); err == nil {
		if info.Path != cleanPath {
			// Same directory reached with different casing; keep the latest spelling.
			if _, err := s.w.ExecContext(ctx, `UPDATE dir_state SET path = ? WHERE entry_id = ?`, cleanPath, info.ID); err != nil {
				return DirInfo{}, err
			}
			info.Path = cleanPath
		}
		return info, nil
	} else if !errors.Is(err, ErrNotFound) {
		return DirInfo{}, err
	}

	var parentID any
	if parent := filepath.Dir(cleanPath); parent != cleanPath {
		var id int64
		err := s.r.QueryRowContext(ctx, `SELECT id FROM entries WHERE path_key = ? AND kind = 0`, pathkey.DirKey(parent)).Scan(&id)
		if err == nil {
			parentID = id
		} else if !errors.Is(err, sql.ErrNoRows) {
			return DirInfo{}, err
		}
	}
	name := filepath.Base(cleanPath)
	if name == string(filepath.Separator) || name == "." || strings.HasSuffix(cleanPath, string(filepath.Separator)) {
		name = cleanPath // filesystem root, e.g. "C:\" or "/"
	}
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return DirInfo{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var id int64
	if err := tx.StmtContext(ctx, s.upsertDir).QueryRowContext(ctx,
		parentID, int(media.KindDir), name, key, natsort.Key(name), FoldName(name), "", 0, 0, 0, 0, 0, time.Now().UnixMilli()).Scan(&id); err != nil {
		return DirInfo{}, err
	}
	if _, err := tx.StmtContext(ctx, s.dirState).ExecContext(ctx, id, cleanPath); err != nil {
		return DirInfo{}, err
	}
	if err := tx.Commit(); err != nil {
		return DirInfo{}, err
	}
	return DirInfo{ID: id, Path: cleanPath, Key: key, Name: name}, nil
}

const dirInfoSQL = `SELECT e.id, d.path, e.path_key, e.name, d.listing_state, COALESCE(d.last_listed_at, 0),
	d.child_dirs, d.child_media, d.skipped
	FROM entries e JOIN dir_state d ON d.entry_id = e.id`

func scanDirInfo(row *sql.Row) (DirInfo, error) {
	var i DirInfo
	err := row.Scan(&i.ID, &i.Path, &i.Key, &i.Name, &i.ListingState, &i.LastListedAt, &i.ChildDirs, &i.ChildMedia, &i.Skipped)
	if errors.Is(err, sql.ErrNoRows) {
		return i, ErrNotFound
	}
	return i, err
}

func (s *Store) dirByKey(ctx context.Context, key string) (DirInfo, error) {
	return scanDirInfo(s.r.QueryRowContext(ctx, dirInfoSQL+` WHERE e.path_key = ? AND e.kind = 0`, key))
}

// Dir returns a directory by id.
func (s *Store) Dir(ctx context.Context, id int64) (DirInfo, error) {
	return scanDirInfo(s.r.QueryRowContext(ctx, dirInfoSQL+` WHERE e.id = ? AND e.kind = 0`, id))
}

// ScanStarted records a scan; ScanEnded closes the record.
func (s *Store) ScanStarted(ctx context.Context, rootID int64, recursive bool, gen int64) (int64, error) {
	res, err := s.w.ExecContext(ctx, `INSERT INTO scans (root_id, recursive, generation, state, started_at) VALUES (?, ?, ?, ?, ?)`,
		rootID, recursive, gen, ScanRunning, time.Now().UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) ScanEnded(ctx context.Context, scanID int64, state int, dirs, entries, errs int) error {
	_, err := s.w.ExecContext(ctx, `UPDATE scans SET state = ?, finished_at = ?, dirs_listed = ?, entries = ?, errors = ? WHERE id = ?`,
		state, time.Now().UnixMilli(), dirs, entries, errs, scanID)
	return err
}

// joinPath joins a stored directory path and an entry name.
func joinPath(dir, name string) string {
	return filepath.Join(dir, name)
}
