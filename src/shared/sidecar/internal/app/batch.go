package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"panelyth/sidecar/internal/editor"
	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/imaging"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/library"
	"panelyth/sidecar/internal/media"
	"panelyth/sidecar/internal/pathkey"
	"panelyth/sidecar/internal/rpc"
)

// Stage 16 methods (ADR-0036): the plan of a batch edit, the job that runs
// it, its undo and the saved recipes. Wire types mirror
// src/shared/contracts/src/edit.ts. edit.plan and edit.batch are called by
// Electron main only: the destination folder is a path from its dialog.

// Limits of a plan.
const (
	MaxBatchSamples = 12
	planNames       = 5
	estimateSamples = 3
	// planChunk is how many entries one index read of a plan covers.
	planChunk = 5000
)

type (
	editBatchParams struct {
		Source jobSourceWire `json:"source"`
		Recipe editor.Recipe `json:"recipe"`
		// Folder is the destination of a "folder" output (from main).
		Folder string `json:"folder"`
		// App is the app that runs the batch (from main): the job is listed there.
		App string `json:"app"`
	}
	planSkip struct {
		// Reason: folder, video, other, unsupported or notWritable.
		Reason string `json:"reason"`
		Count  int    `json:"count"`
	}
	planSample struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	editPlanResult struct {
		// Count is how many pictures the batch edits.
		Count   int        `json:"count"`
		Skipped []planSkip `json:"skipped"`
		// Names are the files the first pictures become.
		Names []string `json:"names"`
		// Bytes is what the pictures take now; EstimateBytes what the
		// results will, roughly.
		Bytes         int64 `json:"bytes"`
		EstimateBytes int64 `json:"estimateBytes"`
		// Warnings: trashUnavailable, formatChange, alphaLoss.
		Warnings []string         `json:"warnings"`
		Problems []editor.Problem `json:"problems"`
		// Samples are pictures to judge the recipe on: the first, the last
		// and some between.
		Samples []planSample `json:"samples"`
	}
	recipeWire struct {
		// ID is the saved recipe's id; 0 for a built-in one.
		ID int64 `json:"id"`
		// Builtin names a built-in recipe ("" for a saved one).
		Builtin string        `json:"builtin"`
		Name    string        `json:"name"`
		Recipe  editor.Recipe `json:"recipe"`
	}
	recipeListResult struct {
		Recipes []recipeWire `json:"recipes"`
	}
	recipeSaveParams struct {
		ID     int64         `json:"id"`
		Name   string        `json:"name"`
		Recipe editor.Recipe `json:"recipe"`
	}
	recipeSaveResult struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	recipeDeleteParams struct {
		ID int64 `json:"id"`
	}
)

func (s *indexService) registerBatch(srv *rpc.Server) {
	rpc.Register(srv, "edit.plan", s.editPlan)
	rpc.Register(srv, "edit.batch", s.editBatch)
	rpc.Register(srv, "batch.undo", func(_ context.Context, p jobIDParams) (jobs.Snapshot, error) {
		snap, err := s.jobs.UndoEdit(p.JobID)
		switch {
		case errors.Is(err, jobs.ErrUnknownJob):
			return snap, rpc.NewError(rpc.CodeNotFound, "this batch can no longer be undone")
		case errors.Is(err, jobs.ErrBusy):
			return snap, rpc.NewError(rpc.CodeBusy, "too many operations are waiting; try again when some have finished")
		case err != nil:
			return snap, dbError(err)
		}
		return snap, nil
	})
	rpc.Register(srv, "recipe.list", s.recipeList)
	rpc.Register(srv, "recipe.save", s.recipeSave)
	rpc.Register(srv, "recipe.delete", func(ctx context.Context, p recipeDeleteParams) (okResult, error) {
		lib, err := s.library(ctx)
		if err != nil {
			return okResult{}, err
		}
		return okResult{OK: true}, libError(lib.DeleteRecipe(ctx, p.ID))
	})
}

// batchFolder checks the destination folder of a "folder" output.
func batchFolder(r editor.Recipe, folder string) (string, error) {
	if r.Output.Destination != editor.DestFolder {
		return "", nil
	}
	clean, err := pathkey.Clean(folder)
	if err != nil {
		return "", rpc.NewError(rpc.CodeInvalidPath, "choose a folder for the results")
	}
	if fi, err := os.Stat(clean); err != nil || !fi.IsDir() {
		return "", rpc.NewError(rpc.CodeInvalidPath, "the destination folder does not exist")
	}
	return clean, nil
}

// pictureOf sorts an entry into "a picture the editor reads" (with the
// decoder family) or the reason it is skipped.
func pictureOf(kind media.Kind, name string) (decoder, skip string) {
	switch kind {
	case media.KindDir:
		return "", "folder"
	case media.KindVideo:
		return "", "video"
	case media.KindImage:
	default:
		return "", "other"
	}
	dec := planRegistry.For(media.Ext(name))
	if dec == nil {
		return "", "unsupported"
	}
	return dec.Name(), ""
}

