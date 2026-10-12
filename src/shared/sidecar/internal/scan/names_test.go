package scan

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/index"
)

// Stage P04: names and paths the platforms treat differently. The rule the
// tests hold the scanner to: what the folder holds is what the listing
// shows, each entry once.

// onDisk reads a folder's names the way the OS reports them.
func onDisk(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, len(ents))
	for i, e := range ents {
		names[i] = e.Name()
	}
	slices.Sort(names)
	return names
}

func (r *rig) listed(t *testing.T, dir string) []string {
	t.Helper()
	stats, info := r.run(context.Background(), dir, false, Options{})
	if stats.State != StateCompleted {
		t.Fatalf("scan of %q: %+v", dir, stats.Progress)
	}
	var names []string
	for name := range r.all(info, false) {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

const (
	composed   = "caf\u00e9"  // é as one code point (NFC)
	decomposed = "cafe\u0301" // e and a combining accent (NFD)
)

// A name copied from a Mac is often decomposed. NTFS and ext4 keep the two
// forms as two files; APFS and HFS+ treat them as one.
func TestComposedAndDecomposedNames(t *testing.T) {
	r := newRig(t)
	root := filepath.Join(t.TempDir(), "unicode")
	write(t, filepath.Join(root, composed+".jpg"), 0o644)
	write(t, filepath.Join(root, decomposed+".jpg"), 0o644)
	write(t, filepath.Join(root, decomposed, "inner.jpg"), 0o644)
	if err := os.MkdirAll(filepath.Join(root, composed), 0o755); err != nil {
		t.Fatal(err)
	}
	want := onDisk(t, root)
	if runtime.GOOS == "darwin" && len(want) != 2 || runtime.GOOS != "darwin" && len(want) != 4 {
		t.Logf("this volume holds %d entries for the two forms: %q", len(want), want)
	}
	if got := r.listed(t, root); !slices.Equal(got, want) {
		t.Fatalf("listed %q, the folder holds %q", got, want)
	}

	// The folder reached through either spelling.
	a, err := r.store.EnsureDir(context.Background(), filepath.Join(root, composed))
	if err != nil {
		t.Fatal(err)
	}
	b, err := r.store.EnsureDir(context.Background(), filepath.Join(root, decomposed))
	if err != nil {
		t.Fatal(err)
	}
	if same := len(want) == 2; (a.ID == b.ID) != same {
		t.Fatalf("one folder on disk: %v, but ids %d and %d", same, a.ID, b.ID)
	}
	// The decomposed folder lists its file whichever way it was reached.
	if got := r.listed(t, filepath.Join(root, decomposed)); !slices.Equal(got, []string{"inner.jpg"}) {
		t.Fatalf("decomposed folder lists %q", got)
	}
	// A second scan changes nothing (no entry flips between two rows).
	if got := r.listed(t, root); !slices.Equal(got, want) {
		t.Fatalf("second scan listed %q, the folder holds %q", got, want)
	}
}

// Two names that differ only in case are two files on a case-sensitive
// volume and one file elsewhere. The key folds case by the platform's
// default (ADR-0015), so the listing is complete wherever the volume
// follows that default.
func TestNamesDifferingInCase(t *testing.T) {
	r := newRig(t)
	root := filepath.Join(t.TempDir(), "case")
	write(t, filepath.Join(root, "Photo.JPG"), 0o644)
	write(t, filepath.Join(root, "photo.jpg"), 0o644)
	want := onDisk(t, root)
	platformSensitive := runtime.GOOS != "windows" && runtime.GOOS != "darwin"
	if (len(want) == 2) != platformSensitive {
		t.Skipf("this volume does not follow the platform's default (%d files for two cases)", len(want))
	}
	if got := r.listed(t, root); !slices.Equal(got, want) {
		t.Fatalf("listed %q, the folder holds %q", got, want)
	}
}

// Where a volume or a folder does not follow the platform's default (a
// folder marked case-sensitive on Windows, a case-sensitive APFS volume),
// two names that differ only in case share one row: the scan completes and
// shows one of them. This is the limit ADR-0015 records.
func TestCaseSensitiveFolderOnACaseFoldingPlatform(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
		t.Skip("the platform's keys are case-sensitive")
	}
	r := newRig(t)
	root := filepath.Join(t.TempDir(), "sensitive")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if !makeCaseSensitive(t, root) {
		t.Skip("no case-sensitive folder on this machine")
	}
	write(t, filepath.Join(root, "Photo.JPG"), 0o644)
	write(t, filepath.Join(root, "photo.jpg"), 0o644)
	write(t, filepath.Join(root, "other.jpg"), 0o644)
	if n := len(onDisk(t, root)); n != 3 {
		t.Skipf("the folder holds %d files; it is not case-sensitive", n)
	}
	got := r.listed(t, root)
	if len(got) != 2 || got[0] != "other.jpg" && got[1] != "other.jpg" {
		t.Fatalf("listed %q; want other.jpg and one of the two cases", got)
	}
}

// targets resolves a folder's entries to the paths every action uses.
func (r *rig) targets(t *testing.T, dir string) map[string]index.Target {
	t.Helper()
	stats, info := r.run(context.Background(), dir, false, Options{})
	if stats.State != StateCompleted {
		t.Fatalf("scan of %q: %+v", dir, stats.Progress)
	}
	var ids []int64
	for _, it := range r.all(info, false) {
		ids = append(ids, it.ID)
	}
	ts, err := r.store.Targets(context.Background(), ids)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]index.Target{}
	for _, tg := range ts {
		out[tg.Name] = tg
	}
	return out
}

