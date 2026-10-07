package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"fastview/sidecar/internal/archive"
	"fastview/sidecar/internal/fsx"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/jobs"
	"fastview/sidecar/internal/media"
	"fastview/sidecar/internal/query"
	"fastview/sidecar/internal/rpc"
)

// Stage C07 (ADR-0030): archives browsed like folders, their entries
// viewed through a temporary extraction, and the extract, pack and test
// jobs. Wire types mirror shared/contracts/src/rpc.ts.

// MaxCheckArchives bounds the archives archive.check lists for an unpack.
const MaxCheckArchives = 64

type (
	archiveOpenResult struct {
		ArchiveID int64  `json:"archiveId"`
		Format    string `json:"format"`
		Entries   int    `json:"entries"`
		// Rejected entries have unsafe names; they are never listed or extracted.
		Rejected    int   `json:"rejected"`
		Bytes       int64 `json:"bytes"`
		PackedBytes int64 `json:"packedBytes"`
	}
	archiveIDParams struct {
		ArchiveID int64 `json:"archiveId"`
	}
	archiveCloseResult struct {
		Closed bool `json:"closed"`
	}
	archiveCheckParams struct {
		Selection        selectionWire `json:"selection"`
		DestinationDirID int64         `json:"destinationDirId"`
	}
	archiveCheckResult struct {
		Files       int   `json:"files"`
		Bytes       int64 `json:"bytes"`
		PackedBytes int64 `json:"packedBytes"`
		// FreeBytes is -1 when the free space could not be read in time.
		FreeBytes int64    `json:"freeBytes"`
		Warnings  []string `json:"warnings"`
		// Partial: only the first MaxCheckArchives archives were looked at.
		Partial bool `json:"partial"`
	}
	archiveToolResult struct {
		SevenZip bool `json:"sevenZip"`
	}
)

func (s *indexService) registerArchives(srv *rpc.Server) {
	rpc.Register(srv, "archive.open", s.archiveOpen)
	rpc.Register(srv, "archive.close", func(_ context.Context, p archiveIDParams) (archiveCloseResult, error) {
		return archiveCloseResult{Closed: s.archives.Close(p.ArchiveID)}, nil
	})
	rpc.Register(srv, "archive.check", s.archiveCheck)
	rpc.Register(srv, "archive.tools", func(context.Context, emptyParams) (archiveToolResult, error) {
		return archiveToolResult{SevenZip: s.archives.Tool().Available()}, nil
	})
}

// archiveError maps archive failures to the protocol; details.reason lets
// the commander say why an archive can't be opened.
func archiveError(err error) error {
	reasoned := func(code rpc.ErrorCode, reason, msg string) error {
		e := rpc.NewError(code, msg)
		e.Details = map[string]string{"reason": reason}
		return e
	}
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return err
	case errors.Is(err, archive.ErrNotArchive):
		return reasoned(rpc.CodeUnsupportedMedia, "notArchive", "This file is not an archive FastView can open.")
	case errors.Is(err, archive.ErrNoTool):
		return reasoned(rpc.CodeUnsupportedMedia, "noTool", "This archive needs 7-Zip, which was not found. Install 7-Zip to open it.")
	case errors.Is(err, archive.ErrEncrypted):
		return reasoned(rpc.CodeCorruptMedia, "encrypted", "The archive is protected by a password; FastView can't open it.")
	case errors.Is(err, archive.ErrCorrupt):
		return reasoned(rpc.CodeCorruptMedia, "corrupt", "The archive is damaged and can't be read.")
	case errors.Is(err, archive.ErrTooLarge):
		return reasoned(rpc.CodeInvalidArgument, "tooLarge", err.Error())
	case errors.Is(err, archive.ErrChanged):
		return reasoned(rpc.CodeNotFound, "changed", "The archive changed since it was opened; open it again.")
	case errors.Is(err, archive.ErrUnknown):
		return rpc.NewError(rpc.CodeNotFound, "the archive is no longer open")
	}
	return statError(err, "archive")
}

