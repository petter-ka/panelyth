package editor

import (
	"context"
	"fmt"
	"image"
	"os"
	"path/filepath"
	"runtime"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/imaging"
)

// SaveRequest describes one save (ADR-0035). The picture is decoded again
// at full resolution: a session keeps only its proxy.
type SaveRequest struct {
	Source Source
	// Size and MtimeNs are the file as the session opened it; a file that
	// changed since is not saved over or from.
	Size    int64
	MtimeNs int64
	Edits   imaging.EditList
	// Dest is the file to write (a clean absolute path).
	Dest string
	// Replace: Dest takes the place of the source, which goes to the trash
	// first. Overwrite: another existing file at Dest may be replaced (the
	// user confirmed it in the save dialog).
	Replace   bool
	Overwrite bool
	// TrashDest: the file that has Dest's name goes to the trash before the
	// new one takes it (a batch's "replace" conflict policy, Stage 16).
	TrashDest bool
	Format    string
	Quality   int
	// Policy is a metadata policy (imaging.MetaKeep, …).
	Policy string
	// DPI, when set, is the resolution written instead of the edit list's.
	DPI imaging.DPI
	// Res gives the list its assets, fonts and tokens (the session's).
	Res imaging.Resources

	// Reserve takes decode memory; Step reports progress (done of total
	// steps, and the bytes written so far). Trash moves the original to
	// the OS trash; nil uses fileops.Trash.
	Reserve func(ctx context.Context, pixels int64) (func(), error)
	Step    func(done, total int, bytes int64)
	Trash   func(path string) error
}

// SaveResult describes the written file.
type SaveResult struct {
	Path          string
	Width, Height int
	Bytes         int64
	// Trashed: the original went to the trash (Replace).
	Trashed bool
	// SourceBytes is the size of the file that was read.
	SourceBytes int64
	// ModTimeNs is the written file's modification time.
	ModTimeNs int64
}

// saveSteps: check, decode, render, write, commit.
const saveSteps = 5

// largeSavePixels: from this size a save collects garbage between its steps.
const largeSavePixels = 16_000_000

