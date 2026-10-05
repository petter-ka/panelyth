// Package preview generates, caches and serves thumbnails (CACHE-DESIGN.md,
// ADR-0003): content-addressed keys, a sharded disk cache with atomic writes,
// a SQLite cache index, and a bounded, deduplicating priority scheduler.
package preview

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"

	"fastview/sidecar/internal/imaging"
)

// Profile names a preview size. Part of the cache key and the protocol.
type Profile string

const (
	GridSm    Profile = "grid-sm"
	GridMd    Profile = "grid-md"
	GridLg    Profile = "grid-lg"
	ViewerFit Profile = "viewer-fit"
)

// Long-edge sizes in device pixels (docs/shared/ARCHITECTURE-ANALYSIS.md §5.3).
var maxEdge = map[Profile]int{GridSm: 192, GridMd: 384, GridLg: 768, ViewerFit: 2560}

// MaxEdge returns the long-edge size of p.
func (p Profile) MaxEdge() (int, bool) {
	e, ok := maxEdge[p]
	return e, ok
}

const (
	// CacheVersion names the cache root directory (v1/).
	CacheVersion = "v1"
	// TransformVersion changes whenever decoding, resizing, orientation or
	// encoding output changes, so old previews become misses.
	TransformVersion = 1
)

// Key identifies one preview of one version of one file.
type Key [sha256.Size]byte

// MakeKey hashes source identity (path key, size, mtime) with the profile
// and every version that affects the output. The path alone is not enough:
// a file replaced in place keeps its name.
func MakeKey(pathKey string, size, mtimeNs int64, p Profile) Key {
	h := sha256.New()
	h.Write([]byte(CacheVersion))
	h.Write([]byte{0})
	h.Write([]byte(pathKey))
	h.Write([]byte{0})
	var n [8]byte
	binary.BigEndian.PutUint64(n[:], uint64(size))
	h.Write(n[:])
	binary.BigEndian.PutUint64(n[:], uint64(mtimeNs))
	h.Write(n[:])
	h.Write([]byte(p))
	h.Write([]byte{0, TransformVersion, imaging.JPEGQuality})
	var k Key
	h.Sum(k[:0])
	return k
}

// Hex is the lowercase hex form used in file names and URLs.
func (k Key) Hex() string { return hex.EncodeToString(k[:]) }

// ParseKey parses a 64-character hex key.
func ParseKey(s string) (Key, error) {
	var k Key
	if len(s) != 2*len(k) {
		return k, errors.New("preview: bad key length")
	}
	_, err := hex.Decode(k[:], []byte(s))
	return k, err
}

// URL is the renderer-facing address served by Electron main's
// fastview-thumb protocol. It is derived from the key; main resolves it to a
// file without asking the sidecar.
func URL(k Key, f imaging.Format) string {
	return "fastview-thumb://t/" + k.Hex() + "." + string(f)
}
