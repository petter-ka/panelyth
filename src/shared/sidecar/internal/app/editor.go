package app

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"sync"

	"panelyth/sidecar/internal/archive"
	"panelyth/sidecar/internal/editor"
	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/imaging"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/pathkey"
	"panelyth/sidecar/internal/rpc"
)

// The image editor's methods (Stage 12, ADR-0035), viewer profile only
// (ADR-0027). The renderer names a picture by entry id and a session by its
// id; frames and saved files are named by paths only towards Electron main
// (edit.frame, edit.write, edit.source, edit.savedPath), which turns them into a token
// URL, takes them from a native dialog, or opens the file manager on them.
// Wire types mirror src/shared/contracts/src/rpc.ts.

// Limits of an edit request (checked again in Electron main).
const (
	MaxEditListBytes = 1 << 20
	maxSavedJobs     = 32
)

type (
	editOpenParams struct {
		EntryID int64 `json:"entryId"`
		// Owner is the window, set by Electron main: one session each.
		Owner int64 `json:"owner"`
	}
	editOpenResult struct {
		SessionID string      `json:"sessionId"`
		Name      string      `json:"name"`
		Width     int         `json:"width"`
		Height    int         `json:"height"`
		Format    string      `json:"format"`
		HasAlpha  bool        `json:"hasAlpha"`
		DPI       imaging.DPI `json:"dpi"`
		// Notice is "bitDepth" for a source with more than 8 bits per channel.
		Notice string `json:"notice,omitempty"`
		// SaveFormat is the format a save defaults to: the source's own, or
		// PNG for one the editor cannot write (WebP).
		SaveFormat string `json:"saveFormat"`
		// CanReplace: the original can be replaced (its format can be
		// written and its drive has a trash).
		CanReplace bool `json:"canReplace"`
	}
	editViewWire struct {
		MaxEdge int `json:"maxEdge"`
	}
	editFrameParams struct {
		SessionID string           `json:"sessionId"`
		Rev       int64            `json:"rev"`
		EditList  imaging.EditList `json:"editList"`
		View      editViewWire     `json:"view"`
		Quality   string           `json:"quality"`
		Histogram bool             `json:"histogram"`
		// HistogramAt asks for the histogram of the picture after that many
		// active operations: what the tool at that place is given.
		HistogramAt *int `json:"histogramAt"`
	}
	// editFrame names the frame file for Electron main, which answers the
	// renderer with a token URL instead.
	editFrame struct {
		File   string `json:"file"`
		Mime   string `json:"mime"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	}
	editOutput struct {
		Width  int         `json:"width"`
		Height int         `json:"height"`
		DPI    imaging.DPI `json:"dpi"`
	}
	editFrameResult struct {
		Rev        int64          `json:"rev"`
		Superseded bool           `json:"superseded,omitempty"`
		Frame      *editFrame     `json:"frame,omitempty"`
		Output     *editOutput    `json:"output,omitempty"`
		Histogram  *imaging.Stats `json:"histogram,omitempty"`
		Before     *imaging.Stats `json:"before,omitempty"`
	}
	editSessionParams struct {
		SessionID string `json:"sessionId"`
	}
	editInfoResult struct {
		Groups []imaging.InfoGroup `json:"groups"`
	}
	editEstimateParams struct {
		SessionID string           `json:"sessionId"`
		EditList  imaging.EditList `json:"editList"`
		Format    string           `json:"format"`
		Quality   int              `json:"quality"`
		Metadata  string           `json:"metadata"`
	}
	editEstimateResult struct {
		Bytes int64 `json:"bytes"`
	}
	editWriteParams struct {
		SessionID string           `json:"sessionId"`
		EditList  imaging.EditList `json:"editList"`
		// Target: "copy", "replace" or "as" (Path then comes from the save
		// dialog in Electron main, never from a renderer).
		Target   string  `json:"target"`
		Path     string  `json:"path"`
		Format   string  `json:"format"`
		Quality  int     `json:"quality"`
		Metadata string  `json:"metadata"`
		DPI      float64 `json:"dpi"`
		// App is the app that saves (Electron main): the job is listed there.
		App string `json:"app"`
	}
	editWriteResult struct {
		JobID int64 `json:"jobId"`
		// Name is the file being written, for messages.
		Name string `json:"name"`
	}
	editJobParams struct {
		JobID int64 `json:"jobId"`
	}
	editSavedResult struct {
		// EntryID is the saved file's entry once it is indexed, else 0.
		EntryID int64  `json:"entryId"`
		Name    string `json:"name"`
	}
	// Electron main only.
	editSavedPathResult struct {
		Path string `json:"path"`
	}
	// Stage 13: a color under the pointer, preset thumbnails, Count colors.
	editProbeParams struct {
		SessionID string           `json:"sessionId"`
		EditList  imaging.EditList `json:"editList"`
		View      editViewWire     `json:"view"`
		X         float64          `json:"x"`
		Y         float64          `json:"y"`
		Radius    int              `json:"radius"`
	}
	editProbeResult struct {
		// RGBA is the straight color; Hex its "#rrggbb".
		RGBA [4]int `json:"rgba"`
		Hex  string `json:"hex"`
	}
	editThumbsParams struct {
		SessionID string             `json:"sessionId"`
		EditLists []imaging.EditList `json:"editLists"`
		Edge      int                `json:"edge"`
	}
	// editThumb names a thumbnail file for Electron main (null for a list
	// that could not be rendered).
	editThumb struct {
		File   string `json:"file"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	}
	editThumbsResult struct {
		Thumbs []*editThumb `json:"thumbs"`
	}
	editColorsParams struct {
		SessionID string           `json:"sessionId"`
		EditList  imaging.EditList `json:"editList"`
		Scope     string           `json:"scope"`
		MaxColors int              `json:"maxColors"`
	}
	editColorsResult struct {
		Distinct int              `json:"distinct"`
		Palette  []imaging.Swatch `json:"palette"`
		HasAlpha bool             `json:"hasAlpha"`
		Width    int              `json:"width"`
		Height   int              `json:"height"`
	}
	// Stage 14: assets (Electron main only: the path is from its dialog) and fonts.
	editAssetAddParams struct {
		SessionID string `json:"sessionId"`
		Path      string `json:"path"`
	}
	editAssetResult struct {
		AssetID string    `json:"assetId"`
		Name    string    `json:"name"`
		Width   int       `json:"width"`
		Height  int       `json:"height"`
		Thumb   editThumb `json:"thumb"`
	}
	editAssetDropParams struct {
		SessionID string `json:"sessionId"`
		AssetID   string `json:"assetId"`
	}
	editFontsResult struct {
		// Families are names only: the built-in ones first.
		Families []string `json:"families"`
	}
	// Stage 15: red pupils found in the picture.
	editEyesParams struct {
		SessionID string           `json:"sessionId"`
		EditList  imaging.EditList `json:"editList"`
	}
	editEyesResult struct {
		// Eyes are rects, 0..1 of the picture, one per pupil.
		Eyes []imaging.Rect `json:"eyes"`
	}
)

