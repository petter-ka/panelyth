package fixture

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"path/filepath"
	"time"
)

// ArchiveSpec describes the archive fixtures (Stage C07): the e2e samples,
// a zip with many entries, a large tar.gz and a folder of small files to
// pack. Zero values skip a part.
type ArchiveSpec struct {
	// Samples writes set.zip, set.tar.gz and slip.zip (a zip-slip archive).
	Samples bool
	// ZipEntries writes many.zip with this many small entries in 100 folders.
	ZipEntries int
	// TgzBytes writes big.tar.gz with about this many bytes of content
	// (compressible about 2:1, like documents and logs).
	TgzBytes int64
	// PackFiles writes pack/ with this many 4 KiB files in 10 folders.
	PackFiles int
}

var archiveTime = time.Date(2024, 5, 6, 7, 8, 10, 0, time.UTC)

// SampleFiles are the entries of set.zip and set.tar.gz.
var SampleFiles = []struct{ Name, Data string }{
	{"docs/readme.txt", "read me first\n"},
	{"docs/sub/deep.txt", "deep inside\n"},
	{"notes.txt", "archive notes\n"},
}

// GenerateArchives writes the archive fixtures below root.
func GenerateArchives(root string, spec ArchiveSpec) error {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	// A marker makes repeated calls with the same spec cheap (big.tar.gz).
	marker := filepath.Join(root, ".fastview-archives")
	want := fmt.Sprintf("%+v", spec)
	if b, err := os.ReadFile(marker); err == nil && string(b) == want {
		return nil
	}
	if err := generateArchives(root, spec); err != nil {
		return err
	}
	return os.WriteFile(marker, []byte(want), 0o644)
}

func generateArchives(root string, spec ArchiveSpec) error {
	if spec.Samples {
		if err := writeZipFile(filepath.Join(root, "set.zip"), func(add func(string, []byte) error) error {
			for _, f := range SampleFiles {
				if err := add(f.Name, []byte(f.Data)); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return err
		}
		if err := writeSampleTgz(filepath.Join(root, "set.tar.gz")); err != nil {
			return err
		}
		if err := writeZipFile(filepath.Join(root, "slip.zip"), func(add func(string, []byte) error) error {
			if err := add("../escaped.txt", []byte("must never be written")); err != nil {
				return err
			}
			return add("good.txt", []byte("safe\n"))
		}); err != nil {
			return err
		}
	}
	if spec.ZipEntries > 0 {
		if err := writeZipFile(filepath.Join(root, "many.zip"), func(add func(string, []byte) error) error {
			for i := range spec.ZipEntries {
				if err := add(fmt.Sprintf("folder%02d/IMG_%06d.jpg", i%100, i), []byte("x")); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return err
		}
	}
	if spec.TgzBytes > 0 {
		if err := writeBigTgz(filepath.Join(root, "big.tar.gz"), spec.TgzBytes); err != nil {
			return err
		}
	}
	if spec.PackFiles > 0 {
		block := halfRandom(4096, 7)
		for i := range spec.PackFiles {
			p := filepath.Join(root, "pack", fmt.Sprintf("d%d", i%10), fmt.Sprintf("file%05d.txt", i))
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(p, block, 0o644); err != nil {
				return err
			}
		}
	}
	return nil
}

func writeZipFile(path string, fill func(add func(string, []byte) error) error) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	bw := bufio.NewWriterSize(f, 1<<20)
	z := zip.NewWriter(bw)
	err = fill(func(name string, data []byte) error {
		w, err := z.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: archiveTime})
		if err == nil {
			_, err = w.Write(data)
		}
		return err
	})
	if cerr := z.Close(); err == nil {
		err = cerr
	}
	if ferr := bw.Flush(); err == nil {
		err = ferr
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func writeSampleTgz(path string) error {
	return writeTgz(path, func(t *tar.Writer) error {
		for _, f := range SampleFiles {
			h := &tar.Header{Name: f.Name, Mode: 0o644, Size: int64(len(f.Data)), ModTime: archiveTime, Typeflag: tar.TypeReg}
			if err := t.WriteHeader(h); err != nil {
				return err
			}
			if _, err := io.WriteString(t, f.Data); err != nil {
				return err
			}
		}
		return nil
	})
}

// writeBigTgz writes 64 MiB files of half-random data until size.
func writeBigTgz(path string, size int64) error {
	const fileBytes = 64 << 20
	chunk := halfRandom(1<<20, 42)
	return writeTgz(path, func(t *tar.Writer) error {
		for i, left := 0, size; left > 0; i++ {
			n := min(left, fileBytes)
			h := &tar.Header{Name: fmt.Sprintf("data/part%03d.bin", i), Mode: 0o644, Size: n, ModTime: archiveTime, Typeflag: tar.TypeReg}
			if err := t.WriteHeader(h); err != nil {
				return err
			}
			for w := int64(0); w < n; {
				k := min(int64(len(chunk)), n-w)
				if _, err := t.Write(chunk[:k]); err != nil {
					return err
				}
				w += k
			}
			left -= n
		}
		return nil
	})
}

func writeTgz(path string, fill func(t *tar.Writer) error) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	bw := bufio.NewWriterSize(f, 1<<20)
	z, _ := gzip.NewWriterLevel(bw, gzip.BestSpeed)
	t := tar.NewWriter(z)
	err = fill(t)
	for _, c := range []func() error{t.Close, z.Close, bw.Flush, f.Close} {
		if cerr := c(); err == nil {
			err = cerr
		}
	}
	return err
}

// halfRandom is n bytes where every other 64-byte run is random: it
// compresses about 2:1, like real documents.
func halfRandom(n int, seed uint64) []byte {
	r := rand.New(rand.NewPCG(seed, seed))
	b := make([]byte, n)
	for i := 0; i < n; i += 128 {
		for j := i; j < min(i+64, n); j++ {
			b[j] = byte(r.Uint32())
		}
		for j := i + 64; j < min(i+128, n); j++ {
			b[j] = 'a' + byte(j%26)
		}
	}
	return b
}
