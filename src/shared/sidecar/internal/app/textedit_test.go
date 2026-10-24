package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"panelyth/sidecar/internal/archive"
	"panelyth/sidecar/internal/remote"
	"panelyth/sidecar/internal/rpc"
	"panelyth/sidecar/internal/textedit"
)

// Stage C10.6: the text editor's methods as main calls them, and the
// reasons a file does not open.

func codeReason(t *testing.T, err error) (rpc.ErrorCode, string) {
	t.Helper()
	var e *rpc.Error
	if !errors.As(err, &e) {
		t.Fatalf("not an rpc error: %v", err)
	}
	reason := ""
	if d, ok := e.Details.(map[string]string); ok {
		reason = d["reason"]
	}
	return e.Code, reason
}

func TestTextEditMethods(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	root := t.TempDir()
	files := map[string][]byte{
		"notes.md":  []byte("# Notes\r\nText\r\n"),
		"image.bin": {0x89, 'P', 'N', 'G', 0, 0, 0, 0x0d, 0, 0},
		"big.txt":   bytes.Repeat([]byte("x"), textedit.MaxBytes+1),
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(root, name), body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	dir, err := svc.store.EnsureDir(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]int64{}
	for name := range files {
		r, err := svc.fsMkfile(ctx, fsMkfileParams{ParentDirID: dir.ID, Name: name})
		if err != nil {
			t.Fatal(err)
		}
		ids[name] = r.EntryID
	}
	sub, err := svc.store.EnsureDir(ctx, filepath.Join(root, "sub"))
	if err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		name   string
		id     int64
		code   rpc.ErrorCode
		reason string
	}{
		{"binary", ids["image.bin"], rpc.CodeInvalidArgument, "binary"},
		{"too large", ids["big.txt"], rpc.CodeInvalidArgument, "tooLarge"},
		{"folder", sub.ID, rpc.CodeInvalidArgument, "folder"},
		{"archive", archive.EntryID(1, 0), rpc.CodeInvalidArgument, "notLocal"},
		{"remote", remote.EntryID(1, 1), rpc.CodeInvalidArgument, "notLocal"},
		{"unknown", 987654, rpc.CodeNotFound, ""},
	} {
		_, err := svc.textEditOpen(ctx, textEditOpenParams{EntryID: c.id})
		if code, reason := codeReason(t, err); code != c.code || reason != c.reason {
			t.Errorf("%s: %s %q (%v)", c.name, code, reason, err)
		}
	}

	open, err := svc.textEditOpen(ctx, textEditOpenParams{EntryID: ids["notes.md"]})
	if err != nil {
		t.Fatal(err)
	}
	if open.Name != "notes.md" || open.Path != filepath.Join(root, "notes.md") || open.Encoding != "utf-8" ||
		open.LineEnding != "crlf" || open.BOM != 0 || len(open.Version) != 64 || open.SizeBytes != 15 {
		t.Fatalf("open %+v", open)
	}
	b, _ := json.Marshal(open)
	var wire map[string]any
	_ = json.Unmarshal(b, &wire)
	for _, k := range []string{"sessionId", "name", "path", "version", "sizeBytes", "mtimeNs", "encoding", "bom", "lineEnding"} {
		if _, ok := wire[k]; !ok {
			t.Errorf("open result has no %s: %s", k, b)
		}
	}

	write := func(seq int, text string) error {
		raw, _ := json.Marshal(text)
		_, err := svc.textEditWrite(ctx, textEditWriteParams{SessionID: open.SessionID, Seq: seq, Text: raw})
		return err
	}
	if err := write(1, "x"); err == nil {
		t.Error("chunk 1 first was accepted")
	} else if code, _ := codeReason(t, err); code != rpc.CodeInvalidArgument {
		t.Errorf("chunk 1 first: %v", err)
	}
	if err := write(0, "# Notes\nMore\n"); err != nil {
		t.Fatal(err)
	}
	res, err := svc.textEditCommit(ctx, textEditCommitParams{SessionID: open.SessionID, BaseVersion: open.Version})
	saved, ok := res.(textEditSaved)
	if err != nil || !ok || saved.Status != "saved" || saved.Encoding != "utf-8" {
		t.Fatalf("commit %+v %v", res, err)
	}
	if got, _ := os.ReadFile(open.Path); string(got) != "# Notes\r\nMore\r\n" {
		t.Fatalf("saved %q", got)
	}
	// A conflict and an unencodable character are answers.
	_ = os.WriteFile(open.Path, []byte("theirs\r\n"), 0o644)
	_ = write(0, "mine\n")
	res, err = svc.textEditCommit(ctx, textEditCommitParams{SessionID: open.SessionID, BaseVersion: saved.Version})
	if c, ok := res.(textEditConflict); err != nil || !ok || c.Gone {
		t.Fatalf("conflict %+v %v", res, err)
	}
	b, _ = json.Marshal(res)
	if string(b) != `{"status":"conflict","gone":false}` {
		t.Errorf("conflict on the wire: %s", b)
	}
	check, err := svc.textEditCheck(ctx, textEditSessionParams{SessionID: open.SessionID})
	if err != nil || check.Disk == nil || check.Disk.SizeBytes != 8 {
		t.Fatalf("check %+v %v", check, err)
	}
	_ = os.Remove(open.Path)
	check, _ = svc.textEditCheck(ctx, textEditSessionParams{SessionID: open.SessionID})
	if b, _ := json.Marshal(check); string(b) != `{"disk":null}` {
		t.Errorf("check of a deleted file: %s", b)
	}

	// Close is idempotent; a closed session is gone.
	for range 2 {
		if r, err := svc.textEditClose(ctx, textEditSessionParams{SessionID: open.SessionID}); err != nil || !r.OK {
			t.Fatalf("close %+v %v", r, err)
		}
	}
	sid := textEditSessionParams{SessionID: open.SessionID}
	_, werr := svc.textEditWrite(ctx, textEditWriteParams{SessionID: open.SessionID, Text: json.RawMessage(`"x"`)})
	_, cerr := svc.textEditCommit(ctx, textEditCommitParams{SessionID: open.SessionID})
	_, kerr := svc.textEditCheck(ctx, sid)
	for m, err := range map[string]error{"write": werr, "commit": cerr, "check": kerr} {
		if err == nil {
			t.Errorf("%s on a closed session", m)
		} else if code, _ := codeReason(t, err); code != rpc.CodeTextEditSessionGone {
			t.Errorf("%s: %v", m, err)
		}
	}
}

