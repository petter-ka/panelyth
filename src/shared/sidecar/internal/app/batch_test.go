package app

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"panelyth/sidecar/internal/editor"
	"panelyth/sidecar/internal/imaging"
	"panelyth/sidecar/internal/jobs"
	"panelyth/sidecar/internal/rpc"
)

func putPicture(t *testing.T, path string, w, h int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.SetRGBA(x, y, color.RGBA{uint8(x * 255 / w), uint8(y * 255 / h), 120, 255})
		}
	}
	var buf bytes.Buffer
	var err error
	if strings.HasSuffix(path, ".png") {
		err = png.Encode(&buf, img)
	} else {
		err = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90})
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func testRecipe(t *testing.T, ops string, out editor.Output) editor.Recipe {
	t.Helper()
	if out.Metadata == "" {
		out.Metadata = imaging.MetaKeep
	}
	if out.Conflict == "" {
		out.Conflict = editor.ConflictKeepBoth
	}
	return editor.Recipe{Version: editor.RecipeVersion, Ops: editList(t, ops), Output: out}
}

const halve = `[{"op":"resize","p":{"mode":"percent","w":50}}]`

// batchFixture lists a folder of five pictures among things that are none.
func batchFixture(t *testing.T) (svc *indexService, dir string, source jobSourceWire) {
	t.Helper()
	svc = newContextService(t, t.TempDir())
	dir = t.TempDir()
	for i, name := range []string{"a.jpg", "b.jpg", "c.png", "d.jpg", "e.jpg"} {
		putPicture(t, filepath.Join(dir, name), 400+40*i, 300)
	}
	for _, name := range []string{"clip.mp4", "notes.txt", "w.webp", "photo.heic"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("not a picture the editor reads"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "album"), 0o755); err != nil {
		t.Fatal(err)
	}
	queryID, version, items := listedQuery(t, svc, dir)
	if len(items) != 10 {
		t.Fatalf("listed %d", len(items))
	}
	return svc, dir, jobSourceWire{Selection: selectionWire{QueryID: queryID, Version: version,
		Ranges: [][2]int{{0, 10}}, Include: []int64{}, Exclude: []int64{}}}
}

func TestEditPlan(t *testing.T) {
	ctx := context.Background()
	svc, dir, source := batchFixture(t)

	plan, err := svc.editPlan(ctx, editBatchParams{Source: source,
		Recipe: testRecipe(t, halve, editor.Output{Format: editor.FormatKeep, Destination: editor.DestBeside})})
	if err != nil {
		t.Fatal(err)
	}
	// The WebP counts: the editor reads that format (this file will fail
	// as an item when the job reaches it).
	if plan.Count != 6 || len(plan.Problems) != 0 {
		t.Fatalf("%+v", plan)
	}
	skipped := map[string]int{}
	for _, s := range plan.Skipped {
		skipped[s.Reason] = s.Count
	}
	if skipped["folder"] != 1 || skipped["video"] != 1 || skipped["other"]+skipped["unsupported"] != 2 || len(plan.Skipped) > 4 {
		t.Errorf("skipped: %v", plan.Skipped)
	}
	if !slices.Equal(plan.Names, []string{"a-edited.jpg", "b-edited.jpg", "c-edited.png", "d-edited.jpg", "e-edited.jpg"}) {
		t.Errorf("names: %v", plan.Names)
	}
	if !slices.Equal(plan.Warnings, []string{"formatChange"}) {
		t.Errorf("warnings: %v", plan.Warnings)
	}
	if len(plan.Samples) != 6 || plan.Samples[0].Name != "a.jpg" || plan.Samples[5].Name != "w.webp" || plan.Samples[0].ID == 0 {
		t.Errorf("samples: %v", plan.Samples)
	}
	// Half the size in each direction: about a quarter of the bytes.
	if plan.Bytes == 0 || plan.EstimateBytes < plan.Bytes/8 || plan.EstimateBytes > plan.Bytes/2 {
		t.Errorf("estimate %d of %d", plan.EstimateBytes, plan.Bytes)
	}

	// JPEG has no transparency; a name template with a number; a taken name.
	putPicture(t, filepath.Join(dir, "002-b.jpg"), 10, 10)
	plan, err = svc.editPlan(ctx, editBatchParams{Source: source,
		Recipe: testRecipe(t, halve, editor.Output{Format: "jpeg", Destination: editor.DestBeside, Template: "{n:3}-{name}"})})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(plan.Names, []string{"001-a.jpg", "002-b (2).jpg", "003-c.jpg", "004-d.jpg", "005-e.jpg"}) {
		t.Errorf("names: %v", plan.Names)
	}
	if !slices.Equal(plan.Warnings, []string{"alphaLoss"}) {
		t.Errorf("warnings: %v", plan.Warnings)
	}

	// Replace: what can't be written is left out, and said so.
	plan, err = svc.editPlan(ctx, editBatchParams{Source: source,
		Recipe: testRecipe(t, halve, editor.Output{Format: editor.FormatKeep, Destination: editor.DestReplace})})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Count != 5 || !slices.Contains(plan.Skipped, planSkip{Reason: "notWritable", Count: 1}) || plan.Names[0] != "a.jpg" {
		t.Errorf("replace: %+v", plan)
	}

	// A recipe that cannot run: the reasons, and no names.
	bad := testRecipe(t, `[{"op":"draw","p":{"strokes":[]}}]`, editor.Output{Format: "jpeg", Destination: editor.DestBeside, Template: "{who}"})
	plan, err = svc.editPlan(ctx, editBatchParams{Source: source, Recipe: bad})
	if err != nil || len(plan.Problems) != 2 || len(plan.Names) != 0 || plan.Count != 6 {
		t.Errorf("problems: %+v %v", plan, err)
	}

	// A folder: counted before one is chosen; a folder that is none is refused.
	folderRecipe := testRecipe(t, halve, editor.Output{Format: "png", Destination: editor.DestFolder})
	if plan, err = svc.editPlan(ctx, editBatchParams{Source: source, Recipe: folderRecipe}); err != nil || plan.Count != 6 {
		t.Errorf("no folder yet: %+v %v", plan, err)
	}
	if _, err := svc.editPlan(ctx, editBatchParams{Source: source, Recipe: folderRecipe, Folder: filepath.Join(dir, "missing")}); rpcCode(err) != rpc.CodeInvalidPath {
		t.Errorf("missing folder: %v", err)
	}
	out := t.TempDir()
	plan, err = svc.editPlan(ctx, editBatchParams{Source: source, Recipe: folderRecipe, Folder: out})
	if err != nil || !slices.Equal(plan.Names[:2], []string{"a.png", "b.png"}) {
		t.Errorf("folder: %+v %v", plan, err)
	}

	// Nothing that is a picture.
	one := jobSourceWire{Selection: selectionWire{QueryID: source.Selection.QueryID, Version: source.Selection.Version,
		Ranges: [][2]int{{0, 1}}, Include: []int64{}, Exclude: []int64{}}}
	plan, err = svc.editPlan(ctx, editBatchParams{Source: one, Recipe: folderRecipe})
	if err != nil || plan.Count != 0 || len(plan.Samples) != 0 || len(plan.Skipped) != 1 {
		t.Errorf("a folder only: %+v %v", plan, err)
	}
}

