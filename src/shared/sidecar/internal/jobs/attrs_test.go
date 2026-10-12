package jobs

import (
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/index"
)

func attrsOf(t testing.TB, path string) int {
	t.Helper()
	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fsx.AttrsOf(filepath.Base(path), fi)
}

func modTime(t testing.TB, path string) time.Time {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.ModTime()
}

func item(e *env, id int64) index.Item {
	items, err := e.store.LoadItems(ctx, []int64{id})
	if err != nil || len(items) != 1 {
		e.t.Fatalf("item %d: %v", id, err)
	}
	return items[0]
}

func TestSetDates(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "a.txt"), 1)
	write(t, filepath.Join(e.root, "album", "in.jpg"), 1)
	write(t, filepath.Join(e.root, "album", "deep", "far.jpg"), 1)
	old := time.Date(2001, 2, 3, 4, 5, 6, 0, time.UTC)
	for _, p := range []string{"a.txt", "album", "album/in.jpg", "album/deep", "album/deep/far.jpg"} {
		if err := os.Chtimes(filepath.Join(e.root, filepath.FromSlash(p)), old, old); err != nil {
			t.Fatal(err)
		}
	}
	root := e.index(e.root)
	ids := e.allIDs(root, "a.txt", "album")
	when := time.Date(2020, 6, 7, 8, 9, 10, 0, time.UTC)
	// Not recursive: the folder itself, not what is in it.
	s := e.run(Spec{Kind: KindSetAttributes, IDs: ids, Attrs: &AttrSpec{AttrChange: fileops.AttrChange{Modified: when}}})
	if s.State != StateCompleted || s.Done != 2 || s.Failed != 0 {
		t.Fatalf("set dates: %+v %v", s, e.errors(s.JobID))
	}
	for _, p := range []string{"a.txt", "album"} {
		if got := modTime(t, filepath.Join(e.root, p)); !got.Equal(when) {
			t.Errorf("%s modified %v, want %v", p, got, when)
		}
	}
	if got := modTime(t, filepath.Join(e.root, "album", "in.jpg")); !got.Equal(old) {
		t.Errorf("a file below changed without recursive: %v", got)
	}
	// The listing shows the new date without a rescan.
	if it := item(e, ids[0]); it.MtimeNs != when.UnixNano() {
		t.Errorf("index date %v", time.Unix(0, it.MtimeNs))
	}
	if !e.changed[root.ID] {
		t.Error("the folder's sessions were not told")
	}
	// Recursive: everything below, and the accessed date alone leaves the
	// modified one.
	deep := time.Date(2022, 1, 2, 3, 4, 6, 0, time.UTC)
	s = e.run(Spec{Kind: KindSetAttributes, IDs: ids[1:], Attrs: &AttrSpec{AttrChange: fileops.AttrChange{Modified: deep}, Recursive: true}})
	if s.Done != 1 || s.Failed != 0 {
		t.Fatalf("recursive: %+v %v", s, e.errors(s.JobID))
	}
	for _, p := range []string{"album", "album/in.jpg", "album/deep", "album/deep/far.jpg"} {
		if got := modTime(t, filepath.Join(e.root, filepath.FromSlash(p))); !got.Equal(deep) {
			t.Errorf("%s modified %v, want %v", p, got, deep)
		}
	}
	if got := modTime(t, filepath.Join(e.root, "a.txt")); !got.Equal(when) {
		t.Errorf("an unselected file changed: %v", got)
	}
	s = e.run(Spec{Kind: KindSetAttributes, IDs: ids[:1], Attrs: &AttrSpec{AttrChange: fileops.AttrChange{Accessed: deep}}})
	if got := modTime(t, filepath.Join(e.root, "a.txt")); s.Done != 1 || !got.Equal(when) {
		t.Errorf("setting the accessed date changed the modified one: %v (%+v)", got, s)
	}
	if fi, err := fsx.Stat(filepath.Join(e.root, "a.txt")); err == nil && fsx.FileTimes(fi).AccessNs != 0 {
		// Volumes mounted without access times keep what they had.
		if got := time.Unix(0, fsx.FileTimes(fi).AccessNs); got.Sub(deep).Abs() > 2*time.Second && runtime.GOOS == "windows" {
			t.Errorf("accessed %v, want %v", got, deep)
		}
	}
	// An entry that is gone fails; the others are done.
	if err := os.Remove(filepath.Join(e.root, "a.txt")); err != nil {
		t.Fatal(err)
	}
	s = e.run(Spec{Kind: KindSetAttributes, IDs: ids, Attrs: &AttrSpec{AttrChange: fileops.AttrChange{Modified: when}}})
	if errs := e.errors(s.JobID); s.Done != 1 || s.Failed != 1 || errs[0].Code != fileops.CodeNotFound {
		t.Fatalf("missing entry: %+v %v", s, errs)
	}
}

