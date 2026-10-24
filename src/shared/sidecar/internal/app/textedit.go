package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"panelyth/sidecar/internal/archive"
	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/remote"
	"panelyth/sidecar/internal/rpc"
	"panelyth/sidecar/internal/textedit"
)

// The text editor's methods (Stage C10.6, ADR-0046), called by Electron main
// only: main opens a session for the editor window from an entry id the
// commander sent, binds it to that window, adds it to the window's calls
// and closes it with the window. The path goes to main (the read token);
// the window never sees it. Wire types mirror
// src/shared/contracts/src/textedit.ts.

type (
	textEditOpenParams struct {
		EntryID int64 `json:"entryId"`
	}
	textEditOpenResult struct {
		SessionID string `json:"sessionId"`
		Name      string `json:"name"`
		Path      string `json:"path"`
		textedit.State
		Encoding   string `json:"encoding"`
		BOM        int    `json:"bom"`
		LineEnding string `json:"lineEnding"`
	}
	textEditWriteParams struct {
		SessionID string `json:"sessionId"`
		Seq       int    `json:"seq"`
		// Text stays raw JSON: halves of a surrogate pair cut by the chunk
		// boundary are joined by textedit (see its chunk.go).
		Text json.RawMessage `json:"text"`
	}
	textEditCommitParams struct {
		SessionID   string `json:"sessionId"`
		BaseVersion string `json:"baseVersion"`
		Force       bool   `json:"force"`
		AsUTF8      bool   `json:"asUtf8"`
	}
	textEditSessionParams struct {
		SessionID string `json:"sessionId"`
	}
	textEditSaved struct {
		Status   string `json:"status"`
		Encoding string `json:"encoding"`
		textedit.State
	}
	textEditConflict struct {
		Status string `json:"status"`
		Gone   bool   `json:"gone"`
	}
	textEditUnencodable struct {
		Status string `json:"status"`
		Line   int    `json:"line"`
	}
	textEditCheckResult struct {
		Disk *textedit.State `json:"disk"`
	}
	// Stage C10.7: pictures in a document.
	textEditAssetChunkParams struct {
		SessionID string `json:"sessionId"`
		Seq       int    `json:"seq"`
		Data      string `json:"data"`
	}
	textEditAssetCommitParams struct {
		SessionID string `json:"sessionId"`
		Name      string `json:"name"`
		Folder    string `json:"folder"`
	}
	textEditAssetCommitResult struct {
		Link   string `json:"link"`
		Reused bool   `json:"reused"`
	}
	textEditResolveImagesParams struct {
		SessionID string   `json:"sessionId"`
		Links     []string `json:"links"`
	}
	textEditResolvedImage struct {
		Link string  `json:"link"`
		Path *string `json:"path"`
		Type *string `json:"type"`
	}
	textEditResolveImagesResult struct {
		Images []textEditResolvedImage `json:"images"`
	}
)

func (s *indexService) registerTextEdit(srv *rpc.Server) {
	rpc.Register(srv, "textedit.open", s.textEditOpen)
	rpc.Register(srv, "textedit.write", s.textEditWrite)
	rpc.Register(srv, "textedit.commit", s.textEditCommit)
	rpc.Register(srv, "textedit.check", s.textEditCheck)
	rpc.Register(srv, "textedit.close", s.textEditClose)
	rpc.Register(srv, "textedit.assetChunk", s.textEditAssetChunk)
	rpc.Register(srv, "textedit.assetCommit", s.textEditAssetCommit)
	rpc.Register(srv, "textedit.resolveImages", s.textEditResolveImages)
}

func (s *indexService) textEditWrite(_ context.Context, p textEditWriteParams) (okResult, error) {
	if p.Seq < 0 {
		return okResult{}, rpc.NewError(rpc.CodeInvalidArgument, "seq must not be negative")
	}
	if err := s.textedits.Write(p.SessionID, p.Seq, p.Text); err != nil {
		return okResult{}, textEditError(err)
	}
	return okResult{OK: true}, nil
}