// Names Windows programs cannot type but that exist on disks (written by
// WSL, git or another system). Win32 rewrites their paths: "photo.jpg."
// opens "photo.jpg" and "NUL" opens the null device. The folder lists them,
// and the path the index gives for each is the entry itself.
func TestNamesWindowsRewrites(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows naming rules")
	}
	r := newRig(t)
	root := filepath.Join(t.TempDir(), "reserved")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	// \\?\ turns the Win32 name rules off, as the systems that write such
	// names do.
	raw := `\\?\` + root + `\`
	files := map[string]string{
		"photo.jpg": "the real one", "photo.jpg.": "dot", "photo.jpg ": "space", "NUL": "nul",
		"aux.jpg": "aux", "con.png": "con", "com1": "com", "plain.jpg": "plain",
	}
	for n, content := range files {
		if err := os.WriteFile(raw+n, []byte(content), 0o644); err != nil {
			t.Skipf("cannot create %q here: %v", n, err)
		}
	}
	if err := os.MkdirAll(raw+`trailing.\inner.`, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(raw+`trailing.\inner.\deep.jpg`, []byte("deep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(raw+`trailing.\NUL`, []byte("nul"), 0o644); err != nil {
		t.Fatal(err)
	}
	want := onDisk(t, root)
	if len(want) != len(files)+1 {
		t.Fatalf("the folder holds %q", want)
	}
	got := r.targets(t, root)
	if len(got) != len(want) {
		t.Fatalf("listed %d entries, the folder holds %q", len(got), want)
	}
	for n, content := range files {
		tg, ok := got[n]
		if !ok {
			t.Errorf("%q is not listed", n)
			continue
		}
		fi, err := fsx.Stat(tg.Path)
		if err != nil || !fi.Mode().IsRegular() {
			t.Errorf("stat %q through %q: %v, %v", n, tg.Path, fi, err)
			continue
		}
		if data, err := os.ReadFile(tg.Path); err != nil || string(data) != content {
			t.Errorf("read %q through %q: %q, %v", n, tg.Path, data, err)
		}
	}
	// Only a path Windows rewrites carries the prefix: the others keep the
	// form the shell (the Recycle Bin, Open with) understands.
	if p := got["plain.jpg"].Path; p != filepath.Join(root, "plain.jpg") {
		t.Errorf("plain.jpg is %q", p)
	}
	if p := got["photo.jpg."].Path; p != raw+"photo.jpg." {
		t.Errorf("photo.jpg. is %q", p)
	}

	// The folder with a trailing dot lists what it holds, and so does the
	// folder below it; both keep one key however the path is spelled.
	dir := got["trailing."]
	inner := r.targets(t, dir.Path)
	if len(inner) != 2 || inner["inner."].Path != raw+`trailing.\inner.` || inner["NUL"].Path != raw+`trailing.\NUL` {
		t.Fatalf("trailing. lists %+v", inner)
	}
	if deep := r.targets(t, inner["inner."].Path); deep["deep.jpg"].Path != raw+`trailing.\inner.\deep.jpg` {
		t.Fatalf("inner. lists %+v", deep)
	}
	listedAs, err := r.store.EnsureDir(context.Background(), dir.Path)
	if err != nil || listedAs.ID != dir.ID || listedAs.Key != dir.Key {
		t.Fatalf("the folder opened by its path is %+v, listed as %+v (%v)", listedAs, dir, err)
	}
	crumbs := fsx.Crumbs(inner["inner."].Path)
	last, parent, grand := crumbs[len(crumbs)-1], crumbs[len(crumbs)-2], crumbs[len(crumbs)-3]
	if last.Name != "inner." || last.Path != raw+`trailing.\inner.` || parent.Path != raw+"trailing." || grand.Path != root {
		t.Fatalf("crumbs %+v", crumbs[len(crumbs)-3:])
	}
	if crumbs[0].Name != filepath.VolumeName(root) {
		t.Fatalf("root crumb %+v", crumbs[0])
	}
	if fsx.VolumeID(dir.Path) != fsx.VolumeID(root) {
		t.Fatalf("volume of %q is %q", dir.Path, fsx.VolumeID(dir.Path))
	}

	// Deleting the stray file leaves its neighbour alone; the Recycle Bin
	// refuses it with a reason instead of taking the neighbour.
	if err := fileops.Trash(got["photo.jpg."].Path); fileops.Code(err) != fileops.CodeTrashUnavailable {
		t.Errorf("trash of photo.jpg.: %v", err)
	}
	for _, n := range []string{"photo.jpg.", "photo.jpg ", "NUL"} {
		if err := fileops.Delete(got[n].Path, false); err != nil {
			t.Errorf("delete %q: %v", n, err)
		}
	}
	if data, err := os.ReadFile(filepath.Join(root, "photo.jpg")); err != nil || string(data) != "the real one" {
		t.Fatalf("photo.jpg after deleting its neighbours: %q, %v", data, err)
	}
	// A folder tree with such names inside is deleted as a whole.
	if n, err := fileops.TreeSize(context.Background(), dir.Path); err != nil || n != int64(len("deep")+len("nul")) {
		t.Errorf("tree size %d, %v", n, err)
	}
	if err := fileops.Delete(dir.Path, true); err != nil {
		t.Fatalf("delete the folder: %v", err)
	}
	if left := onDisk(t, root); !slices.Equal(left, []string{"aux.jpg", "com1", "con.png", "photo.jpg", "plain.jpg"}) {
		t.Fatalf("left on disk: %q", left)
	}
}

// The same tree deleted from a folder with an ordinary name: the walk
// below it must not rewrite the names it reads.
func TestDeleteTreeHoldingRewrittenNames(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows naming rules")
	}
	root := filepath.Join(t.TempDir(), "tree")
	raw := `\\?\` + root + `\`
	if err := os.MkdirAll(raw+`sub\folder.`, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{`keep.txt`, `sub\a.txt`, `sub\a.txt.`, `sub\NUL`, `sub\folder.\b.txt `} {
		if err := os.WriteFile(raw+n, []byte("x"), 0o644); err != nil {
			t.Skipf("cannot create %q here: %v", n, err)
		}
	}
	sub := filepath.Join(root, "sub")
	if n, err := fileops.TreeSize(context.Background(), sub); err != nil || n != 4 {
		t.Errorf("tree size %d, %v", n, err)
	}
	if err := fileops.Delete(sub, true); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if left := onDisk(t, root); !slices.Equal(left, []string{"keep.txt"}) {
		t.Fatalf("left on disk: %q", left)
	}
}

// A path beyond MAX_PATH (260) and beyond the 255 bytes of one name's
// limit in total.
func TestLongPathIsListed(t *testing.T) {
	r := newRig(t)
	dir := t.TempDir()
	part := strings.Repeat("d", 100)
	for range 4 {
		dir = filepath.Join(dir, part)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Skipf("no long paths here: %v", err)
	}
	long := strings.Repeat("n", 200) + ".jpg"
	write(t, filepath.Join(dir, long), 0o644)
	write(t, filepath.Join(dir, "sub", "inner.jpg"), 0o644)
	if len(filepath.Join(dir, long)) < 600 {
		t.Fatalf("path is only %d long", len(filepath.Join(dir, long)))
	}
	if got := r.listed(t, dir); !slices.Equal(got, []string{long, "sub"}) {
		t.Fatalf("listed %q", got)
	}
	info, err := r.store.EnsureDir(context.Background(), filepath.Join(dir, "sub"))
	if err != nil || info.Path != filepath.Join(dir, "sub") {
		t.Fatalf("sub folder: %+v, %v", info, err)
	}
}

// A folder on a share, reached by its UNC path (the loopback admin share,
// where the account may use it).
func TestUNCPathIsListed(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("UNC paths")
	}
	local := filepath.Join(t.TempDir(), "share")
	write(t, filepath.Join(local, "a.jpg"), 0o644)
	write(t, filepath.Join(local, "Sub", "b.jpg"), 0o644)
	vol := filepath.VolumeName(local) // "C:"
	unc := `\\localhost\` + vol[:1] + `$` + local[len(vol):]
	if _, err := os.Stat(unc); err != nil {
		t.Skipf("no access to %s: %v", unc, err)
	}
	r := newRig(t)
	if got := r.listed(t, unc); !slices.Equal(got, []string{"Sub", "a.jpg"}) {
		t.Fatalf("listed %q", got)
	}
	// The share's folder and the local folder are two folders to the index:
	// nothing tells it they are the same disk.
	viaShare, err := r.store.EnsureDir(context.Background(), unc)
	if err != nil {
		t.Fatal(err)
	}
	viaDrive, err := r.store.EnsureDir(context.Background(), local)
	if err != nil {
		t.Fatal(err)
	}
	if viaShare.ID == viaDrive.ID || !strings.HasPrefix(viaShare.Key, "//localhost/") {
		t.Fatalf("share %+v, drive %+v", viaShare, viaDrive)
	}
	// The share's root is a root: nothing above it is listed or needed.
	crumbs := fsx.Crumbs(unc)
	if crumbs[0].Path != `\\localhost\`+vol[:1]+`$\` || crumbs[0].Name != `\\localhost\`+vol[:1]+`$` {
		t.Fatalf("root crumb %+v", crumbs[0])
	}
	if fsx.VolumeID(unc) != `\\localhost\`+strings.ToLower(vol[:1])+`$` {
		t.Fatalf("volume id %q", fsx.VolumeID(unc))
	}
}
