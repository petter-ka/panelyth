// Command fixturegen writes a deterministic media tree for e2e tests and
// benchmarks, then prints the expected counts as JSON.
//
//	go run ./cmd/fixturegen -out /tmp/fv-flat-100k -files 100000
//	go run ./cmd/fixturegen -out /tmp/fv-images -images 300 -width 1600 -height 1200
//	go run ./cmd/fixturegen -out /tmp/fv-text-2g -text-log-bytes 2147483648 -encodings
//	go run ./cmd/fixturegen -out /tmp/fv-archives -archive-samples -archive-zip-entries 100000
//	go run ./cmd/fixturegen -out /tmp/fv-sync -sync-pair -sync-entries 100000
//	go run ./cmd/fixturegen -out /tmp/fv-rename -rename-scenario -rename-files 10000 -rename-folders 1000
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"panelyth/sidecar/internal/fixture"
)

func main() {
	out := flag.String("out", "", "root directory to create (required)")
	var s fixture.Spec
	flag.IntVar(&s.Files, "files", 1000, "files per directory")
	flag.IntVar(&s.Depth, "depth", 0, "subdirectory depth")
	flag.IntVar(&s.Fanout, "fanout", 0, "subdirectories per directory")
	flag.IntVar(&s.NonMediaEvery, "non-media-every", 10, "every n-th file is .txt (0 = none)")
	flag.IntVar(&s.HiddenEvery, "hidden-every", 0, "every n-th file is a dot-file (0 = none)")
	var img fixture.ImageSpec
	flag.IntVar(&img.Count, "images", 0, "write this many real, decodable images instead of empty files")
	flag.IntVar(&img.Width, "width", 1600, "image width")
	flag.IntVar(&img.Height, "height", 1200, "image height")
	flag.IntVar(&img.PNGAlphaEvery, "png-alpha-every", 0, "every n-th image is a PNG with alpha")
	flag.IntVar(&img.RotatedEvery, "rotated-every", 0, "every n-th JPEG has EXIF orientation 6")
	var text fixture.TextSpec
	flag.Int64Var(&text.LogBytes, "text-log-bytes", 0, "write big.log with numbered lines up to this size (lister fixtures)")
	flag.BoolVar(&text.Encodings, "encodings", false, "write the encoding samples (lister fixtures)")
	var arch fixture.ArchiveSpec
	flag.BoolVar(&arch.Samples, "archive-samples", false, "write set.zip, set.tar.gz and slip.zip (archive fixtures)")
	flag.IntVar(&arch.ZipEntries, "archive-zip-entries", 0, "write many.zip with this many entries")
	flag.Int64Var(&arch.TgzBytes, "archive-tgz-bytes", 0, "write big.tar.gz with about this many bytes")
	flag.IntVar(&arch.PackFiles, "archive-pack-files", 0, "write pack/ with this many 4 KiB files")
	var sync fixture.SyncSpec
	flag.BoolVar(&sync.Pair, "sync-pair", false, "write left/ and right/ with known differences (compare fixtures)")
	flag.IntVar(&sync.Entries, "sync-entries", 0, "write tree-a/ and tree-b/ with this many files each")
	flag.Int64Var(&sync.TextBytes, "sync-text-bytes", 0, "write text-a.txt and text-b.txt of about this size")
	flag.Int64Var(&sync.HashBytes, "sync-hash-bytes", 0, "write hash.bin of this size")
	var ren fixture.RenameSpec
	flag.BoolVar(&ren.Scenario, "rename-scenario", false, "write scenario/ with a few named files (multi-rename fixtures)")
	flag.IntVar(&ren.Files, "rename-files", 0, "write files/ with this many empty pictures")
	flag.IntVar(&ren.Folders, "rename-folders", 0, "write folders/ with this many folders")
	flag.IntVar(&ren.FolderFiles, "rename-folder-files", 20, "files of 1 KiB per folder of folders/")
	flag.Parse()
	if *out == "" {
		fmt.Fprintln(os.Stderr, "-out is required")
		os.Exit(2)
	}
	start := time.Now()
	result := map[string]any{"root": *out}
	if ren.Scenario || ren.Files > 0 || ren.Folders > 0 {
		if err := fixture.GenerateRename(*out, ren); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		result["rename"] = ren
		result["expected"] = fixture.Expected{}
	} else if sync.Pair || sync.Entries > 0 || sync.TextBytes > 0 || sync.HashBytes > 0 {
		if err := fixture.GenerateSync(*out, sync); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		result["sync"] = sync
		result["expected"] = fixture.Expected{}
	} else if arch.Samples || arch.ZipEntries > 0 || arch.TgzBytes > 0 || arch.PackFiles > 0 {
		if err := fixture.GenerateArchives(*out, arch); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		result["archives"] = arch
		result["expected"] = fixture.Expected{}
	} else if text.LogBytes > 0 || text.Encodings {
		if err := fixture.GenerateText(*out, text); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		result["text"] = text
		result["expected"] = fixture.Expected{}
	} else if img.Count > 0 {
		if err := fixture.GenerateImages(*out, img); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		result["images"] = img
		result["expected"] = fixture.Expected{Media: img.Count}
	} else {
		exp, err := fixture.Generate(*out, s)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		result["spec"] = s
		result["expected"] = exp
	}
	result["ms"] = time.Since(start).Milliseconds()
	_ = json.NewEncoder(os.Stdout).Encode(result)
}
