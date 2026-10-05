// Package platform resolves OS-specific locations. Application code must not
// hardcode per-OS paths; everything goes through here.
package platform

import (
	"fmt"
	"os"
	"path/filepath"
)

const (
	appDirName   = "FastView"
	cacheVersion = "v1"
)

// Dirs are the sidecar's storage roots. They are resolved, not created:
// subsystems create what they need when they first write.
type Dirs struct {
	// CacheRoot holds disposable data (preview cache, index.db). Safe to delete.
	CacheRoot string
	// ConfigRoot holds user data (library.db: tags, ratings, bookmarks, settings).
	ConfigRoot string
}

// ResolveDirs uses the OS per-user cache/config directories. The
// FASTVIEW_CACHE_DIR and FASTVIEW_CONFIG_DIR environment variables override
// them (tests, portable setups).
func ResolveDirs(getenv func(string) string) (Dirs, error) {
	cacheBase := getenv("FASTVIEW_CACHE_DIR")
	if cacheBase == "" {
		base, err := os.UserCacheDir()
		if err != nil {
			return Dirs{}, fmt.Errorf("resolve cache dir: %w", err)
		}
		cacheBase = filepath.Join(base, appDirName)
	}
	configRoot := getenv("FASTVIEW_CONFIG_DIR")
	if configRoot == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return Dirs{}, fmt.Errorf("resolve config dir: %w", err)
		}
		configRoot = filepath.Join(base, appDirName)
	}
	return Dirs{
		CacheRoot:  filepath.Join(filepath.Clean(cacheBase), cacheVersion),
		ConfigRoot: filepath.Clean(configRoot),
	}, nil
}
