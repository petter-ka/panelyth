package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"panelyth/sidecar/internal/imaging"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/pathkey"
	"panelyth/sidecar/internal/rpc"
	"panelyth/sidecar/internal/scan"
	"panelyth/sidecar/internal/video"
)

func editList(t *testing.T, js string) imaging.EditList {
	t.Helper()
	var e imaging.EditList
	if err := json.Unmarshal([]byte(js), &e); err != nil {
		t.Fatal(err)
	}
	return e
}

// editFixture indexes a folder with a.jpg (600×400) and clip.mp4.
func editFixture(t *testing.T) (svc *indexService, root string, imageID, videoID int64) {
	t.Helper()
	root = filepath.Join(t.TempDir(), "pics")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(image.Rect(0, 0, 600, 400))
	for y := range 400 {
		for x := range 600 {
			img.SetRGBA(x, y, color.RGBA{uint8(x / 3), uint8(y / 2), 90, 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "a.jpg"), buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "clip.mp4"), []byte("not decoded"), 0o644); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.DiscardHandler)
	svc, err := newIndexService(t.TempDir(), 1<<30, log, func(string, any) error { return nil }, &video.Tools{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.close)
	ctx := context.Background()
	info, err := svc.store.EnsureDir(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if st := scan.Run(ctx, svc.store, log, scan.Options{}, scan.Hooks{}, 1, svc.store.NextGeneration(), info, false); st.State != scan.StateCompleted {
		t.Fatal(st.State)
	}
	dir, _ := svc.store.Dir(ctx, info.ID)
	ids, _ := svc.store.QueryIDs(ctx, index.Descriptor{DirID: dir.ID, Sort: []index.SortKey{{Field: index.SortName}}}, dir.Key)
	if len(ids) != 2 {
		t.Fatalf("ids %v", ids)
	}
	return svc, root, ids[0], ids[1]
}

func TestEditOpenAndRender(t *testing.T) {
	svc, _, imageID, videoID := editFixture(t)
	ctx := context.Background()
	if _, err := svc.editOpen(ctx, editOpenParams{EntryID: videoID, Owner: 1}); rpcCode(err) != rpc.CodeEditUnsupported {
		t.Fatalf("video: %v", err)
	}
	if _, err := svc.editOpen(ctx, editOpenParams{EntryID: 999_999, Owner: 1}); rpcCode(err) != rpc.CodeNotFound {
		t.Fatalf("unknown entry: %v", err)
	}
	open, err := svc.editOpen(ctx, editOpenParams{EntryID: imageID, Owner: 1})
	if err != nil {
		t.Fatal(err)
	}
	if open.Name != "a.jpg" || open.Width != 600 || open.Height != 400 || open.Format != "jpeg" || open.SaveFormat != "jpeg" || open.HasAlpha {
		t.Fatalf("%+v", open)
	}
	frame, err := svc.editRender(ctx, editFrameParams{SessionID: open.SessionID, Rev: 1, Quality: "final", Histogram: true,
		View: editViewWire{MaxEdge: 300}, EditList: editList(t, `[{"op":"rotate","p":{"angle":90}}]`)})
	if err != nil {
		t.Fatal(err)
	}
	if frame.Frame == nil || frame.Frame.Width != 213 || frame.Frame.Height != 320 || frame.Output.Width != 400 || frame.Output.Height != 600 || frame.Histogram == nil {
		t.Fatalf("%+v %+v %+v", frame, frame.Frame, frame.Output)
	}
	if _, err := os.Stat(frame.Frame.File); err != nil || filepath.Base(filepath.Dir(frame.Frame.File)) != "edit" {
		t.Fatalf("frame file %q: %v", frame.Frame.File, err)
	}
	stale, err := svc.editRender(ctx, editFrameParams{SessionID: open.SessionID, Rev: 1, Quality: "draft", View: editViewWire{MaxEdge: 300}})
	if err != nil || !stale.Superseded || stale.Frame != nil {
		t.Fatalf("stale revision: %+v %v", stale, err)
	}
	if _, err := svc.editRender(ctx, editFrameParams{SessionID: open.SessionID, Rev: 2, Quality: "best"}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Fatalf("bad quality: %v", err)
	}
	if _, err := svc.editRender(ctx, editFrameParams{SessionID: open.SessionID, Rev: 2, Quality: "final", EditList: editList(t, `[{"op":"warp"}]`)}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Fatalf("unknown operation: %v", err)
	}
	if _, err := svc.editRender(ctx, editFrameParams{SessionID: open.SessionID, Rev: 2, Quality: "final",
		EditList: editList(t, `[{"op":"resize","p":{"mode":"pixels","w":65535,"h":65535}}]`)}); rpcCode(err) != rpc.CodeEditTooLarge {
		t.Fatalf("huge result: %v", err)
	}
	// Opening another picture in the same window ends the first session.
	if _, err := svc.editOpen(ctx, editOpenParams{EntryID: imageID, Owner: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.editRender(ctx, editFrameParams{SessionID: open.SessionID, Rev: 9, Quality: "final"}); rpcCode(err) != rpc.CodeEditSessionGone {
		t.Fatalf("closed session: %v", err)
	}
	if _, err := svc.editRender(ctx, editFrameParams{SessionID: "nope", Rev: 1, Quality: "final"}); rpcCode(err) != rpc.CodeEditSessionGone {
		t.Fatalf("unknown session: %v", err)
	}
}

func TestEditWrite(t *testing.T) {
	svc, root, imageID, _ := editFixture(t)
	ctx := context.Background()
	open, err := svc.editOpen(ctx, editOpenParams{EntryID: imageID, Owner: 1})
	if err != nil {
		t.Fatal(err)
	}
	original, _ := os.ReadFile(filepath.Join(root, "a.jpg"))
	list := editList(t, `[{"op":"crop","p":{"rect":{"x":0,"y":0,"w":0.5,"h":0.5}}}]`)
	base := editWriteParams{SessionID: open.SessionID, EditList: list, Format: "jpeg", Quality: 80, Metadata: "keep"}

	// A copy beside the original, indexed when the job is done.
	p := base
	p.Target = "copy"
	res, err := svc.editWrite(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if res.Name != "a (edited).jpg" {
		t.Fatalf("name %q", res.Name)
	}
	snap := waitJob(t, svc, res.JobID)
	if snap.State != jobs.StateCompleted || snap.Kind != jobs.KindEditSave || snap.Done != snap.Total {
		t.Fatalf("%+v", snap)
	}
	probe, err := imaging.DefaultRegistry().ProbeFile(filepath.Join(root, res.Name), "jpg")
	if err != nil || probe.Width != 300 || probe.Height != 200 {
		t.Fatalf("saved copy: %+v %v", probe, err)
	}
	key := pathkey.ChildKey(pathkey.DirKey(root), res.Name, false)
	if id, _ := svc.store.IDByKey(ctx, key); id == 0 {
		t.Fatal("the saved copy is not in the index")
	}
	if path, ok := svc.saves.get(res.JobID); !ok || path != filepath.Join(root, res.Name) {
		t.Fatalf("saved path %q", path)
	}
	// The next copy takes the next name.
	if res2, err := svc.editWrite(ctx, p); err != nil || res2.Name != "a (edited) (2).jpg" {
		t.Fatalf("second copy: %+v %v", res2, err)
	} else {
		waitJob(t, svc, res2.JobID)
	}
	// As PNG.
	p.Format = "png"
	res3, err := svc.editWrite(ctx, p)
	if err != nil || res3.Name != "a (edited).png" {
		t.Fatalf("png copy: %+v %v", res3, err)
	}
	waitJob(t, svc, res3.JobID)

	// Save as: a path from Electron main's dialog.
	other := t.TempDir()
	as := base
	as.Target, as.Path, as.Format = "as", filepath.Join(other, "out.tif"), "tiff"
	res4, err := svc.editWrite(ctx, as)
	if err != nil {
		t.Fatal(err)
	}
	if snap := waitJob(t, svc, res4.JobID); snap.State != jobs.StateCompleted {
		t.Fatalf("save as: %+v", snap)
	}
	if _, err := os.Stat(as.Path); err != nil {
		t.Fatal(err)
	}
	for name, bad := range map[string]func(*editWriteParams){
		"relative path":    func(p *editWriteParams) { p.Path = "out.tif" },
		"wrong extension":  func(p *editWriteParams) { p.Path = filepath.Join(other, "out.png") },
		"no extension":     func(p *editWriteParams) { p.Path = filepath.Join(other, "out") },
		"unknown format":   func(p *editWriteParams) { p.Format = "webp" },
		"policy":           func(p *editWriteParams) { p.Metadata = "some" },
		"quality":          func(p *editWriteParams) { p.Quality = 400 },
		"resolution":       func(p *editWriteParams) { p.DPI = -1 },
		"target":           func(p *editWriteParams) { p.Target = "elsewhere" },
		"invalid edits":    func(p *editWriteParams) { p.EditList = editList(t, `[{"op":"flip","p":{"axis":"z"}}]`) },
		"original as png":  func(p *editWriteParams) { p.Path, p.Format = filepath.Join(root, "a.jpg"), "png" },
		"original renamed": func(p *editWriteParams) { p.Path, p.Format = filepath.Join(root, "a.jpg"), "tiff" },
	} {
		q := as
		bad(&q)
		if _, err := svc.editWrite(ctx, q); err == nil {
			t.Errorf("%s: accepted", name)
		} else if c := rpcCode(err); c != rpc.CodeInvalidArgument && c != rpc.CodeInvalidPath {
			t.Errorf("%s: %v", name, err)
		}
	}
	if now, _ := os.ReadFile(filepath.Join(root, "a.jpg")); !bytes.Equal(now, original) {
		t.Fatal("the original changed")
	}

	// A file that changed on disk fails the job with a message; nothing is written.
	later := time.Now().Add(3 * time.Second)
	if err := os.Chtimes(filepath.Join(root, "a.jpg"), later, later); err != nil {
		t.Fatal(err)
	}
	p.Format = "bmp"
	res5, err := svc.editWrite(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	snap = waitJob(t, svc, res5.JobID)
	if snap.State != jobs.StateFailed || snap.Error == "" || snap.Failed != 1 {
		t.Fatalf("changed file: %+v", snap)
	}
	if _, err := os.Stat(filepath.Join(root, res5.Name)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a failed save left a file")
	}
	// A closed session cannot save.
	svc.editor.Close(open.SessionID)
	if _, err := svc.editWrite(ctx, p); rpcCode(err) != rpc.CodeEditSessionGone {
		t.Fatalf("closed session: %v", err)
	}
}
