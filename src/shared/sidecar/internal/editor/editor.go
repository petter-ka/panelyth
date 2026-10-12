// Package editor holds the image editor's sessions (ADR-0035): one opened
// picture, kept as a proxy, rendered through an edit list on request and
// saved at full resolution by a job. Pixel work is in internal/imaging;
// this package owns the lifetime, the memory and the scheduling.
package editor

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/fonts"
	"panelyth/sidecar/internal/imaging"
)

// Limits of a session (ADR-0035, fixed by the Stage 12 measurements).
const (
	// MaxPixels: larger pictures are refused for editing.
	MaxPixels = imaging.MaxEditPixels
	// ProxyEdge is the long edge of the picture a session keeps.
	ProxyEdge = 2560
	// MaxCheckpoints is how many intermediate results a session caches.
	MaxCheckpoints = 3
	// Frame sizes: what a caller may ask for, and the cap while a control
	// is dragged.
	MinFrameEdge = 64
	MaxFrameEdge = ProxyEdge
	DraftEdge    = 1280
	// workEdge bounds the long edge of any intermediate of a render.
	workEdge = 4096
	// sessionPixels is the memory a session reserves, in proxy sizes: the
	// proxy, a scaled base, the checkpoints and one result being made.
	sessionPixels = 6
	// DefaultIdle closes a session nobody used.
	DefaultIdle = 10 * time.Minute
)

var (
	// ErrTooLarge: the picture exceeds MaxPixels.
	ErrTooLarge = errors.New("editor: picture too large to edit")
	// ErrUnsupported: a format the editor cannot open (animations, files
	// without a decoder).
	ErrUnsupported = errors.New("editor: format cannot be edited")
	// ErrGone: the session was closed or timed out.
	ErrGone = errors.New("editor: session closed")
	// ErrChanged: the file changed on disk since it was opened.
	ErrChanged = errors.New("editor: the file changed since it was opened")
)

// Source names the file of a session; the caller resolved it from an entry.
type Source struct {
	EntryID int64
	Path    string
	Ext     string
}

// Config holds a manager's collaborators.
type Config struct {
	// TmpDir receives the frames; it is emptied at start.
	TmpDir string
	// Reserve takes decode memory from the budget previews share, so an
	// edit never starves the tile view. Nil reserves nothing.
	Reserve func(ctx context.Context, pixels int64) (func(), error)
	Log     *slog.Logger
	// Idle is the idle timeout (DefaultIdle when zero).
	Idle time.Duration
	// Fonts is where text finds its fonts (the system's when nil).
	Fonts *fonts.Library
}

// Manager owns the open sessions: at most one per owner (a window).
type Manager struct {
	cfg    Config
	reg    *imaging.Registry
	assets *assetStore
	fonts  *fonts.Library

	mu       sync.Mutex
	sessions map[string]*Session
	closed   bool
	stop     chan struct{}
	done     chan struct{}
}

// NewManager removes frames left by a crash and starts the idle watch.
func NewManager(cfg Config) *Manager {
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.DiscardHandler)
	}
	if cfg.Idle <= 0 {
		cfg.Idle = DefaultIdle
	}
	if cfg.Reserve == nil {
		cfg.Reserve = func(context.Context, int64) (func(), error) { return func() {}, nil }
	}
	if cfg.Fonts == nil {
		cfg.Fonts = fonts.System()
	}
	_ = os.RemoveAll(cfg.TmpDir)
	reg := imaging.DefaultRegistry()
	m := &Manager{cfg: cfg, reg: reg, sessions: map[string]*Session{},
		assets: &assetStore{reg: reg, dir: cfg.TmpDir, byID: map[string]*Asset{}}, fonts: cfg.Fonts,
		stop: make(chan struct{}), done: make(chan struct{})}
	go m.watchIdle()
	return m
}

func (m *Manager) watchIdle() {
	defer close(m.done)
	tick := time.NewTicker(min(m.cfg.Idle/4, 30*time.Second))
	defer tick.Stop()
	for {
		select {
		case <-m.stop:
			return
		case now := <-tick.C:
			m.mu.Lock()
			var idle []*Session
			for _, s := range m.sessions {
				if now.Sub(s.used()) >= m.cfg.Idle {
					idle = append(idle, s)
				}
			}
			m.mu.Unlock()
			for _, s := range idle {
				m.cfg.Log.Info("edit session idle; closed", "session", s.ID)
				m.Close(s.ID)
			}
		}
	}
}

// Shutdown closes every session and removes their frames.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	all := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.sessions = map[string]*Session{}
	m.mu.Unlock()
	close(m.stop)
	<-m.done
	for _, s := range all {
		s.close()
	}
	_ = os.RemoveAll(m.cfg.TmpDir)
}

// Count is the number of open sessions.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions)
}

// Get returns an open session and marks it used.
func (m *Manager) Get(id string) (*Session, error) {
	m.mu.Lock()
	s := m.sessions[id]
	m.mu.Unlock()
	if s == nil {
		return nil, ErrGone
	}
	s.touch()
	return s, nil
}

// Close ends a session; unknown ids are ignored.
func (m *Manager) Close(id string) bool {
	m.mu.Lock()
	s := m.sessions[id]
	delete(m.sessions, id)
	last := len(m.sessions) == 0
	m.mu.Unlock()
	if s == nil {
		return false
	}
	s.close()
	if last {
		// Nobody is editing: the decoded assets are memory for nothing.
		m.assets.dropDecoded()
	}
	return true
}