func (s *indexService) textEditCheck(ctx context.Context, p textEditSessionParams) (textEditCheckResult, error) {
	disk, err := s.textedits.Check(ctx, p.SessionID)
	if err != nil {
		return textEditCheckResult{}, textEditError(err)
	}
	return textEditCheckResult{Disk: disk}, nil
}

// textEditClose is idempotent: an unknown or closed session is ok.
func (s *indexService) textEditClose(_ context.Context, p textEditSessionParams) (okResult, error) {
	s.textedits.Close(p.SessionID)
	return okResult{OK: true}, nil
}

// refused is an INVALID_ARGUMENT whose details.reason is a TextEditRefusal
// (main opens the lister instead, or says why).
func refused(reason, msg string) error {
	e := rpc.NewError(rpc.CodeInvalidArgument, msg)
	e.Details = map[string]string{"reason": reason}
	return e
}

// textEditOpen resolves an entry as file.resolve does, but only a local
// file: one inside an archive or on a server has no file of its own to
// write back to here (C10.9 adds servers).
func (s *indexService) textEditOpen(ctx context.Context, p textEditOpenParams) (textEditOpenResult, error) {
	if archive.IsID(p.EntryID) || remote.IsID(p.EntryID) {
		return textEditOpenResult{}, refused("notLocal", "only a file on this computer can be edited")
	}
	paths, err := s.store.EntryPaths(ctx, []int64{p.EntryID})
	if err != nil {
		return textEditOpenResult{}, dbError(err)
	}
	if len(paths) == 0 || paths[0].Path == "" {
		return textEditOpenResult{}, rpc.NewError(rpc.CodeNotFound, "not in the index")
	}
	if paths[0].Kind == media.KindDir {
		return textEditOpenResult{}, refused("folder", "a folder cannot be edited")
	}
	info, err := s.textedits.Open(ctx, paths[0].Path)
	if err != nil {
		return textEditOpenResult{}, textEditError(err)
	}
	return textEditOpenResult{SessionID: info.SessionID, Name: info.Name, Path: info.Path, State: info.State,
		Encoding: info.Encoding, BOM: info.BOM, LineEnding: info.LineEnding}, nil
}

func (s *indexService) textEditCommit(ctx context.Context, p textEditCommitParams) (any, error) {
	out, err := s.textedits.Commit(ctx, p.SessionID, p.BaseVersion, p.Force, p.AsUTF8)
	if err != nil {
		return nil, textEditSaveError(err)
	}
	switch out.Status {
	case textedit.StatusConflict:
		return textEditConflict{Status: out.Status, Gone: out.Gone}, nil
	case textedit.StatusUnencodable:
		return textEditUnencodable{Status: out.Status, Line: out.Line}, nil
	}
	return textEditSaved{Status: out.Status, Encoding: out.Encoding, State: out.State}, nil
}

// textEditError maps the editor's failures to the protocol. Refusals to
// open carry details.reason (TextEditRefusal).
func textEditError(err error) error {
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return err
	case errors.Is(err, textedit.ErrGone):
		return rpc.NewError(rpc.CodeTextEditSessionGone, "the editing session is closed")
	case errors.Is(err, textedit.ErrFolder):
		return refused("folder", "a folder cannot be edited")
	case errors.Is(err, textedit.ErrTooLarge):
		return refused("tooLarge", "the file is too large for the editor")
	case errors.Is(err, textedit.ErrBinary):
		return refused("binary", "the file is not text")
	case errors.Is(err, textedit.ErrNotRegular):
		return rpc.NewError(rpc.CodeInvalidArgument, "not a regular file")
	case errors.Is(err, textedit.ErrChunk):
		return rpc.NewError(rpc.CodeInvalidArgument, strings.TrimPrefix(err.Error(), textedit.ErrChunk.Error()+": "))
	case errors.Is(err, textedit.ErrBusy):
		return rpc.NewError(rpc.CodeBusy, err.Error())
	case errors.Is(err, textedit.ErrLinkBroken):
		return rpc.NewError(rpc.CodeNotFound, "the link's target no longer exists")
	case errors.Is(err, textedit.ErrNotImage):
		return refused("notImage", "only a PNG, JPEG, GIF, WebP, BMP or AVIF picture can be added")
	case errors.Is(err, textedit.ErrAssetFolder):
		return refused("folder", strings.TrimPrefix(err.Error(), textedit.ErrAssetFolder.Error()+": "))
	case errors.Is(err, textedit.ErrTooManyLinks):
		return rpc.NewError(rpc.CodeInvalidArgument, strings.TrimPrefix(err.Error(), textedit.ErrTooManyLinks.Error()+": "))
	}
	return statError(err, "file")
}

