package fixture

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// SyncSpec describes the compare and synchronize fixtures (Stage C08,
// docs/commander/TESTING.md "sync-pair").
type SyncSpec struct {
	// Pair writes left/ and right/ with every kind of difference: newer on
	// each side, missing on each side, another size, another content, and
	// folders that exist on one side only.
	Pair bool
	// Entries writes tree-a/ and tree-b/ with this many files each (100 per
	// folder) and a few differences per thousand.
	Entries int
	// TextBytes writes text-a.txt and text-b.txt of about this size: the
	// same numbered lines with a change every few thousand.
	TextBytes int64
	// HashBytes writes hash.bin of this size.
	HashBytes int64
}

// SyncPairDay is how far apart the dates of the pair's newer files are.
const SyncPairDay = 48 * time.Hour

// GenerateSync writes the fixtures under root. A marker file makes repeated
// calls with the same spec a no-op.
func GenerateSync(root string, spec SyncSpec) error {
	marker := filepath.Join(root, ".panelyth-fixture")
	want := fmt.Sprintf("sync %+v", spec)
	if b, err := os.ReadFile(marker); err == nil && string(b) == want {
		return nil
	}
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	if spec.Pair {
		if err := syncPair(root); err != nil {
			return err
		}
	}
	if spec.Entries > 0 {
		if err := syncTrees(root, spec.Entries); err != nil {
			return err
		}
	}
	if spec.TextBytes > 0 {
		if err := syncTexts(root, spec.TextBytes); err != nil {
			return err
		}
	}
	if spec.HashBytes > 0 {
		if err := syncHashFile(filepath.Join(root, "hash.bin"), spec.HashBytes); err != nil {
			return err
		}
	}
	return os.WriteFile(marker, []byte(want), 0o644)
}

// put writes a file dated baseTime plus age.
func put(path, data string, age time.Duration) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		return err
	}
	at := baseTime.Add(age)
	return os.Chtimes(path, at, at)
}

// SyncReadmeLeft and SyncReadmeRight are the pair's text files: one changed
// line and one line only on the right.
const (
	SyncReadmeLeft  = "Panelyth sync fixture\n\nalpha\nbeta\ngamma\ndelta\n"
	SyncReadmeRight = "Panelyth sync fixture\n\nalpha\nBETA (edited)\ngamma\ndelta\nepsilon\n"
)

func syncPair(root string) error {
	left, right := filepath.Join(root, "left"), filepath.Join(root, "right")
	files := []struct {
		root, rel, data string
		age             time.Duration
	}{
		// The same on both sides.
		{left, "same.txt", "same\n", 0}, {right, "same.txt", "same\n", 0},
		{left, "docs/deep/equal.bin", "12345", 0}, {right, "docs/deep/equal.bin", "12345", 0},
		// Newer on one side.
		{left, "newer.txt", "the new text\n", SyncPairDay}, {right, "newer.txt", "old\n", 0},
		{left, "older.txt", "old\n", 0}, {right, "older.txt", "newer on the right\n", SyncPairDay},
		{left, "docs/readme.txt", SyncReadmeLeft, 0}, {right, "docs/readme.txt", SyncReadmeRight, SyncPairDay},
		// The same date: another size, and the same size with other bytes.
		{left, "size.txt", "12345", 0}, {right, "size.txt", "123456789", 0},
		{left, "content.bin", "AAAA", 0}, {right, "content.bin", "AAAB", 0},
		// On one side only, files and folders.
		{left, "only-left.txt", "left\n", 0},
		{left, "photos/new/a.jpg", "a", 0}, {left, "photos/new/b.jpg", "bb", 0},
		{right, "only-right.txt", "right\n", 0},
		{right, "old/gone.txt", "gone\n", 0},
	}
	for _, f := range files {
		if err := put(filepath.Join(f.root, filepath.FromSlash(f.rel)), f.data, f.age); err != nil {
			return err
		}
	}
	// An empty folder on the right only.
	return os.MkdirAll(filepath.Join(right, "empty"), 0o755)
}

