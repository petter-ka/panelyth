package app

import (
	"context"
	"path/filepath"
	"time"

	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/pathkey"
	"panelyth/sidecar/internal/rpc"
	"panelyth/sidecar/internal/scan"
)

// "Open with": a picture or video the OS handed to the app (a double-click
// in the file manager, a file on the command line). Main is the only caller;
// no renderer ever names a path.

type (
	entryFromPathParams struct {
		Path string `json:"path"`
	}
	entryFromPathResult struct {
		DirID   int64  `json:"dirId"`
		EntryID int64  `json:"entryId"`
		Kind    string `json:"kind"`
		// Listed: the folder's listing is complete, so the file's neighbours are
		// all there. False while a large folder is still being listed.
		Listed bool `json:"listed"`
	}
)

// openWithLane is the scan lane of folders opened this way, so the listing
// of one never cancels a panel's or the viewer's.
const openWithLane = "open-with"

// openWithListWait is how long the answer waits for the folder's listing: a
// folder of a few thousand files is listed by then, so "next" works from the
// first moment. A larger folder is not waited for; its files arrive in the
// window's session as they are listed.
const openWithListWait = 150 * time.Millisecond

// entryFromPath opens the file's folder as dir.open does (listed in the
// background, watched) and puts the file itself in the index at once, so it
// can be shown before the listing has reached it: the first picture never
// waits for a folder of 100,000 files. Anything but an image or a video is
// refused.
func (s *indexService) entryFromPath(ctx context.Context, p entryFromPathParams) (entryFromPathResult, error) {
	clean, err := pathkey.Clean(p.Path)
	if err != nil {
		return entryFromPathResult{}, rpc.NewError(rpc.CodeInvalidPath, "file path must be absolute")
	}
	fi, err := fsx.Stat(clean)
	if err != nil {
		return entryFromPathResult{}, statError(err, "file")
	}
	if !fi.Mode().IsRegular() {
		return entryFromPathResult{}, rpc.NewError(rpc.CodeInvalidArgument, "not a regular file")
	}
	name := filepath.Base(clean)
	kind, ext, ok := media.Classify(name)
	if !ok || !kind.IsMedia() {
		return entryFromPathResult{}, rpc.NewError(rpc.CodeUnsupportedMedia, "not an image or a video")
	}
	dir, err := s.dirOpen(ctx, dirOpenParams{Path: filepath.Dir(clean), Lane: openWithLane})
	if err != nil {
		return entryFromPathResult{}, err
	}
	parent, err := s.store.Dir(ctx, dir.DirID)
	if err != nil {
		return entryFromPathResult{}, dbError(err)
	}
	key := pathkey.ChildKey(parent.Key, name, false)
	id, err := s.store.IDByKey(ctx, key)
	if err != nil {
		return entryFromPathResult{}, dbError(err)
	}
	if id == 0 {
		// Not listed yet: its row now, the rest of the folder when the listing gets there.
		row := index.Row{ParentID: parent.ID, ParentKey: parent.Key, Kind: kind, Name: name, PathKey: key, Ext: ext,
			Size: fi.Size(), MtimeNs: fi.ModTime().UnixNano(), BtimeNs: fsx.FileTimes(fi).BirthNs, Attrs: fsx.AttrsOf(name, fi)}
		if _, err := s.store.Commit(ctx, s.store.NextGeneration(), []index.Row{row}, nil); err != nil {
			return entryFromPathResult{}, dbError(err)
		}
		if id, err = s.store.IDByKey(ctx, key); err != nil {
			return entryFromPathResult{}, dbError(err)
		}
		s.changed([]scan.Change{{DirID: parent.ID, DirKey: parent.Key}})
	}
	listed := dir.ListedBefore || s.scans.WaitFor(ctx, dir.ScanID, openWithListWait)
	return entryFromPathResult{DirID: parent.ID, EntryID: id, Kind: kind.String(), Listed: listed}, nil
}
