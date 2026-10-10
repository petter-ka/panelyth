// Package fixture generates deterministic directory trees for tests,
// benchmarks and e2e runs (docs/shared/TESTING.md "Performance fixtures").
package fixture

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Spec describes a tree. Files are tiny (a few bytes): scanning never reads
// content, and generation stays fast.
type Spec struct {
	// Files per directory (media and non-media combined).
	Files int
	// Depth of subdirectories below the root (0 = flat).
	Depth int
	// Fanout is the number of subdirectories per directory above Depth.
	Fanout int
	// NonMediaEvery makes every n-th file a .txt (0 = none).
	NonMediaEvery int
	// HiddenEvery makes every n-th file a dot-file (0 = none).
	HiddenEvery int
}

var exts = []string{"jpg", "png", "JPG", "jpeg", "webp", "mp4", "gif", "tif"}

// Expected counts produced by Generate for a Spec.
type Expected struct {
	Dirs, Media, NonMedia, Hidden int
}

// Generate writes the tree under root (which must not exist or be empty) and
// returns the counts. A marker file makes repeated calls with the same spec
// a no-op, so large fixtures are generated once per machine.
func Generate(root string, spec Spec) (Expected, error) {
	marker := filepath.Join(root, ".panelyth-fixture")
	want := fmt.Sprintf("%+v", spec)
	exp := expected(spec)
	if b, err := os.ReadFile(marker); err == nil && string(b) == want {
		return exp, nil
	}
	if err := os.RemoveAll(root); err != nil {
		return exp, err
	}
	if err := gen(root, spec, spec.Depth); err != nil {
		return exp, err
	}
	return exp, os.WriteFile(marker, []byte(want), 0o644)
}

func expected(s Spec) Expected {
	var e Expected
	dirs := 1
	levelDirs := 1
	for range s.Depth {
		levelDirs *= s.Fanout
		dirs += levelDirs
	}
	e.Dirs = dirs - 1 // subdirectories below root
	for i := range s.Files {
		switch {
		case s.HiddenEvery > 0 && i%s.HiddenEvery == s.HiddenEvery-1:
			e.Hidden++
		case s.NonMediaEvery > 0 && i%s.NonMediaEvery == s.NonMediaEvery-1:
			e.NonMedia++
		default:
			e.Media++
		}
	}
	e.Media *= dirs
	e.NonMedia *= dirs
	e.Hidden *= dirs
	return e
}

var baseTime = time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)

func gen(dir string, s Spec, depth int) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for i := range s.Files {
		var name string
		switch {
		case s.HiddenEvery > 0 && i%s.HiddenEvery == s.HiddenEvery-1:
			name = fmt.Sprintf(".hidden_%d.jpg", i)
		case s.NonMediaEvery > 0 && i%s.NonMediaEvery == s.NonMediaEvery-1:
			name = fmt.Sprintf("notes_%d.txt", i)
		default:
			name = fmt.Sprintf("IMG_%d.%s", i, exts[i%len(exts)])
		}
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, make([]byte, i%17), 0o644); err != nil {
			return err
		}
		mt := baseTime.Add(time.Duration((i*7919)%100_000) * time.Second)
		if err := os.Chtimes(p, mt, mt); err != nil {
			return err
		}
	}
	if depth > 0 {
		for d := range s.Fanout {
			if err := gen(filepath.Join(dir, fmt.Sprintf("folder %d", d+1)), s, depth-1); err != nil {
				return err
			}
		}
	}
	// Last, because creating children updates the directory's mtime.
	return os.Chtimes(dir, baseTime, baseTime)
}
