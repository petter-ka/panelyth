package fsx

import (
	"fmt"
	"testing"
)

// Stage P04: the macOS volume list comes from the mount table.
func TestDarwinVolumes(t *testing.T) {
	mounts := []Mount{
		{Path: "/", FS: "apfs", Local: true},
		{Path: "/dev", FS: "devfs", Local: true, Hidden: true},
		{Path: "/System/Volumes/Data", FS: "apfs", Local: true, Hidden: true},
		{Path: "/Volumes/photos", FS: "smbfs"},
		{Path: "/Volumes/Untitled", FS: "exfat", Local: true},
		{Path: "/Volumes/Backup", FS: "apfs", Local: true},
		{Path: "/Volumes/com.apple.TimeMachine.localsnapshots/Backups", FS: "apfs", Local: true, Hidden: true},
		{Path: "/Volumes/Holiday 2019", FS: "cd9660", Local: true},
		{Path: "/Volumes/nfs", FS: "nfs"},
		{Path: "/Volumes/Backup", FS: "apfs", Local: true},
		{Path: "/Users/petter/mnt", FS: "smbfs"},
	}
	got := DarwinVolumes(mounts, "Macintosh HD")
	want := []Volume{
		{Path: "/", Label: "Macintosh HD", Kind: "fixed"},
		{Path: "/Volumes/Backup", Label: "Backup", Kind: "removable"},
		{Path: "/Volumes/Holiday 2019", Label: "Holiday 2019", Kind: "optical"},
		{Path: "/Volumes/Untitled", Label: "Untitled", Kind: "removable"},
		{Path: "/Volumes/nfs", Label: "nfs", Kind: "network"},
		{Path: "/Volumes/photos", Label: "photos", Kind: "network"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
	// No mount table: the boot volume alone, under a default name.
	if got := DarwinVolumes(nil, ""); len(got) != 1 || got[0].Path != "/" || got[0].Label != "Macintosh HD" || got[0].Kind != "fixed" {
		t.Fatalf("empty table: %v", got)
	}
}
