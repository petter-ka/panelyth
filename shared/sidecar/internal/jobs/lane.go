package jobs

import (
	"context"

	"fastview/sidecar/internal/fsx"
	"fastview/sidecar/internal/index"
)

// laneOf puts file operations in a lane per (source volume, destination
// volume), so two jobs never compete for one disk; metadata and folder-size
// jobs have no lane (ADR-0029).
func laneOf(spec Spec, store *index.Store) string {
	switch spec.Kind {
	case KindCopy, KindMove, KindTrash, KindDelete, KindRename, KindExtract, KindPack, KindTestArchive:
	default:
		return ""
	}
	src := ""
	if sel := spec.Archive.Selection; sel != nil {
		src = fsx.VolumeID(sel.Archive.Listing.Path)
	} else if len(spec.IDs) > 0 && store != nil {
		if paths, err := store.EntryPaths(context.Background(), spec.IDs[:1]); err == nil && len(paths) > 0 {
			src = fsx.VolumeID(paths[0].Path)
		}
	}
	dst := src
	if spec.Destination != "" {
		dst = fsx.VolumeID(spec.Destination)
	}
	return src + ">" + dst
}

// SmallFilesInFlight is how many small files a copy job writes at once on
// SSD lanes (chosen by measurement in Stage P03); HDD lanes copy one at a
// time.
var SmallFilesInFlight = 4

func inFlightFor(src, dst string) int {
	if fsx.IsRotational(src) || fsx.IsRotational(dst) {
		return 1
	}
	return SmallFilesInFlight
}
