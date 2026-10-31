package jobs

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"panelyth/sidecar/internal/editor"
	"panelyth/sidecar/internal/fileops"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/imaging"
	"panelyth/sidecar/internal/index"
	"panelyth/sidecar/internal/media"
)

// Batch editing (Stage 16, ADR-0036). An edit job runs a recipe over the
// pictures of a selection: a bounded number of pictures at a time, each on
// one goroutine, each through the editor's own save (so a batch writes what
// the editor would have written for that picture), with the decode memory
// taken from the budget previews share. It remembers the files it created;
// an undoEdit job sends those to the trash.
const (
	KindEdit     Kind = "edit"
	KindUndoEdit Kind = "undoEdit"
)

// Item error codes of an edit job (mirror JobItemErrorCode), besides the
// file-operation codes.
const (
	CodeDecodeFailed = "DECODE_FAILED"
	CodeUnsupported  = "UNSUPPORTED"
	CodeTooLarge     = "TOO_LARGE"
)

// MaxCreated is how many created files a job remembers for its undo.
const MaxCreated = 10_000

// BatchWorkers is how many pictures an edit job works on at once.
func BatchWorkers() int { return min(4, max(1, runtime.NumCPU()/2)) }

// BatchSpec is the recipe run of an edit job.
type BatchSpec struct {
	Recipe editor.Recipe
	// Folder is the destination of editor.DestFolder: a clean absolute path
	// from Electron main's folder dialog.
	Folder string
	// Workers overrides BatchWorkers (tests and benchmarks).
	Workers int
	// Reserve takes decode memory; Resources gives a picture's run its
	// assets, fonts and tokens.
	Reserve   func(ctx context.Context, pixels int64) (func(), error)
	Resources func(*editor.Facts) imaging.Resources
	// Trash and CanTrash stand in for the OS trash in tests.
	Trash    func(path string) error
	CanTrash func(dir string) bool
}

func validateBatch(s Spec) error {
	b := s.Batch
	if b == nil || b.Resources == nil {
		return fmt.Errorf("%w: no recipe", ErrInvalid)
	}
	if p := b.Recipe.Problems(nil); len(p) > 0 {
		return fmt.Errorf("%w: the recipe cannot run (%s %s %s)", ErrInvalid, p[0].Code, p[0].Op, p[0].Detail)
	}
	if b.Recipe.Output.Destination == editor.DestFolder && !filepath.IsAbs(b.Folder) {
		return fmt.Errorf("%w: the destination folder is missing", ErrInvalid)
	}
	return nil
}

// Created is one file an edit job wrote, as it was when written: an undo
// leaves a file that changed since alone.
type Created struct {
	Path    string
	Size    int64
	MtimeNs int64
}

// createdJournal holds the created files of the finished edit jobs the
// manager still lists. It lives in memory and ends with the sidecar.
type createdJournal struct {
	mu   sync.Mutex
	jobs map[int64][]Created
}

func (c *createdJournal) set(jobID int64, files []Created) {
	if len(files) == 0 {
		return
	}
	c.mu.Lock()
	if c.jobs == nil {
		c.jobs = map[int64][]Created{}
	}
	c.jobs[jobID] = files
	c.mu.Unlock()
}

func (c *createdJournal) take(jobID int64) []Created {
	c.mu.Lock()
	defer c.mu.Unlock()
	files := c.jobs[jobID]
	delete(c.jobs, jobID)
	return files
}

func (c *createdJournal) get(jobID int64) []Created {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.jobs[jobID]
}

func (c *createdJournal) drop(jobID int64) {
	c.mu.Lock()
	delete(c.jobs, jobID)
	c.mu.Unlock()
}

// CreatedBy lists the files a finished edit job wrote and that an undo
// would remove (nil when there is nothing to undo, or no longer).
func (m *Manager) CreatedBy(jobID int64) []Created { return m.created.get(jobID) }

// UndoEdit starts the job that sends the files an edit job created to the
// trash. The journal goes to that job: a batch is undone once.
func (m *Manager) UndoEdit(jobID int64) (Snapshot, error) {
	files := m.created.take(jobID)
	if len(files) == 0 {
		return Snapshot{}, ErrUnknownJob
	}
	// The undo is listed where the batch it undoes was.
	snap, err := m.start(Spec{Kind: KindUndoEdit, App: m.AppOf(jobID), created: files, undoOf: jobID})
	if err != nil {
		m.created.set(jobID, files)
	}
	return snap, err
}

// isPicture reports whether the editor reads a target, and the decoder
// family that does.
func isPicture(t index.Target) (string, bool) {
	if t.Kind != media.KindImage {
		return "", false
	}
	dec := imaging.DefaultRegistry().For(media.Ext(t.Name))
	if dec == nil {
		return "", false
	}
	return dec.Name(), true
}

// batchScan is what an edit job learns from its targets before the first
// picture: how much there is to read, whether the trash it needs exists,
// and (for the "replace" policy) which files are originals.
type batchScan struct {
	bytes   int64
	noTrash bool
	sources map[string]struct{}
}

