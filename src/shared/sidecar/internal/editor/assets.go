package editor

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/image/font/sfnt"

	"panelyth/sidecar/internal/fonts"
	"panelyth/sidecar/internal/imaging"
)

// Assets (Stage 14, ADR-0035): pictures the user picked for a watermark, a
// mask or a texture. The path comes from Electron main's file dialog; a
// renderer and an edit list only ever see the id, which is a hash of the
// file's content. An asset file is not trusted: it must be a regular file
// of a known picture type within the size limits.
const (
	MaxAssetBytes = 16 << 20
	MaxAssetEdge  = 8000
	// MaxAssets are remembered at once; the oldest is forgotten first.
	MaxAssets = 32
	// maxDecodedAssets stay decoded, within maxDecodedPixels in all; another
	// is decoded again when used.
	maxDecodedAssets = 4
	maxDecodedPixels = 32_000_000
	assetThumbEdge   = 128
)

// ErrAsset: the file cannot be used as an asset; the message says why.
var ErrAsset = errors.New("editor: not a usable picture")

// Asset describes a registered picture.
type Asset struct {
	ID            string
	Name          string
	Width, Height int

	path  string
	size  int64
	mtime int64
	probe imaging.Probe
}

type assetStore struct {
	reg *imaging.Registry
	dir string

	mu      sync.Mutex
	byID    map[string]*Asset
	order   []string // oldest first
	decoded []decodedAsset
}

type decodedAsset struct {
	id  string
	img *image.RGBA
}

func assetErr(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrAsset, fmt.Sprintf(format, args...))
}

// sniff names the picture type by the file's first bytes; the extension is
// not believed.
func sniff(head []byte) string {
	switch {
	case bytes.HasPrefix(head, []byte("\x89PNG\r\n\x1a\n")):
		return "png"
	case bytes.HasPrefix(head, []byte("\xff\xd8\xff")):
		return "jpg"
	case bytes.HasPrefix(head, []byte("GIF87a")), bytes.HasPrefix(head, []byte("GIF89a")):
		return "gif"
	case len(head) >= 12 && string(head[:4]) == "RIFF" && string(head[8:12]) == "WEBP":
		return "webp"
	}
	return ""
}

// add registers the file at path. Errors: ErrAsset (with the reason), I/O errors.
func (a *assetStore) add(ctx context.Context, path string) (*Asset, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, assetErr("not a regular file")
	}
	if fi.Size() <= 0 || fi.Size() > MaxAssetBytes {
		return nil, assetErr("the file is larger than %d MB", MaxAssetBytes>>20)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > MaxAssetBytes {
		return nil, assetErr("the file is larger than %d MB", MaxAssetBytes>>20)
	}
	ext := sniff(data)
	if ext == "" {
		return nil, assetErr("not a PNG, JPEG, WebP or GIF picture")
	}
	probe, err := a.reg.ProbeFile(path, ext)
	if err != nil {
		return nil, assetErr("the picture cannot be read")
	}
	w, h := probe.DisplaySize()
	if w < 1 || h < 1 || w > MaxAssetEdge || h > MaxAssetEdge {
		return nil, assetErr("the picture is larger than %d pixels", MaxAssetEdge)
	}
	if animated(path, probe.Decoder.Name()) {
		return nil, assetErr("animations cannot be used")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	asset := &Asset{ID: hex.EncodeToString(sum[:16]), Name: filepath.Base(path), Width: w, Height: h,
		path: path, size: fi.Size(), mtime: fi.ModTime().UnixNano(), probe: probe}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, known := a.byID[asset.ID]; !known {
		a.order = append(a.order, asset.ID)
	}
	a.byID[asset.ID] = asset
	for len(a.order) > MaxAssets {
		a.forget(a.order[0])
	}
	return asset, nil
}

// forget drops an asset; the caller holds the lock.
func (a *assetStore) forget(id string) {
	delete(a.byID, id)
	for i, have := range a.order {
		if have == id {
			a.order = append(a.order[:i:i], a.order[i+1:]...)
			break
		}
	}
	for i, d := range a.decoded {
		if d.id == id {
			a.decoded = append(a.decoded[:i:i], a.decoded[i+1:]...)
			break
		}
	}
}

func (a *assetStore) remove(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.forget(id)
}

func (a *assetStore) dropDecoded() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.decoded = nil
}

func (a *assetStore) has(id string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	_, ok := a.byID[id]
	return ok
}

func (a *assetStore) count() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.byID)
}