func TestEditBatchRuns(t *testing.T) {
	ctx := context.Background()
	svc, dir, source := batchFixture(t)
	out := t.TempDir()

	// Refused with the list of what is wrong.
	_, err := svc.editBatch(ctx, editBatchParams{Source: source,
		Recipe: testRecipe(t, `[{"op":"clone","p":{}}]`, editor.Output{Format: "bad", Destination: editor.DestBeside})})
	var re *rpc.Error
	if rpcCode(err) != rpc.CodeInvalidArgument {
		t.Fatalf("invalid recipe: %v", err)
	}
	if e, ok := err.(*rpc.Error); ok {
		re = e
	}
	var problems []editor.Problem
	details, _ := re.Details.(map[string]string)
	if json.Unmarshal([]byte(details["problems"]), &problems) != nil || len(problems) != 2 {
		t.Errorf("problems: %+v", re)
	}
	folderRecipe := testRecipe(t, halve, editor.Output{Format: "jpeg", Quality: 80, Destination: editor.DestFolder, Template: "{name}-half"})
	if _, err := svc.editBatch(ctx, editBatchParams{Source: source, Recipe: folderRecipe}); rpcCode(err) != rpc.CodeInvalidPath {
		t.Errorf("no folder: %v", err)
	}

	snap, err := svc.editBatch(ctx, editBatchParams{Source: source, Recipe: folderRecipe, Folder: out})
	if err != nil {
		t.Fatal(err)
	}
	if snap.Kind != jobs.KindEdit || snap.Total != 10 || snap.Destination != filepath.Base(out) {
		t.Errorf("started: %+v", snap)
	}
	done := waitJob(t, svc, snap.JobID)
	// Five pictures; the WebP that is none fails as an item; the rest is skipped.
	if done.State != jobs.StateCompleted || done.Done != 5 || done.Failed != 1 || done.Skipped != 4 {
		errs, _, _ := svc.jobs.Errors(snap.JobID, 0, 10)
		t.Fatalf("finished: %+v %v", done, errs)
	}
	names, _ := filepath.Glob(filepath.Join(out, "*"))
	if len(names) != 5 || filepath.Base(names[0]) != "a-half.jpg" {
		t.Errorf("results: %v", names)
	}
	f, err := os.Open(filepath.Join(out, "c-half.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := jpeg.DecodeConfig(f)
	f.Close()
	if err != nil || cfg.Width != 240 || cfg.Height != 150 {
		t.Errorf("c-half.jpg: %+v %v", cfg, err)
	}
	// The originals are untouched.
	if got, _ := filepath.Glob(filepath.Join(dir, "*")); len(got) != 10 {
		t.Errorf("source folder: %v", got)
	}
	// "Show in folder" finds the first result.
	if path, ok := svc.batchFirst(snap.JobID); !ok || filepath.Dir(path) != out {
		t.Errorf("first result: %q", path)
	}
	if _, ok := svc.batchFirst(snap.JobID + 100); ok {
		t.Error("an unknown job has a result")
	}
}

func TestRecipeStore(t *testing.T) {
	ctx := context.Background()
	svc := newContextService(t, t.TempDir())
	list := func() []recipeWire {
		t.Helper()
		res, err := svc.recipeList(ctx, emptyParams{})
		if err != nil {
			t.Fatal(err)
		}
		return res.Recipes
	}
	builtins := len(editor.Builtins())
	if got := list(); len(got) != builtins || got[0].Builtin != "web1600" || got[0].ID != 0 || len(got[0].Recipe.Ops) == 0 {
		t.Fatalf("built-in recipes: %+v", got)
	}
	web := testRecipe(t, halve, editor.Output{Format: "jpeg", Quality: 80, Destination: editor.DestFolder, Template: "{name}-web"})
	saved, err := svc.recipeSave(ctx, recipeSaveParams{Name: "  For the web ", Recipe: web})
	if err != nil || saved.ID == 0 || saved.Name != "For the web" {
		t.Fatalf("save: %+v %v", saved, err)
	}
	got := list()
	if len(got) != builtins+1 || got[builtins].ID != saved.ID || got[builtins].Builtin != "" ||
		got[builtins].Recipe.Output.Template != "{name}-web" || len(got[builtins].Recipe.Ops) != 1 {
		t.Fatalf("listed: %+v", got[builtins:])
	}
	// The same name again replaces it; the case of the name does not matter.
	web.Output.Quality = 60
	again, err := svc.recipeSave(ctx, recipeSaveParams{Name: "for the WEB", Recipe: web})
	if err != nil || again.ID != saved.ID || len(list()) != builtins+1 || list()[builtins].Recipe.Output.Quality != 60 {
		t.Fatalf("replace by name: %+v %v", again, err)
	}
	other, err := svc.recipeSave(ctx, recipeSaveParams{Name: "Other", Recipe: web})
	if err != nil {
		t.Fatal(err)
	}
	// Renaming onto another recipe's name is refused.
	if _, err := svc.recipeSave(ctx, recipeSaveParams{ID: other.ID, Name: "For the web", Recipe: web}); rpcCode(err) != rpc.CodeInvalidArgument {
		t.Errorf("duplicate name: %v", err)
	}
	if renamed, err := svc.recipeSave(ctx, recipeSaveParams{ID: other.ID, Name: "Another", Recipe: web}); err != nil || renamed.ID != other.ID {
		t.Errorf("rename: %+v %v", renamed, err)
	}
	// What cannot run is not stored; nor is a recipe without a name.
	for name, p := range map[string]recipeSaveParams{
		"free-hand":  {Name: "x", Recipe: testRecipe(t, `[{"op":"heal","p":{}}]`, web.Output)},
		"bad output": {Name: "x", Recipe: testRecipe(t, halve, editor.Output{Format: "exe", Destination: editor.DestBeside})},
		"no name":    {Name: "   ", Recipe: web},
		"long name":  {Name: strings.Repeat("n", 81), Recipe: web},
		"unknown id": {ID: 99_999, Name: "y", Recipe: web},
	} {
		if _, err := svc.recipeSave(ctx, p); err == nil {
			t.Errorf("%s: stored", name)
		}
	}
	// A stored recipe names an asset; whether it is still picked is checked
	// when it runs.
	marked := testRecipe(t, `[{"op":"watermark","p":{"kind":"image","assetId":"`+strings.Repeat("ab", 16)+`","size":10}}]`, web.Output)
	if _, err := svc.recipeSave(ctx, recipeSaveParams{Name: "Logo", Recipe: marked}); err != nil {
		t.Errorf("recipe with an asset: %v", err)
	}
	// A row this version cannot read is not listed.
	lib, _ := svc.library(ctx)
	if _, err := lib.SaveRecipe(ctx, 0, "Broken", `{"version":1,"ops":"rm -rf"}`); err != nil {
		t.Fatal(err)
	}
	if got := list(); len(got) != builtins+3 {
		t.Errorf("listed %d recipes", len(got)-builtins)
	}
	del := func(id int64) error {
		return libError(lib.DeleteRecipe(ctx, id))
	}
	if err := del(saved.ID); err != nil {
		t.Fatal(err)
	}
	if err := del(saved.ID); rpcCode(err) != rpc.CodeNotFound {
		t.Errorf("delete twice: %v", err)
	}
	if got := list(); len(got) != builtins+2 {
		t.Errorf("after delete: %d", len(got)-builtins)
	}
}