func (m *Manager) scanBatch(j *job) (batchScan, error) {
	b := j.spec.Batch
	out := b.Recipe.Output
	canTrash := b.CanTrash
	if canTrash == nil {
		canTrash = fileops.CanTrash
	}
	var scan batchScan
	if out.Conflict == editor.ConflictReplace && out.Destination != editor.DestReplace {
		scan.sources = map[string]struct{}{}
	}
	// One trash check per volume.
	volumes := map[string]bool{}
	needTrash := func(dir string) {
		v := fsx.VolumeID(dir)
		ok, seen := volumes[v]
		if !seen {
			ok = canTrash(dir)
			volumes[v] = ok
		}
		if !ok {
			scan.noTrash = true
		}
	}
	if scan.sources != nil && out.Destination == editor.DestFolder {
		needTrash(b.Folder)
	}
	ids := j.spec.IDs
	for lo := 0; lo < len(ids); lo += targetChunk {
		if err := j.ctx.Err(); err != nil {
			return scan, err
		}
		targets, err := m.deps.Store.Targets(j.ctx, ids[lo:min(lo+targetChunk, len(ids))])
		if err != nil {
			return scan, err
		}
		for _, t := range targets {
			if _, ok := isPicture(t); !ok {
				continue
			}
			scan.bytes += t.Size
			if scan.sources != nil {
				scan.sources[t.Key] = struct{}{}
			}
			if out.Destination == editor.DestReplace || scan.sources != nil && out.Destination == editor.DestBeside {
				needTrash(filepath.Dir(t.Path))
			}
		}
	}
	return scan, nil
}

type batchItem struct {
	t       index.Target
	src     editor.Source
	decoder string
	target  editor.Target
	facts   *editor.Facts
}

type batchResult struct {
	item batchItem
	res  editor.SaveResult
	err  error
}

var errAnimated = errors.New("animations are not edited")

func (m *Manager) editOne(ctx context.Context, b *BatchSpec, it batchItem) (editor.SaveResult, error) {
	fi, err := os.Stat(it.src.Path)
	if err != nil {
		return editor.SaveResult{}, err
	}
	if editor.Animated(it.src.Path, it.decoder) {
		return editor.SaveResult{}, errAnimated
	}
	out := b.Recipe.Output
	return editor.Save(ctx, editor.SaveRequest{
		Source: it.src, Size: fi.Size(), MtimeNs: fi.ModTime().UnixNano(), Edits: b.Recipe.Ops,
		Dest: it.target.Path, Replace: it.target.Replace, TrashDest: it.target.TrashDest,
		Format: it.target.Format, Quality: out.Quality, Policy: out.Metadata,
		DPI: imaging.DPI{X: out.DPI, Y: out.DPI}, Res: b.Resources(it.facts),
		Reserve: b.Reserve, Trash: b.Trash,
	})
}

// editFailure words a failed save for the item's error.
func editFailure(err error) (code, msg string) {
	code, msg = fileops.Code(err), message(err)
	switch {
	case errors.Is(err, errAnimated):
		return CodeUnsupported, "Animated pictures are not edited."
	case errors.Is(err, editor.ErrChanged):
		return fileops.CodeIO, "The file changed while it was being edited."
	case errors.Is(err, editor.ErrTooLarge), errors.Is(err, imaging.ErrTooLarge):
		return CodeTooLarge, "The picture is too large to edit."
	case errors.Is(err, imaging.ErrUnsupported):
		return CodeUnsupported, "This kind of picture can't be edited."
	case errors.Is(err, imaging.ErrCorrupt):
		return CodeDecodeFailed, "The picture can't be read."
	case errors.Is(err, imaging.ErrInvalidEdit):
		return fileops.CodeIO, "The recipe doesn't fit this picture: " + err.Error()
	case code == fileops.CodeTrashUnavailable:
		msg = "This drive has no trash, so nothing was replaced."
	}
	return code, msg
}