// archiveOpen lists an archive file (an index entry) for browsing.
func (s *indexService) archiveOpen(ctx context.Context, p entryParams) (archiveOpenResult, error) {
	paths, err := s.store.EntryPaths(ctx, []int64{p.EntryID})
	if err != nil {
		return archiveOpenResult{}, dbError(err)
	}
	if len(paths) == 0 || paths[0].Kind == media.KindDir {
		return archiveOpenResult{}, rpc.NewError(rpc.CodeNotFound, "not a file in the index")
	}
	start := time.Now()
	a, err := s.archives.OpenFile(ctx, p.EntryID, paths[0].Path, true)
	if err != nil {
		return archiveOpenResult{}, archiveError(err)
	}
	l := a.Listing
	s.log.Info("archive opened", "archiveId", a.ID, "format", l.Format, "entries", l.Len(), "rejected", l.Rejected,
		"ms", time.Since(start).Milliseconds())
	return archiveOpenResult{ArchiveID: a.ID, Format: string(l.Format), Entries: l.Len(), Rejected: l.Rejected,
		Bytes: l.Bytes, PackedBytes: l.Packed}, nil
}

// openArchiveQuery serves query.open for a folder of an open archive.
func (s *indexService) openArchiveQuery(ctx context.Context, archiveID, dirID int64, d index.Descriptor) (query.Snapshot, error) {
	src, err := s.archives.Source(archiveID, dirID)
	if err != nil {
		return query.Snapshot{}, archiveError(err)
	}
	snap, err := s.queries.OpenSource(ctx, d, src)
	if err != nil {
		return snap, dbError(err)
	}
	s.archives.Attach(snap.QueryID, src)
	return snap, nil
}

// archiveCheck sizes an extraction before it starts: the expanded size, the
// free space, and the warnings of ADR-0030 (too little space, zip bomb).
func (s *indexService) archiveCheck(ctx context.Context, p archiveCheckParams) (archiveCheckResult, error) {
	dest, err := s.dirPath(ctx, p.DestinationDirID)
	if err != nil {
		return archiveCheckResult{}, err
	}
	ids, err := s.resolveSelection(p.Selection)
	if err != nil {
		return archiveCheckResult{}, err
	}
	res := archiveCheckResult{FreeBytes: -1}
	if len(ids) > 0 && archive.IsID(ids[0]) {
		sel, err := s.archives.Select(ids)
		if err != nil {
			return res, archiveError(err)
		}
		l := sel.Archive.Listing
		res.Files, res.Bytes = sel.Files, sel.Bytes
		// The packed share of a selection is not known per entry; scale.
		if l.Bytes > 0 {
			res.PackedBytes = int64(float64(l.Packed) * float64(sel.Bytes) / float64(l.Bytes))
		}
	} else {
		paths, err := s.store.EntryPaths(ctx, ids[:min(len(ids), MaxCheckArchives)])
		if err != nil {
			return res, dbError(err)
		}
		res.Partial = len(ids) > MaxCheckArchives
		for _, e := range paths {
			if e.Kind == media.KindDir {
				continue
			}
			a, err := s.archives.OpenFile(ctx, e.ID, e.Path, false)
			if err != nil {
				if ctx.Err() != nil {
					return res, ctx.Err()
				}
				continue // the job reports it
			}
			res.Bytes += a.Listing.Bytes
			res.PackedBytes += a.Listing.Packed
			for i := range a.Listing.Len() {
				if a.Listing.Entry(i).Kind == archive.KindFile {
					res.Files++
				}
			}
		}
	}
	if free, ok := fsx.FreeSpace(dest); ok {
		res.FreeBytes = free
	}
	res.Warnings = archive.Warnings(res.Bytes, res.PackedBytes, res.FreeBytes)
	return res, nil
}

