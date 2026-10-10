//go:build !darwin

package watch

import (
	"path/filepath"

	"github.com/fsnotify/fsnotify"
)

// fsnotifyBackend wraps fsnotify (inotify on Linux, ReadDirectoryChangesW on
// Windows): one watch per directory, events name the changed entry.
type fsnotifyBackend struct {
	fw  *fsnotify.Watcher
	out chan string
}

func newBackend() (backend, error) {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	b := &fsnotifyBackend{fw: fw, out: make(chan string)}
	go func() {
		defer close(b.out)
		for ev := range fw.Events {
			b.out <- filepath.Dir(ev.Name)
		}
	}()
	return b, nil
}

func (b *fsnotifyBackend) Add(dir string) error    { return b.fw.Add(dir) }
func (b *fsnotifyBackend) Remove(dir string) error { return b.fw.Remove(dir) }
func (b *fsnotifyBackend) Close() error            { return b.fw.Close() }
func (b *fsnotifyBackend) changed() <-chan string  { return b.out }
func (b *fsnotifyBackend) errors() <-chan error    { return b.fw.Errors }
