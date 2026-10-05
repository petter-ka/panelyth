package preview

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"fastview/sidecar/internal/fixture"
	"fastview/sidecar/internal/index"
	"fastview/sidecar/internal/media"
	"fastview/sidecar/internal/pathkey"
	"fastview/sidecar/internal/scan"
)

// coverRig adds folders to the photo root: "album" (6 images), "single"
// (1 image, 1 video without ffmpeg, a text file) and "empty" (text only).
func newCoverRig(t *testing.T) (*rig, map[string]int64, *[]CoverItem, *sync.Mutex) {
	t.Helper()
	r := newRigWith(t, fixture.ImageSpec{Count: 1, Width: 64, Height: 48}, nil, func(root string) {
		if err := fixture.GenerateImages(filepath.Join(root, "album"), fixture.ImageSpec{Count: 6, Width: 320, Height: 240}); err != nil {
			t.Fatal(err)
		}
		if err := fixture.GenerateImages(filepath.Join(root, "single"), fixture.ImageSpec{Count: 1, Width: 320, Height: 240}); err != nil {
			t.Fatal(err)
		}
		for _, f := range []string{"single/clip.mp4", "single/notes.txt", "empty/readme.txt"} {
			p := filepath.Join(root, filepath.FromSlash(f))
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	})
	var mu sync.Mutex
	var got []CoverItem
	r.svc.SetCoverEmitter(func(it CoverItem) {
		mu.Lock()
		got = append(got, it)
		mu.Unlock()
	})
	paths, err := r.store.EntryPaths(bg, r.ids())
	if err != nil {
		t.Fatal(err)
	}
	dirs := map[string]int64{}
	for _, p := range paths {
		if p.Kind == media.KindDir {
			dirs[filepath.Base(p.Path)] = p.ID
		}
	}
	if len(dirs) != 3 {
		t.Fatalf("folders: %v", dirs)
	}
	return r, dirs, &got, &mu
}

func (r *rig) covers(epoch uint64, ids ...int64) map[int64]FolderCover {
	r.t.Helper()
	req := CoversRequest{Lane: "covers", Epoch: epoch, Profile: GridMd}
	for _, id := range ids {
		req.Items = append(req.Items, EnsureItem{ID: id, Priority: PriorityVisible})
	}
	res, err := r.svc.Covers(bg, req)
	if err != nil {
		r.t.Fatal(err)
	}
	out := map[int64]FolderCover{}
	for _, fc := range res {
		out[fc.DirID] = fc
	}
	return out
}

func cacheFiles(t *testing.T, root string) int {
	t.Helper()
	n := 0
	err := filepath.WalkDir(filepath.Join(root, "thumbnails"), func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			n++
		}
		return err
	})
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return n
}

func TestCoversGenerateOnlyFirstFourThenHit(t *testing.T) {
	r, dirs, got, mu := newCoverRig(t)
	album, single, empty := dirs["album"], dirs["single"], dirs["empty"]

	cold := r.covers(1, album, single, empty)
	if n := len(cold[album].Slots); n != MaxCovers {
		t.Fatalf("album slots = %d", n)
	}
	for _, s := range cold[album].Slots {
		if !s.Pending {
			t.Fatalf("cold slot not pending: %+v", s)
		}
	}
	// Without ffmpeg the video is not a cover candidate; text never is.
	if n := len(cold[single].Slots); n != 1 {
		t.Fatalf("single slots = %d", n)
	}
	if fc, ok := cold[empty]; !ok || len(fc.Slots) != 0 {
		t.Fatalf("empty folder: %+v", fc)
	}

	deadline := time.Now().Add(20 * time.Second)
	for {
		mu.Lock()
		n := len(*got)
		mu.Unlock()
		if n == MaxCovers+1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d covers arrived", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	for _, it := range *got {
		if it.URL == "" || it.Failed != "" || it.Profile != GridMd {
			t.Fatalf("cover item: %+v", it)
		}
	}
	mu.Unlock()
	// Only the covers were generated: the other two album images were not.
	if n := cacheFiles(t, r.cache); n != MaxCovers+1 {
		t.Fatalf("cache files = %d, want %d", n, MaxCovers+1)
	}

	warm := r.covers(2, album)
	for _, s := range warm[album].Slots {
		if s.URL == "" || s.Pending {
			t.Fatalf("warm slot: %+v", s)
		}
	}
}

func TestCoversShareCacheWithOpenedFolder(t *testing.T) {
	r, dirs, got, mu := newCoverRig(t)
	r.covers(1, dirs["album"])
	deadline := time.Now().Add(20 * time.Second)
	for {
		mu.Lock()
		n := len(*got)
		mu.Unlock()
		if n == MaxCovers {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d covers arrived", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Open the album: its first four files are cache hits without generation.
	info, err := r.store.EnsureDir(bg, filepath.Join(r.root, "album"))
	if err != nil {
		t.Fatal(err)
	}
	if st := scan.Run(bg, r.store, quiet, scan.Options{}, scan.Hooks{}, 2, r.store.NextGeneration(), info, false); st.State != scan.StateCompleted {
		t.Fatal(st.State)
	}
	dir, _ := r.store.Dir(bg, info.ID)
	ids, err := r.store.QueryIDs(bg, index.Descriptor{DirID: dir.ID, Sort: []index.SortKey{{Field: index.SortName}}}, dir.Key)
	if err != nil {
		t.Fatal(err)
	}
	res := r.ensure(3, ids)
	if len(res.Items) != MaxCovers || res.Queued != len(ids)-MaxCovers {
		t.Fatalf("hits=%d queued=%d of %d", len(res.Items), res.Queued, len(ids))
	}
}

func TestFindCoverSourcesSkipsHiddenAndVideosWithoutPosters(t *testing.T) {
	dir := t.TempDir()
	for _, f := range []string{".hidden.jpg", "b.jpg", "a.mp4", "c.png", "d.txt"} {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "sub.jpg"), 0o755); err != nil {
		t.Fatal(err)
	}
	key := pathkey.DirKey(dir)
	names := func(srcs []index.Source) []string {
		var out []string
		for _, s := range srcs {
			out = append(out, filepath.Base(s.Path))
		}
		return out
	}
	srcs, err := findCoverSources(bg, dir, key, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := names(srcs); len(got) != 2 || got[0] != "b.jpg" || got[1] != "c.png" {
		t.Fatalf("without video: %v", got)
	}
	srcs, err = findCoverSources(bg, dir, key, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := names(srcs); len(got) != 3 || got[0] != "a.mp4" {
		t.Fatalf("with video: %v", got)
	}
	if srcs[0].PathKey != pathkey.ChildKey(key, "a.mp4", false) {
		t.Fatalf("path key %q", srcs[0].PathKey)
	}
}

// BenchmarkFindCoverSources measures discovery in a folder of 10k files:
// "media" finds four images among the first entries, "none" holds no media
// and is bounded by coverScanLimit instead of a full listing.
func BenchmarkFindCoverSources(b *testing.B) {
	for _, tc := range []struct {
		name  string
		media bool
	}{{"media", true}, {"none", false}} {
		dir := b.TempDir()
		for i := range 10_000 {
			ext := ".txt"
			if tc.media && i%50 == 0 {
				ext = ".jpg"
			}
			if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%05d%s", i, ext)), nil, 0o644); err != nil {
				b.Fatal(err)
			}
		}
		key := pathkey.DirKey(dir)
		b.Run(tc.name, func(b *testing.B) {
			for b.Loop() {
				if _, err := findCoverSources(bg, dir, key, false); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
