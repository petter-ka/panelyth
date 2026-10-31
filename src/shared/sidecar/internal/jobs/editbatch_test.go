package jobs

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"

	"panelyth/sidecar/internal/editor"
	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/imaging"
	"panelyth/sidecar/internal/index"
)

func testPicture(w, h, seed int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.SetNRGBA(x, y, color.NRGBA{uint8(x*255/w + seed), uint8(y * 255 / h), uint8((x + y + seed*7) % 256), 255})
		}
	}
	return img
}

func writeImage(t testing.TB, path string, w, h, seed int) {
	t.Helper()
	var buf bytes.Buffer
	var err error
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		err = png.Encode(&buf, testPicture(w, h, seed))
	case ".gif":
		err = gif.Encode(&buf, testPicture(w, h, seed), nil)
	default:
		err = jpeg.Encode(&buf, testPicture(w, h, seed), &jpeg.Options{Quality: 90})
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

func imageSize(t testing.TB, path string) (int, int) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return cfg.Width, cfg.Height
}

// batchEnv is an env with the editor's resources and a trash that is a
// folder of the test.
type batchEnv struct {
	*env
	ed      *editor.Manager
	trash   string
	mu      sync.Mutex
	trashed []string
}

func newBatchEnv(t testing.TB) *batchEnv {
	t.Helper()
	b := &batchEnv{env: newEnv(t), trash: t.TempDir()}
	b.ed = editor.NewManager(editor.Config{TmpDir: filepath.Join(t.TempDir(), "edit")})
	t.Cleanup(b.ed.Shutdown)
	trashMany = func(paths []string) []error {
		errs := make([]error, len(paths))
		for i, p := range paths {
			errs[i] = b.toTrash(p)
		}
		return errs
	}
	t.Cleanup(func() { trashMany = fileops.TrashMany })
	return b
}

func (b *batchEnv) toTrash(path string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.trashed = append(b.trashed, filepath.Base(path))
	return os.Rename(path, filepath.Join(b.trash, filepath.Base(path)+"."+string(rune('a'+len(b.trashed)))))
}

func (b *batchEnv) spec(ids []int64, ops string, out editor.Output, folder string) Spec {
	b.t.Helper()
	var list imaging.EditList
	if err := json.Unmarshal([]byte(ops), &list); err != nil {
		b.t.Fatal(err)
	}
	if out.Metadata == "" {
		out.Metadata = imaging.MetaKeep
	}
	if out.Conflict == "" {
		out.Conflict = editor.ConflictKeepBoth
	}
	return Spec{Kind: KindEdit, IDs: ids, Destination: folder, Batch: &BatchSpec{
		Recipe: editor.Recipe{Version: editor.RecipeVersion, Ops: list, Output: out}, Folder: folder,
		Resources: b.ed.ResourcesFor, Trash: b.toTrash, CanTrash: func(string) bool { return true },
	}}
}

func (b *batchEnv) all(dir index.DirInfo) []int64 {
	b.t.Helper()
	ids, err := b.store.QueryIDs(ctx, index.Descriptor{DirID: dir.ID, Sort: []index.SortKey{{Field: index.SortName}}}, dir.Key)
	if err != nil {
		b.t.Fatal(err)
	}
	return ids
}