// editBatch runs the recipe. The producer names the files in display order
// (so {n} and the numbers of duplicate names do not depend on the worker
// count), the workers render and write, and this goroutine alone records
// what happened: the index, the journal and the progress.
func (m *Manager) editBatch(j *job, a *applier) (string, error) {
	b := j.spec.Batch
	out := b.Recipe.Output
	scan, err := m.scanBatch(j)
	if err != nil {
		return "", err
	}
	if scan.noTrash {
		// Before the first picture, not after half of them.
		if out.Destination == editor.DestReplace {
			return "A drive in this selection has no trash, so the originals can't be replaced safely. Choose another destination.", nil
		}
		return "The destination has no trash, so existing files can't be replaced safely. Keep both or skip instead.", nil
	}
	j.update(func(s *Snapshot) { s.BytesTotal = scan.bytes })
	m.emit(j, true)

	workers := b.Workers
	if workers <= 0 {
		workers = BatchWorkers()
	}
	// Parallel across pictures, one goroutine inside each.
	ctx := imaging.WithWorkers(j.ctx, 1)
	namer := editor.NewNamer(out, b.Folder)
	if scan.sources != nil {
		namer.IsSource = func(key string) bool {
			_, ok := scan.sources[key]
			return ok
		}
	}
	work := make(chan batchItem)
	results := make(chan batchResult, workers)
	var wg sync.WaitGroup
	wg.Add(workers)
	for range workers {
		go func() {
			defer wg.Done()
			for it := range work {
				res, err := m.editOne(ctx, b, it)
				results <- batchResult{item: it, res: res, err: err}
			}
		}()
	}
	produced := make(chan error, 1)
	go func() {
		defer close(work)
		produced <- m.eachTarget(j, func(t index.Target) error {
			decoder, ok := isPicture(t)
			if !ok {
				j.update(func(s *Snapshot) { s.Skipped++ })
				return nil
			}
			src := editor.Source{EntryID: t.ID, Path: t.Path, Ext: media.Ext(t.Name)}
			facts := editor.NewFacts(src)
			target, err := namer.Next(src, decoder, facts.Token)
			// A picture that is not handed to a worker is still accounted for.
			switch {
			case err != nil:
				j.fail(t.Name, fileops.Code(err), message(err))
			case target.Skip == "notWritable":
				j.fail(t.Name, CodeUnsupported, "This format can't be written, so the original was not replaced.")
			case target.Skip != "":
				j.update(func(s *Snapshot) { s.Skipped++ })
			}
			if err != nil || target.Skip != "" {
				j.update(func(s *Snapshot) { s.BytesDone += t.Size })
				return nil
			}
			select {
			case work <- batchItem{t: t, src: src, decoder: decoder, target: target, facts: facts}:
				return nil
			case <-j.ctx.Done():
				return j.ctx.Err()
			}
		})
	}()
	go func() {
		wg.Wait()
		close(results)
	}()

	dirs := newDirCache(m, j, a)
	var created []Created
	for r := range results {
		name := r.item.t.Name
		if r.res.Path != "" {
			// Written, or the original went to the trash: the folder changed
			// either way.
			if r.res.Trashed && r.err != nil {
				dirs.removed(r.item.src.Path, false, false)
			} else {
				dirs.added(r.res.Path, false)
			}
		}
		switch {
		case r.err == nil:
			if len(created) < MaxCreated {
				created = append(created, Created{Path: r.res.Path, Size: r.res.Bytes, MtimeNs: r.res.ModTimeNs})
			}
			j.update(func(s *Snapshot) { s.Done++; s.BytesDone += r.item.t.Size })
		case j.ctx.Err() != nil:
			// Cancelled: the picture in progress left no file.
		default:
			code, msg := editFailure(r.err)
			j.fail(name, code, msg)
			j.update(func(s *Snapshot) { s.BytesDone += r.item.t.Size })
		}
		m.emit(j, false)
	}
	m.created.set(j.snap.JobID, created)
	if err := <-produced; err != nil {
		return "", err
	}
	return "", j.ctx.Err()
}

// undoEdit sends the files an edit job created to the trash: only those,
// and only while they are still what the job wrote. Originals are never
// touched (those a Replace took are in the trash already).
func (m *Manager) undoEdit(j *job, a *applier) error {
	files := j.spec.created
	dirs := newDirCache(m, j, a)
	for lo := 0; lo < len(files); lo += trashBatch {
		if err := j.gate(j.ctx); err != nil {
			// What was not reached can still be undone.
			m.created.set(j.spec.undoOf, files[lo:])
			return err
		}
		var batch []Created
		for _, f := range files[lo:min(lo+trashBatch, len(files))] {
			fi, err := os.Stat(f.Path)
			if err != nil || fi.Size() != f.Size || fi.ModTime().UnixNano() != f.MtimeNs {
				// Gone, or changed since: not this job's file any more.
				j.update(func(s *Snapshot) { s.Skipped++ })
				continue
			}
			batch = append(batch, f)
		}
		paths := make([]string, len(batch))
		for i, f := range batch {
			paths[i] = f.Path
		}
		j.update(func(s *Snapshot) {
			if len(paths) > 0 {
				s.Current = truncate(filepath.Base(paths[0]))
			}
		})
		for i, err := range trashMany(paths) {
			name := filepath.Base(paths[i])
			if err != nil && fileops.Code(err) != fileops.CodeNotFound {
				j.fail(name, fileops.Code(err), message(err))
				continue
			}
			dirs.removed(paths[i], false, false)
			j.update(func(s *Snapshot) { s.Done++ })
		}
		m.emit(j, false)
	}
	return nil
}

// undoEditLane is the lane of an undo: the volume its files are on.
func undoEditLane(s Spec) string {
	if len(s.created) == 0 {
		return ""
	}
	v := fsx.VolumeID(s.created[0].Path)
	return v + ">" + v
}
