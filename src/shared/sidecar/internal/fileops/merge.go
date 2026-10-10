package fileops

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// Folder merges (ADR-0029): copying or moving a folder onto an existing
// folder of the same name, with "replace" (or replace older, replace if
// different size), merges the two: what is missing is added, folders are
// merged recursively, and every file that exists on both sides is decided
// by o.Conflict (the job's policy, or a question to the user).

// MergeCopy copies the contents of the folder src into the existing folder
// dst.
func MergeCopy(ctx context.Context, src, dst string, o *CopyOptions) error {
	return merge(ctx, src, dst, o, false)
}

// MergeMove moves the contents of src into the existing folder dst and
// removes src when nothing was left behind (skipped files stay).
func MergeMove(ctx context.Context, src, dst string, o *CopyOptions) error {
	if err := merge(ctx, src, dst, o, true); err != nil {
		return err
	}
	_ = os.Remove(src) // fails, as intended, when skipped items remain
	return nil
}

func merge(ctx context.Context, src, dst string, o *CopyOptions, move bool) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := o.gate(ctx); err != nil {
			return err
		}
		name := e.Name()
		if err := o.validName(name); err != nil {
			return &Error{Code: CodeInvalidName, Err: errors.New(name + ": " + err.Error())}
		}
		s, d := filepath.Join(src, name), filepath.Join(dst, name)
		si, err := os.Lstat(s)
		if err != nil {
			return err
		}
		if !si.IsDir() && !o.included(name) {
			continue // left in place (a move keeps the source folder for it)
		}
		di, err := os.Lstat(d)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			err = place(ctx, s, si, d, o, move, false)
		case err != nil:
		case si.IsDir() && di.IsDir():
			err = merge(ctx, s, d, o, move)
			if err == nil && move {
				_ = os.Remove(s)
			}
		default:
			err = mergeConflict(ctx, s, si, d, di, o, move)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// place copies or moves one item to a free name d.
func place(ctx context.Context, s string, si fs.FileInfo, d string, o *CopyOptions, move, replace bool) error {
	switch {
	case move:
		return Move(ctx, s, d, si.IsDir(), replace, o)
	case si.IsDir():
		return CopyTree(ctx, s, d, o)
	case si.Mode()&fs.ModeSymlink != 0:
		if o == nil || o.Links != LinksCopy {
			if o != nil && o.Skipped != nil {
				o.Skipped(s)
			}
			return nil
		}
		if replace {
			_ = forceRemove(d)
		}
		return CopyLink(s, d)
	case si.Mode().IsRegular():
		return CopyFile(ctx, s, d, replace, o)
	}
	if o != nil && o.Skipped != nil {
		o.Skipped(s)
	}
	return nil
}

// mergeConflict decides an item that exists on both sides. A file and a
// folder of the same name are never replaced by each other: "replace"
// keeps both instead.
func mergeConflict(ctx context.Context, s string, si fs.FileInfo, d string, di fs.FileInfo, o *CopyOptions, move bool) error {
	decision := MergeSkip
	if o != nil && o.Conflict != nil {
		var err error
		if decision, err = o.Conflict(ctx, MergeConflict{Source: s, Target: d, Src: si, Dst: di}); err != nil {
			return err
		}
	}
	if decision == MergeReplace && si.IsDir() != di.IsDir() {
		decision = MergeRenameNew
	}
	exists := func(n string) bool {
		_, err := os.Lstat(filepath.Join(filepath.Dir(d), n))
		return err == nil
	}
	switch decision {
	case MergeReplace:
		return place(ctx, s, si, d, o, move, true)
	case MergeRenameNew:
		n, ok := UniqueName(filepath.Base(d), si.IsDir(), exists)
		if !ok {
			return Errorf(CodeExists, "no free name for %s", filepath.Base(d))
		}
		return place(ctx, s, si, filepath.Join(filepath.Dir(d), n), o, move, false)
	case MergeRenameExisting:
		n, ok := UniqueName(filepath.Base(d), di.IsDir(), exists)
		if !ok {
			return Errorf(CodeExists, "no free name for %s", filepath.Base(d))
		}
		if _, err := Rename(d, n); err != nil {
			return err
		}
		return place(ctx, s, si, d, o, move, false)
	}
	return nil // skipped
}
