// Package textedit holds the text editor's sessions (Stage C10.6, ADR-0046):
// a file opened by entry id is read once to learn its encoding, line endings
// and version (the SHA-256 of its bytes); a save arrives as chunks of text,
// staged in the session, and a commit encodes them back to the file's own
// encoding and line endings and replaces the file atomically, unless it
// changed on disk since the version the edits started from.
//
// The page reads the file's bytes itself, through a read-only token, so
// nothing here sends text back. The image editor is package editor.
package textedit

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf16"

	"panelyth/sidecar/internal/pathkey"
)

// Limits (mirror src/shared/contracts/src/textedit.ts).
const (
	// MaxBytes is the largest file the editor opens (TEXTEDIT_MAX_BYTES).
	MaxBytes = 8 << 20
	// ChunkChars bounds one chunk in UTF-16 code units (TEXTEDIT_CHUNK_CHARS).
	ChunkChars = 256 << 10
	// MaxChars bounds a save in UTF-16 code units (TEXTEDIT_MAX_CHARS).
	MaxChars = 16 << 20
)

const (
	// DefaultMaxSessions caps the open sessions; a new one past it closes
	// the least recently used.
	DefaultMaxSessions = 32
	// DefaultIdle closes a session nobody used for that long. An editor
	// window may stay open for hours without a save, so it is generous; a
	// window that closes ends its session at once anyway.
	DefaultIdle = 2 * time.Hour
	// DefaultStagingBytes bounds the text staged by all sessions together.
	DefaultStagingBytes = 256 << 20
	// hashLimit: a file larger than this (it grew past the editor's limit
	// since it was opened) is not hashed; its version is made from its size
	// and modified time, a version no save starts from.
	hashLimit = 64 << 20
	// readStep is how much is read between two looks at the context.
	readStep = 1 << 20
)

var (
	// ErrGone: the session was closed, evicted or never existed.
	ErrGone = errors.New("textedit: the editing session is closed")
	// ErrFolder: the entry is a folder (or a link to one).
	ErrFolder = errors.New("textedit: a folder cannot be edited")
	// ErrNotRegular: a device, a pipe or another special file.
	ErrNotRegular = errors.New("textedit: not a regular file")
	// ErrTooLarge: larger than MaxBytes.
	ErrTooLarge = errors.New("textedit: the file is too large for the editor")
	// ErrBinary: not text.
	ErrBinary = errors.New("textedit: the file is not text")
	// ErrChunk: a chunk out of order, too long, or a commit with no text
	// staged. The staged text is dropped; the save starts again at seq 0.
	ErrChunk = errors.New("textedit: invalid chunk")
	// ErrBusy: the staging memory of all sessions is used up.
	ErrBusy = errors.New("textedit: too much text is being saved at once")
	// ErrLinkBroken: the file is a link whose target is gone; an overwrite
	// does not guess where to create it.
	ErrLinkBroken = errors.New("textedit: the link's target no longer exists")
)

// State is what is known of the file on disk (TextFileState).
type State struct {
	Version   string `json:"version"`
	SizeBytes int64  `json:"sizeBytes"`
	MtimeNs   int64  `json:"mtimeNs"`
}

// Info describes a session that opened (TextEditOpenResult).
type Info struct {
	SessionID  string
	Name       string
	Path       string
	State      State
	Encoding   string
	BOM        int
	LineEnding string
}

// Commit outcomes (TextEditCommitResult.status).
const (
	StatusSaved       = "saved"
	StatusConflict    = "conflict"
	StatusUnencodable = "unencodable"
)

// Outcome is a commit's answer.
type Outcome struct {
	Status string
	// Saved: the file's encoding and state now.
	Encoding string
	State    State
	// Conflict: the file is gone.
	Gone bool
	// Unencodable: the 1-based line of the first character that does not fit.
	Line int
}

// Config holds a manager's limits; zero values take the defaults.
type Config struct {
	Log          *slog.Logger
	Idle         time.Duration
	MaxSessions  int
	StagingBytes int64
}

// Manager owns the open sessions.
type Manager struct {
	cfg Config

	mu       sync.Mutex
	sessions map[string]*session
	paths    map[string]*pathLock
	closed   bool
	staged   atomic.Int64
	stop     chan struct{}
	done     chan struct{}
}

type pathLock struct {
	mu   sync.Mutex
	refs int
}

