//go:build windows

package fsx

import (
	"context"
	"path/filepath"
	"syscall"
	"testing"
)

// A folder with the system attribute is a system folder, also when it is
// hidden too (as Windows marks its own); HideSystem keeps it out of the tree.
func TestListDirsHideSystem(t *testing.T) {
	root := t.TempDir()
	mkdirs(t, root, "plain", ".dot", "attr-hidden", "attr-system", "both")
	set := func(name string, attrs uint32) {
		t.Helper()
		p, err := syscall.UTF16PtrFromString(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		if err := syscall.SetFileAttributes(p, attrs); err != nil {
			t.Fatal(err)
		}
	}
	set("attr-hidden", syscall.FILE_ATTRIBUTE_HIDDEN|syscall.FILE_ATTRIBUTE_DIRECTORY)
	set("attr-system", syscall.FILE_ATTRIBUTE_SYSTEM|syscall.FILE_ATTRIBUTE_DIRECTORY)
	set("both", syscall.FILE_ATTRIBUTE_HIDDEN|syscall.FILE_ATTRIBUTE_SYSTEM|syscall.FILE_ATTRIBUTE_DIRECTORY)
	listed := func(o ListOptions) []string {
		t.Helper()
		got, _, err := ListDirs(context.Background(), root, o)
		if err != nil {
			t.Fatal(err)
		}
		out := []string{}
		for _, c := range got {
			out = append(out, c.Name)
		}
		return out
	}
	if got := listed(ListOptions{}); len(got) != 1 || got[0] != "plain" {
		t.Errorf("default: %v", got)
	}
	got := listed(ListOptions{ShowHidden: true, HideSystem: true})
	want := map[string]bool{".dot": true, "attr-hidden": true, "plain": true}
	if len(got) != len(want) {
		t.Fatalf("hidden without system: %v", got)
	}
	for _, name := range got {
		if !want[name] {
			t.Errorf("hidden without system lists %s: %v", name, got)
		}
	}
	if got := listed(ListOptions{ShowHidden: true}); len(got) != 5 {
		t.Errorf("hidden and system: %v", got)
	}
}
