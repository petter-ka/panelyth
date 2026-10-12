package app

import (
	"context"
	"path/filepath"
	"testing"

	"panelyth/sidecar/internal/rpc"
)

// "Open with": main names a file the OS handed over; the file is in the
// index at once and its folder is listed behind it.

func TestEntryFromPath(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	dir := t.TempDir()
	for i, name := range []string{"a.jpg", "b.png", "clip.mp4", "notes.txt"} {
		putAt(t, filepath.Join(dir, name), "x", i)
	}
	putAt(t, filepath.Join(dir, "sub", "inner.jpg"), "x", 9)

	got, err := svc.entryFromPath(ctx, entryFromPathParams{Path: filepath.Join(dir, "b.png")})
	if err != nil {
		t.Fatal(err)
	}
	if got.EntryID == 0 || got.DirID == 0 || got.Kind != "image" {
		t.Fatalf("result %+v", got)
	}
	// A folder of a few files is listed before the answer: "next" works at once.
	if !got.Listed {
		t.Error("a small folder was not listed in time")
	}
	// A session over the folder has the file whether or not the listing is done.
	snap, err := svc.queryOpen(ctx, queryOpenParams{DirID: got.DirID, Scope: "media", Kinds: []string{"image", "video"},
		Sort: []sortKeyWire{{Field: "name", Direction: "asc"}}})
	if err != nil {
		t.Fatal(err)
	}
	at, _, err := svc.queries.IndexOf(snap.QueryID, got.EntryID)
	if err != nil || at < 0 {
		t.Fatalf("the file is not in its folder's session: %d %v", at, err)
	}

	// Once the folder is listed, the entry is the same one, with its neighbours around it.
	again, err := svc.entryFromPath(ctx, entryFromPathParams{Path: filepath.Join(dir, "b.png")})
	if err != nil || again.EntryID != got.EntryID || again.DirID != got.DirID {
		t.Fatalf("a second time: %+v %v", again, err)
	}
	res, err := svc.dirOpen(ctx, dirOpenParams{Path: dir, Lane: openWithLane})
	if err != nil {
		t.Fatal(err)
	}
	svc.scans.Wait(res.ScanID)
	listed, err := svc.queryOpen(ctx, queryOpenParams{DirID: got.DirID, Scope: "media", Kinds: []string{"image", "video"},
		Sort: []sortKeyWire{{Field: "name", Direction: "asc"}}})
	if err != nil {
		t.Fatal(err)
	}
	items, names := pageNames(t, svc, listed.QueryID)
	if len(names) != 3 || names[0] != "a.jpg" || names[1] != "b.png" || names[2] != "clip.mp4" {
		t.Fatalf("the folder's pictures and videos: %v", names)
	}
	if items[1].ID != got.EntryID {
		t.Errorf("the listing gave the file another id: %d, was %d", items[1].ID, got.EntryID)
	}

	video, err := svc.entryFromPath(ctx, entryFromPathParams{Path: filepath.Join(dir, "clip.mp4")})
	if err != nil || video.Kind != "video" || video.EntryID != items[2].ID {
		t.Errorf("a video: %+v %v", video, err)
	}

	// What is refused, and why.
	for name, c := range map[string]struct {
		path string
		code rpc.ErrorCode
	}{
		"a file that is not a picture or a video": {filepath.Join(dir, "notes.txt"), rpc.CodeUnsupportedMedia},
		"a folder":                    {filepath.Join(dir, "sub"), rpc.CodeInvalidArgument},
		"a file that is not there":    {filepath.Join(dir, "gone.jpg"), rpc.CodeNotFound},
		"a path that is not absolute": {"b.png", rpc.CodeInvalidPath},
	} {
		if _, err := svc.entryFromPath(ctx, entryFromPathParams{Path: c.path}); rpcCode(err) != c.code {
			t.Errorf("%s: %v, want %s", name, err, c.code)
		}
	}
}
