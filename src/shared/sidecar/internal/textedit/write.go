package textedit

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"panelyth/sidecar/internal/fileops"
)

// commitWaits are the pauses before the rename is tried again. A file that
// was just written is often opened for a moment by a virus scanner, the
// search indexer or a sync tool; the rename then fails with a sharing
// violation that is gone a few milliseconds later (as fileops waits for a
// copy's commit). At most 410 ms.
var commitWaits = []time.Duration{5 * time.Millisecond, 15 * time.Millisecond, 40 * time.Millisecond,
	100 * time.Millisecond, 250 * time.Millisecond}

// replace renames partial over target; tests make it fail.
var replace = replaceFile

// writeFile replaces target's contents with data and returns target's
// info after. cur is target's info before; nil creates the file.
//
// The bytes go to a partial file in the same folder (fileops.PartialName,
// so startup recovery and the index treat it as any unfinished copy), are
// synced, take the original's permissions or attributes (not its dates: a
// save changes the modified time) and are renamed over the original. A
// failure at any step removes the partial file and leaves the original as
// it was.
func writeFile(ctx context.Context, target string, data []byte, cur fs.FileInfo) (fs.FileInfo, error) {
	if cur != nil && linkCount(target) > 1 {
		// A file with more than one hard link: a rename would give this name
		// a new file and leave the other names on the old contents. It is
		// written in place instead, so all names stay one file. The price is
		// that this write is not atomic: a crash or a full disk midway
		// leaves the file cut short (the editor still holds the text).
		if err := writeInPlace(ctx, target, data); err != nil {
			return nil, err
		}
		return os.Stat(target)
	}
	dir := filepath.Dir(target)
	partial := fileops.PartialName(dir, filepath.Base(target))
	// A partial file left by a crash would make the exclusive create fail.
	fileops.RemovePartial(partial, false)
	err := writePartial(ctx, partial, data, cur != nil)
	if err == nil && cur != nil {
		err = keepAttrs(target, cur, partial)
	}
	if err == nil {
		err = ctx.Err()
	}
	if err == nil {
		err = replace(partial, target)
	}
	if err != nil {
		fileops.RemovePartial(partial, false)
		return nil, err
	}
	syncDir(dir)
	return os.Stat(target)
}

// writePartial writes and syncs a new file. A replacement starts private
// (its permissions are set to the original's before the rename).
func writePartial(ctx context.Context, path string, data []byte, private bool) (err error) {
	perm := fs.FileMode(0o666)
	if private {
		perm = 0o600
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}()
	if err := writeAll(ctx, f, data); err != nil {
		return err
	}
	return f.Sync()
}

// writeAll writes data in steps that look at ctx (the bytes are in memory:
// one write per step, no buffer in between).
func writeAll(ctx context.Context, f *os.File, data []byte) error {
	for off := 0; off < len(data); off += readStep {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := f.Write(data[off:min(len(data), off+readStep)]); err != nil {
			return err
		}
	}
	return nil
}

// overwrite truncates and writes an existing file, and syncs it.
func overwrite(ctx context.Context, target string, data []byte) (err error) {
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}()
	if err := writeAll(ctx, f, data); err != nil {
		return err
	}
	return f.Sync()
}
