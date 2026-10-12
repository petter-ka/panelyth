package fixture

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// count walks root and classifies what Generate wrote.
func count(t *testing.T, root string) (got Expected) {
	t.Helper()
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || path == root {
			return err
		}
		name := d.Name()
		switch {
		case d.IsDir():
			got.Dirs++
		case name == ".panelyth-fixture":
		case d.Type()&os.ModeSymlink != 0:
			got.Links++
		case strings.HasSuffix(name, ".exe"):
			got.Exec++
		case strings.HasPrefix(name, "."):
			got.Hidden++
		case strings.HasSuffix(name, ".txt"):
			got.NonMedia++
		default:
			got.Media++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestGenerateWritesWhatItSaysItWrites(t *testing.T) {
	for name, spec := range map[string]Spec{
		"flat":  {Files: 100, NonMediaEvery: 10},
		"tree":  {Files: 20, Depth: 2, Fanout: 3, NonMediaEvery: 4, HiddenEvery: 5},
		"mixed": {Files: 200, NonMediaEvery: 2, HiddenEvery: 5, ExecEvery: 20, LinkEvery: 50},
		"media": {Files: 50},
	} {
		t.Run(name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "fx")
			exp, err := Generate(root, spec)
			if err != nil {
				t.Fatal(err)
			}
			if got := count(t, root); got != exp {
				t.Fatalf("on disk %+v, Generate reported %+v", got, exp)
			}
			total := exp.Media + exp.NonMedia + exp.Hidden + exp.Exec + exp.Links
			if dirs := exp.Dirs + 1; total != spec.Files*dirs {
				t.Fatalf("%d files in %d folders, want %d each", total, dirs, spec.Files)
			}
		})
	}
}

func TestMixedSpecHasProgramsAndLinksOrSaysWhyNot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "fx")
	spec := Spec{Files: 200, NonMediaEvery: 2, HiddenEvery: 5, ExecEvery: 20, LinkEvery: 50}
	exp, err := Generate(root, spec)
	if err != nil {
		t.Fatal(err)
	}
	if exp.Exec == 0 {
		t.Fatal("no programs generated")
	}
	if canLink(root) {
		if exp.Links != 4 {
			t.Fatalf("links: %d, want 4", exp.Links)
		}
		// A link names the file before it and is never a copy of it.
		target, err := os.Readlink(filepath.Join(root, "link_49.jpg"))
		if err != nil || target != "IMG_48.jpg" {
			t.Fatalf("link_49.jpg -> %q, %v", target, err)
		}
	} else if exp.Links != 0 {
		// Windows without developer mode: the same positions are documents.
		t.Fatalf("links cannot be created here, yet %d are reported", exp.Links)
	}
}

func TestGenerateIsANoOpForTheSameSpecAndRebuildsForAnother(t *testing.T) {
	root := filepath.Join(t.TempDir(), "fx")
	spec := Spec{Files: 10, NonMediaEvery: 5}
	if _, err := Generate(root, spec); err != nil {
		t.Fatal(err)
	}
	extra := filepath.Join(root, "left-by-a-test.txt")
	if err := os.WriteFile(extra, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Generate(root, spec); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(extra); err != nil {
		t.Fatal("the same spec must reuse the tree")
	}
	if _, err := Generate(root, Spec{Files: 10, NonMediaEvery: 5, ExecEvery: 3}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(extra); err == nil {
		t.Fatal("another spec must rebuild the tree")
	}
}

// Trees generated before programs and links existed carry the marker Go
// printed for the five-field Spec; 100k-file fixtures must not be rebuilt
// because the struct grew.
func TestOldMarkersAreStillRecognized(t *testing.T) {
	for spec, old := range map[Spec]string{
		{Files: 100_000, NonMediaEvery: 10}:                  "{Files:100000 Depth:0 Fanout:0 NonMediaEvery:10 HiddenEvery:0}",
		{Files: 200, Depth: 3, Fanout: 6, NonMediaEvery: 10}: "{Files:200 Depth:3 Fanout:6 NonMediaEvery:10 HiddenEvery:0}",
		{Files: 100_000, NonMediaEvery: 2, HiddenEvery: 5}:   "{Files:100000 Depth:0 Fanout:0 NonMediaEvery:2 HiddenEvery:5}",
	} {
		if got := marker(spec, false); got != old {
			t.Errorf("marker(%+v) = %q, want %q", spec, got, old)
		}
	}
	a := marker(Spec{Files: 10, LinkEvery: 2}, true)
	b := marker(Spec{Files: 10, LinkEvery: 2}, false)
	if a == b {
		t.Error("a tree with links and one without must not share a marker")
	}
}

// Stage P04: a cleaner of temporary files removed parts of fixture trees
// and left their markers; the next run then tested what was left.
func TestADamagedTreeIsGeneratedAgain(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tree")
	spec := Spec{Files: 12, Depth: 1, Fanout: 2, NonMediaEvery: 4}
	exp, err := Generate(root, spec)
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, ".panelyth-fixture")
	generated := func() os.FileInfo {
		t.Helper()
		fi, err := os.Stat(marker)
		if err != nil {
			t.Fatal(err)
		}
		return fi
	}
	first := generated()
	// A whole tree is kept: the marker is not written again.
	if _, err := Generate(root, spec); err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(first, generated()) || !first.ModTime().Equal(generated().ModTime()) {
		t.Fatal("a whole tree was generated again")
	}

	damage := []func(){
		// One file of the root is gone.
		func() {
			ents, _ := os.ReadDir(root)
			for _, e := range ents {
				if !e.IsDir() && e.Name() != ".panelyth-fixture" {
					if err := os.Remove(filepath.Join(root, e.Name())); err != nil {
						t.Fatal(err)
					}
					return
				}
			}
			t.Fatal("no file to remove")
		},
		// A folder is gone with everything in it.
		func() {
			if err := os.RemoveAll(filepath.Join(root, "folder 1")); err != nil {
				t.Fatal(err)
			}
		},
		// Everything but the marker is gone.
		func() {
			ents, _ := os.ReadDir(root)
			for _, e := range ents {
				if e.Name() != ".panelyth-fixture" {
					if err := os.RemoveAll(filepath.Join(root, e.Name())); err != nil {
						t.Fatal(err)
					}
				}
			}
		},
		// A marker of the time before the count was kept.
		func() {
			if err := os.WriteFile(marker, []byte(marker_(spec)), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(filepath.Join(root, "folder 2", "IMG_000001.jpg")); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
		},
	}
	for i, harm := range damage {
		harm()
		if _, err := Generate(root, spec); err != nil {
			t.Fatal(err)
		}
		if got := count(t, root); got.Media != exp.Media || got.NonMedia != exp.NonMedia || got.Dirs != exp.Dirs {
			t.Fatalf("damage %d: %+v, want %+v", i, got, exp)
		}
	}

	images := filepath.Join(t.TempDir(), "images")
	ispec := ImageSpec{Count: 2, Width: 32, Height: 24}
	if err := GenerateImages(images, ispec); err != nil {
		t.Fatal(err)
	}
	ents, _ := os.ReadDir(images)
	for _, e := range ents {
		if e.Name() != ".panelyth-fixture" {
			_ = os.Remove(filepath.Join(images, e.Name()))
			break
		}
	}
	if err := GenerateImages(images, ispec); err != nil {
		t.Fatal(err)
	}
	if ents, _ = os.ReadDir(images); len(ents) != 3 {
		t.Fatalf("images after one was removed: %d entries", len(ents))
	}
}

// marker_ is the marker of a tree without links, as Generate writes it.
func marker_(s Spec) string { return marker(s, false) }
