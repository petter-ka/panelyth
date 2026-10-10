package app

import (
	"archive/zip"
	"context"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"panelyth/sidecar/internal/archive"
	"panelyth/sidecar/internal/rpc"
)

// Stage C07: an archive is a folder of its own session source; its entries
// are viewed through a temporary extraction and copied out by extract jobs.

func writeTestZip(t *testing.T, path string, files map[string]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	z := zip.NewWriter(f)
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	slices.Sort(names)
	for _, n := range names {
		// A fixed UTC time (an extended timestamp), so golden frames do not
		// depend on the machine's time zone.
		w, _ := z.CreateHeader(&zip.FileHeader{Name: n, Method: zip.Deflate, Modified: time.Date(2024, 5, 6, 7, 8, 10, 0, time.UTC)})
		_, _ = io.WriteString(w, files[n])
	}
	_ = z.Close()
	_ = f.Close()
}

// openListed opens a folder in the all scope and returns its session's
// entries by name.
func openListed(t *testing.T, svc *indexService, dir string) (int64, map[string]contentItem) {
	t.Helper()
	ctx := context.Background()
	res, err := svc.dirOpen(ctx, dirOpenParams{Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	svc.scans.Wait(res.ScanID)
	snap, err := svc.queryOpen(ctx, queryOpenParams{DirID: res.DirID, Scope: "all", ShowHidden: true})
	if err != nil {
		t.Fatal(err)
	}
	page, err := svc.queryPage(ctx, queryPageParams{QueryID: snap.QueryID, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]contentItem{}
	for _, it := range page.Items {
		out[it.Name] = it
	}
	return res.DirID, out
}

func pageNames(t *testing.T, svc *indexService, queryID int64) ([]contentItem, []string) {
	t.Helper()
	page, err := svc.queryPage(context.Background(), queryPageParams{QueryID: queryID, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, len(page.Items))
	for i, it := range page.Items {
		names[i] = it.Name
	}
	return page.Items, names
}

func TestArchiveAsAFolder(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	root := t.TempDir()
	writeTestZip(t, filepath.Join(root, "photos.zip"), map[string]string{
		"docs/readme.txt": "read me", "docs/sub/deep.txt": "deep", "b.txt": "bb", "a.txt": "a",
	})
	out := filepath.Join(root, "out")
	_ = os.Mkdir(out, 0o755)
	_, items := openListed(t, svc, root)
	outID, _ := openListed(t, svc, out)
	zipItem := items["photos.zip"]

	opened, err := svc.archiveOpen(ctx, entryParams{EntryID: zipItem.ID})
	if err != nil {
		t.Fatal(err)
	}
	if opened.Format != "zip" || opened.Entries != 6 || opened.Bytes != int64(len("read me")+4+2+1) {
		t.Errorf("opened %+v", opened)
	}
	snap, err := svc.queryOpen(ctx, queryOpenParams{ArchiveID: opened.ArchiveID, Scope: "all",
		Sort: []sortKeyWire{{Field: "name", Direction: "asc"}}})
	if err != nil {
		t.Fatal(err)
	}
	rows, names := pageNames(t, svc, snap.QueryID)
	if !slices.Equal(names, []string{"docs", "a.txt", "b.txt"}) {
		t.Fatalf("root %v", names)
	}
	if !archive.IsID(rows[0].ID) || rows[0].Kind != "dir" || rows[0].DirSizeBytes == nil || *rows[0].DirSizeBytes != 11 || rows[1].DirPath != "" {
		t.Errorf("rows %+v", rows)
	}
	if svc.queries.SpansFolders(snap.QueryID) {
		t.Error("an archive folder spans folders")
	}
	if at, _, err := svc.queries.Locate(ctx, snap.QueryID, "b", 0, false); err != nil || at != 2 {
		t.Errorf("quick search %d %v", at, err)
	}

	// A subfolder, then a file viewed through its temporary extraction.
	sub, err := svc.queryOpen(ctx, queryOpenParams{ArchiveID: opened.ArchiveID, ArchiveDirID: rows[0].ID, Scope: "all"})
	if err != nil {
		t.Fatal(err)
	}
	subRows, subNames := pageNames(t, svc, sub.QueryID)
	if !slices.Equal(subNames, []string{"sub", "readme.txt"}) {
		t.Errorf("docs %v", subNames)
	}
	f, err := svc.fileResolve(ctx, mediaResolveParams{EntryID: subRows[1].ID})
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(f.Path); string(b) != "read me" || f.SizeBytes != 7 || !strings.Contains(f.Path, filepath.Join("tmp", "archive")) {
		t.Errorf("view %+v", f)
	}
	if _, err := svc.fileResolve(ctx, mediaResolveParams{EntryID: rows[0].ID}); err == nil {
		t.Error("a folder was resolved")
	}
	props, err := svc.propsGet(ctx, entryParams{EntryID: subRows[1].ID})
	if err != nil || props.Name != "readme.txt" || !strings.HasSuffix(props.Path, filepath.Join("photos.zip", "docs", "readme.txt")) {
		t.Errorf("props %+v %v", props, err)
	}
	sel := selectionWire{QueryID: snap.QueryID, Version: snap.Version, Ranges: [][2]int{{0, 2}}, Include: []int64{}, Exclude: []int64{}}
	info, err := svc.resolveSelection(sel)
	if err != nil || len(info) != 2 {
		t.Fatal(err)
	}
	if sum, err := svc.archiveSummary(info); err != nil || sum.Count != 2 || sum.Dirs != 1 || sum.Bytes != 12 {
		t.Errorf("summary %+v %v", sum, err)
	}

	// Copy out: docs and a.txt into out.
	check, err := svc.archiveCheck(ctx, archiveCheckParams{Selection: sel, DestinationDirID: outID})
	if err != nil || check.Files != 3 || check.Bytes != 12 || len(check.Warnings) != 0 {
		t.Errorf("check %+v %v", check, err)
	}
	job, err := svc.jobsStart(ctx, jobStartParams{Kind: "extract", Source: jobSourceWire{Selection: sel},
		DestinationDirID: outID, Conflict: "ask"})
	if err != nil {
		t.Fatal(err)
	}
	jobOK(t, svc, job.JobID)
	if b, _ := os.ReadFile(filepath.Join(out, "docs", "sub", "deep.txt")); string(b) != "deep" {
		t.Error("docs/sub/deep.txt was not copied out")
	}
	if _, err := os.Stat(filepath.Join(out, "b.txt")); err == nil {
		t.Error("b.txt was not marked")
	}

	// Archives are read-only.
	for _, kind := range []string{"delete", "trash", "copy", "pack"} {
		_, err := svc.jobsStart(ctx, jobStartParams{Kind: kind, Source: jobSourceWire{Selection: sel},
			DestinationDirID: outID, Conflict: "ask", Name: "x.zip", Format: "zip"})
		if err == nil {
			t.Errorf("%s ran on archive entries", kind)
		}
	}
	if _, err := svc.clipSet(ctx, clipSetParams{Selection: sel, Mode: "copy"}); err == nil {
		t.Error("archive entries went to the clipboard")
	}

	// Closing the handle and the sessions closes the archive and removes
	// the viewed file.
	if !svc.archives.Close(opened.ArchiveID) {
		t.Error("close")
	}
	svc.queries.Close(snap.QueryID)
	svc.queries.Close(sub.QueryID)
	if _, err := svc.archives.Get(opened.ArchiveID); err == nil {
		t.Error("the archive is still open")
	}
	if _, err := os.Stat(f.Path); err == nil {
		t.Error("the viewed file is still there")
	}
	if _, err := svc.queryOpen(ctx, queryOpenParams{ArchiveID: opened.ArchiveID, Scope: "all"}); err == nil {
		t.Error("a closed archive opened")
	}
}

// jobOK waits for a job and fails the test unless it completed cleanly.
func jobOK(t *testing.T, svc *indexService, id int64) {
	t.Helper()
	if s := waitJob(t, svc, id); s.State != "completed" || s.Failed > 0 {
		errs, _, _ := svc.jobs.Errors(id, 0, 10)
		t.Fatalf("job %+v %v", s, errs)
	}
}

func TestArchiveOpenErrors(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	root := t.TempDir()
	_ = os.WriteFile(filepath.Join(root, "notes.txt"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "broken.zip"), []byte("not a zip at all"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "x.7z"), []byte("7z"), 0o644)
	_, items := openListed(t, svc, root)
	for name, reason := range map[string]string{"notes.txt": "notArchive", "broken.zip": "corrupt", "x.7z": "noTool"} {
		_, err := svc.archiveOpen(ctx, entryParams{EntryID: items[name].ID})
		if _, got := rpcReason(err); got != reason {
			t.Errorf("%s: %v (reason %q, want %q)", name, err, got, reason)
		}
	}
	if _, err := svc.archiveOpen(ctx, entryParams{EntryID: 987654}); err == nil {
		t.Error("an unknown entry opened")
	} else if code, _ := rpcReason(err); code != rpc.CodeNotFound {
		t.Errorf("unknown entry: %v", err)
	}
}

func TestUnpackPackThroughRPC(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	root := t.TempDir()
	writeTestZip(t, filepath.Join(root, "set.zip"), map[string]string{"one.txt": "1", "two/three.txt": "3"})
	_ = os.WriteFile(filepath.Join(root, "loose.txt"), []byte("loose"), 0o644)
	dirID, items := openListed(t, svc, root)
	snapID := func() int64 {
		snap, _ := svc.queryOpen(ctx, queryOpenParams{DirID: dirID, Scope: "all", Sort: []sortKeyWire{{Field: "name", Direction: "asc"}}})
		return snap.QueryID
	}
	q := snapID()
	_, names := pageNames(t, svc, q)
	idx := slices.Index(names, "set.zip")
	sel := selectionWire{QueryID: q, Version: 1, Ranges: [][2]int{{idx, idx + 1}}, Include: []int64{}, Exclude: []int64{}}

	check, err := svc.archiveCheck(ctx, archiveCheckParams{Selection: sel, DestinationDirID: dirID})
	if err != nil || check.Files != 2 || check.Bytes != 2 || check.FreeBytes <= 0 {
		t.Errorf("check %+v %v", check, err)
	}
	job, err := svc.jobsStart(ctx, jobStartParams{Kind: "extract", Source: jobSourceWire{Selection: sel},
		DestinationDirID: dirID, Conflict: "skip", Subfolders: true})
	if err != nil {
		t.Fatal(err)
	}
	jobOK(t, svc, job.JobID)
	if b, _ := os.ReadFile(filepath.Join(root, "set", "two", "three.txt")); string(b) != "3" {
		t.Error("unpacked into its folder")
	}

	job, err = svc.jobsStart(ctx, jobStartParams{Kind: "testArchive", Source: jobSourceWire{Selection: sel}})
	if err != nil {
		t.Fatal(err)
	}
	jobOK(t, svc, job.JobID)

	looseSel := sel
	looseSel.Include, looseSel.Ranges = []int64{items["loose.txt"].ID}, [][2]int{}
	job, err = svc.jobsStart(ctx, jobStartParams{Kind: "pack", Source: jobSourceWire{Selection: looseSel},
		DestinationDirID: dirID, Conflict: "ask", Name: "loose.zip", Format: "zip", Level: 9})
	if err != nil {
		t.Fatal(err)
	}
	jobOK(t, svc, job.JobID)
	l, err := archive.Read(ctx, filepath.Join(root, "loose.zip"), archive.FormatZip, nil)
	if err != nil || l.Find("loose.txt") < 0 {
		t.Errorf("packed: %v", err)
	}
	if _, err := svc.jobsStart(ctx, jobStartParams{Kind: "pack", Source: jobSourceWire{Selection: looseSel},
		DestinationDirID: dirID, Conflict: "ask", Name: "x.7z", Format: "7z"}); err == nil {
		t.Error("7z was packed without 7-Zip")
	}
}