type session struct {
	id   string
	path string // as opened: a link stays the link
	name string
	used atomic.Int64

	mu     sync.Mutex
	closed bool
	enc    string
	bom    int
	eol    string
	disk   State // the file as last seen (open, check, save)

	// The staged save: chunks in order, next is the seq expected (-1: none
	// started), units their length, high a first half of a surrogate pair
	// the last chunk ended with.
	chunks []string
	next   int
	units  int
	bytes  int64
	high   uint16

	// The staged picture (C10.7): its bytes so far and the seq expected
	// (-1: none started).
	pic     []byte
	picNext int
}

func (s *session) touch() { s.used.Store(time.Now().UnixNano()) }

// NewManager starts the idle watch.
func NewManager(cfg Config) *Manager {
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.DiscardHandler)
	}
	if cfg.Idle <= 0 {
		cfg.Idle = DefaultIdle
	}
	if cfg.MaxSessions <= 0 {
		cfg.MaxSessions = DefaultMaxSessions
	}
	if cfg.StagingBytes <= 0 {
		cfg.StagingBytes = DefaultStagingBytes
	}
	m := &Manager{cfg: cfg, sessions: map[string]*session{}, paths: map[string]*pathLock{},
		stop: make(chan struct{}), done: make(chan struct{})}
	go m.watchIdle()
	return m
}

func (m *Manager) watchIdle() {
	defer close(m.done)
	tick := time.NewTicker(min(m.cfg.Idle/4, time.Minute))
	defer tick.Stop()
	for {
		select {
		case <-m.stop:
			return
		case now := <-tick.C:
			m.mu.Lock()
			var idle []string
			for id, s := range m.sessions {
				if now.Sub(time.Unix(0, s.used.Load())) >= m.cfg.Idle {
					idle = append(idle, id)
				}
			}
			m.mu.Unlock()
			for _, id := range idle {
				m.cfg.Log.Info("text edit session idle; closed", "session", id)
				m.Close(id)
			}
		}
	}
}

// Shutdown closes every session.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	all := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.sessions = map[string]*session{}
	m.mu.Unlock()
	close(m.stop)
	<-m.done
	for _, s := range all {
		m.release(s)
	}
}

// Count is the number of open sessions.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions)
}

// Close ends a session; an unknown id is not an error (false).
func (m *Manager) Close(id string) bool {
	m.mu.Lock()
	s := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()
	if s == nil {
		return false
	}
	m.release(s)
	return true
}

// release closes a session taken out of the map. It waits for a save under
// way to finish.
func (m *Manager) release(s *session) {
	s.mu.Lock()
	s.closed = true
	m.dropStaged(s)
	m.dropPicture(s)
	s.mu.Unlock()
}

func (m *Manager) get(id string) (*session, error) {
	m.mu.Lock()
	s := m.sessions[id]
	m.mu.Unlock()
	if s == nil {
		return nil, ErrGone
	}
	s.touch()
	return s, nil
}

// lockPath serializes saves of one file (two sessions may name it).
func (m *Manager) lockPath(path string) func() {
	key := pathkey.DirKey(path)
	m.mu.Lock()
	l := m.paths[key]
	if l == nil {
		l = &pathLock{}
		m.paths[key] = l
	}
	l.refs++
	m.mu.Unlock()
	l.mu.Lock()
	return func() {
		l.mu.Unlock()
		m.mu.Lock()
		if l.refs--; l.refs == 0 {
			delete(m.paths, key)
		}
		m.mu.Unlock()
	}
}

// Open reads the file at path (an indexed, local entry the caller resolved)
// and starts a session for it. Errors: ErrFolder, ErrNotRegular,
// ErrTooLarge, ErrBinary, I/O errors and the context's.
func (m *Manager) Open(ctx context.Context, path string) (Info, error) {
	data, fi, err := readFile(ctx, path)
	if err != nil {
		return Info{}, err
	}
	enc, bom, ok := detect(data)
	if !ok {
		return Info{}, ErrBinary
	}
	sum := sha256.Sum256(data)
	var idBytes [16]byte
	_, _ = rand.Read(idBytes[:])
	s := &session{id: hex.EncodeToString(idBytes[:]), path: path, name: filepath.Base(path),
		enc: enc, bom: bom, eol: lineEnding(data[bom:], enc), next: -1, picNext: -1,
		disk: State{Version: hex.EncodeToString(sum[:]), SizeBytes: fi.Size(), MtimeNs: fi.ModTime().UnixNano()}}
	s.touch()

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Info{}, ErrGone
	}
	var evicted *session
	if len(m.sessions) >= m.cfg.MaxSessions {
		for _, o := range m.sessions {
			if evicted == nil || o.used.Load() < evicted.used.Load() {
				evicted = o
			}
		}
		delete(m.sessions, evicted.id)
	}
	m.sessions[s.id] = s
	m.mu.Unlock()
	if evicted != nil {
		m.cfg.Log.Info("text edit sessions full; closed the least recently used", "session", evicted.id)
		m.release(evicted)
	}
	return Info{SessionID: s.id, Name: s.name, Path: path, State: s.disk, Encoding: enc, BOM: bom,
		LineEnding: s.eol}, nil
}