// syncTrees writes two trees of n files each, 100 per folder in two levels.
// Per thousand files: about ten are newer in tree-a, ten are missing in
// tree-b, ten exist only in tree-b and nine differ in size.
func syncTrees(root string, n int) error {
	a, b := filepath.Join(root, "tree-a"), filepath.Join(root, "tree-b")
	const perDir, perGroup = 100, 32
	write := func(path string, size int, age time.Duration) error {
		if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
			return err
		}
		at := baseTime.Add(age)
		return os.Chtimes(path, at, at)
	}
	for i := 0; i < n; i += perDir {
		dir := filepath.Join(fmt.Sprintf("group%03d", i/perDir/perGroup), fmt.Sprintf("folder%03d", i/perDir%perGroup))
		for _, side := range []string{a, b} {
			if err := os.MkdirAll(filepath.Join(side, dir), 0o755); err != nil {
				return err
			}
		}
		for k := i; k < min(i+perDir, n); k++ {
			name := fmt.Sprintf("file%06d.dat", k)
			age := time.Duration(k%50_000) * time.Minute
			size := k % 17
			ageA, sizeB := age, size
			inB := true
			switch {
			case k%97 == 0:
				ageA = age + 24*time.Hour
			case k%101 == 0:
				inB = false
			case k%107 == 0:
				sizeB = size + 1
			}
			if err := write(filepath.Join(a, dir, name), size, ageA); err != nil {
				return err
			}
			if inB {
				if err := write(filepath.Join(b, dir, name), sizeB, age); err != nil {
					return err
				}
			}
			if k%103 == 0 {
				if err := write(filepath.Join(b, dir, fmt.Sprintf("extra%06d.dat", k)), 3, age); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// syncTexts writes two versions of a numbered text: every 5,000th line is
// edited, every 7,000th removed, and a line is inserted after every 9,000th.
func syncTexts(root string, size int64) error {
	fa, err := os.Create(filepath.Join(root, "text-a.txt"))
	if err != nil {
		return err
	}
	defer fa.Close()
	fb, err := os.Create(filepath.Join(root, "text-b.txt"))
	if err != nil {
		return err
	}
	defer fb.Close()
	wa, wb := bufio.NewWriterSize(fa, 1<<20), bufio.NewWriterSize(fb, 1<<20)
	var written int64
	for i := 1; written < size; i++ {
		line := fmt.Sprintf("line %08d: the quick brown fox jumps over the lazy dog, %d times\n", i, i%977)
		n, _ := wa.WriteString(line)
		written += int64(n)
		switch {
		case i%5000 == 0:
			fmt.Fprintf(wb, "line %08d: this line was edited in the second version\n", i)
		case i%7000 == 0:
		default:
			_, _ = wb.WriteString(line)
		}
		if i%9000 == 0 {
			fmt.Fprintf(wb, "an inserted line after %d\n", i)
		}
	}
	if err := wa.Flush(); err != nil {
		return err
	}
	return wb.Flush()
}

// syncHashFile writes size bytes that do not compress or repeat.
func syncHashFile(path string, size int64) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	buf := make([]byte, 1<<20)
	x := uint64(0x9E3779B97F4A7C15)
	for written := int64(0); written < size; {
		for i := 0; i+8 <= len(buf); i += 8 {
			x ^= x << 13
			x ^= x >> 7
			x ^= x << 17
			buf[i], buf[i+1], buf[i+2], buf[i+3] = byte(x), byte(x>>8), byte(x>>16), byte(x>>24)
			buf[i+4], buf[i+5], buf[i+6], buf[i+7] = byte(x>>32), byte(x>>40), byte(x>>48), byte(x>>56)
		}
		n := min(int64(len(buf)), size-written)
		if _, err := f.Write(buf[:n]); err != nil {
			return err
		}
		written += n
	}
	return nil
}