// textEditSaveError maps a failed save: the fileops item code (IN_USE,
// NO_SPACE, PERMISSION_DENIED…) is its details.reason.
func textEditSaveError(err error) error {
	for _, own := range []error{context.Canceled, context.DeadlineExceeded, textedit.ErrGone, textedit.ErrFolder,
		textedit.ErrNotRegular, textedit.ErrChunk, textedit.ErrBusy, textedit.ErrLinkBroken, textedit.ErrNotImage,
		textedit.ErrAssetFolder, textedit.ErrTooManyLinks} {
		if errors.Is(err, own) {
			return textEditError(err)
		}
	}
	var e *rpc.Error
	switch code := fileops.Code(err); code {
	case fileops.CodeNotFound:
		e = rpc.NewError(rpc.CodeNotFound, "the file or its folder no longer exists")
	case fileops.CodePermission:
		e = rpc.NewError(rpc.CodePermissionDenied, "no permission to write this file")
	case fileops.CodeInUse:
		e = rpc.NewError(rpc.CodeBusy, "the file is in use by another program")
	case fileops.CodeNoSpace:
		e = rpc.NewError(rpc.CodeInternal, "the disk is full")
	default:
		e = rpc.NewError(rpc.CodeInternal, err.Error())
	}
	e.Details = map[string]string{"reason": fileops.Code(err)}
	return e
}

func (s *indexService) textEditAssetChunk(_ context.Context, p textEditAssetChunkParams) (okResult, error) {
	if p.Seq < 0 {
		return okResult{}, rpc.NewError(rpc.CodeInvalidArgument, "seq must not be negative")
	}
	if err := s.textedits.AssetChunk(p.SessionID, p.Seq, p.Data); err != nil {
		return okResult{}, textEditError(err)
	}
	return okResult{OK: true}, nil
}

// textEditAssetCommit writes the staged picture beside the document. A
// failed write maps like a failed save (the fileops code as the reason).
func (s *indexService) textEditAssetCommit(ctx context.Context, p textEditAssetCommitParams) (textEditAssetCommitResult, error) {
	link, reused, err := s.textedits.AssetCommit(ctx, p.SessionID, p.Name, p.Folder)
	if err != nil {
		return textEditAssetCommitResult{}, textEditSaveError(err)
	}
	return textEditAssetCommitResult{Link: link, Reused: reused}, nil
}

func (s *indexService) textEditResolveImages(ctx context.Context, p textEditResolveImagesParams) (textEditResolveImagesResult, error) {
	res, err := s.textedits.ResolveImages(ctx, p.SessionID, p.Links)
	if err != nil {
		return textEditResolveImagesResult{}, textEditError(err)
	}
	out := textEditResolveImagesResult{Images: make([]textEditResolvedImage, len(res))}
	for i, r := range res {
		out.Images[i].Link = r.Link
		if r.Path != "" {
			out.Images[i].Path, out.Images[i].Type = &r.Path, &r.Type
		}
	}
	return out, nil
}