// archiveJob fills the archive fields of a jobs.start request.
func (s *indexService) archiveJob(p jobStartParams, spec *jobs.Spec, ids []int64) error {
	inArchive := len(ids) > 0 && archive.IsID(ids[0])
	for _, id := range ids {
		if archive.IsID(id) != inArchive {
			return rpc.NewError(rpc.CodeInvalidArgument, "archive entries and files can't be mixed")
		}
	}
	switch spec.Kind {
	case jobs.KindExtract:
		spec.Archive.Links, spec.Archive.Subfolders = p.Links, p.Subfolders
		if inArchive {
			sel, err := s.archives.Select(ids)
			if err != nil {
				return archiveError(err)
			}
			spec.Archive.Selection, spec.IDs = sel, nil
		}
	case jobs.KindPack:
		if inArchive {
			return rpc.NewError(rpc.CodeInvalidArgument, "entries inside an archive can't be packed; copy them out first")
		}
		spec.Archive.Name, spec.Archive.Format = p.Name, archive.Format(p.Format)
		spec.Archive.Level, spec.Archive.DeleteOriginals = p.Level, p.DeleteOriginals
		spec.Name = ""
		if spec.Archive.Format == archive.Format7z && !s.archives.Tool().Available() {
			return archiveError(archive.ErrNoTool)
		}
	case jobs.KindTestArchive:
		if inArchive {
			return rpc.NewError(rpc.CodeInvalidArgument, "test the archive itself, not its entries")
		}
	default:
		if inArchive {
			// Archives are read-only (ADR-0030): copying out is an extract job.
			return rpc.NewError(rpc.CodeInvalidArgument, "archives are read-only; copy entries out with an extract job")
		}
	}
	return nil
}

// viewArchiveEntry extracts an archive entry for viewing (file.resolve,
// media.resolve, entry.path).
func (s *indexService) viewArchiveEntry(ctx context.Context, id int64) (string, archive.Entry, error) {
	p, e, err := s.archives.View(ctx, id)
	if err != nil {
		if errors.Is(err, archive.ErrNotArchive) {
			return "", e, rpc.NewError(rpc.CodeInvalidArgument, err.Error()[len(archive.ErrNotArchive.Error())+2:])
		}
		return "", e, archiveError(err)
	}
	return p, e, nil
}

// archiveFileResolve is file.resolve for an archive entry.
func (s *indexService) archiveFileResolve(ctx context.Context, id int64) (fileResolveResult, error) {
	p, e, err := s.viewArchiveEntry(ctx, id)
	if err != nil {
		return fileResolveResult{}, err
	}
	kind, mime := media.KindFile, "application/octet-stream"
	if k, ext, ok := media.Classify(e.Name); ok {
		kind = k
		if m, ok := mimeByExt[ext]; ok {
			mime = m
		}
	}
	fi, err := os.Stat(p)
	if err != nil {
		return fileResolveResult{}, statError(err, "file")
	}
	return fileResolveResult{Path: p, Kind: kind.String(), Mime: mime, SizeBytes: fi.Size()}, nil
}

// archiveProps is props.get for an archive entry: what the listing knows.
func (s *indexService) archiveProps(id int64) (propsResult, error) {
	a, i, err := s.archives.Lookup(id)
	if err != nil {
		return propsResult{}, archiveError(err)
	}
	it, _ := a.Item(id)
	e := a.Listing.Entry(i)
	res := propsResult{ID: id, Kind: it.Kind.String(), Name: e.Name, Ext: it.Ext,
		Path: filepath.Join(a.Listing.Path, filepath.FromSlash(e.Path)), Exists: true,
		SizeBytes: e.Size, ModifiedMs: e.MtimeNs / int64(time.Millisecond), Tags: []string{}}
	if e.Kind == archive.KindDir {
		folders, files := 0, 0
		for _, c := range a.Listing.Children(i) {
			if a.Listing.Entry(int(c)).Kind == archive.KindDir {
				folders++
			} else {
				files++
			}
		}
		res.ChildFolders, res.ChildMedia = &folders, &files
	}
	return res, nil
}

// archiveSummary is selection.info for archive entries.
func (s *indexService) archiveSummary(ids []int64) (index.Summary, error) {
	var sum index.Summary
	for _, id := range ids {
		a, i, err := s.archives.Lookup(id)
		if err != nil {
			return sum, archiveError(err)
		}
		it, _ := a.Item(id)
		sum.Count++
		switch it.Kind {
		case media.KindDir:
			sum.Dirs++
			sum.Bytes += a.Listing.Entry(i).Size
		case media.KindImage:
			sum.Images++
		case media.KindVideo:
			sum.Videos++
		}
		if it.Kind != media.KindDir {
			sum.Bytes += it.Size
		}
	}
	return sum, nil
}

func archiveOnly(ids []int64) bool {
	return len(ids) > 0 && archive.IsID(ids[0])
}
