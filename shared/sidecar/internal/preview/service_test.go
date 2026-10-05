package preview

import (
	"context"
	"image/jpeg"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"fastview/sidecar/internal/fixture"
	"fastview/sidecar/internal/imaging"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/scan"
	"fastview/sidecar/internal/video"
)

var quiet = slog.New(slog.DiscardHandler)
var bg = context.Background()

type rig struct {
	t      *testing.T
	root   string
	cache  string
	dbPath string
	store  *index.Store
	disk   *DiskCache
	svc    *Service
	dir    index.DirInfo

	video *video.Tools // nil: no ffmpeg

	mu    sync.Mutex
	items map[int64]Item
	count int
}

func newRig(t *testing.T, images fixture.ImageSpec) *rig {
	t.Helper()
	return newRigWith(t, images, nil, nil)
}

// newRigWith also runs prepare(root) before the first scan (extra files).
func newRigWith(t *testing.T, images fixture.ImageSpec, tools *video.Tools, prepare func(root string)) *rig {
	t.Helper()
	base := t.TempDir()
	r := &rig{t: t, root: filepath.Join(base, "photos"), cache: filepath.Join(base, "cache"),
		dbPath: filepath.Join(base, "cache", "db", "index.db"), items: map[int64]Item{}, video: tools}
	if err := fixture.GenerateImages(r.root, images); err != nil {
		t.Fatal(err)
	}
	if prepare != nil {
		prepare(r.root)
	}
	r.open()
	t.Cleanup(r.close)
	r.scan()
	return r
}

func (r *rig) open() {
	var err error
	if r.store, err = index.Open(r.dbPath, quiet); err != nil {
		r.t.Fatal(err)
	}
	if r.disk, err = OpenDiskCache(r.cache); err != nil {
		r.t.Fatal(err)
	}
	r.svc = NewService(r.store, r.disk, quiet, Options{Workers: 4, FlushInterval: 20 * time.Millisecond, Video: r.video}, func(it Item) {
		r.mu.Lock()
		r.items[it.ID] = it
		r.count++
		r.mu.Unlock()
	})
}

func (r *rig) close() {
	if r.svc != nil {
		r.svc.Close()
		_ = r.store.Close()
		r.svc = nil
	}
}

func (r *rig) restart() {
	r.close()
	r.open()
}

func (r *rig) scan() {
	info, err := r.store.EnsureDir(bg, r.root)
	if err != nil {
		r.t.Fatal(err)
	}
	gen := r.store.NextGeneration()
	if st := scan.Run(bg, r.store, quiet, scan.Options{}, scan.Hooks{}, 1, gen, info, false); st.State != scan.StateCompleted {
		r.t.Fatal(st.State)
	}
	r.dir, _ = r.store.Dir(bg, info.ID)
}

func (r *rig) ids() []int64 {
	ids, err := r.store.QueryIDs(bg, index.Descriptor{DirID: r.dir.ID, Sort: []index.SortKey{{Field: index.SortName}}}, r.dir.Key)
	if err != nil {
		r.t.Fatal(err)
	}
	return ids
}

func (r *rig) ensure(epoch uint64, ids []int64, force ...int64) EnsureResult {
	r.t.Helper()
	req := EnsureRequest{Lane: "grid", Epoch: epoch, Profile: GridMd, Force: force}
	for _, id := range ids {
		req.Items = append(req.Items, EnsureItem{ID: id, Priority: PriorityVisible})
	}
	res, err := r.svc.Ensure(bg, req)
	if err != nil {
		r.t.Fatal(err)
	}
	return res
}