func listDir(t testing.TB, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

const fit64 = `[{"op":"resize","p":{"mode":"fit","w":64,"h":64}}]`

func TestEditBatchWritesBesideAndSkipsWhatIsNoPicture(t *testing.T) {
	b := newBatchEnv(t)
	for i, name := range []string{"a.jpg", "b.jpg", "c.png", "d.jpeg"} {
		writeImage(t, filepath.Join(b.root, name), 200, 100+10*i, i)
	}
	write(t, filepath.Join(b.root, "clip.mp4"), 500)
	write(t, filepath.Join(b.root, "notes.txt"), 50)
	write(t, filepath.Join(b.root, "raw.heic"), 50)
	writeImage(t, filepath.Join(b.root, "album", "inner.jpg"), 50, 50, 9)
	root := b.index(b.root)

	s := b.run(b.spec(b.all(root), fit64, editor.Output{Format: editor.FormatKeep, Destination: editor.DestBeside}, ""))
	if s.State != StateCompleted || s.Done != 4 || s.Failed != 0 {
		t.Fatalf("batch: %+v %v", s, b.errors(s.JobID))
	}
	// The folder and the video are left out (files that are no media are
	// not in a viewer's selection to begin with).
	if s.Skipped != 2 || s.Total != 6 {
		t.Errorf("skipped %d of %d", s.Skipped, s.Total)
	}
	if s.BytesTotal == 0 || s.BytesDone != s.BytesTotal {
		t.Errorf("bytes %d/%d", s.BytesDone, s.BytesTotal)
	}
	for name, h := range map[string]int{"a-edited.jpg": 32, "b-edited.jpg": 35, "c-edited.png": 38, "d-edited.jpeg": 42} {
		w, got := imageSize(t, filepath.Join(b.root, name))
		if w != 64 || got != h {
			t.Errorf("%s is %d×%d, want 64×%d", name, w, got, h)
		}
	}
	// The originals are as they were; nothing was written into the subfolder.
	if w, h := imageSize(t, filepath.Join(b.root, "a.jpg")); w != 200 || h != 100 {
		t.Errorf("original changed: %d×%d", w, h)
	}
	if got := listDir(t, filepath.Join(b.root, "album")); len(got) != 1 {
		t.Errorf("album: %v", got)
	}
	// The results are in the index.
	names := b.names(root)
	for _, want := range []string{"a-edited.jpg", "c-edited.png", "d-edited.jpeg"} {
		if !slices.Contains(names, want) {
			t.Errorf("%s is not indexed: %v", want, names)
		}
	}
	// The job remembers what it wrote.
	if got := b.m.CreatedBy(s.JobID); len(got) != 4 {
		t.Errorf("journal: %v", got)
	}
}

func TestEditBatchEqualsTheEditorsSaveForAnyWorkerCount(t *testing.T) {
	b := newBatchEnv(t)
	for i := range 9 {
		writeImage(t, filepath.Join(b.root, "p"+string(rune('1'+i))+".jpg"), 320+16*i, 240, i)
	}
	// Two pictures that become one name: the numbers follow the order.
	writeImage(t, filepath.Join(b.root, "p1.png"), 100, 80, 3)
	root := b.index(b.root)
	ops := `[{"op":"resize","p":{"mode":"fit","w":160,"h":160}},{"op":"sharpen","p":{"amount":80,"radius":1}},` +
		`{"op":"watermark","p":{"kind":"text","text":"{name} {width}","size":12,"anchor":"se","margin":3}},` +
		`{"op":"border","p":{"width":3,"color":"#ffffff"}}]`
	out := editor.Output{Format: "jpeg", Quality: 85, Destination: editor.DestFolder, Template: "{n:2}-{name}"}
	folders := map[int]string{}
	for _, workers := range []int{1, 2, 4} {
		folder := filepath.Join(t.TempDir(), "out")
		if err := os.Mkdir(folder, 0o755); err != nil {
			t.Fatal(err)
		}
		spec := b.spec(b.all(root), ops, out, folder)
		spec.Batch.Workers = workers
		if s := b.run(spec); s.State != StateCompleted || s.Done != 10 || s.Failed != 0 {
			t.Fatalf("%d workers: %+v %v", workers, s, b.errors(s.JobID))
		}
		folders[workers] = folder
	}
	names := listDir(t, folders[1])
	if len(names) != 10 || names[0] != "01-p1.jpg" || names[1] != "02-p1.jpg" || names[9] != "10-p9.jpg" {
		t.Fatalf("names: %v", names)
	}
	for _, workers := range []int{2, 4} {
		if got := listDir(t, folders[workers]); !slices.Equal(got, names) {
			t.Fatalf("%d workers named the files %v", workers, got)
		}
		for _, name := range names {
			one, _ := os.ReadFile(filepath.Join(folders[1], name))
			other, _ := os.ReadFile(filepath.Join(folders[workers], name))
			if !bytes.Equal(one, other) {
				t.Errorf("%s differs with %d workers", name, workers)
			}
		}
	}

	// The single editor's save of one of the pictures writes the same bytes.
	src := editor.Source{Path: filepath.Join(b.root, "p4.jpg"), Ext: "jpg"}
	fi, err := os.Stat(src.Path)
	if err != nil {
		t.Fatal(err)
	}
	var list imaging.EditList
	_ = json.Unmarshal([]byte(ops), &list)
	dest := filepath.Join(t.TempDir(), "single.jpg")
	if _, err := editor.Save(ctx, editor.SaveRequest{Source: src, Size: fi.Size(), MtimeNs: fi.ModTime().UnixNano(),
		Edits: list, Dest: dest, Format: "jpeg", Quality: 85, Policy: imaging.MetaKeep,
		Res: b.ed.ResourcesFor(editor.NewFacts(src))}); err != nil {
		t.Fatal(err)
	}
	single, _ := os.ReadFile(dest)
	batch, _ := os.ReadFile(filepath.Join(folders[4], "05-p4.jpg"))
	if !bytes.Equal(single, batch) {
		t.Error("the batch's file differs from the editor's save of the same picture")
	}
}

func TestEditBatchStaysInsideItsMemoryAndWorkers(t *testing.T) {
	b := newBatchEnv(t)
	for i := range 16 {
		writeImage(t, filepath.Join(b.root, "m"+string(rune('a'+i))+".jpg"), 400, 300, i)
	}
	root := b.index(b.root)
	base := runtime.NumGoroutine()
	run := func(limit int64, workers int) (maxUsed int64, maxHeld, maxGoroutines int) {
		var mu sync.Mutex
		cond := sync.NewCond(&mu)
		var used int64
		held := 0
		spec := b.spec(b.all(root), fit64, editor.Output{Format: "jpeg", Destination: editor.DestFolder}, t.TempDir())
		spec.Batch.Workers = workers
		spec.Batch.Reserve = func(_ context.Context, pixels int64) (func(), error) {
			n := min(pixels, limit)
			mu.Lock()
			for used+n > limit {
				cond.Wait()
			}
			used += n
			held++
			maxUsed, maxHeld = max(maxUsed, used), max(maxHeld, held)
			maxGoroutines = max(maxGoroutines, runtime.NumGoroutine())
			mu.Unlock()
			return func() {
				mu.Lock()
				used -= n
				held--
				cond.Broadcast()
				mu.Unlock()
			}, nil
		}
		if s := b.run(spec); s.State != StateCompleted || s.Done != 16 {
			t.Fatalf("batch: %+v %v", s, b.errors(s.JobID))
		}
		return
	}
	// A picture takes 3 × 400 × 300 pixels: a budget of one and a half
	// lets one through at a time, whatever the worker count.
	const one = 3 * 400 * 300
	if used, held, _ := run(one*3/2, 4); used > one*3/2 || held != 1 {
		t.Errorf("tiny budget: %d pixels, %d pictures at once", used, held)
	}
	// A budget smaller than one picture still lets it run, alone.
	if used, held, _ := run(one/4, 4); used > one/4 || held != 1 {
		t.Errorf("budget below one picture: %d pixels, %d at once", used, held)
	}
	// With room, the workers are the bound.
	used, held, goroutines := run(one*100, 3)
	if held > 3 || used > 3*one {
		t.Errorf("3 workers held %d pictures, %d pixels", held, used)
	}
	// The job's goroutine, the producer, the collector's closer and the
	// workers: no goroutine per picture.
	if goroutines > base+3+3+2 {
		t.Errorf("goroutines: %d over a base of %d with 3 workers", goroutines, base)
	}
	if BatchWorkers() < 1 || BatchWorkers() > 4 {
		t.Errorf("BatchWorkers() = %d", BatchWorkers())
	}
}

func partialsIn(t testing.TB, dir string) []string {
	t.Helper()
	var out []string
	for _, name := range listDir(t, dir) {
		if strings.Contains(name, fileops.PartialSuffix) {
			out = append(out, name)
		}
	}
	return out
}

func TestEditBatchCancelLeavesNoPartials(t *testing.T) {
	b := newBatchEnv(t)
	for i := range 12 {
		writeImage(t, filepath.Join(b.root, "c"+string(rune('a'+i))+".jpg"), 600, 400, i)
	}
	root := b.index(b.root)
	folder := t.TempDir()
	spec := b.spec(b.all(root), `[{"op":"blur","p":{"radius":6}},{"op":"resize","p":{"mode":"percent","w":150}}]`,
		editor.Output{Format: "png", Destination: editor.DestFolder}, folder)
	spec.Batch.Workers = 2
	var mu sync.Mutex
	started := 0
	var jobID int64
	ready := make(chan struct{})
	spec.Batch.Reserve = func(c context.Context, _ int64) (func(), error) {
		<-ready
		mu.Lock()
		started++
		third := started == 3
		mu.Unlock()
		if third {
			// Two pictures are being worked on or done: stop the job.
			b.m.Cancel(jobID)
		}
		return func() {}, c.Err()
	}
	snap, err := b.m.Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	jobID = snap.JobID
	close(ready)
	s := b.wait(jobID)
	if s.State != StateCancelled {
		t.Fatalf("state %s: %+v", s.State, s)
	}
	if s.Done >= 12 || s.Failed != 0 {
		t.Errorf("after cancel: %d done, %d failed %v", s.Done, s.Failed, b.errors(jobID))
	}
	if p := partialsIn(t, folder); len(p) != 0 {
		t.Errorf("partial files left: %v", p)
	}
	// What was finished stays, complete, and can be undone.
	done := listDir(t, folder)
	if len(done) != s.Done {
		t.Errorf("%d files for %d done", len(done), s.Done)
	}
	for _, name := range done {
		if w, h := imageSize(t, filepath.Join(folder, name)); w != 900 || h != 600 {
			t.Errorf("%s is %d×%d", name, w, h)
		}
	}
	if got := len(b.m.CreatedBy(jobID)); got != s.Done {
		t.Errorf("journal has %d of %d", got, s.Done)
	}
}

func TestEditBatchReplaceGoesThroughTheTrash(t *testing.T) {
	b := newBatchEnv(t)
	writeImage(t, filepath.Join(b.root, "a.jpg"), 200, 100, 1)
	writeImage(t, filepath.Join(b.root, "b.png"), 200, 100, 2)
	write(t, filepath.Join(b.root, "w.webp"), 64) // can't be written, so it can't be replaced
	root := b.index(b.root)
	before, _ := os.ReadFile(filepath.Join(b.root, "a.jpg"))
	out := editor.Output{Format: editor.FormatKeep, Destination: editor.DestReplace}

	// No trash: refused before the first picture, with one message.
	spec := b.spec(b.all(root), fit64, out, "")
	spec.Batch.CanTrash = func(string) bool { return false }
	s := b.run(spec)
	if s.State != StateFailed || s.Done != 0 || !strings.Contains(s.Error, "no trash") {
		t.Fatalf("without a trash: %+v", s)
	}
	if now, _ := os.ReadFile(filepath.Join(b.root, "a.jpg")); !bytes.Equal(now, before) || len(b.trashed) != 0 {
		t.Fatal("a picture was touched although the drive has no trash")
	}

	s = b.run(b.spec(b.all(root), fit64, out, ""))
	if s.State != StateCompleted || s.Done != 2 || s.Failed != 1 {
		t.Fatalf("replace: %+v %v", s, b.errors(s.JobID))
	}
	if errs := b.errors(s.JobID); errs[0].Name != "w.webp" || errs[0].Code != CodeUnsupported {
		t.Errorf("errors: %v", errs)
	}
	slices.Sort(b.trashed)
	if !slices.Equal(b.trashed, []string{"a.jpg", "b.png"}) {
		t.Errorf("trashed: %v", b.trashed)
	}
	for _, name := range []string{"a.jpg", "b.png"} {
		if w, h := imageSize(t, filepath.Join(b.root, name)); w != 64 || h != 32 {
			t.Errorf("%s is %d×%d", name, w, h)
		}
	}
	// The originals are whole, in the trash.
	if got := listDir(t, b.trash); len(got) != 2 {
		t.Errorf("trash: %v", got)
	}
	if len(listDir(t, b.root)) != 3 || len(partialsIn(t, b.root)) != 0 {
		t.Errorf("folder: %v", listDir(t, b.root))
	}
}

func TestEditBatchConflictPolicies(t *testing.T) {
	b := newBatchEnv(t)
	writeImage(t, filepath.Join(b.root, "a.jpg"), 200, 100, 1)
	writeImage(t, filepath.Join(b.root, "b.jpg"), 200, 100, 2)
	root := b.index(b.root)
	ids := b.ids(root, "a.jpg", "b.jpg")
	folder := filepath.Join(t.TempDir(), "out")
	write(t, filepath.Join(folder, "a.jpg"), 10) // something else has the name
	run := func(conflict string) Snapshot {
		return b.run(b.spec(ids, fit64, editor.Output{Format: "jpeg", Destination: editor.DestFolder, Conflict: conflict}, folder))
	}
	other := func() int64 {
		fi, err := os.Stat(filepath.Join(folder, "a.jpg"))
		if err != nil {
			t.Fatal(err)
		}
		return fi.Size()
	}

	if s := run(editor.ConflictSkip); s.Done != 1 || s.Skipped != 1 || s.Failed != 0 || other() != 10 {
		t.Fatalf("skip: %+v", s)
	}
	if s := run(editor.ConflictKeepBoth); s.Done != 2 || other() != 10 {
		t.Fatalf("keep both: %+v", s)
	}
	if got := listDir(t, folder); !slices.Equal(got, []string{"a (2).jpg", "a.jpg", "b (2).jpg", "b.jpg"}) {
		t.Fatalf("keep both: %v", got)
	}
	// Replace: what had the name goes to the trash first.
	s := run(editor.ConflictReplace)
	if s.Done != 2 || s.Failed != 0 || other() == 10 {
		t.Fatalf("replace: %+v %v", s, b.errors(s.JobID))
	}
	slices.Sort(b.trashed)
	if !slices.Equal(b.trashed, []string{"a.jpg", "b.jpg"}) || len(listDir(t, folder)) != 4 {
		t.Errorf("trashed %v, folder %v", b.trashed, listDir(t, folder))
	}
	// Without a trash that policy is refused before anything is written.
	spec := b.spec(ids, fit64, editor.Output{Format: "jpeg", Destination: editor.DestFolder, Conflict: editor.ConflictReplace}, folder)
	spec.Batch.CanTrash = func(string) bool { return false }
	if s := b.run(spec); s.State != StateFailed || s.Done != 0 {
		t.Errorf("replace without a trash: %+v", s)
	}
}

func TestEditBatchReportsEachPictureThatFails(t *testing.T) {
	b := newBatchEnv(t)
	writeImage(t, filepath.Join(b.root, "good.jpg"), 200, 100, 1)
	write(t, filepath.Join(b.root, "broken.jpg"), 300)
	anim := &gif.GIF{}
	for i := range 2 {
		frame := image.NewPaletted(image.Rect(0, 0, 8, 8), color.Palette{color.Black, color.White})
		frame.SetColorIndex(i, i, 1)
		anim.Image, anim.Delay = append(anim.Image, frame), append(anim.Delay, 10)
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, anim); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(b.root, "moving.gif"), buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	root := b.index(b.root)
	s := b.run(b.spec(b.all(root), fit64, editor.Output{Format: "png", Destination: editor.DestBeside}, ""))
	if s.State != StateCompleted || s.Done != 1 || s.Failed != 2 {
		t.Fatalf("batch: %+v", s)
	}
	codes := map[string]string{}
	for _, e := range b.errors(s.JobID) {
		codes[e.Name] = e.Code
		if e.Message == "" {
			t.Errorf("%s has no message", e.Name)
		}
	}
	if codes["moving.gif"] != CodeUnsupported || codes["broken.jpg"] == "" {
		t.Errorf("codes: %v", codes)
	}
	if len(partialsIn(t, b.root)) != 0 {
		t.Errorf("partials: %v", listDir(t, b.root))
	}
}

func TestEditBatchValidation(t *testing.T) {
	b := newBatchEnv(t)
	writeImage(t, filepath.Join(b.root, "a.jpg"), 20, 20, 1)
	ids := b.all(b.index(b.root))
	out := editor.Output{Format: "jpeg", Destination: editor.DestBeside}
	for name, spec := range map[string]Spec{
		"no recipe":         {Kind: KindEdit, IDs: ids},
		"a free-hand tool":  b.spec(ids, `[{"op":"draw","p":{"strokes":[]}}]`, out, ""),
		"an unknown tool":   b.spec(ids, `[{"op":"shell","p":{}}]`, out, ""),
		"no folder":         b.spec(ids, fit64, editor.Output{Format: "jpeg", Destination: editor.DestFolder}, ""),
		"a relative folder": b.spec(ids, fit64, editor.Output{Format: "jpeg", Destination: editor.DestFolder}, "out"),
		"an unknown token":  b.spec(ids, fit64, editor.Output{Format: "jpeg", Destination: editor.DestBeside, Template: "{who}"}, ""),
	} {
		if _, err := b.m.Start(spec); err == nil {
			t.Errorf("%s: started", name)
		}
	}
	if _, err := b.m.UndoEdit(12345); err != ErrUnknownJob {
		t.Errorf("undo of an unknown job: %v", err)
	}
}

func TestUndoEditRemovesOnlyWhatTheBatchWrote(t *testing.T) {
	b := newBatchEnv(t)
	for _, name := range []string{"a.jpg", "b.jpg", "c.jpg"} {
		writeImage(t, filepath.Join(b.root, name), 200, 100, 1)
	}
	root := b.index(b.root)
	spec := b.spec(b.all(root), fit64, editor.Output{Format: "jpeg", Destination: editor.DestBeside}, "")
	spec.App = "viewer"
	s := b.run(spec)
	if s.Done != 3 || s.App != "viewer" {
		t.Fatalf("batch: %+v", s)
	}
	// The user kept working on one of the results: it is theirs now.
	writeImage(t, filepath.Join(b.root, "b-edited.jpg"), 30, 30, 5)
	// And removed another themselves.
	if err := os.Remove(filepath.Join(b.root, "c-edited.jpg")); err != nil {
		t.Fatal(err)
	}

	snap, err := b.m.UndoEdit(s.JobID)
	if err != nil {
		t.Fatal(err)
	}
	// The undo is listed where the batch was (ADR-0031 amended).
	if snap.App != "viewer" {
		t.Errorf("undo app %q", snap.App)
	}
	u := b.wait(snap.JobID)
	if u.Kind != KindUndoEdit || u.State != StateCompleted || u.Total != 3 || u.Done != 1 || u.Skipped != 2 || u.Failed != 0 {
		t.Fatalf("undo: %+v %v", u, b.errors(u.JobID))
	}
	if !slices.Equal(b.trashed, []string{"a-edited.jpg"}) {
		t.Errorf("trashed: %v", b.trashed)
	}
	if got := listDir(t, b.root); !slices.Equal(got, []string{"a.jpg", "b-edited.jpg", "b.jpg", "c.jpg"}) {
		t.Errorf("folder after undo: %v", got)
	}
	// The index follows.
	if names := b.names(root); slices.Contains(names, "a-edited.jpg") || !slices.Contains(names, "a.jpg") {
		t.Errorf("index after undo: %v", names)
	}
	// A batch is undone once.
	if _, err := b.m.UndoEdit(s.JobID); err != ErrUnknownJob {
		t.Errorf("second undo: %v", err)
	}
	if b.m.CreatedBy(s.JobID) != nil {
		t.Error("the journal outlived its undo")
	}
}

func TestEditJournalIsBounded(t *testing.T) {
	var c createdJournal
	c.set(1, nil)
	if c.get(1) != nil {
		t.Error("an empty journal is kept")
	}
	c.set(1, []Created{{Path: "a"}})
	c.set(2, []Created{{Path: "b"}})
	c.drop(1)
	if c.get(1) != nil || len(c.take(2)) != 1 || c.get(2) != nil {
		t.Error("drop and take")
	}
	if MaxCreated != 10_000 {
		t.Errorf("MaxCreated = %d", MaxCreated)
	}
}