var planRegistry = imaging.DefaultRegistry()

// bytesPerPixel is a rough size of a photograph in a format.
func bytesPerPixel(format string, quality int) float64 {
	switch format {
	case "jpeg":
		if quality == 0 {
			quality = imaging.DefaultQuality
		}
		return 0.1 + 0.006*float64(max(quality-50, 0))
	case "png":
		return 2.2
	case "gif":
		return 0.8
	}
	return 3
}

// editPlan describes what a batch would do, without reading pixels: one
// pass over the selection's index rows, and the headers of a few pictures.
func (s *indexService) editPlan(ctx context.Context, p editBatchParams) (editPlanResult, error) {
	res := editPlanResult{Skipped: []planSkip{}, Names: []string{}, Warnings: []string{}, Samples: []planSample{}}
	res.Problems = p.Recipe.Problems(s.editor.HasAsset)
	if res.Problems == nil {
		res.Problems = []editor.Problem{}
	}
	out := p.Recipe.Output
	folder := ""
	if out.Destination == editor.DestFolder && p.Folder != "" {
		// Without a folder yet the plan still counts; Run asks for one.
		var err error
		if folder, err = batchFolder(p.Recipe, p.Folder); err != nil {
			return res, err
		}
	}
	ids, err := s.resolveSelection(p.Source.Selection)
	if err != nil {
		return res, err
	}
	skipped := map[string]int{}
	var pictures, first []int64
	volumes := map[string]bool{}
	noTrash, changed, alpha := false, false, false
	needTrash := func(dir string) {
		v := fsx.VolumeID(dir)
		ok, seen := volumes[v]
		if !seen {
			ok = fileops.CanTrash(dir)
			volumes[v] = ok
		}
		noTrash = noTrash || !ok
	}
	replacing := out.Conflict == editor.ConflictReplace && out.Destination != editor.DestReplace
	if replacing && folder != "" {
		needTrash(folder)
	}
	// The folders whose trash matters: each is looked up once.
	trashDirs := out.Destination == editor.DestReplace || replacing && out.Destination == editor.DestBeside
	parents := map[int64]struct{}{}
	for lo := 0; lo < len(ids); lo += planChunk {
		rows, err := s.store.Briefs(ctx, ids[lo:min(lo+planChunk, len(ids))])
		if err != nil {
			return res, dbError(err)
		}
		for _, t := range rows {
			decoder, skip := pictureOf(t.Kind, t.Name)
			own := imaging.FormatOf(decoder)
			if skip == "" && out.Destination == editor.DestReplace && own == "" {
				skip = "notWritable"
			}
			if skip != "" {
				skipped[skip]++
				continue
			}
			pictures = append(pictures, t.ID)
			res.Bytes += t.Size
			if len(first) < planNames {
				first = append(first, t.ID)
			}
			changed = changed || own == "" && out.Format == editor.FormatKeep
			alpha = alpha || out.Format == "jpeg" && decoder != "jpeg"
			if _, seen := parents[t.ParentID]; trashDirs && !seen {
				parents[t.ParentID] = struct{}{}
				if d, err := s.store.Dir(ctx, t.ParentID); err == nil {
					needTrash(d.Path)
				}
			}
		}
	}
	res.Count = len(pictures)
	for _, reason := range []string{"folder", "video", "other", "unsupported", "notWritable"} {
		if n := skipped[reason]; n > 0 {
			res.Skipped = append(res.Skipped, planSkip{Reason: reason, Count: n})
		}
	}
	for _, w := range []struct {
		on   bool
		code string
	}{{noTrash, "trashUnavailable"}, {changed, "formatChange"}, {alpha, "alphaLoss"}} {
		if w.on {
			res.Warnings = append(res.Warnings, w.code)
		}
	}
	if len(pictures) == 0 {
		return res, nil
	}

	// The names of the first results, as the job will give them.
	if len(res.Problems) == 0 {
		named, err := s.store.Targets(ctx, first)
		if err != nil {
			return res, dbError(err)
		}
		namer := editor.NewNamer(out, folder)
		for _, t := range named {
			src := editor.Source{EntryID: t.ID, Path: t.Path, Ext: media.Ext(t.Name)}
			decoder, _ := pictureOf(t.Kind, t.Name)
			target, err := namer.Next(src, decoder, editor.NewFacts(src).Token)
			if err != nil || target.Skip != "" {
				continue
			}
			res.Names = append(res.Names, filepath.Base(target.Path))
		}
	}

	// Samples: the first, the last and evenly between.
	n := min(len(pictures), MaxBatchSamples)
	sampleIDs := make([]int64, 0, n)
	for i := range n {
		at := 0
		if n > 1 {
			at = i * (len(pictures) - 1) / (n - 1)
		}
		sampleIDs = append(sampleIDs, pictures[at])
	}
	samples, err := s.store.Targets(ctx, sampleIDs)
	if err != nil {
		return res, dbError(err)
	}
	for _, t := range samples {
		res.Samples = append(res.Samples, planSample{ID: t.ID, Name: t.Name})
	}
	res.EstimateBytes = estimateBatch(p.Recipe, samples, res.Bytes)
	return res, nil
}

