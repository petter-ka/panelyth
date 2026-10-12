// Package fixture generates deterministic directory trees for tests,
// benchmarks and e2e runs (docs/shared/TESTING.md "Performance fixtures").
package fixture

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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
	// ExecEvery makes every n-th file a program (.exe, mode 0755; 0 = none).
	ExecEvery int
	// LinkEvery makes every n-th file a symbolic link to the file before it
	// (0 = none). Where the OS refuses to create links (Windows without
	// developer mode) these are plain documents instead.
	LinkEvery int
}

var exts = []string{"jpg", "png", "JPG", "jpeg", "webp", "mp4", "gif", "tif"}

// Expected counts produced by Generate for a Spec. NonMedia are documents;
// programs and links are counted apart.
type Expected struct {
	Dirs, Media, NonMedia, Hidden, Exec, Links int
}

// A cleaner of temporary files (Storage Sense on Windows, systemd-tmpfiles)
// can remove part of a generated tree and leave its marker behind: files,
// and the folders it emptied. A marker alone is therefore not a fixture.
// The marker's second line is the count of the root's entries when the tree
// was generated, and a tree whose root holds fewer is generated again
// (Stage P04).

// topCount counts the root's entries, the generators' own files aside.
func topCount(root string) (int, bool) {
	ents, err := os.ReadDir(root)
	if err != nil {
		return 0, false
	}
	n := 0
	for _, e := range ents {
		if !strings.HasPrefix(e.Name(), ".panelyth-") {
			n++
		}
	}
	return n, true
}

// cached reports whether root still holds what its marker describes.
func cached(root, markerFile, want string) bool {
	b, err := os.ReadFile(markerFile)
	if err != nil {
		return false
	}
	what, count, ok := strings.Cut(string(b), "\n")
	if !ok || what != want {
		return false // another tree, or one generated before the count was kept
	}
	sealed, err := strconv.Atoi(count)
	now, ok := topCount(root)
	// Fewer is damage; more is what a test left behind, as before.
	return err == nil && ok && now >= sealed
}

// seal writes the marker after a tree was generated.
func seal(root, markerFile, want string) error {
	n, ok := topCount(root)
	if !ok {
		return fmt.Errorf("fixture root %s cannot be read", root)
	}
	return os.WriteFile(markerFile, []byte(want+"\n"+strconv.Itoa(n)), 0o644)
}

// marker identifies a generated tree. The first part is what was written
// before programs and links existed, so trees generated then are still
// recognized.
func marker(s Spec, links bool) string {
	m := fmt.Sprintf("{Files:%d Depth:%d Fanout:%d NonMediaEvery:%d HiddenEvery:%d}",
		s.Files, s.Depth, s.Fanout, s.NonMediaEvery, s.HiddenEvery)
	if s.ExecEvery > 0 || s.LinkEvery > 0 {
		m += fmt.Sprintf(" exec:%d link:%d symlinks:%v", s.ExecEvery, s.LinkEvery, links)
	}
	return m
}

// canLink reports whether symbolic links can be created beside root.
func canLink(root string) bool {
	parent := filepath.Dir(root)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return false
	}
	probe := filepath.Join(parent, fmt.Sprintf(".panelyth-link-probe-%d", os.Getpid()))
	if err := os.Symlink("target", probe); err != nil {
		return false
	}
	_ = os.Remove(probe)
	return true
}

// fileClass is what the i-th file of a directory is.
type fileClass int

const (
	classMedia fileClass = iota
	classDoc
	classHidden
	classExec
	classLink
)

func classOf(s Spec, i int, links bool) fileClass {
	every := func(n int) bool { return n > 0 && i%n == n-1 }
	switch {
	case every(s.LinkEvery) && i > 0:
		if links {
			return classLink
		}
		return classDoc
	case every(s.ExecEvery):
		return classExec
	case every(s.HiddenEvery):
		return classHidden
	case every(s.NonMediaEvery):
		return classDoc
	}
	return classMedia
}

func fileName(c fileClass, i int) string {
	switch c {
	case classLink:
		return fmt.Sprintf("link_%d.jpg", i)
	case classExec:
		return fmt.Sprintf("tool_%d.exe", i)
	case classHidden:
		return fmt.Sprintf(".hidden_%d.jpg", i)
	case classDoc:
		return fmt.Sprintf("notes_%d.txt", i)
	}
	return fmt.Sprintf("IMG_%d.%s", i, exts[i%len(exts)])
}

// Generate writes the tree under root (which must not exist or be empty) and
// returns the counts. A marker file makes repeated calls with the same spec
// a no-op, so large fixtures are generated once per machine.
func Generate(root string, spec Spec) (Expected, error) {
	markerFile := filepath.Join(root, ".panelyth-fixture")
	links := spec.LinkEvery > 0 && canLink(root)
	want := marker(spec, links)
	exp := expected(spec, links)
	if cached(root, markerFile, want) {
		return exp, nil
	}
	if err := os.RemoveAll(root); err != nil {
		return exp, err
	}
	if err := gen(root, spec, spec.Depth, links); err != nil {
		return exp, err
	}
	return exp, seal(root, markerFile, want)
}

func expected(s Spec, links bool) Expected {
	var e Expected
	dirs := 1
	levelDirs := 1
	for range s.Depth {
		levelDirs *= s.Fanout
		dirs += levelDirs
	}
	e.Dirs = dirs - 1 // subdirectories below root
	for i := range s.Files {
		switch classOf(s, i, links) {
		case classLink:
			e.Links++
		case classExec:
			e.Exec++
		case classHidden:
			e.Hidden++
		case classDoc:
			e.NonMedia++
		default:
			e.Media++
		}
	}
	e.Media *= dirs
	e.NonMedia *= dirs
	e.Hidden *= dirs
	e.Exec *= dirs
	e.Links *= dirs
	return e
}

var baseTime = time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)

func gen(dir string, s Spec, depth int, links bool) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	prev := ""
	for i := range s.Files {
		c := classOf(s, i, links)
		name := fileName(c, i)
		p := filepath.Join(dir, name)
		if c == classLink {
			// Relative, to the file before it: never followed by the scanner.
			if err := os.Symlink(prev, p); err != nil {
				return err
			}
			continue
		}
		mode := os.FileMode(0o644)
		if c == classExec {
			mode = 0o755
		}
		if err := os.WriteFile(p, make([]byte, i%17), mode); err != nil {
			return err
		}
		mt := baseTime.Add(time.Duration((i*7919)%100_000) * time.Second)
		if err := os.Chtimes(p, mt, mt); err != nil {
			return err
		}
		prev = name
	}
	if depth > 0 {
		for d := range s.Fanout {
			if err := gen(filepath.Join(dir, fmt.Sprintf("folder %d", d+1)), s, depth-1, links); err != nil {
				return err
			}
		}
	}
	// Last, because creating children updates the directory's mtime.
	return os.Chtimes(dir, baseTime, baseTime)
}
