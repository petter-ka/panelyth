package scan

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"fastview/sidecar/internal/fsx"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/media"
)

// Stage P02 (ADR-0026): the scanner stores every entry with attributes.

func write(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), mode); err != nil {
		t.Fatal(err)
	}
}

func (r *rig) all(info index.DirInfo, recursive bool) map[string]index.Item {
	r.t.Helper()
	ids, err := r.store.QueryIDs(context.Background(), index.Descriptor{DirID: info.ID, Recursive: recursive,
		Scope: index.ScopeAll, ShowHidden: true}, info.Key)
	if err != nil {
		r.t.Fatal(err)
	}
	items, err := r.store.LoadItems(context.Background(), ids)
	if err != nil {
		r.t.Fatal(err)
	}
	out := map[string]index.Item{}
	for _, it := range items {
		out[it.Name] = it
	}
	return out
}

func TestScanStoresEveryEntryWithAttrs(t *testing.T) {
	r := newRig(t)
	root := filepath.Join(t.TempDir(), "mixed")
	write(t, filepath.Join(root, "photo.jpg"), 0o644)
	write(t, filepath.Join(root, "notes.txt"), 0o644)
	write(t, filepath.Join(root, ".hidden.jpg"), 0o644)
	write(t, filepath.Join(root, "run.sh"), 0o755)
	write(t, filepath.Join(root, "tool.exe"), 0o755)
	write(t, filepath.Join(root, "locked.txt"), 0o444)
	write(t, filepath.Join(root, "sub", "inner.jpg"), 0o644)
	write(t, filepath.Join(root, ".cache", "deep.jpg"), 0o644)
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(root, "locked.txt"), 0o644) })

	stats, info := r.run(context.Background(), root, false, Options{})
	items := r.all(info, false)
	if len(items) != 8 {
		t.Fatalf("every entry stored: got %d: %v", len(items), slices.Collect(mapKeys(items)))
	}
	if k := items["notes.txt"].Kind; k != media.KindFile {
		t.Fatalf("notes.txt kind %v", k)
	}
	if items["notes.txt"].Ext != "txt" || items["notes.txt"].Size != 1 {
		t.Fatalf("other files keep ext and size: %+v", items["notes.txt"])
	}
	if items[".hidden.jpg"].Attrs&fsx.AttrHidden == 0 || items[".cache"].Attrs&fsx.AttrHidden == 0 {
		t.Fatalf("dot-names are hidden: %+v %+v", items[".hidden.jpg"], items[".cache"])
	}
	if items["locked.txt"].Attrs&fsx.AttrReadOnly == 0 || items["notes.txt"].Attrs&fsx.AttrReadOnly != 0 {
		t.Fatalf("read-only flag: %+v %+v", items["locked.txt"], items["notes.txt"])
	}
	exe := "run.sh"
	if runtime.GOOS == "windows" {
		exe = "tool.exe" // Windows decides by extension
	}
	if items[exe].Attrs&fsx.AttrExecutable == 0 || items["notes.txt"].Attrs&fsx.AttrExecutable != 0 {
		t.Fatalf("executable flag: %+v", items[exe])
	}
	// The viewer's counters are unchanged: visible folders and media, and
	// visible other files as "not shown"; hidden entries count nowhere.
	d, err := r.store.Dir(context.Background(), info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.ChildDirs != 1 || d.ChildMedia != 1 || d.Skipped != 4 || stats.Skipped != 4 {
		t.Fatalf("counters dirs=%d media=%d skipped=%d (stats %d)", d.ChildDirs, d.ChildMedia, d.Skipped, stats.Skipped)
	}
	if got := r.names(info, false); !slices.Equal(got, []string{"sub", "photo.jpg"}) {
		t.Fatalf("media scope: %q", got)
	}
}

func TestRecursiveScanSkipsHiddenFolders(t *testing.T) {
	r := newRig(t)
	root := filepath.Join(t.TempDir(), "tree")
	write(t, filepath.Join(root, "a", "one.jpg"), 0o644)
	write(t, filepath.Join(root, ".git", "objects", "blob.jpg"), 0o644)
	stats, info := r.run(context.Background(), root, true, Options{Workers: 2})
	if stats.DirsListed != 2 { // root and "a"; ".git" is stored but not listed
		t.Fatalf("dirs listed %d", stats.DirsListed)
	}
	if got := r.names(info, true); !slices.Equal(got, []string{"one.jpg"}) {
		t.Fatalf("recursive media: %q", got)
	}
}

func TestLinksAreListedNotFollowed(t *testing.T) {
	r := newRig(t)
	base := t.TempDir()
	target := filepath.Join(base, "target")
	write(t, filepath.Join(target, "far.jpg"), 0o644)
	root := filepath.Join(base, "root")
	write(t, filepath.Join(root, "near.jpg"), 0o644)
	link(t, target, filepath.Join(root, "linked"))
	link(t, root, filepath.Join(root, "loop")) // a cycle back to its own parent
	stats, info := r.run(context.Background(), root, true, Options{})
	if stats.State != StateCompleted || stats.DirsListed != 1 {
		t.Fatalf("links must not be descended into: %+v", stats.Progress)
	}
	items := r.all(info, true)
	for _, name := range []string{"linked", "loop"} {
		if it, ok := items[name]; !ok || it.Kind != media.KindLink || it.Attrs&fsx.AttrLink == 0 {
			t.Fatalf("%s: %+v (ok=%v)", name, it, ok)
		}
	}
	if _, ok := items["far.jpg"]; ok {
		t.Fatal("link target was listed")
	}
	if got := r.names(info, false); !slices.Equal(got, []string{"near.jpg"}) {
		t.Fatalf("media scope hides links: %q", got)
	}
}

// link makes a directory symlink, or on Windows without the symlink
// privilege a junction (listed as fs.ModeIrregular).
func link(t *testing.T, target, at string) {
	t.Helper()
	err := os.Symlink(target, at)
	if err == nil {
		return
	}
	if runtime.GOOS != "windows" {
		t.Skipf("symlinks unavailable here: %v", err)
	}
	if out, jerr := exec.Command("cmd", "/c", "mklink", "/J", at, target).CombinedOutput(); jerr != nil {
		t.Skipf("neither symlinks nor junctions available: %v; %v %s", err, jerr, out)
	}
}

func mapKeys(m map[string]index.Item) func(func(string) bool) {
	return func(yield func(string) bool) {
		for k := range m {
			if !yield(k) {
				return
			}
		}
	}
}
