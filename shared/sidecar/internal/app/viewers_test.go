package app

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"fastview/sidecar/internal/fileops"
	"fastview/sidecar/internal/fsx"
	"fastview/sidecar/internal/rpc"
)

// Stage C05: any file's bytes for the lister (file.resolve), the program
// flag behind the commander's confirmation, and Shift+F4's new file.

func TestFileResolveAndProgramFlag(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	root := t.TempDir()
	files := map[string]string{"notes.txt": "hello", "photo.jpg": "not really", "setup.bat": "@echo off", "run.sh": "#!/bin/sh"}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
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
	res, err := svc.fsMkfile(ctx, fsMkfileParams{ParentDirID: dir.ID, Name: "notes.txt"})
	if err != nil || res.Created {
		t.Fatalf("existing file: %+v %v", res, err)
	}
	ids := map[string]int64{"notes.txt": res.EntryID}
	for _, name := range []string{"photo.jpg", "setup.bat", "run.sh"} {
		r, err := svc.fsMkfile(ctx, fsMkfileParams{ParentDirID: dir.ID, Name: name})
		if err != nil {
			t.Fatal(err)
		}
		ids[name] = r.EntryID
	}

	txt, err := svc.fileResolve(ctx, mediaResolveParams{EntryID: ids["notes.txt"]})
	if err != nil || txt.Kind != "file" || txt.Mime != "application/octet-stream" || txt.SizeBytes != 5 ||
		txt.Path != filepath.Join(root, "notes.txt") {
		t.Fatalf("text: %+v %v", txt, err)
	}
	jpg, err := svc.fileResolve(ctx, mediaResolveParams{EntryID: ids["photo.jpg"]})
	if err != nil || jpg.Kind != "image" || jpg.Mime != "image/jpeg" {
		t.Fatalf("image: %+v %v", jpg, err)
	}
	sub, err := svc.store.EnsureDir(ctx, filepath.Join(root, "sub"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.fileResolve(ctx, mediaResolveParams{EntryID: sub.ID}); err == nil {
		t.Error("a folder resolved as a file")
	}
	if err := os.Remove(filepath.Join(root, "notes.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.fileResolve(ctx, mediaResolveParams{EntryID: ids["notes.txt"]}); err == nil {
		t.Error("a deleted file resolved")
	} else if code, _ := rpcReason(err); code != rpc.CodeNotFound {
		t.Errorf("deleted file: %v", err)
	}
	if _, err := svc.fileResolve(ctx, mediaResolveParams{EntryID: 999_999}); err == nil {
		t.Error("an unknown id resolved")
	}

	program := func(name string) bool {
		p, err := svc.entryPath(ctx, entryParams{EntryID: ids[name]})
		if err != nil {
			t.Fatal(err)
		}
		return p.Program
	}
	if program("photo.jpg") {
		t.Error("an image is not a program")
	}
	if runtime.GOOS == "windows" {
		if !program("setup.bat") {
			t.Error("a .bat file is a program on Windows")
		}
	} else if !program("run.sh") {
		t.Error("a .sh file is a program")
	}
}

func TestIsProgramExecBit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows decides by extension")
	}
	path := filepath.Join(t.TempDir(), "tool")
	if err := os.WriteFile(path, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(path)
	if !fsx.IsProgram(path, fi) {
		t.Error("a file with the execute bit is a program")
	}
}

func TestMkfile(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "folder"), 0o755); err != nil {
		t.Fatal(err)
	}
	dir, err := svc.store.EnsureDir(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	res, err := svc.fsMkfile(ctx, fsMkfileParams{ParentDirID: dir.ID, Name: " new.txt "})
	if err != nil || !res.Created || res.EntryID == 0 {
		t.Fatalf("%+v %v", res, err)
	}
	if fi, err := os.Stat(filepath.Join(root, "new.txt")); err != nil || fi.Size() != 0 {
		t.Fatalf("file not created empty: %v", err)
	}
	p, err := svc.entryPath(ctx, entryParams{EntryID: res.EntryID})
	if err != nil || p.Kind != "file" || p.Path != filepath.Join(root, "new.txt") {
		t.Fatalf("not indexed: %+v %v", p, err)
	}
	// Existing content is kept.
	if err := os.WriteFile(filepath.Join(root, "new.txt"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	again, err := svc.fsMkfile(ctx, fsMkfileParams{ParentDirID: dir.ID, Name: "new.txt"})
	if err != nil || again.Created || again.EntryID != res.EntryID {
		t.Fatalf("existing: %+v %v", again, err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "new.txt")); string(b) != "keep" {
		t.Error("an existing file was truncated")
	}
	for _, c := range []struct {
		name   string
		reason string
	}{
		{"folder", fileops.CodeExists},
		{"a/b.txt", fileops.CodeInvalidName},
		{"..", fileops.CodeInvalidName},
		{"   ", fileops.CodeInvalidName},
	} {
		_, err := svc.fsMkfile(ctx, fsMkfileParams{ParentDirID: dir.ID, Name: c.name})
		if code, reason := rpcReason(err); code != rpc.CodeInvalidArgument || reason != c.reason {
			t.Errorf("%q: %v (%s %q)", c.name, err, code, reason)
		}
	}
	if _, err := svc.fsMkfile(ctx, fsMkfileParams{ParentDirID: 999_999, Name: "x"}); err == nil {
		t.Error("unknown parent accepted")
	}
}
