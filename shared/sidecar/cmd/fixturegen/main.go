// Command fixturegen writes a deterministic media tree for e2e tests and
// benchmarks, then prints the expected counts as JSON.
//
//	go run ./cmd/fixturegen -out /tmp/fv-flat-100k -files 100000
//	go run ./cmd/fixturegen -out /tmp/fv-images -images 300 -width 1600 -height 1200
//	go run ./cmd/fixturegen -out /tmp/fv-text-2g -text-log-bytes 2147483648 -encodings
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"fastview/sidecar/internal/fixture"
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
	flag.Parse()
	if *out == "" {
		fmt.Fprintln(os.Stderr, "-out is required")
		os.Exit(2)
	}
	start := time.Now()
	result := map[string]any{"root": *out}
	if text.LogBytes > 0 || text.Encodings {
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