// readFile reads a whole file of at most MaxBytes.
func readFile(ctx context.Context, path string) ([]byte, fs.FileInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	switch {
	case fi.IsDir():
		return nil, nil, ErrFolder
	case !fi.Mode().IsRegular():
		return nil, nil, ErrNotRegular
	case fi.Size() > MaxBytes:
		return nil, nil, ErrTooLarge
	}
	// The file may grow while it is read: one byte more than the limit
	// tells.
	data := make([]byte, 0, fi.Size()+1)
	for {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		if len(data) == cap(data) {
			data = append(data, 0)[:len(data)]
		}
		end := min(cap(data), len(data)+readStep, MaxBytes+1)
		n, err := f.Read(data[len(data):end])
		data = data[:len(data)+n]
		if len(data) > MaxBytes {
			return nil, nil, ErrTooLarge
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, nil, err
		}
	}
	if fi2, err := f.Stat(); err == nil {
		fi = fi2
	}
	return data, fi, nil
}

// Write stages one chunk of a save. Seq 0 starts a new save (dropping one
// staged before); each next chunk is the one after. raw is the chunk as a
// JSON string. Errors: ErrGone, ErrChunk (the staged text is dropped),
// ErrBusy.
func (m *Manager) Write(id string, seq int, raw []byte) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrGone
	}
	if seq == 0 {
		m.dropStaged(s)
		s.next = 0
	}
	if s.next < 0 || seq != s.next {
		want := s.next
		m.dropStaged(s)
		if want < 0 {
			return fmt.Errorf("%w: chunk %d comes before chunk 0", ErrChunk, seq)
		}
		return fmt.Errorf("%w: chunk %d out of order, expected %d", ErrChunk, seq, want)
	}
	c, err := decodeChunk(raw)
	if err != nil {
		m.dropStaged(s)
		return fmt.Errorf("%w: %v", ErrChunk, err)
	}
	if c.units > ChunkChars {
		m.dropStaged(s)
		return fmt.Errorf("%w: a chunk is at most %d characters", ErrChunk, ChunkChars)
	}
	if s.units+c.units > MaxChars {
		m.dropStaged(s)
		return fmt.Errorf("%w: a save is at most %d characters", ErrChunk, MaxChars)
	}
	text := s.join(c)
	n := int64(len(text))
	if m.staged.Add(n) > m.cfg.StagingBytes {
		m.staged.Add(-n)
		m.dropStaged(s)
		return ErrBusy
	}
	s.chunks = append(s.chunks, text)
	s.bytes += n
	s.units += c.units
	s.next++
	return nil
}

// join returns a chunk's text with a surrogate pair cut by the chunk
// boundary made whole again; a half without its other half is U+FFFD, as
// any decoder makes it.
func (s *session) join(c chunk) string {
	var head string
	switch {
	case s.high != 0 && c.lead != 0:
		head = string(utf16.DecodeRune(rune(s.high), rune(c.lead)))
	case s.high != 0 || c.lead != 0:
		head = "�"
	}
	s.high = c.trail
	if head == "" {
		return c.text
	}
	return head + c.text
}

// dropStaged forgets the staged save. Callers hold s.mu.
func (m *Manager) dropStaged(s *session) {
	m.staged.Add(-s.bytes)
	s.chunks, s.next, s.units, s.bytes, s.high = nil, -1, 0, 0, 0
}

// staged joins the staged chunks.
func (s *session) staged() string {
	tail := ""
	if s.high != 0 {
		tail = "�"
	}
	if len(s.chunks) == 1 && tail == "" {
		return s.chunks[0]
	}
	var b strings.Builder
	b.Grow(int(s.bytes) + len(tail))
	for _, c := range s.chunks {
		b.WriteString(c)
	}
	b.WriteString(tail)
	return b.String()
}

