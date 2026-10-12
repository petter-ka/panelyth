package fsx

import (
	"path"
	"slices"
	"strings"
)

// Mount is one mounted filesystem as macOS reports it (getfsstat).
type Mount struct {
	Path string // the mount point
	FS   string // "apfs", "smbfs", "exfat", ...
	// Local is false for a filesystem served over the network (MNT_LOCAL).
	Local bool
	// Hidden is a mount the Finder does not show (MNT_DONTBROWSE).
	Hidden bool
}

var opticalFS = map[string]bool{"cd9660": true, "iso9660": true, "udf": true, "cddafs": true}

// DarwinVolumes picks the volumes a user sees from the mount table of
// macOS: the boot volume as "/", then what is mounted under /Volumes. The
// kind comes from the table, so a share that stopped answering is still
// listed as a network volume without being touched (Stage P04).
func DarwinVolumes(mounts []Mount, bootLabel string) []Volume {
	if bootLabel == "" {
		bootLabel = "Macintosh HD"
	}
	out := []Volume{{Path: "/", Label: bootLabel, Kind: "fixed"}}
	seen := map[string]bool{"/": true}
	for _, m := range mounts {
		if m.Hidden || seen[m.Path] || !strings.HasPrefix(m.Path, "/Volumes/") {
			continue
		}
		seen[m.Path] = true
		kind := "removable"
		switch {
		case !m.Local:
			kind = "network"
		case opticalFS[m.FS]:
			kind = "optical"
		}
		out = append(out, Volume{Path: m.Path, Label: path.Base(m.Path), Kind: kind})
	}
	slices.SortFunc(out[1:], func(a, b Volume) int { return strings.Compare(a.Path, b.Path) })
	return out
}