// image returns the asset's pixels, upright. The file must still be the one
// that was registered.
func (a *assetStore) image(ctx context.Context, id string) (*image.RGBA, error) {
	a.mu.Lock()
	asset := a.byID[id]
	for i, d := range a.decoded {
		if d.id == id {
			a.decoded = append(append(a.decoded[:i:i], a.decoded[i+1:]...), d)
			a.mu.Unlock()
			return d.img, nil
		}
	}
	a.mu.Unlock()
	if asset == nil {
		return nil, fmt.Errorf("%w: asset %q is not available", imaging.ErrInvalidEdit, id)
	}
	fi, err := os.Lstat(asset.path)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() != asset.size || fi.ModTime().UnixNano() != asset.mtime {
		return nil, fmt.Errorf("%w: the picture %q changed or is gone; choose it again", imaging.ErrInvalidEdit, asset.Name)
	}
	img, err := imaging.DecodeOriented(ctx, asset.probe)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.byID[id] == asset {
		a.decoded = append(a.decoded, decodedAsset{id, img})
		pixels := 0
		for _, d := range a.decoded {
			pixels += d.img.Rect.Dx() * d.img.Rect.Dy()
		}
		// The oldest go first; the one just decoded always stays.
		for len(a.decoded) > 1 && (len(a.decoded) > maxDecodedAssets || pixels > maxDecodedPixels) {
			pixels -= a.decoded[0].img.Rect.Dx() * a.decoded[0].img.Rect.Dy()
			a.decoded = append([]decodedAsset(nil), a.decoded[1:]...)
		}
	}
	return img, nil
}

// thumb writes a small PNG of the asset (it keeps the transparency) into the
// frames folder and returns the file.
func (a *assetStore) thumb(ctx context.Context, asset *Asset) (string, int, int, error) {
	img, err := a.image(ctx, asset.ID)
	if err != nil {
		return "", 0, 0, err
	}
	w, h := imaging.FitSize(img.Rect.Dx(), img.Rect.Dy(), assetThumbEdge)
	small := img
	if w != img.Rect.Dx() || h != img.Rect.Dy() {
		if small, err = imaging.Resample(ctx, img, w, h, imaging.CatmullRom); err != nil {
			return "", 0, 0, err
		}
	}
	if err := os.MkdirAll(a.dir, 0o700); err != nil {
		return "", 0, 0, err
	}
	// Named like a frame, so main serves it under the same rule.
	file := filepath.Join(a.dir, asset.ID[:24]+"-0.png")
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, small); err != nil {
		return "", 0, 0, err
	}
	if err := os.WriteFile(file, buf.Bytes(), 0o600); err != nil {
		return "", 0, 0, err
	}
	return file, w, h, nil
}

// AddAsset registers the picture at path (a path from main's file dialog)
// and writes its thumbnail. Errors: ErrAsset with the reason, I/O errors.
func (m *Manager) AddAsset(ctx context.Context, path string) (Asset, Thumb, error) {
	asset, err := m.assets.add(ctx, path)
	if err != nil {
		return Asset{}, Thumb{}, err
	}
	file, w, h, err := m.assets.thumb(ctx, asset)
	if err != nil {
		m.assets.remove(asset.ID)
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return Asset{}, Thumb{}, err
		}
		return Asset{}, Thumb{}, assetErr("the picture cannot be read")
	}
	return *asset, Thumb{File: file, Width: w, Height: h}, nil
}

// DropAsset forgets an asset; edit lists that name it no longer render.
func (m *Manager) DropAsset(id string) { m.assets.remove(id) }

// Assets is the number of registered assets.
func (m *Manager) Assets() int { return m.assets.count() }

// Fonts lists the font families text can be drawn with: the built-in ones
// first, then the system's.
func (m *Manager) Fonts(ctx context.Context) []string { return m.fonts.Families(ctx) }

// resources gives a run its assets, fonts and the picture's tokens.
type resources struct {
	assets *assetStore
	fonts  *fonts.Library
	lookup func(name string) (string, bool)
}

func (r *resources) Asset(ctx context.Context, id string) (*image.RGBA, error) {
	return r.assets.image(ctx, id)
}

func (r *resources) Font(family string, bold, italic bool) (*sfnt.Font, error) {
	return r.fonts.Font(family, bold, italic)
}

func (r *resources) Token(name string) (string, bool) {
	return r.lookup(name)
}

// Resources is what a run of this session's edit lists needs besides the
// picture; a save job keeps it after the session is closed.
func (s *Session) Resources() imaging.Resources { return s.res }

// Tokens are the facts about a picture that text can show: its name, date
// and size, and the EXIF tags it carries as "exif.<tag>".
func Tokens(src Source, width, height int, modified time.Time, info []imaging.InfoGroup) map[string]string {
	base := filepath.Base(src.Path)
	ext := filepath.Ext(base)
	t := map[string]string{
		"filename": base,
		"name":     strings.TrimSuffix(base, ext),
		"ext":      strings.TrimPrefix(ext, "."),
		"folder":   filepath.Base(filepath.Dir(src.Path)),
		"date":     modified.Format("2006-01-02"),
		"time":     modified.Format("15:04"),
		"year":     modified.Format("2006"),
		"month":    modified.Format("01"),
		"day":      modified.Format("02"),
		"width":    strconv.Itoa(width),
		"height":   strconv.Itoa(height),
	}
	for _, g := range info {
		for _, item := range g.Items {
			if item.Value != "" {
				t["exif."+strings.ToLower(item.ID)] = item.Value
			}
		}
	}
	return t
}