// editSaves remembers where recent saves wrote, by job id.
type editSaves struct {
	mu    sync.Mutex
	paths map[int64]string
	order []int64
}

func (e *editSaves) put(jobID int64, path string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.paths == nil {
		e.paths = map[int64]string{}
	}
	e.paths[jobID] = path
	e.order = append(e.order, jobID)
	for len(e.order) > maxSavedJobs {
		delete(e.paths, e.order[0])
		e.order = e.order[1:]
	}
}

func (e *editSaves) get(jobID int64) (string, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	p, ok := e.paths[jobID]
	return p, ok
}

func (s *indexService) registerEditor(srv *rpc.Server) {
	rpc.Register(srv, "edit.open", s.editOpen)
	rpc.Register(srv, "edit.frame", s.editRender)
	rpc.Register(srv, "edit.info", func(_ context.Context, p editSessionParams) (editInfoResult, error) {
		sess, err := s.editor.Get(p.SessionID)
		if err != nil {
			return editInfoResult{}, editError(err)
		}
		groups := sess.Info()
		if groups == nil {
			groups = []imaging.InfoGroup{}
		}
		return editInfoResult{Groups: groups}, nil
	})
	rpc.Register(srv, "edit.estimate", func(ctx context.Context, p editEstimateParams) (editEstimateResult, error) {
		sess, err := s.editor.Get(p.SessionID)
		if err != nil {
			return editEstimateResult{}, editError(err)
		}
		if !validPolicy(p.Metadata) {
			return editEstimateResult{}, rpc.NewError(rpc.CodeInvalidArgument, "unknown metadata policy")
		}
		n, err := sess.Estimate(ctx, p.EditList, p.Format, p.Quality, p.Metadata)
		if err != nil {
			return editEstimateResult{}, editError(err)
		}
		return editEstimateResult{Bytes: n}, nil
	})
	rpc.Register(srv, "edit.write", s.editWrite)
	rpc.Register(srv, "edit.close", func(_ context.Context, p editSessionParams) (okResult, error) {
		return okResult{OK: s.editor.Close(p.SessionID)}, nil
	})
	rpc.Register(srv, "edit.saved", func(ctx context.Context, p editJobParams) (editSavedResult, error) {
		path, ok := s.saves.get(p.JobID)
		if !ok {
			// A batch (Stage 16): its first result.
			path, ok = s.batchFirst(p.JobID)
		}
		if !ok {
			return editSavedResult{}, rpc.NewError(rpc.CodeNotFound, "not a recent save")
		}
		dir, name := filepath.Split(path)
		key := pathkey.ChildKey(pathkey.DirKey(filepath.Clean(dir)), name, false)
		id, err := s.store.IDByKey(ctx, key)
		if err != nil {
			return editSavedResult{}, dbError(err)
		}
		return editSavedResult{EntryID: id, Name: name}, nil
	})
	rpc.Register(srv, "edit.probe", func(ctx context.Context, p editProbeParams) (editProbeResult, error) {
		sess, err := s.editor.Get(p.SessionID)
		if err != nil {
			return editProbeResult{}, editError(err)
		}
		if !(p.X >= 0 && p.X <= 1 && p.Y >= 0 && p.Y <= 1) {
			return editProbeResult{}, rpc.NewError(rpc.CodeInvalidArgument, "the point is 0..1 of the picture")
		}
		c, err := sess.Probe(ctx, p.EditList, p.View.MaxEdge, p.X, p.Y, p.Radius)
		if err != nil {
			return editProbeResult{}, editError(err)
		}
		return editProbeResult{RGBA: [4]int{int(c[0]), int(c[1]), int(c[2]), int(c[3])},
			Hex: fmt.Sprintf("#%02x%02x%02x", c[0], c[1], c[2])}, nil
	})
	rpc.Register(srv, "edit.thumbFrames", func(ctx context.Context, p editThumbsParams) (editThumbsResult, error) {
		sess, err := s.editor.Get(p.SessionID)
		if err != nil {
			return editThumbsResult{}, editError(err)
		}
		thumbs, err := sess.Thumbs(ctx, p.EditLists, p.Edge)
		if err != nil {
			return editThumbsResult{}, editError(err)
		}
		out := make([]*editThumb, len(thumbs))
		for i, t := range thumbs {
			if t.File != "" {
				out[i] = &editThumb{File: t.File, Width: t.Width, Height: t.Height}
			}
		}
		return editThumbsResult{Thumbs: out}, nil
	})
	rpc.Register(srv, "edit.colors", func(ctx context.Context, p editColorsParams) (editColorsResult, error) {
		sess, err := s.editor.Get(p.SessionID)
		if err != nil {
			return editColorsResult{}, editError(err)
		}
		switch p.Scope {
		case editor.ScopePreview, editor.ScopeEdited, editor.ScopeOriginal:
		default:
			return editColorsResult{}, rpc.NewError(rpc.CodeInvalidArgument, `scope is "preview", "edited" or "original"`)
		}
		if p.MaxColors == 0 {
			p.MaxColors = 16
		}
		c, err := sess.CountColors(ctx, p.EditList, p.Scope, p.MaxColors)
		switch {
		case errors.Is(err, editor.ErrChanged):
			return editColorsResult{}, rpc.NewError(rpc.CodeNotFound, "the file changed since it was opened")
		case err != nil:
			return editColorsResult{}, editError(err)
		}
		return editColorsResult{Distinct: c.Distinct, Palette: c.Palette, HasAlpha: c.HasAlpha, Width: c.Width, Height: c.Height}, nil
	})
	rpc.Register(srv, "edit.assetAdd", func(ctx context.Context, p editAssetAddParams) (editAssetResult, error) {
		// An asset is picked for a picture that is being edited.
		if _, err := s.editor.Get(p.SessionID); err != nil {
			return editAssetResult{}, editError(err)
		}
		clean, err := pathkey.Clean(p.Path)
		if err != nil {
			return editAssetResult{}, rpc.NewError(rpc.CodeInvalidPath, "the picture must be named by an absolute path")
		}
		asset, thumb, err := s.editor.AddAsset(ctx, clean)
		if err != nil {
			return editAssetResult{}, editError(err)
		}
		return editAssetResult{AssetID: asset.ID, Name: asset.Name, Width: asset.Width, Height: asset.Height,
			Thumb: editThumb{File: thumb.File, Width: thumb.Width, Height: thumb.Height}}, nil
	})
	rpc.Register(srv, "edit.assetDrop", func(_ context.Context, p editAssetDropParams) (okResult, error) {
		if _, err := s.editor.Get(p.SessionID); err != nil {
			return okResult{}, editError(err)
		}
		s.editor.DropAsset(p.AssetID)
		return okResult{OK: true}, nil
	})
	rpc.Register(srv, "edit.fonts", func(ctx context.Context, p editSessionParams) (editFontsResult, error) {
		if _, err := s.editor.Get(p.SessionID); err != nil {
			return editFontsResult{}, editError(err)
		}
		return editFontsResult{Families: s.editor.Fonts(ctx)}, nil
	})
	rpc.Register(srv, "edit.eyes", func(ctx context.Context, p editEyesParams) (editEyesResult, error) {
		sess, err := s.editor.Get(p.SessionID)
		if err != nil {
			return editEyesResult{}, editError(err)
		}
		eyes, err := sess.Eyes(ctx, p.EditList)
		if err != nil {
			return editEyesResult{}, editError(err)
		}
		if eyes == nil {
			eyes = []imaging.Rect{}
		}
		return editEyesResult{Eyes: eyes}, nil
	})
	rpc.Register(srv, "edit.source", func(_ context.Context, p editSessionParams) (editSavedPathResult, error) {
		sess, err := s.editor.Get(p.SessionID)
		if err != nil {
			return editSavedPathResult{}, editError(err)
		}
		return editSavedPathResult{Path: sess.Source.Path}, nil
	})
	rpc.Register(srv, "edit.savedPath", func(_ context.Context, p editJobParams) (editSavedPathResult, error) {
		path, ok := s.saves.get(p.JobID)
		if !ok {
			path, ok = s.batchFirst(p.JobID)
		}
		if !ok {
			return editSavedPathResult{}, rpc.NewError(rpc.CodeNotFound, "not a recent save")
		}
		return editSavedPathResult{Path: path}, nil
	})
}

