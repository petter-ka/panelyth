package fsx

import (
	"errors"
	"io/fs"
	"os"
	"time"
)

// removeWaits are the pauses before a removal is tried again. A file that was
// just written is often opened for a moment by a virus scanner or the search
// indexer (Windows), and removing it fails until they let go. Like the commit
// of a copy (fileops, commitWaits), this waits it out, for at most 410 ms.
var removeWaits = []time.Duration{5 * time.Millisecond, 15 * time.Millisecond,
	40 * time.Millisecond, 100 * time.Millisecond, 250 * time.Millisecond}

// RemoveSoon removes a file, trying again for a moment while something else
// holds it. A file that is gone already is no error. It blocks for the
// waits: not for a hot path.
func RemoveSoon(path string) error {
	err := os.Remove(path)
	for _, wait := range removeWaits {
		if err == nil || errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		time.Sleep(wait)
		err = os.Remove(path)
	}
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}