// estimateBatch guesses the size of a batch's results from the headers of a
// few pictures: how the recipe changes their pixel count, and what a pixel
// costs in the output format. It is an estimate ("about").
func estimateBatch(r editor.Recipe, samples []index.Target, total int64) int64 {
	var inPx, outPx, bytes, same float64
	step := max(len(samples)/estimateSamples, 1)
	for i := 0; i < len(samples); i += step {
		t := samples[i]
		probe, err := imaging.DefaultRegistry().ProbeFile(t.Path, media.Ext(t.Name))
		if err != nil {
			continue
		}
		w, h := probe.DisplaySize()
		ow, oh := r.Ops.OutputSize(w, h)
		inPx += float64(w) * float64(h)
		outPx += float64(ow) * float64(oh)
		bytes += float64(t.Size)
		format := r.Output.Format
		if format == editor.FormatKeep || format == imaging.FormatOf(probe.Decoder.Name()) {
			same++
		}
	}
	if inPx == 0 || bytes == 0 {
		return 0
	}
	ratio := outPx / inPx
	if same > 0 {
		// The pictures keep their format: they stay as dense as they are.
		return int64(float64(total) * ratio)
	}
	pixels := float64(total) * (inPx / bytes) * ratio
	return int64(pixels * bytesPerPixel(r.Output.Format, r.Output.Quality))
}

// editBatch starts the edit job.
func (s *indexService) editBatch(ctx context.Context, p editBatchParams) (jobs.Snapshot, error) {
	if problems := p.Recipe.Problems(s.editor.HasAsset); len(problems) > 0 {
		e := rpc.NewError(rpc.CodeInvalidArgument, "the recipe cannot run")
		if b, err := json.Marshal(problems); err == nil {
			e.Details = map[string]string{"problems": string(b)}
		}
		return jobs.Snapshot{}, e
	}
	folder, err := batchFolder(p.Recipe, p.Folder)
	if err != nil {
		return jobs.Snapshot{}, err
	}
	ids, err := s.resolveSelection(p.Source.Selection)
	if err != nil {
		return jobs.Snapshot{}, err
	}
	if len(ids) == 0 {
		return jobs.Snapshot{}, rpc.NewError(rpc.CodeInvalidArgument, "nothing is selected")
	}
	return s.startJob(jobs.Spec{Kind: jobs.KindEdit, App: p.App, IDs: ids, Destination: folder, Batch: &jobs.BatchSpec{
		Recipe: p.Recipe, Folder: folder, Reserve: s.preview.ReserveDecode, Resources: s.editor.ResourcesFor,
	}})
}

func (s *indexService) recipeList(ctx context.Context, _ emptyParams) (recipeListResult, error) {
	res := recipeListResult{Recipes: []recipeWire{}}
	for _, b := range editor.Builtins() {
		res.Recipes = append(res.Recipes, recipeWire{Builtin: b.Key, Name: b.Name, Recipe: b.Recipe})
	}
	lib, err := s.library(ctx)
	if err != nil {
		// The built-in recipes work without the library.
		return res, nil
	}
	saved, err := lib.Recipes(ctx)
	if err != nil {
		return res, dbError(err)
	}
	for _, r := range saved {
		recipe, err := editor.ParseRecipe([]byte(r.JSON))
		if err != nil {
			// A row this version cannot read is left alone, not shown.
			s.log.Warn("stored recipe is not readable", "id", r.ID)
			continue
		}
		res.Recipes = append(res.Recipes, recipeWire{ID: r.ID, Name: r.Name, Recipe: recipe})
	}
	return res, nil
}

func (s *indexService) recipeSave(ctx context.Context, p recipeSaveParams) (recipeSaveResult, error) {
	// A stored recipe is checked for everything but its assets: those are
	// picked again when it is used.
	if problems := p.Recipe.Problems(nil); len(problems) > 0 {
		return recipeSaveResult{}, rpc.NewError(rpc.CodeInvalidArgument, "the recipe is not valid: "+problems[0].Code)
	}
	raw, err := json.Marshal(p.Recipe)
	if err != nil || len(raw) > library.MaxRecipeBytes {
		return recipeSaveResult{}, rpc.NewError(rpc.CodeInvalidArgument, "the recipe is too large")
	}
	lib, err := s.library(ctx)
	if err != nil {
		return recipeSaveResult{}, err
	}
	saved, err := lib.SaveRecipe(ctx, p.ID, p.Name, string(raw))
	if err != nil {
		return recipeSaveResult{}, libError(err)
	}
	return recipeSaveResult{ID: saved.ID, Name: saved.Name}, nil
}

// batchFirst is the first file a finished edit job wrote (for "Show in
// folder" and for selecting it in the tile view).
func (s *indexService) batchFirst(jobID int64) (string, bool) {
	created := s.jobs.CreatedBy(jobID)
	if len(created) == 0 {
		return "", false
	}
	return created[0].Path, true
}