func validPolicy(p string) bool {
	return p == imaging.MetaKeep || p == imaging.MetaStrip || p == imaging.MetaStripGPS
}

// editError maps the editor's errors onto the envelope.
func editError(err error) error {
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return err
	case errors.Is(err, editor.ErrGone):
		return rpc.NewError(rpc.CodeEditSessionGone, "the editing session has ended; open the picture again")
	case errors.Is(err, editor.ErrAsset):
		return rpc.NewError(rpc.CodeEditAssetInvalid, strings.TrimPrefix(err.Error(), editor.ErrAsset.Error()+": "))
	case errors.Is(err, editor.ErrTooLarge), errors.Is(err, imaging.ErrTooLarge):
		return rpc.NewError(rpc.CodeEditTooLarge, "the picture is too large to edit")
	case errors.Is(err, editor.ErrUnsupported), errors.Is(err, imaging.ErrUnsupported):
		return rpc.NewError(rpc.CodeEditUnsupported, "this kind of picture can't be edited")
	case errors.Is(err, imaging.ErrInvalidEdit):
		return rpc.NewError(rpc.CodeInvalidArgument, err.Error())
	case errors.Is(err, imaging.ErrCorrupt):
		return rpc.NewError(rpc.CodeCorruptMedia, "image cannot be read")
	case errors.Is(err, fs.ErrNotExist):
		return rpc.NewError(rpc.CodeNotFound, "file no longer exists")
	case errors.Is(err, fs.ErrPermission):
		return rpc.NewError(rpc.CodePermissionDenied, "no permission to read this file")
	}
	return rpc.NewError(rpc.CodeInternal, strings.TrimSpace(err.Error()))
}

