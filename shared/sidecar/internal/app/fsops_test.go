package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"fastview/sidecar/internal/fileops"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/jobs"
	"fastview/sidecar/internal/rpc"
)

// Stage C04: new folders, trash availability, destinations by folder id,
// masks and new names.

func rpcReason(err error) (rpc.ErrorCode, string) {
	var e *rpc.Error
	if !errors.As(err, &e) {
		return "", ""
	}
	r, _ := e.Details.(map[string]string)
	return e.Code, r["reason"]
}

func TestMkdirChain(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	root := filepath.Join(t.TempDir(), "root")
	if err := os.MkdirAll(filepath.Join(root, "a"), 0o755); err != nil {
		t.Fatal(err)
	}
	dir, err := svc.store.EnsureDir(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	// "a" exists: kept; b and c are created; the id is a's.
	res, err := svc.fsMkdir(ctx, fsMkdirParams{ParentDirID: dir.ID, Path: `a/b\c`})
	if err != nil || !res.Created || res.EntryID == 0 {
		t.Fatalf("%+v %v", res, err)
	}
	if fi, err := os.Stat(filepath.Join(root, "a", "b", "c")); err != nil || !fi.IsDir() {
		t.Fatalf("chain not created: %v", err)
	}
	a, err := svc.store.Dir(ctx, res.EntryID)
	if err != nil || a.Path != filepath.Join(root, "a") {
		t.Fatalf("entry %d is %+v (%v)", res.EntryID, a, err)
	}
	// The whole chain exists: no error, nothing created.
	again, err := svc.fsMkdir(ctx, fsMkdirParams{ParentDirID: dir.ID, Path: "a/b/c"})
	if err != nil || again.Created || again.EntryID != res.EntryID {
		t.Fatalf("existing chain: %+v %v", again, err)
	}
	// A file in the way, an invalid name, an empty path, an unknown parent.
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		path   string
		code   rpc.ErrorCode
		reason string
	}{
		{"file/sub", rpc.CodeInvalidArgument, fileops.CodeExists},
		{"ok/..", rpc.CodeInvalidArgument, fileops.CodeInvalidName},
		{"bad:name", rpc.CodeInvalidArgument, fileops.CodeInvalidName},
		{" / ", rpc.CodeInvalidArgument, fileops.CodeInvalidName},
	} {
		if c.path == "bad:name" && runtime.GOOS != "windows" {
			continue // a valid name outside Windows rules
		}
		_, err := svc.fsMkdir(ctx, fsMkdirParams{ParentDirID: dir.ID, Path: c.path})
		if code, reason := rpcReason(err); code != c.code || reason != c.reason {
			t.Errorf("%q: %v (code %s reason %q)", c.path, err, code, reason)
		}
	}
	if _, err := svc.fsMkdir(ctx, fsMkdirParams{ParentDirID: 999_999, Path: "x"}); err == nil {
		t.Error("unknown parent accepted")
	}
	if exists := func(p string) bool { _, err := os.Stat(filepath.Join(root, p)); return err == nil }; exists("ok") {
		t.Error("an invalid chain created its valid first part")
	}
}

func TestMkdirPermissionDenied(t *testing.T) {
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("needs Unix permissions and a non-root user")
	}
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	root := filepath.Join(t.TempDir(), "locked")
	if err := os.MkdirAll(root, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(root, 0o755) })
	dir, _ := svc.store.EnsureDir(ctx, root)
	_, err := svc.fsMkdir(ctx, fsMkdirParams{ParentDirID: dir.ID, Path: "x"})
	if code, _ := rpcReason(err); code != rpc.CodePermissionDenied {
		t.Fatalf("%v", err)
	}
}

func TestCanTrashAndDestinationsByID(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	src := filepath.Join(t.TempDir(), "src")
	dst := filepath.Join(t.TempDir(), "dst")
	for _, n := range []string{"a.jpg", "b.png", "c.txt"} {
		if err := os.MkdirAll(src, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(src, n), []byte(n), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	dstDir, _ := svc.store.EnsureDir(ctx, dst)
	if res, err := svc.registerTrash(ctx, dstDir.ID); err != nil || !res.Trash && runtime.GOOS != "windows" {
		t.Errorf("canTrash: %+v %v", res, err)
	}
	if _, err := svc.dirPath(ctx, 0); err == nil {
		t.Error("folder id 0 accepted")
	}
	got, err := svc.jobDestination(ctx, dstDir.ID, "ignored")
	if err != nil || got != dst {
		t.Fatalf("destination %q %v", got, err)
	}

	// A job with a mask copies the matching files only; the others count as skipped.
	srcDir, _ := svc.store.EnsureDir(ctx, src)
	ids := listIDs(t, svc, srcDir)
	s, err := svc.jobs.Start(jobs.Spec{Kind: jobs.KindCopy, IDs: ids, Destination: dst, Conflict: jobs.ConflictKeepBoth, Mask: "*.jpg;*.png"})
	if err != nil {
		t.Fatal(err)
	}
	f := waitJob(t, svc, s.JobID)
	if f.Done != 2 || f.Skipped != 1 {
		t.Fatalf("masked copy %+v", f)
	}
	if _, err := os.Stat(filepath.Join(dst, "c.txt")); err == nil {
		t.Error("c.txt copied despite the mask")
	}
	// Shift+F5: one item copied into its own folder under a new name.
	s, err = svc.jobs.Start(jobs.Spec{Kind: jobs.KindCopy, IDs: ids[:1], Destination: src, Conflict: jobs.ConflictAsk, Name: "copy of a.jpg"})
	if err != nil {
		t.Fatal(err)
	}
	if f := waitJob(t, svc, s.JobID); f.Done != 1 {
		t.Fatalf("copy under a new name %+v", f)
	}
	if b, err := os.ReadFile(filepath.Join(src, "copy of a.jpg")); err != nil || string(b) != "a.jpg" {
		t.Errorf("copy of a.jpg: %v", err)
	}
	if _, err := svc.jobs.Start(jobs.Spec{Kind: jobs.KindCopy, IDs: ids, Destination: src, Conflict: jobs.ConflictAsk, Name: "x"}); !errors.Is(err, jobs.ErrInvalid) {
		t.Errorf("a new name for several items: %v", err)
	}
}

func (s *indexService) registerTrash(ctx context.Context, id int64) (fsCanTrashResult, error) {
	p, err := s.dirPath(ctx, id)
	if err != nil {
		return fsCanTrashResult{}, err
	}
	return fsCanTrashResult{Trash: fileops.CanTrash(p)}, nil
}

// listIDs lists a folder (all entries) and returns its ids in name order.
func listIDs(t *testing.T, svc *indexService, dir index.DirInfo) []int64 {
	t.Helper()
	ctx := context.Background()
	scanID, err := svc.scans.Open(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	_ = scanID
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		ids, err := svc.store.QueryIDs(ctx, index.Descriptor{DirID: dir.ID, Scope: index.ScopeAll,
			Sort: []index.SortKey{{Field: index.SortName}}}, dir.Key)
		if err == nil && len(ids) == 3 {
			return ids
		}
	}
	t.Fatal("folder not listed")
	return nil
}

func waitJob(t *testing.T, svc *indexService, id int64) jobs.Snapshot {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		for _, s := range svc.jobs.List() {
			if s.JobID == id && !s.State.Active() {
				return s
			}
		}
	}
	t.Fatalf("job %d did not finish", id)
	return jobs.Snapshot{}
}
