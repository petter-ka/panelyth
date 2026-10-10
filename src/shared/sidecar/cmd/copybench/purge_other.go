//go:build !windows

package main

import (
	"bufio"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// purgeTrash removes the freedesktop.org trash entries whose original path
// is inside dir (home trash only). macOS keeps no original paths for a
// pure-Go trash, so the bench files are left for the user there.
func purgeTrash(dir string) (int, error) {
	if runtime.GOOS == "darwin" {
		return 0, errors.New("the macOS trash keeps no original paths; empty it by hand")
	}
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return 0, err
		}
		data = filepath.Join(home, ".local", "share")
	}
	trash := filepath.Join(data, "Trash")
	infos, err := filepath.Glob(filepath.Join(trash, "info", "*.trashinfo"))
	if err != nil {
		return 0, err
	}
	prefix := filepath.Clean(dir) + "/"
	n := 0
	for _, info := range infos {
		f, err := os.Open(info)
		if err != nil {
			continue
		}
		var orig string
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if p, ok := strings.CutPrefix(sc.Text(), "Path="); ok {
				orig, _ = url.PathUnescape(p)
			}
		}
		_ = f.Close()
		if !strings.HasPrefix(orig, prefix) {
			continue
		}
		name := strings.TrimSuffix(filepath.Base(info), ".trashinfo")
		if os.RemoveAll(filepath.Join(trash, "files", name)) == nil && os.Remove(info) == nil {
			n++
		}
	}
	return n, nil
}
