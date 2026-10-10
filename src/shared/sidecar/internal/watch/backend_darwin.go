//go:build darwin

package watch

import (
	"errors"
	"sync"

	"golang.org/x/sys/unix"
)

// kqueueBackend watches each directory through one descriptor on the
// directory itself (Stage P04, ADR-0020). fsnotify's kqueue backend also
// opens every file in a watched directory, one descriptor each: a 100k-file
// folder meant 100k opens inside dir.open and could exhaust the process's
// descriptors. NOTE_WRITE on a directory reports entries added, removed or
// renamed; a file rewritten in place without its directory changing is not
// seen (F5 re-lists).
type kqueueBackend struct {
	kq   int
	mu   sync.Mutex
	fds  map[string]int
	dirs map[int]string
	out  chan string
	errs chan error
	stop chan struct{}
	done chan struct{}
}

const dirNotes = unix.NOTE_WRITE | unix.NOTE_EXTEND | unix.NOTE_ATTRIB | unix.NOTE_DELETE | unix.NOTE_RENAME

func newBackend() (backend, error) {
	kq, err := unix.Kqueue()
	if err != nil {
		return nil, err
	}
	unix.CloseOnExec(kq)
	b := &kqueueBackend{kq: kq, fds: map[string]int{}, dirs: map[int]string{},
		out: make(chan string), errs: make(chan error), stop: make(chan struct{}), done: make(chan struct{})}
	go b.loop()
	return b, nil
}

func (b *kqueueBackend) Add(dir string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.fds[dir]; ok {
		return nil
	}
	fd, err := unix.Open(dir, unix.O_EVTONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	ev := unix.Kevent_t{}
	unix.SetKevent(&ev, fd, unix.EVFILT_VNODE, unix.EV_ADD|unix.EV_CLEAR|unix.EV_ENABLE)
	ev.Fflags = dirNotes
	if _, err := unix.Kevent(b.kq, []unix.Kevent_t{ev}, nil, nil); err != nil {
		_ = unix.Close(fd)
		return err
	}
	b.fds[dir], b.dirs[fd] = fd, dir
	return nil
}

// Remove closes the directory's descriptor, which also removes its kevent.
func (b *kqueueBackend) Remove(dir string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	fd, ok := b.fds[dir]
	if !ok {
		return nil
	}
	delete(b.fds, dir)
	delete(b.dirs, fd)
	return unix.Close(fd)
}

func (b *kqueueBackend) Close() error {
	close(b.stop)
	<-b.done
	b.mu.Lock()
	for dir, fd := range b.fds {
		_ = unix.Close(fd)
		delete(b.fds, dir)
	}
	b.mu.Unlock()
	return unix.Close(b.kq)
}

func (b *kqueueBackend) changed() <-chan string { return b.out }
func (b *kqueueBackend) errors() <-chan error   { return b.errs }

// loop waits for kevents with a short timeout so Close can stop it.
func (b *kqueueBackend) loop() {
	defer close(b.done)
	defer close(b.out)
	events := make([]unix.Kevent_t, 32)
	timeout := unix.NsecToTimespec(int64(200e6))
	for {
		select {
		case <-b.stop:
			return
		default:
		}
		n, err := unix.Kevent(b.kq, nil, events, &timeout)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			select {
			case b.errs <- err:
			case <-b.stop:
				return
			}
			continue
		}
		for _, ev := range events[:n] {
			b.mu.Lock()
			dir, ok := b.dirs[int(ev.Ident)]
			b.mu.Unlock()
			if !ok {
				continue
			}
			select {
			case b.out <- dir:
			case <-b.stop:
				return
			}
		}
	}
}
