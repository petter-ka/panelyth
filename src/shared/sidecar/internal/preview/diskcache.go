package preview

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"panelyth/sidecar/internal/imaging"
)

// DiskCache stores preview files under <cacheRoot>/thumbnails/ab/cd/<key>.<ext>
// (two-level sharding keeps directories small). Writes go to <cacheRoot>/tmp
// on the same volume and are renamed into place, so a crash can never leave a
// partial file that looks valid.
type DiskCache struct {
	root string
	tmp  string
}

// OpenDiskCache creates the directories and clears leftovers in tmp.
func OpenDiskCache(cacheRoot string) (*DiskCache, error) {
	c := &DiskCache{root: filepath.Join(cacheRoot, "thumbnails"), tmp: filepath.Join(cacheRoot, "tmp")}
	for _, d := range []string{c.root, c.tmp} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}
	entries, err := os.ReadDir(c.tmp)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		_ = os.RemoveAll(filepath.Join(c.tmp, e.Name()))
	}
	return c, nil
}

// Root is the thumbnails directory (shared with Electron main via hello).
func (c *DiskCache) Root() string { return c.root }

// Path returns the file path of a preview.
func (c *DiskCache) Path(k Key, f imaging.Format) string {
	h := k.Hex()
	return filepath.Join(c.root, h[0:2], h[2:4], h+"."+string(f))
}

// Write stores data atomically and returns its size.
func (c *DiskCache) Write(k Key, f imaging.Format, data []byte) (int64, error) {
	dst := c.Path(k, f)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return 0, err
	}
	tmp, err := os.CreateTemp(c.tmp, "w-*")
	if err != nil {
		return 0, err
	}
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if err := errors.Join(werr, cerr); err != nil {
		_ = os.Remove(tmp.Name())
		return 0, err
	}
	if err := os.Rename(tmp.Name(), dst); err != nil {
		_ = os.Remove(tmp.Name())
		return 0, err
	}
	return int64(len(data)), nil
}

// Remove deletes a preview file; a missing file is not an error.
func (c *DiskCache) Remove(k Key, f imaging.Format) error {
	err := os.Remove(c.Path(k, f))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// Size returns the on-disk size of a preview, or an error if it is missing.
func (c *DiskCache) Size(k Key, f imaging.Format) (int64, error) {
	fi, err := os.Stat(c.Path(k, f))
	if err != nil {
		return 0, err
	}
	return fi.Size(), nil
}

// CachedFile is one file found by a shard walk.
type CachedFile struct {
	Key    Key
	Format imaging.Format
	Path   string
}

// Shard lists the files under first-level shard n (0..255). Walking one
// shard at a time bounds cleanup work per tick.
func (c *DiskCache) Shard(n int) ([]CachedFile, error) {
	dir := filepath.Join(c.root, fmt.Sprintf("%02x", n))
	var out []CachedFile
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return filepath.SkipDir
			}
			return err
		}
		if d.IsDir() {
			return nil
		}
		name := d.Name()
		dot := strings.LastIndexByte(name, '.')
		if dot < 0 {
			return nil
		}
		k, perr := ParseKey(name[:dot])
		if perr != nil {
			return nil
		}
		out = append(out, CachedFile{Key: k, Format: imaging.Format(name[dot+1:]), Path: p})
		return nil
	})
	return out, err
}
