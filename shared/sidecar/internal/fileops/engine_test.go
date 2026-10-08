package fileops

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"fastview/sidecar/internal/fsx"
)

// Engine v2 (Stage P03, ADR-0029).

func randomFile(t testing.TB, path string, size int) []byte {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	b := make([]byte, size)
	_, _ = rand.Read(b)
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return b
}

// readOnly reports the read-only state the way each platform keeps it.
func readOnly(t testing.TB, path string) bool {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Mode().Perm()&0o200 == 0
}

func setReadOnly(t testing.TB, path string) {
	t.Helper()
	if err := os.Chmod(path, 0o444); err != nil {
		t.Fatal(err)
	}
}

func TestFastPathAndPortableCopyAgree(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	data := randomFile(t, src, 5<<20+123)
	mtime := time.Date(2019, 3, 4, 5, 6, 7, 0, time.UTC)
	atime := time.Date(2021, 1, 2, 3, 4, 5, 0, time.UTC)
	setReadOnly(t, src)
	t.Cleanup(func() { _ = os.Chmod(src, 0o644) })
	for _, portable := range []bool{false, true} {
		t.Run(fmt.Sprintf("portable=%v", portable), func(t *testing.T) {
			// Per run: reading the source for the previous copy may have
			// moved its access time (Linux relatime).
			if err := os.Chtimes(src, atime, mtime); err != nil {
				t.Fatal(err)
			}
			noFastPath = portable
			t.Cleanup(func() { noFastPath = false })
			dst := filepath.Join(dir, fmt.Sprintf("out-%v.bin", portable))
			var reported int64
			if err := CopyFile(context.Background(), src, dst, false, &CopyOptions{Progress: func(n int64) { reported += n }}); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Chmod(dst, 0o644) })
			// Before reading it: a read may update the access time.
			if fi, err := os.Stat(dst); err == nil {
				if at := fsx.FileTimes(fi).AccessNs; at != 0 && !time.Unix(0, at).Equal(atime) {
					t.Errorf("atime %v, want %v", time.Unix(0, at).UTC(), atime)
				}
			}
			got, _ := os.ReadFile(dst)
			if !bytes.Equal(got, data) {
				t.Fatal("bytes differ")
			}
			if reported != int64(len(data)) {
				t.Errorf("progress %d, want %d", reported, len(data))
			}
			fi, _ := os.Stat(dst)
			if !fi.ModTime().Equal(mtime) {
				t.Errorf("mtime %v, want %v", fi.ModTime(), mtime)
			}
			if !readOnly(t, dst) {
				t.Error("read-only attribute not kept")
			}
		})
	}
}

func TestReplaceReadOnlyTarget(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "a.txt"), filepath.Join(dir, "b.txt")
	randomFile(t, src, 100)
	randomFile(t, dst, 10)
	setReadOnly(t, dst)
	t.Cleanup(func() { _ = os.Chmod(dst, 0o644) })
	if err := CopyFile(context.Background(), src, dst, true, nil); err != nil {
		t.Fatalf("replace a read-only file: %v", err)
	}
	if fi, _ := os.Stat(dst); fi.Size() != 100 {
		t.Errorf("size %d", fi.Size())
	}
}