// A failed rename is an error with the item code as its reason.
func TestTextEditSaveErrors(t *testing.T) {
	if code, reason := codeReason(t, textEditSaveError(&os.PathError{Op: "open", Path: "x", Err: os.ErrPermission})); code != rpc.CodePermissionDenied || reason != "PERMISSION_DENIED" {
		t.Errorf("permission: %s %s", code, reason)
	}
	if code, _ := codeReason(t, textEditSaveError(textedit.ErrGone)); code != rpc.CodeTextEditSessionGone {
		t.Errorf("gone: %s", code)
	}
	if err := textEditSaveError(context.Canceled); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled: %v", err)
	}
}

// Stage C10.7: the picture methods' refusals reach main with their reasons.
func TestTextEditAssetReasons(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "doc.md"), []byte("# Doc\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir, err := svc.store.EnsureDir(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	f, err := svc.fsMkfile(ctx, fsMkfileParams{ParentDirID: dir.ID, Name: "doc.md"})
	if err != nil {
		t.Fatal(err)
	}
	open, err := svc.textEditOpen(ctx, textEditOpenParams{EntryID: f.EntryID})
	if err != nil {
		t.Fatal(err)
	}
	sid := open.SessionID
	if _, err := svc.textEditAssetChunk(ctx, textEditAssetChunkParams{SessionID: sid, Data: "!!"}); err == nil {
		t.Error("bad base64 accepted")
	} else if code, _ := codeReason(t, err); code != rpc.CodeInvalidArgument {
		t.Errorf("bad base64: %v", err)
	}
	gif := base64.StdEncoding.EncodeToString([]byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;"))
	if _, err := svc.textEditAssetChunk(ctx, textEditAssetChunkParams{SessionID: sid, Data: gif}); err != nil {
		t.Fatal(err)
	}
	_, err = svc.textEditAssetCommit(ctx, textEditAssetCommitParams{SessionID: sid, Name: "x", Folder: "../up"})
	if code, reason := codeReason(t, err); code != rpc.CodeInvalidArgument || reason != "folder" {
		t.Errorf("folder: %s %q", code, reason)
	}
	res, err := svc.textEditAssetCommit(ctx, textEditAssetCommitParams{SessionID: sid, Name: "dot", Folder: "assets"})
	if err != nil || res.Link != "assets/dot.gif" || res.Reused {
		t.Fatalf("commit %+v %v", res, err)
	}
	text := base64.StdEncoding.EncodeToString([]byte("just some text, not a picture"))
	_, _ = svc.textEditAssetChunk(ctx, textEditAssetChunkParams{SessionID: sid, Data: text})
	_, err = svc.textEditAssetCommit(ctx, textEditAssetCommitParams{SessionID: sid, Name: "x", Folder: "assets"})
	if code, reason := codeReason(t, err); code != rpc.CodeInvalidArgument || reason != "notImage" {
		t.Errorf("not an image: %s %q", code, reason)
	}
	imgs, err := svc.textEditResolveImages(ctx, textEditResolveImagesParams{SessionID: sid, Links: []string{"assets/dot.gif", "x.png"}})
	if err != nil || imgs.Images[0].Path == nil || *imgs.Images[0].Type != "gif" || imgs.Images[1].Path != nil || imgs.Images[1].Type != nil {
		t.Fatalf("resolve %+v %v", imgs, err)
	}
	if _, err := svc.textEditResolveImages(ctx, textEditResolveImagesParams{SessionID: sid, Links: make([]string, 201)}); err == nil {
		t.Error("201 links accepted")
	} else if code, _ := codeReason(t, err); code != rpc.CodeInvalidArgument {
		t.Errorf("201 links: %v", err)
	}
	svc.textEditClose(ctx, textEditSessionParams{SessionID: sid})
	if _, err := svc.textEditAssetChunk(ctx, textEditAssetChunkParams{SessionID: sid, Data: gif}); err == nil {
		t.Error("closed session accepted a chunk")
	} else if code, _ := codeReason(t, err); code != rpc.CodeTextEditSessionGone {
		t.Errorf("closed: %v", err)
	}
}