func (s *indexService) editOpen(ctx context.Context, p editOpenParams) (editOpenResult, error) {
	if archive.IsID(p.EntryID) {
		return editOpenResult{}, rpc.NewError(rpc.CodeEditUnsupported, "a picture inside an archive can't be edited; copy it out first")
	}
	srcs, err := s.store.Sources(ctx, []int64{p.EntryID})
	if err != nil {
		return editOpenResult{}, dbError(err)
	}
	src, ok := srcs[p.EntryID]
	if !ok {
		return editOpenResult{}, rpc.NewError(rpc.CodeNotFound, "not an indexed picture")
	}
	if src.Kind != media.KindImage {
		return editOpenResult{}, rpc.NewError(rpc.CodeEditUnsupported, "only pictures can be edited")
	}
	sess, err := s.editor.Open(ctx, p.Owner, editor.Source{EntryID: p.EntryID, Path: src.Path, Ext: src.Ext})
	if err != nil {
		return editOpenResult{}, editError(err)
	}
	res := editOpenResult{SessionID: sess.ID, Name: filepath.Base(src.Path), Width: sess.Width, Height: sess.Height,
		Format: sess.Format, HasAlpha: sess.HasAlpha, DPI: sess.Meta.DPI, Notice: sess.Notice,
		SaveFormat: imaging.FormatOf(sess.Format)}
	res.CanReplace = res.SaveFormat != "" && fileops.CanTrash(filepath.Dir(src.Path))
	if res.SaveFormat == "" {
		res.SaveFormat = "png"
	}
	return res, nil
}