func TestLongPaths(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("MAX_PATH is a Windows limit")
	}
	dir := t.TempDir()
	deep := dir
	for len(deep) < 300 {
		deep = filepath.Join(deep, strings.Repeat("d", 40))
	}
	src := filepath.Join(deep, "source-file-with-a-long-name.bin")
	data := randomFile(t, src, 2<<20)
	dst := filepath.Join(deep, "copy-of-the-source-file.bin")
	if err := CopyFile(context.Background(), src, dst, false, &CopyOptions{Verify: true}); err != nil {
		t.Fatalf("copy at %d characters: %v", len(dst), err)
	}
	if got, _ := os.ReadFile(dst); !bytes.Equal(got, data) {
		t.Error("bytes differ")
	}
	if got := LongPath(dst); !strings.HasPrefix(got, `\\?\`) {
		t.Errorf("LongPath(%d chars) = %q", len(dst), got[:12])
	}
	if LongPath(`C:\short`) != `C:\short` || LongPath(`\\srv\share\`+strings.Repeat("x", 300)) != `\\?\UNC\srv\share\`+strings.Repeat("x", 300) {
		t.Error("LongPath prefixes")
	}
}

func TestVerifyCatchesAMismatch(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.bin")
	randomFile(t, src, 3<<20)
	if err := CopyFile(context.Background(), src, filepath.Join(dir, "ok.bin"), false, &CopyOptions{Verify: true}); err != nil {
		t.Fatalf("verified copy: %v", err)
	}
	testAfterCopy = func(target string) {
		f, err := os.OpenFile(target, os.O_WRONLY, 0)
		if err != nil {
			t.Error(err)
			return
		}
		_, _ = f.WriteAt([]byte{0xff, 0x00, 0xff}, 1<<20)
		_ = f.Close()
	}
	t.Cleanup(func() { testAfterCopy = nil })
	dst := filepath.Join(dir, "bad.bin")
	err := CopyFile(context.Background(), src, dst, false, &CopyOptions{Verify: true})
	if Code(err) != CodeVerify {
		t.Fatalf("err = %v, want %s", err, CodeVerify)
	}
	if exists(dst) || exists(PartialName(dir, "bad.bin")) {
		t.Error("a copy that failed verification was kept")
	}
	// Without verification the same corruption goes unnoticed (the reason for the option).
	if err := CopyFile(context.Background(), src, dst, false, nil); err != nil {
		t.Fatal(err)
	}
}

func TestLinksPerMode(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "album")
	randomFile(t, filepath.Join(src, "a.jpg"), 10)
	if err := os.Symlink("a.jpg", filepath.Join(src, "link.jpg")); err != nil {
		t.Skip("symlinks need Developer Mode or admin on Windows:", err)
	}
	var skipped []string
	if err := CopyTree(context.Background(), src, filepath.Join(dir, "viewer"), &CopyOptions{
		Skipped: func(p string) { skipped = append(skipped, p) },
	}); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(dir, "viewer", "link.jpg")) || len(skipped) != 1 {
		t.Errorf("viewer: link copied or not reported (%v)", skipped)
	}
	if err := CopyTree(context.Background(), src, filepath.Join(dir, "commander"), &CopyOptions{Links: LinksCopy}); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Lstat(filepath.Join(dir, "commander", "link.jpg"))
	if err != nil || fi.Mode()&fs.ModeSymlink == 0 {
		t.Fatalf("commander: link not copied as a link: %v", err)
	}
	if target, _ := os.Readlink(filepath.Join(dir, "commander", "link.jpg")); target != "a.jpg" {
		t.Errorf("link target %q", target)
	}
}

func TestMoveAcrossVolumes(t *testing.T) {
	dir := t.TempDir()
	renameItem = func(a, b string) error { return &os.LinkError{Op: "rename", Old: a, New: b, Err: errCrossDevice} }
	t.Cleanup(func() { renameItem = os.Rename })
	src := filepath.Join(dir, "a.bin")
	data := randomFile(t, src, 1<<20)
	mtime := time.Date(2018, 1, 1, 0, 0, 0, 0, time.UTC)
	_ = os.Chtimes(src, mtime, mtime)
	dst := filepath.Join(dir, "other", "a.bin")
	_ = os.MkdirAll(filepath.Dir(dst), 0o755)
	if err := Move(context.Background(), src, dst, false, false, &CopyOptions{Verify: true}); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(dst)
	fi, _ := os.Stat(dst)
	if exists(src) || !bytes.Equal(got, data) || !fi.ModTime().Equal(mtime) {
		t.Errorf("cross-volume move: src left=%v bytes ok=%v mtime=%v", exists(src), bytes.Equal(got, data), fi.ModTime())
	}
	// A folder moves as a copy plus a removal.
	randomFile(t, filepath.Join(dir, "tree", "x", "y.bin"), 100)
	if err := Move(context.Background(), filepath.Join(dir, "tree"), filepath.Join(dir, "other", "tree"), true, false, nil); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(dir, "tree")) || !exists(filepath.Join(dir, "other", "tree", "x", "y.bin")) {
		t.Error("cross-volume folder move")
	}
}

func TestMergeDecisions(t *testing.T) {
	for _, move := range []bool{false, true} {
		t.Run(fmt.Sprintf("move=%v", move), func(t *testing.T) {
			dir := t.TempDir()
			src, dst := filepath.Join(dir, "src"), filepath.Join(dir, "dst")
			randomFile(t, filepath.Join(src, "new.txt"), 5)
			randomFile(t, filepath.Join(src, "same.txt"), 7)
			randomFile(t, filepath.Join(src, "keep.txt"), 9)
			randomFile(t, filepath.Join(src, "both.txt"), 11)
			randomFile(t, filepath.Join(src, "aside.txt"), 13)
			randomFile(t, filepath.Join(src, "sub", "deep.txt"), 3)
			randomFile(t, filepath.Join(dst, "same.txt"), 1)
			randomFile(t, filepath.Join(dst, "keep.txt"), 1)
			randomFile(t, filepath.Join(dst, "both.txt"), 1)
			randomFile(t, filepath.Join(dst, "aside.txt"), 1)
			randomFile(t, filepath.Join(dst, "sub", "other.txt"), 1)
			decide := map[string]MergeDecision{
				"same.txt": MergeReplace, "keep.txt": MergeSkip, "both.txt": MergeRenameNew, "aside.txt": MergeRenameExisting,
			}
			var asked []string
			o := &CopyOptions{Conflict: func(_ context.Context, c MergeConflict) (MergeDecision, error) {
				asked = append(asked, filepath.Base(c.Target))
				return decide[filepath.Base(c.Target)], nil
			}}
			var err error
			if move {
				err = MergeMove(context.Background(), src, dst, o)
			} else {
				err = MergeCopy(context.Background(), src, dst, o)
			}
			if err != nil {
				t.Fatal(err)
			}
			size := func(name string) int64 {
				fi, err := os.Stat(filepath.Join(dst, name))
				if err != nil {
					return -1
				}
				return fi.Size()
			}
			want := map[string]int64{"new.txt": 5, "same.txt": 7, "keep.txt": 1, "both.txt": 1, "both (2).txt": 11,
				"aside.txt": 13, "aside (2).txt": 1, "sub/deep.txt": 3, "sub/other.txt": 1}
			for name, n := range want {
				if got := size(filepath.FromSlash(name)); got != n {
					t.Errorf("%s: size %d, want %d", name, got, n)
				}
			}
			if len(asked) != 4 {
				t.Errorf("asked about %v", asked)
			}
			// A move leaves only what was skipped; the source folder stays for it.
			if move && (!exists(filepath.Join(src, "keep.txt")) || exists(filepath.Join(src, "new.txt")) || exists(filepath.Join(src, "sub"))) {
				t.Error("move merge: sources")
			}
		})
	}
}

func TestSmallFilesInFlight(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "many")
	want := map[string][]byte{}
	for i := range 300 {
		name := fmt.Sprintf("f%03d.bin", i)
		want[name] = randomFile(t, filepath.Join(src, name), 1000+i)
	}
	randomFile(t, filepath.Join(src, "big.bin"), int(SmallFile)+1)
	var total atomic.Int64
	var mu sync.Mutex
	if err := CopyTree(context.Background(), src, filepath.Join(dir, "copy"), &CopyOptions{InFlight: 4, Progress: func(n int64) {
		mu.Lock()
		total.Add(n)
		mu.Unlock()
	}}); err != nil {
		t.Fatal(err)
	}
	for name, data := range want {
		if got, err := os.ReadFile(filepath.Join(dir, "copy", name)); err != nil || !bytes.Equal(got, data) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	size, _ := TreeSize(context.Background(), src)
	if total.Load() != size {
		t.Errorf("progress %d of %d", total.Load(), size)
	}
	// A failure stops the copy and leaves nothing under the final name.
	randomFile(t, filepath.Join(src, "zz-bad", "x.bin"), 10)
	err := CopyTree(context.Background(), src, filepath.Join(dir, "copy2"), &CopyOptions{InFlight: 4, WindowsNames: true,
		Progress: func(int64) {}})
	if err != nil {
		t.Fatalf("valid names refused: %v", err)
	}
}

func TestWindowsNamesOnTheDestination(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("such names can't be created on Windows to begin with")
	}
	dir := t.TempDir()
	randomFile(t, filepath.Join(dir, "src", `a:b.txt`), 1)
	err := CopyTree(context.Background(), filepath.Join(dir, "src"), filepath.Join(dir, "fat"), &CopyOptions{WindowsNames: true})
	if Code(err) != CodeInvalidName {
		t.Fatalf("err = %v", err)
	}
	if exists(filepath.Join(dir, "fat")) || exists(PartialName(dir, "fat")) {
		t.Error("partial tree left behind")
	}
}

func TestGatePausesAndCancels(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "big.bin")
	randomFile(t, src, 64<<20)
	for _, portable := range []bool{false, true} {
		t.Run(fmt.Sprintf("portable=%v", portable), func(t *testing.T) {
			noFastPath = portable
			t.Cleanup(func() { noFastPath = false })
			release := make(chan struct{})
			var once sync.Once
			var copied atomic.Int64
			var paused atomic.Bool
			gate := func(ctx context.Context) error {
				if copied.Load() > 0 {
					once.Do(func() { paused.Store(true) })
					select {
					case <-release:
					case <-ctx.Done():
						return ctx.Err()
					}
				}
				return ctx.Err()
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			dst := filepath.Join(dir, fmt.Sprintf("out-%v.bin", portable))
			if !portable && runtime.GOOS == "darwin" {
				// APFS clones the file in one step: no bytes stream, so there
				// is no pause point. The clone completes and reports it all.
				if err := CopyFile(ctx, src, dst, false, &CopyOptions{Gate: gate, Progress: func(n int64) { copied.Add(n) }}); err != nil {
					t.Fatal(err)
				}
				if copied.Load() != 64<<20 {
					t.Fatalf("progress %d after a clone", copied.Load())
				}
				if a, b := mustRead(t, src), mustRead(t, dst); !bytes.Equal(a, b) {
					t.Fatal("clone differs")
				}
				close(release)
				return
			}
			done := make(chan error, 1)
			go func() {
				done <- CopyFile(ctx, src, dst, false, &CopyOptions{Gate: gate, Progress: func(n int64) { copied.Add(n) }})
			}()
			deadline := time.Now().Add(5 * time.Second)
			for !paused.Load() && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			at := copied.Load()
			time.Sleep(150 * time.Millisecond)
			if copied.Load() != at || at >= 64<<20 {
				t.Fatalf("still copying while paused: %d → %d", at, copied.Load())
			}
			if !exists(PartialName(dir, filepath.Base(dst))) {
				t.Error("the partial file is kept while paused")
			}
			cancel() // cancel while paused
			if err := <-done; !errors.Is(err, context.Canceled) {
				t.Fatalf("err = %v", err)
			}
			if exists(dst) || exists(PartialName(dir, filepath.Base(dst))) {
				t.Error("cancelled copy left files behind")
			}
			close(release)
		})
	}
}

func mustRead(t testing.TB, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