// Commit saves the staged text. baseVersion is the version the edits
// started from; unless force, a file that is no longer that version is a
// conflict and nothing is written. asUTF8 writes UTF-8 without a mark
// instead of the file's encoding. A conflict and an unencodable character
// keep the staged text, so the save can be repeated (with force or asUTF8)
// without sending it again.
func (m *Manager) Commit(ctx context.Context, id, baseVersion string, force, asUTF8 bool) (Outcome, error) {
	s, err := m.get(id)
	if err != nil {
		return Outcome{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Outcome{}, ErrGone
	}
	if s.next < 0 {
		return Outcome{}, fmt.Errorf("%w: no text was written for this save (chunk 0 is missing)", ErrChunk)
	}
	enc, bom := s.enc, s.bom
	if asUTF8 {
		enc, bom = UTF8, 0
	}
	out, line, ok := encode(s.staged(), enc, bom > 0, s.eol)
	if !ok {
		return Outcome{Status: StatusUnencodable, Line: line}, nil
	}
	if err := ctx.Err(); err != nil {
		return Outcome{}, err
	}

	unlock := m.lockPath(s.path)
	defer unlock()
	target, cur, err := locate(s.path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return Outcome{}, err
	}
	gone := cur == nil
	if !force {
		if gone {
			return Outcome{Status: StatusConflict, Gone: true}, nil
		}
		same := false
		// A different size is a different version: no need to read it.
		if baseVersion != s.disk.Version || cur.Size() == s.disk.SizeBytes {
			st, err := hashFile(ctx, target)
			if errors.Is(err, fs.ErrNotExist) {
				return Outcome{Status: StatusConflict, Gone: true}, nil
			}
			if err != nil {
				return Outcome{}, err
			}
			s.disk = st
			same = st.Version == baseVersion
		}
		if !same {
			return Outcome{Status: StatusConflict}, nil
		}
	}
	if gone {
		// Overwrite of a file that was deleted: it is created again, unless
		// the name is a link that points nowhere now.
		if fi, err := os.Lstat(s.path); err == nil && fi.Mode()&fs.ModeSymlink != 0 {
			return Outcome{}, ErrLinkBroken
		}
		target = s.path
	}
	if err := ctx.Err(); err != nil {
		return Outcome{}, err
	}
	fi, err := writeFile(ctx, target, out, cur)
	if err != nil {
		return Outcome{}, err
	}
	sum := sha256.Sum256(out)
	s.disk = State{Version: hex.EncodeToString(sum[:]), SizeBytes: fi.Size(), MtimeNs: fi.ModTime().UnixNano()}
	s.enc, s.bom = enc, bom
	m.dropStaged(s)
	return Outcome{Status: StatusSaved, Encoding: enc, State: s.disk}, nil
}

// Check reports the file on disk now (nil when it is gone). A file with the
// size and modified time last seen is not read again.
func (m *Manager) Check(ctx context.Context, id string) (*State, error) {
	s, err := m.get(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, ErrGone
	}
	target, cur, err := locate(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if cur.Size() == s.disk.SizeBytes && cur.ModTime().UnixNano() == s.disk.MtimeNs {
		st := s.disk
		return &st, nil
	}
	st, err := hashFile(ctx, target)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.disk = st
	return &st, nil
}

// locate resolves links to the file a save writes and stats it. A path
// whose file (or link target) is gone returns fs.ErrNotExist.
func locate(path string) (string, fs.FileInfo, error) {
	target, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", nil, err
	}
	fi, err := os.Stat(target)
	if err != nil {
		return "", nil, err
	}
	if fi.IsDir() {
		return "", nil, ErrFolder
	}
	if !fi.Mode().IsRegular() {
		return "", nil, ErrNotRegular
	}
	return target, fi, nil
}

// hashFile is the file's state now, read in steps that look at ctx.
func hashFile(ctx context.Context, path string) (State, error) {
	f, err := os.Open(path)
	if err != nil {
		return State{}, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return State{}, err
	}
	st := State{SizeBytes: fi.Size(), MtimeNs: fi.ModTime().UnixNano()}
	h := sha256.New()
	if fi.Size() > hashLimit {
		fmt.Fprintf(h, "panelyth-textedit-unhashed\x00%d\x00%d", st.SizeBytes, st.MtimeNs)
		st.Version = hex.EncodeToString(h.Sum(nil))
		return st, nil
	}
	buf := make([]byte, 256<<10)
	for {
		if err := ctx.Err(); err != nil {
			return State{}, err
		}
		n, err := f.Read(buf)
		h.Write(buf[:n])
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return State{}, err
		}
	}
	st.Version = hex.EncodeToString(h.Sum(nil))
	return st, nil
}