func (s *indexService) editRender(ctx context.Context, p editFrameParams) (editFrameResult, error) {
	if p.Quality != "draft" && p.Quality != "final" {
		return editFrameResult{}, rpc.NewError(rpc.CodeInvalidArgument, `quality is "draft" or "final"`)
	}
	sess, err := s.editor.Get(p.SessionID)
	if err != nil {
		return editFrameResult{}, editError(err)
	}
	req := editor.RenderRequest{Rev: p.Rev, Edits: p.EditList, MaxEdge: p.View.MaxEdge,
		Draft: p.Quality == "draft", Histogram: p.Histogram}
	if p.HistogramAt != nil {
		req.Before, req.BeforeAt = true, *p.HistogramAt
	}
	res, err := sess.Render(ctx, req)
	if err != nil {
		return editFrameResult{}, editError(err)
	}
	if res.Superseded {
		return editFrameResult{Rev: res.Rev, Superseded: true}, nil
	}
	return editFrameResult{Rev: res.Rev,
		Frame:     &editFrame{File: res.File, Mime: res.Mime, Width: res.Width, Height: res.Height},
		Output:    &editOutput{Width: res.OutWidth, Height: res.OutHeight, DPI: res.DPI},
		Histogram: res.Stats, Before: res.Before}, nil
}

// formatExts are the file extensions a save format may be written under.
var formatExts = map[string][]string{
	"jpeg": {"jpg", "jpeg", "jpe", "jfif"}, "png": {"png"}, "gif": {"gif"}, "bmp": {"bmp"}, "tiff": {"tif", "tiff"},
}

func extFits(format, name string) bool {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	for _, e := range formatExts[format] {
		if e == ext {
			return true
		}
	}
	return false
}