func (r *rig) waitItems(ids []int64) map[int64]Item {
	r.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		r.mu.Lock()
		n := 0
		for _, id := range ids {
			if _, ok := r.items[id]; ok {
				n++
			}
		}
		if n == len(ids) {
			out := make(map[int64]Item, len(ids))
			for _, id := range ids {
				out[id] = r.items[id]
			}
			r.mu.Unlock()
			return out
		}
		r.mu.Unlock()
		if time.Now().After(deadline) {
			r.t.Fatalf("only %d of %d previews arrived", n, len(ids))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (r *rig) reset() {
	r.mu.Lock()
	r.items, r.count = map[int64]Item{}, 0
	r.mu.Unlock()
}

func filePath(url string, disk *DiskCache) string {
	name := strings.TrimPrefix(url, "fastview-thumb://t/")
	dot := strings.LastIndexByte(name, '.')
	k, _ := ParseKey(name[:dot])
	return disk.Path(k, imaging.Format(name[dot+1:]))
}

func TestGenerateThenHitThenRestartHits(t *testing.T) {
	r := newRig(t, fixture.ImageSpec{Count: 12, Width: 1200, Height: 800, PNGAlphaEvery: 4, RotatedEvery: 5})
	ids := r.ids()
	first := r.ensure(1, ids)
	if first.Queued != len(ids) || len(first.Items) != 0 {
		t.Fatalf("cold ensure: %+v", first)
	}
	got := r.waitItems(ids)
	for id, it := range got {
		if it.Failed != "" || it.URL == "" {
			t.Fatalf("item %d: %+v", id, it)
		}
		if _, err := os.Stat(filePath(it.URL, r.disk)); err != nil {
			t.Fatalf("cache file missing for %d: %v", id, err)
		}
	}
	// PNG with alpha stays PNG; EXIF-rotated JPEG preview is portrait.
	var sawPNG, sawPortrait bool
	for _, it := range got {
		sawPNG = sawPNG || strings.HasSuffix(it.URL, ".png")
		sawPortrait = sawPortrait || it.Height > it.Width
	}
	if !sawPNG || !sawPortrait {
		t.Fatalf("png=%v portrait=%v", sawPNG, sawPortrait)
	}

	// Warm: every item is a hit, returned synchronously, nothing queued.
	warm := r.ensure(2, ids)
	if warm.Queued != 0 || len(warm.Items) != len(ids) {
		t.Fatalf("warm ensure: queued=%d items=%d", warm.Queued, len(warm.Items))
	}

	// Restart: new process state, same disk cache and index.
	r.restart()
	r.reset()
	again := r.ensure(1, ids)
	if again.Queued != 0 || len(again.Items) != len(ids) {
		t.Fatalf("after restart: queued=%d items=%d", again.Queued, len(again.Items))
	}

	// Page thumbnails come straight from the cache index.
	items, _ := r.store.LoadItems(bg, ids)
	thumbs, err := r.svc.Thumbs(bg, items, GridMd)
	if err != nil || len(thumbs) != len(ids) {
		t.Fatalf("thumbs %d %v", len(thumbs), err)
	}
}

func TestModifiedSourceIsACacheMiss(t *testing.T) {
	r := newRig(t, fixture.ImageSpec{Count: 2, Width: 800, Height: 600})
	ids := r.ids()
	r.ensure(1, ids)
	before := r.waitItems(ids)[ids[0]].URL

	// Replace the file in place (same name) and rescan.
	src := filepath.Join(r.root, "photo_0000.jpg")
	f, _ := os.Create(src)
	_ = jpeg.Encode(f, fixture.Pattern(640, 640, 99), nil)
	_ = f.Close()
	later := time.Now().Add(time.Minute)
	_ = os.Chtimes(src, later, later)
	r.scan()
	r.reset()
	res := r.ensure(2, ids[:1])
	if res.Queued != 1 {
		t.Fatalf("modified source must miss: %+v", res)
	}
	after := r.waitItems(ids[:1])[ids[0]]
	if after.URL == before || after.Width != after.Height {
		t.Fatalf("stale preview served: before %s after %+v", before, after)
	}
}

func TestChangedSourceWithoutRescanUpdatesIdentity(t *testing.T) {
	r := newRig(t, fixture.ImageSpec{Count: 1, Width: 800, Height: 600})
	ids := r.ids()
	src := filepath.Join(r.root, "photo_0000.jpg")
	f, _ := os.Create(src)
	_ = jpeg.Encode(f, fixture.Pattern(300, 600, 5), nil)
	_ = f.Close()
	later := time.Now().Add(time.Hour)
	_ = os.Chtimes(src, later, later)
	r.ensure(1, ids)
	it := r.waitItems(ids)[ids[0]]
	if it.Height <= it.Width {
		t.Fatalf("preview reflects the old file: %+v", it)
	}
	srcs, _ := r.store.Sources(bg, ids)
	if srcs[ids[0]].MtimeNs != later.UnixNano() {
		t.Fatal("index identity not updated")
	}
}

func TestCorruptCacheFileIsRegenerated(t *testing.T) {
	r := newRig(t, fixture.ImageSpec{Count: 1, Width: 800, Height: 600})
	ids := r.ids()
	r.ensure(1, ids)
	it := r.waitItems(ids)[ids[0]]
	path := filePath(it.URL, r.disk)
	if err := os.WriteFile(path, []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	r.reset()
	// The renderer's <img> fails to decode and asks again with force.
	res := r.ensure(2, ids, ids[0])
	if res.Queued != 1 {
		t.Fatalf("forced ensure should regenerate: %+v", res)
	}
	regen := r.waitItems(ids)[ids[0]]
	data, _ := os.ReadFile(filePath(regen.URL, r.disk))
	if len(data) < 100 {
		t.Fatal("cache file was not rewritten")
	}
}

func TestBrokenSourcesFailPermanently(t *testing.T) {
	r := newRig(t, fixture.ImageSpec{Count: 1, Width: 400, Height: 300})
	if err := os.WriteFile(filepath.Join(r.root, "broken.jpg"), []byte("not an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r.root, "clip.mp4"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	r.scan()
	items, _ := r.store.LoadItems(bg, r.ids())
	var broken, video int64
	for _, it := range items {
		switch it.Name {
		case "broken.jpg":
			broken = it.ID
		case "clip.mp4":
			video = it.ID
		}
	}
	res := r.ensure(1, []int64{broken, video})
	if len(res.Items) != 1 || res.Items[0].ID != video || res.Items[0].Failed != "UNSUPPORTED_MEDIA" {
		t.Fatalf("without ffmpeg a video should fail immediately: %+v", res.Items)
	}
	if got := r.waitItems([]int64{broken})[broken]; got.Failed != "CORRUPT_MEDIA" {
		t.Fatalf("broken: %+v", got)
	}
	// Not retried: the failure is served from the index, nothing is queued.
	again := r.ensure(2, []int64{broken})
	if again.Queued != 0 || len(again.Items) != 1 || again.Items[0].Failed != "CORRUPT_MEDIA" {
		t.Fatalf("permanent failure retried: %+v", again)
	}
}

func TestCleanerEvictsLRUAndOrphans(t *testing.T) {
	r := newRig(t, fixture.ImageSpec{Count: 10, Width: 800, Height: 600})
	ids := r.ids()
	r.ensure(1, ids)
	r.waitItems(ids)
	total, _ := r.store.PreviewBytes(bg)
	orphan := r.disk.Path(MakeKey("/nowhere", 1, 1, GridMd), imaging.FormatJPEG)
	_ = os.MkdirAll(filepath.Dir(orphan), 0o755)
	_ = os.WriteFile(orphan, []byte("x"), 0o644)

	c := NewCleaner(r.store, r.disk, quiet, total/2)
	res, err := c.RunOnce(bg, 256)
	if err != nil {
		t.Fatal(err)
	}
	if res.TotalBytesNow > total/2/10*9 || res.EvictedFiles == 0 {
		t.Fatalf("not evicted to 90%% of ceiling: %+v (total %d)", res, total)
	}
	if res.OrphanFiles != 1 {
		t.Fatalf("orphans removed %d", res.OrphanFiles)
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatal("orphan still on disk")
	}
	// Evicted previews regenerate on the next request.
	r.reset()
	res2 := r.ensure(2, ids)
	if res2.Queued != res.EvictedFiles {
		t.Fatalf("queued %d, evicted %d", res2.Queued, res.EvictedFiles)
	}
	for _, f := range []string{"photo_0000.jpg"} {
		if _, err := os.Stat(filepath.Join(r.root, f)); err != nil {
			t.Fatal("cleanup must never touch source images")
		}
	}
}

func TestKeyChangesWithIdentityAndProfile(t *testing.T) {
	base := MakeKey("/a/b.jpg", 10, 20, GridMd)
	for name, k := range map[string]Key{
		"path":    MakeKey("/a/c.jpg", 10, 20, GridMd),
		"size":    MakeKey("/a/b.jpg", 11, 20, GridMd),
		"mtime":   MakeKey("/a/b.jpg", 10, 21, GridMd),
		"profile": MakeKey("/a/b.jpg", 10, 20, GridSm),
	} {
		if k == base {
			t.Errorf("key ignores %s", name)
		}
	}
	if MakeKey("/a/b.jpg", 10, 20, GridMd) != base {
		t.Fatal("key not deterministic")
	}
	if k, err := ParseKey(base.Hex()); err != nil || k != base {
		t.Fatal("hex round trip")
	}
	if _, err := ParseKey("../../etc"); err == nil {
		t.Fatal("bad key parsed")
	}
}

func TestDiskCacheClearsTmpAndWritesAtomically(t *testing.T) {
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "tmp"), 0o755)
	_ = os.WriteFile(filepath.Join(root, "tmp", "w-partial"), []byte("half"), 0o644)
	c, err := OpenDiskCache(root)
	if err != nil {
		t.Fatal(err)
	}
	if left, _ := os.ReadDir(filepath.Join(root, "tmp")); len(left) != 0 {
		t.Fatal("tmp leftovers not cleared")
	}
	k := MakeKey("/x", 1, 1, GridSm)
	if _, err := c.Write(k, imaging.FormatJPEG, []byte("data")); err != nil {
		t.Fatal(err)
	}
	h := k.Hex()
	want := filepath.Join(root, "thumbnails", h[:2], h[2:4], h+".jpg")
	if c.Path(k, imaging.FormatJPEG) != want {
		t.Fatalf("path %s", c.Path(k, imaging.FormatJPEG))
	}
	if left, _ := os.ReadDir(filepath.Join(root, "tmp")); len(left) != 0 {
		t.Fatal("temp file left after write")
	}
	if err := c.Remove(k, imaging.FormatPNG); err != nil {
		t.Fatal("removing a missing file must not fail")
	}
}