// Open decodes src once and keeps its proxy. The owner's previous session,
// if any, is closed first. Errors: ErrTooLarge, ErrUnsupported, the
// imaging decode errors and I/O errors.
func (m *Manager) Open(ctx context.Context, owner int64, src Source) (*Session, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, ErrGone
	}
	var previous []*Session
	for id, s := range m.sessions {
		if s.owner == owner {
			previous = append(previous, s)
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()
	for _, s := range previous {
		s.close()
	}

	fi, err := os.Stat(src.Path)
	if err != nil {
		return nil, err
	}
	probe, err := m.reg.ProbeFile(src.Path, src.Ext)
	switch {
	case errors.Is(err, imaging.ErrTooLarge):
		return nil, ErrTooLarge
	case errors.Is(err, imaging.ErrUnsupported):
		return nil, ErrUnsupported
	case err != nil:
		return nil, err
	}
	if probe.Pixels() > MaxPixels {
		return nil, ErrTooLarge
	}
	format := probe.Decoder.Name()
	if animated(src.Path, format) {
		return nil, fmt.Errorf("%w: animations are not edited", ErrUnsupported)
	}
	// The decode is transient; the session's own memory stays reserved.
	releaseDecode, err := m.cfg.Reserve(ctx, 2*probe.Pixels())
	if err != nil {
		return nil, err
	}
	proxy, err := loadProxy(ctx, probe)
	releaseDecode()
	if err != nil {
		return nil, err
	}
	release, err := m.cfg.Reserve(ctx, sessionPixels*int64(proxy.Rect.Dx())*int64(proxy.Rect.Dy()))
	if err != nil {
		return nil, err
	}
	meta, err := imaging.ReadMetadata(src.Path, format)
	if err != nil {
		release()
		return nil, err
	}
	w, h := probe.DisplaySize()
	var idBytes [12]byte
	_, _ = rand.Read(idBytes[:])
	s := &Session{
		ID: hex.EncodeToString(idBytes[:]), owner: owner, Source: src, Format: format,
		Width: w, Height: h, HasAlpha: imaging.HasAlpha(proxy), Meta: meta,
		Size: fi.Size(), MtimeNs: fi.ModTime().UnixNano(),
		proxy: proxy, dir: m.cfg.TmpDir, release: release, slot: make(chan struct{}, 1), lastUsed: time.Now(),
		reserve: m.cfg.Reserve,
	}
	tokens := Tokens(src, w, h, fi.ModTime(), s.Info())
	s.res = &resources{assets: m.assets, fonts: m.fonts, lookup: func(name string) (string, bool) {
		v, ok := tokens[name]
		return v, ok
	}}
	if meta.BitDepth > 8 {
		s.Notice = "bitDepth"
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		s.close()
		return nil, ErrGone
	}
	m.sessions[s.ID] = s
	m.mu.Unlock()
	return s, nil
}

// loadProxy decodes p and scales it to the proxy size, upright.
func loadProxy(ctx context.Context, p imaging.Probe) (*image.RGBA, error) {
	src, err := imaging.DecodeFile(p)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return imaging.OrientedProxy(ctx, src, ProxyEdge, p.Orientation)
}

// animated reports a GIF with more than one frame or an animated WebP.
func animated(path, format string) bool {
	if format != "gif" && format != "webp" {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 64<<10)
	if format == "webp" {
		var h [21]byte
		if _, err := io.ReadFull(r, h[:]); err != nil {
			return false
		}
		return string(h[12:16]) == "VP8X" && h[20]&0x02 != 0
	}
	return gifFrames(r, 2) >= 2
}

// gifFrames counts the image blocks of a GIF, up to limit.
func gifFrames(r *bufio.Reader, limit int) int {
	var h [13]byte
	if _, err := io.ReadFull(r, h[:]); err != nil || string(h[:3]) != "GIF" {
		return 0
	}
	skipTable := func(flags byte) bool {
		if flags&0x80 == 0 {
			return true
		}
		_, err := r.Discard(3 << (flags&7 + 1))
		return err == nil
	}
	skipBlocks := func() bool {
		for {
			n, err := r.ReadByte()
			if err != nil {
				return false
			}
			if n == 0 {
				return true
			}
			if _, err := r.Discard(int(n)); err != nil {
				return false
			}
		}
	}
	if !skipTable(h[10]) {
		return 0
	}
	frames := 0
	for frames < limit {
		b, err := r.ReadByte()
		if err != nil {
			return frames
		}
		switch b {
		case 0x21: // extension: label, then sub-blocks
			if _, err := r.ReadByte(); err != nil || !skipBlocks() {
				return frames
			}
		case 0x2C: // image
			var d [9]byte
			if _, err := io.ReadFull(r, d[:]); err != nil {
				return frames
			}
			frames++
			if !skipTable(d[8]) {
				return frames
			}
			if _, err := r.ReadByte(); err != nil || !skipBlocks() { // LZW code size, data
				return frames
			}
		default:
			return frames
		}
	}
	return frames
}

// CopyName is the default name of a saved copy in dir: "name (edited).ext",
// with a number when that is taken.
func CopyName(dir, source, ext string) (string, bool) {
	base := filepath.Base(source)
	stem := base[:len(base)-len(filepath.Ext(base))]
	return fileops.UniqueName(stem+" (edited)."+ext, false, func(name string) bool {
		_, err := os.Lstat(filepath.Join(dir, name))
		return err == nil
	})
}