// Save renders the source through the edit list at full resolution and
// writes it atomically: a partial file beside the destination, synced, then
// renamed into place. With Replace the original is moved to the trash
// between the two, so a failure at any step leaves the original where it
// was or in the trash, and never a half-written file. Cancelling removes
// the partial file.
func Save(ctx context.Context, req SaveRequest) (SaveResult, error) {
	step := func(done int, bytes int64) {
		if req.Step != nil {
			req.Step(done, saveSteps, bytes)
		}
	}
	if _, ok := imaging.SaveFormats[req.Format]; !ok {
		return SaveResult{}, fmt.Errorf("%w: save format %q", imaging.ErrInvalidEdit, req.Format)
	}
	fi, err := os.Stat(req.Source.Path)
	if err != nil {
		return SaveResult{}, err
	}
	if fi.Size() != req.Size || fi.ModTime().UnixNano() != req.MtimeNs {
		return SaveResult{}, ErrChanged
	}
	probe, err := imaging.DefaultRegistry().ProbeFile(req.Source.Path, req.Source.Ext)
	if err != nil {
		return SaveResult{}, err
	}
	if probe.Pixels() > MaxPixels {
		return SaveResult{}, ErrTooLarge
	}
	w, h := probe.DisplaySize()
	meta, err := imaging.ReadMetadata(req.Source.Path, probe.Decoder.Name())
	if err != nil {
		return SaveResult{}, err
	}
	prog, err := imaging.Compile(req.Edits, w, h, meta.DPI)
	if err != nil {
		return SaveResult{}, err
	}
	step(1, 0)

	// The decoded picture, its RGBA form and one operation's output.
	release := func() {}
	if req.Reserve != nil {
		if release, err = req.Reserve(ctx, 3*probe.Pixels()); err != nil {
			return SaveResult{}, err
		}
	}
	defer release()
	// A large picture is several hundred megabytes per copy. What a step
	// leaves behind is collected at once instead of when the heap has
	// doubled: the peak is then one step's input and output, not three.
	large := probe.Pixels() >= largeSavePixels
	collect := func() {
		if large {
			runtime.GC()
		}
	}
	img, err := imaging.DecodeOriented(ctx, probe)
	if err != nil {
		return SaveResult{}, err
	}
	collect()
	step(2, 0)
	out, err := prog.Run(ctx, img, 0, imaging.RunOptions{Scale: 1, Res: req.Res, Each: func(int, *image.RGBA) { collect() }})
	if err != nil {
		return SaveResult{}, err
	}
	img = nil
	collect()
	step(3, 0)

	dpi := prog.DPI()
	if req.DPI.X > 0 {
		dpi = req.DPI
		if dpi.Y <= 0 {
			dpi.Y = dpi.X
		}
	}
	ow, oh := out.Rect.Dx(), out.Rect.Dy()
	opts := imaging.SaveOptions{Format: req.Format, Quality: req.Quality, Meta: meta.For(req.Policy, ow, oh, dpi)}
	dir, name := filepath.Split(req.Dest)
	partial := fileops.PartialName(filepath.Clean(dir), name)
	var written int64
	err = imaging.WriteFile(ctx, partial, out, opts, func(n int) {
		written += int64(n)
		step(3, written)
	})
	if err != nil {
		return SaveResult{}, err
	}
	step(4, written)
	// From here on the save is not interrupted: either the file is
	// committed or the partial is removed.
	res := SaveResult{Path: req.Dest, Width: ow, Height: oh, SourceBytes: fi.Size()}
	if pfi, err := os.Stat(partial); err == nil {
		res.Bytes = pfi.Size()
	}
	if err := ctx.Err(); err != nil {
		fileops.RemovePartial(partial, false)
		return SaveResult{}, err
	}
	if req.Replace {
		// Once more, right before the original is touched.
		if fi, err := os.Stat(req.Source.Path); err != nil || fi.Size() != req.Size || fi.ModTime().UnixNano() != req.MtimeNs {
			fileops.RemovePartial(partial, false)
			if err != nil {
				return SaveResult{}, err
			}
			return SaveResult{}, ErrChanged
		}
		if err := trashFile(req, req.Source.Path); err != nil {
			fileops.RemovePartial(partial, false)
			return SaveResult{}, err
		}
		res.Trashed = true
	}
	if req.TrashDest && !req.Replace {
		if _, err := os.Lstat(req.Dest); err == nil {
			if err := trashFile(req, req.Dest); err != nil {
				fileops.RemovePartial(partial, false)
				return SaveResult{}, err
			}
		}
	}
	// After a Replace the name is free; otherwise only a confirmed
	// overwrite may take an existing file's place.
	if err := fileops.CommitFile(partial, req.Dest, req.Overwrite && !req.Replace); err != nil {
		if res.Trashed {
			return res, fmt.Errorf("the original is in the trash, but the new file could not be put in its place: %w", err)
		}
		return SaveResult{}, err
	}
	if cfi, err := os.Stat(req.Dest); err == nil {
		res.ModTimeNs = cfi.ModTime().UnixNano()
	}
	step(5, written)
	return res, nil
}

func trashFile(req SaveRequest, path string) error {
	if req.Trash != nil {
		return req.Trash(path)
	}
	return fileops.Trash(path)
}

// IsTrashUnavailable reports a Replace that failed because the drive has no
// trash.
func IsTrashUnavailable(err error) bool {
	return fileops.Code(err) == fileops.CodeTrashUnavailable
}

// SamePath reports whether two clean paths name the same file.
func SamePath(a, b string) bool {
	if a == b {
		return true
	}
	fa, erra := os.Stat(a)
	fb, errb := os.Stat(b)
	return erra == nil && errb == nil && os.SameFile(fa, fb)
}
