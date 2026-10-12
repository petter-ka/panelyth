package fileops

import (
	"io/fs"
	"os"
	"time"

	"panelyth/sidecar/internal/fsx"
)

// SettableAttrs are the attribute bits a change may set or clear (Windows:
// read-only, hidden, system and archive). Elsewhere permissions take their
// place.
const SettableAttrs = fsx.AttrReadOnly | fsx.AttrHidden | fsx.AttrSystem | fsx.AttrArchive

// AttrChange is a change of attributes, permissions and dates (Stage C09).
// The zero value changes nothing.
type AttrChange struct {
	// Set and Clear are fsx.Attr* bits; bits in neither stay as they are.
	// They apply on Windows only.
	Set, Clear int
	// ModeSet and ModeClear are permission bits (0o777); they apply
	// everywhere but on Windows.
	ModeSet, ModeClear fs.FileMode
	// Modified and Accessed replace the dates; a zero time leaves one.
	Modified, Accessed time.Time
}

// Empty reports whether the change changes nothing.
func (c AttrChange) Empty() bool {
	return c.Set == 0 && c.Clear == 0 && c.ModeSet == 0 && c.ModeClear == 0 && c.Modified.IsZero() && c.Accessed.IsZero()
}

// ApplyAttrs changes one entry. It must not be a link: dates and
// permissions would go to its target.
func ApplyAttrs(path string, c AttrChange) error {
	if !c.Modified.IsZero() || !c.Accessed.IsZero() {
		if err := os.Chtimes(path, c.Accessed, c.Modified); err != nil {
			return err
		}
	}
	return setAttrs(path, c)
}