// editWrite starts the save job. The destination is decided here: beside
// the original for a copy, the original itself for a replace, or the path
// Electron main got from its save dialog.
func (s *indexService) editWrite(ctx context.Context, p editWriteParams) (editWriteResult, error) {
	sess, err := s.editor.Get(p.SessionID)
	if err != nil {
		return editWriteResult{}, editError(err)
	}
	if !validPolicy(p.Metadata) {
		return editWriteResult{}, rpc.NewError(rpc.CodeInvalidArgument, "unknown metadata policy")
	}
	if p.Quality != 0 && (p.Quality < imaging.MinQuality || p.Quality > imaging.MaxQuality) {
		return editWriteResult{}, rpc.NewError(rpc.CodeInvalidArgument, "quality is 1..100")
	}
	if !(p.DPI >= 0 && p.DPI <= 10000) {
		return editWriteResult{}, rpc.NewError(rpc.CodeInvalidArgument, "resolution is 1..10000 dpi")
	}
	src := sess.Source
	req := editor.SaveRequest{Source: src, Size: sess.Size, MtimeNs: sess.MtimeNs, Edits: p.EditList,
		Format: p.Format, Quality: p.Quality, Policy: p.Metadata, DPI: imaging.DPI{X: p.DPI, Y: p.DPI},
		Reserve: s.preview.ReserveDecode, Res: sess.Resources()}
	dir := filepath.Dir(src.Path)
	own := imaging.FormatOf(sess.Format)
	replace := func() error {
		// The original keeps its name, so it keeps its format.
		if own == "" {
			return rpc.NewError(rpc.CodeInvalidArgument, "this format can't be written; save a copy as PNG or JPEG")
		}
		if !fileops.CanTrash(dir) {
			return rpc.NewError(rpc.CodeTrashUnavailable, "this drive has no trash; save a copy instead")
		}
		req.Format, req.Dest, req.Replace = own, src.Path, true
		return nil
	}
	switch p.Target {
	case "copy":
		ext, ok := imaging.SaveFormats[p.Format]
		if !ok {
			return editWriteResult{}, rpc.NewError(rpc.CodeInvalidArgument, "unknown format")
		}
		name, ok := editor.CopyName(dir, src.Path, ext)
		if !ok {
			return editWriteResult{}, rpc.NewError(rpc.CodeInvalidArgument, "no free name for the copy")
		}
		req.Dest = filepath.Join(dir, name)
	case "replace":
		if err := replace(); err != nil {
			return editWriteResult{}, err
		}
	case "as":
		clean, err := pathkey.Clean(p.Path)
		if err != nil {
			return editWriteResult{}, rpc.NewError(rpc.CodeInvalidPath, "the destination must be an absolute path")
		}
		if _, ok := imaging.SaveFormats[p.Format]; !ok || !extFits(p.Format, clean) {
			return editWriteResult{}, rpc.NewError(rpc.CodeInvalidArgument, "the file name does not match the format")
		}
		if err := fileops.ValidateName(filepath.Base(clean)); err != nil {
			return editWriteResult{}, rpc.NewError(rpc.CodeInvalidArgument, err.Error())
		}
		if editor.SamePath(clean, src.Path) {
			// Saving over the original goes the safe way: through the trash.
			if p.Format != own {
				return editWriteResult{}, rpc.NewError(rpc.CodeInvalidArgument, "the original can't be saved over in another format")
			}
			if err := replace(); err != nil {
				return editWriteResult{}, err
			}
		} else {
			// The save dialog asked before naming an existing file.
			req.Dest, req.Overwrite = clean, true
		}
	default:
		return editWriteResult{}, rpc.NewError(rpc.CodeInvalidArgument, `target is "copy", "replace" or "as"`)
	}
	snap, err := s.startJob(jobs.Spec{Kind: jobs.KindEditSave, App: p.App, IDs: []int64{src.EntryID}, Edit: &jobs.EditSpec{Save: req}})
	if err != nil {
		return editWriteResult{}, err
	}
	s.saves.put(snap.JobID, req.Dest)
	return editWriteResult{JobID: snap.JobID, Name: filepath.Base(req.Dest)}, nil
}
