package fixture

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// RenameSpec describes the multi-rename fixtures (Stage C09,
// docs/commander/TESTING.md "rename-set").
type RenameSpec struct {
	// Scenario writes scenario/: three pictures a minute apart, notes.txt,
	// taken.txt and a folder, for scenario 15.
	Scenario bool
	// Files writes files/ with this many empty pictures (IMG_000001.jpg …).
	Files int
	// Folders writes folders/ with this many folders of FolderFiles files of
	// 1 KiB each (the sizes of a panel's folders).
	Folders     int
	FolderFiles int
}

// RenameScenarioNames are the entries of scenario/, in name order.
var RenameScenarioNames = []string{"Album", "IMG_0001.JPG", "IMG_0002.JPG", "IMG_0003.JPG", "notes.txt", "taken.txt"}

// GenerateRename writes the fixtures under root. A marker file makes
// repeated calls with the same spec a no-op; a benchmark that renames the
// files removes the marker while they have other names.
func GenerateRename(root string, spec RenameSpec) error {
	marker := RenameMarker(root)
	want := fmt.Sprintf("rename %+v", spec)
	if b, err := os.ReadFile(marker); err == nil && string(b) == want {
		return nil
	}
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	if spec.Scenario {
		dir := filepath.Join(root, "scenario")
		for i, name := range RenameScenarioNames[1:] {
			if err := put(filepath.Join(dir, name), name, time.Duration(i)*time.Minute); err != nil {
				return err
			}
		}
		if err := put(filepath.Join(dir, "Album", "inside.jpg"), "inside", 0); err != nil {
			return err
		}
	}
	if spec.Files > 0 {
		dir := filepath.Join(root, "files")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		for i := range spec.Files {
			path := filepath.Join(dir, fmt.Sprintf("IMG_%06d.jpg", i+1))
			if err := os.WriteFile(path, nil, 0o644); err != nil {
				return err
			}
			// A second apart, so the date placeholders differ.
			at := baseTime.Add(time.Duration(i) * time.Second)
			if err := os.Chtimes(path, at, at); err != nil {
				return err
			}
		}
	}
	if spec.Folders > 0 {
		block := make([]byte, 1024)
		for i := range spec.Folders {
			dir := filepath.Join(root, "folders", fmt.Sprintf("dir%04d", i))
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return err
			}
			for f := range max(spec.FolderFiles, 1) {
				if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%03d.bin", f)), block, 0o644); err != nil {
					return err
				}
			}
		}
	}
	return os.WriteFile(marker, []byte(want), 0o644)
}

// RenameMarker is the marker file of a rename fixture.
func RenameMarker(root string) string { return filepath.Join(root, ".panelyth-fixture") }