func TestSetAttributes(t *testing.T) {
	e := newEnv(t)
	file := filepath.Join(e.root, "doc.txt")
	inner := filepath.Join(e.root, "dir", "inner.txt")
	write(t, file, 1)
	write(t, inner, 1)
	root := e.index(e.root)
	ids := e.allIDs(root, "doc.txt", "dir")
	// Whatever the test leaves read-only must be removable afterwards.
	t.Cleanup(func() {
		for _, p := range []string{file, inner, filepath.Dir(inner)} {
			_ = fileops.ApplyAttrs(p, fileops.AttrChange{Clear: fileops.SettableAttrs, ModeSet: 0o700})
		}
	})
	if runtime.GOOS == "windows" {
		set := fileops.AttrChange{Set: fsx.AttrReadOnly | fsx.AttrHidden, Clear: fsx.AttrArchive}
		s := e.run(Spec{Kind: KindSetAttributes, IDs: ids, Attrs: &AttrSpec{AttrChange: set, Recursive: true}})
		if s.Done != 2 || s.Failed != 0 {
			t.Fatalf("set attributes: %+v %v", s, e.errors(s.JobID))
		}
		for _, p := range []string{file, inner, filepath.Dir(inner)} {
			if got := attrsOf(t, p) & fileops.SettableAttrs; got != fsx.AttrReadOnly|fsx.AttrHidden {
				t.Errorf("%s: attributes %04b", filepath.Base(p), got)
			}
		}
		if it := item(e, ids[0]); it.Attrs&fileops.SettableAttrs != fsx.AttrReadOnly|fsx.AttrHidden {
			t.Errorf("index attributes %04b", it.Attrs)
		}
		// Dates can be set on a read-only file, and one bit alone leaves the others.
		when := time.Date(2019, 1, 2, 3, 4, 6, 0, time.UTC)
		s = e.run(Spec{Kind: KindSetAttributes, IDs: ids[:1], Attrs: &AttrSpec{AttrChange: fileops.AttrChange{
			Modified: when, Clear: fsx.AttrHidden, Set: fsx.AttrSystem}}})
		if got := attrsOf(t, file) & fileops.SettableAttrs; s.Done != 1 || got != fsx.AttrReadOnly|fsx.AttrSystem || !modTime(t, file).Equal(when) {
			t.Fatalf("second change: %+v attributes %04b date %v", s, got, modTime(t, file))
		}
		// Permission bits are not Windows': they change nothing.
		s = e.run(Spec{Kind: KindSetAttributes, IDs: ids[:1], Attrs: &AttrSpec{AttrChange: fileops.AttrChange{ModeClear: 0o444}}})
		if got := attrsOf(t, file) & fileops.SettableAttrs; s.Done != 1 || got != fsx.AttrReadOnly|fsx.AttrSystem {
			t.Fatalf("permission bits on Windows: %+v %04b", s, got)
		}
	} else {
		perm := func(p string) fs.FileMode {
			fi, err := os.Lstat(p)
			if err != nil {
				t.Fatal(err)
			}
			return fi.Mode().Perm()
		}
		for _, p := range []string{file, inner} {
			if err := os.Chmod(p, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.Chmod(filepath.Dir(inner), 0o755); err != nil {
			t.Fatal(err)
		}
		// Everything below loses its write bits; the folder is walked before
		// it loses its own.
		change := fileops.AttrChange{ModeClear: 0o222, ModeSet: 0o010}
		s := e.run(Spec{Kind: KindSetAttributes, IDs: ids, Attrs: &AttrSpec{AttrChange: change, Recursive: true}})
		if s.Done != 2 || s.Failed != 0 {
			t.Fatalf("set permissions: %+v %v", s, e.errors(s.JobID))
		}
		if perm(file) != 0o454 || perm(inner) != 0o454 || perm(filepath.Dir(inner)) != 0o555 {
			t.Fatalf("permissions %o %o %o", perm(file), perm(inner), perm(filepath.Dir(inner)))
		}
		if it := item(e, ids[0]); it.Attrs&fsx.AttrReadOnly == 0 {
			t.Errorf("index attributes %b: read-only is missing", it.Attrs)
		}
		// The Windows attributes are not Unix': they change nothing.
		s = e.run(Spec{Kind: KindSetAttributes, IDs: ids[:1], Attrs: &AttrSpec{AttrChange: fileops.AttrChange{Set: fsx.AttrHidden}}})
		if s.Done != 1 || perm(file) != 0o454 {
			t.Fatalf("attribute bits on Unix: %+v %o", s, perm(file))
		}
	}
}

// Links are never changed and never followed.
func TestSetAttributesSkipsLinks(t *testing.T) {
	e := newEnv(t)
	outside := filepath.Join(t.TempDir(), "outside")
	write(t, filepath.Join(outside, "target.txt"), 1)
	old := time.Date(2001, 2, 3, 4, 5, 6, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(outside, "target.txt"), old, old); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(e.root, "dir", "real.txt"), 1)
	link := filepath.Join(e.root, "dir", "link")
	if err := os.Symlink(outside, link); err != nil {
		if out, jerr := exec.Command("cmd", "/c", "mklink", "/J", link, outside).CombinedOutput(); jerr != nil {
			t.Skipf("no link could be made: %v / %v %s", err, jerr, out)
		}
	}
	root := e.index(e.root)
	dir, err := e.store.DirByPath(ctx, filepath.Join(e.root, "dir"))
	if err != nil {
		t.Fatal(err)
	}
	when := time.Date(2020, 6, 7, 8, 9, 10, 0, time.UTC)
	change := &AttrSpec{AttrChange: fileops.AttrChange{Modified: when}, Recursive: true}
	s := e.run(Spec{Kind: KindSetAttributes, IDs: e.allIDs(root, "dir"), Attrs: change})
	if s.Done != 1 || s.Failed != 0 {
		t.Fatalf("recursive over a link: %+v %v", s, e.errors(s.JobID))
	}
	if got := modTime(t, filepath.Join(outside, "target.txt")); !got.Equal(old) {
		t.Fatalf("a file behind a link was changed: %v", got)
	}
	if got := modTime(t, filepath.Join(e.root, "dir", "real.txt")); !got.Equal(when) {
		t.Fatalf("the file beside the link was not changed: %v", got)
	}
	// The link itself, selected: skipped, not followed.
	s = e.run(Spec{Kind: KindSetAttributes, IDs: e.allIDs(dir, "link"), Attrs: change})
	if s.Skipped != 1 || s.Done != 0 || !modTime(t, filepath.Join(outside, "target.txt")).Equal(old) {
		t.Fatalf("a selected link: %+v", s)
	}
}

func TestSetAttributesValidation(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.root, "a.txt"), 1)
	ids := e.allIDs(e.index(e.root), "a.txt")
	for name, c := range map[string]*AttrSpec{
		"missing":        nil,
		"empty":          {},
		"recursive only": {Recursive: true},
		"set and clear":  {AttrChange: fileops.AttrChange{Set: fsx.AttrHidden, Clear: fsx.AttrHidden}},
		"other bits":     {AttrChange: fileops.AttrChange{Set: fsx.AttrExecutable}},
		"link bit":       {AttrChange: fileops.AttrChange{Clear: fsx.AttrLink}},
		"mode overlap":   {AttrChange: fileops.AttrChange{ModeSet: 0o400, ModeClear: 0o600}},
		"setuid":         {AttrChange: fileops.AttrChange{ModeSet: fs.ModeSetuid}},
		"too early":      {AttrChange: fileops.AttrChange{Modified: time.Date(1979, 12, 31, 0, 0, 0, 0, time.UTC)}},
		"too late":       {AttrChange: fileops.AttrChange{Accessed: time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)}},
	} {
		if _, err := e.m.Start(Spec{Kind: KindSetAttributes, IDs: ids, Attrs: c}); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// The folders of a panel: sizes are stored and announced in batches.
func TestDirSizeOfManyFolders(t *testing.T) {
	e := newEnv(t)
	const n = 300
	names := make([]string, n)
	for i := range names {
		names[i] = "d" + itoa(i)
		write(t, filepath.Join(e.root, names[i], "f.bin"), i+1)
	}
	root := e.index(e.root)
	ids := e.allIDs(root, names...)
	s := e.run(Spec{Kind: KindDirSize, IDs: ids})
	if s.State != StateCompleted || s.Done != n || s.BytesDone != n*(n+1)/2 {
		t.Fatalf("sizes: %+v", s)
	}
	items, err := e.store.LoadItems(ctx, ids)
	if err != nil {
		t.Fatal(err)
	}
	for i, it := range items {
		if it.DirSize != int64(i+1) {
			t.Fatalf("%s: %d bytes, want %d", it.Name, it.DirSize, i+1)
		}
	}
	if !e.changed[root.ID] {
		t.Fatal("the panel's session was not told")
	}
}
