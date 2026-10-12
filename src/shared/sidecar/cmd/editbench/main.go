// Command editbench measures the image editor (Stage 12, ADR-0035): opening
// a session, the latency of a dragged control, saving, and what a session
// and a save hold in memory, for 24, 50 and 100 megapixel JPEGs.
//
//	go run ./cmd/editbench -fixtures <dir> -out result.json
//
// Fixtures are generated once per machine and reused.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/jpeg"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"runtime/metrics"
	"sort"
	"sync/atomic"
	"time"

	"panelyth/sidecar/internal/editor"
	"panelyth/sidecar/internal/imaging"
)

type latency struct {
	P50Ms float64 `json:"p50Ms"`
	P95Ms float64 `json:"p95Ms"`
	MaxMs float64 `json:"maxMs"`
	// FrameKB is the mean size of a frame file; FrameMP its pixels.
	FrameKB float64 `json:"frameKB"`
	FrameMP float64 `json:"frameMP"`
}

type sizeResult struct {
	Megapixels float64 `json:"megapixels"`
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	FileMB     float64 `json:"fileMB"`
	// Open: decoding once and building the proxy (the first is a cold run).
	OpenMs []float64 `json:"openMs"`
	// OpenPeakMB is the most heap in use while opening; SessionMB what an
	// open session holds after a few renders (proxy and checkpoints).
	OpenPeakMB float64 `json:"openPeakMB"`
	SessionMB  float64 `json:"sessionMB"`
	// Drag: a control moved 60 times, each a draft render of the last
	// operation; Final: the full frame when it rests.
	DragRotate latency `json:"dragRotate"`
	DragResize latency `json:"dragResize"`
	DragCrop   latency `json:"dragCrop"`
	Final      latency `json:"final"`
	FinalMax   latency `json:"finalMaxFrame"`
	// Save: three geometry operations at full resolution.
	SaveJPEGMs   []float64   `json:"saveJpegMs"`
	SavePNGMs    float64     `json:"savePngMs"`
	SavePeakMB   float64     `json:"savePeakMB"`
	SavedMB      float64     `json:"savedMB"`
	EstimateMs   float64     `json:"estimateMs"`
	EstimateMB   float64     `json:"estimateMB"`
	MaxGoroutine int         `json:"maxGoroutines"`
	Color        colorResult `json:"color"`
}

// colorResult is Stage 13: the color tools in a session.
type colorResult struct {
	// Drags are drafts of a list whose last operation changes: a fused
	// chain of point operations, the unsharp mask, a Gaussian blur and the
	// two noise filters. Finals are the frame when the control rests.
	DragPoint    latency `json:"dragPointChain"`
	DragLevels   latency `json:"dragLevelsWithBefore"`
	DragSharpen  latency `json:"dragSharpen"`
	DragBlur     latency `json:"dragBlur"`
	DragDenoise  latency `json:"dragDenoise"`
	DragNLM      latency `json:"dragDenoiseHigh"`
	FinalPoint   latency `json:"finalPointChain"`
	FinalSharpen latency `json:"finalSharpen"`
	FinalDenoise latency `json:"finalDenoise"`
	FinalNLM     latency `json:"finalDenoiseHigh"`
	FinalReduce  latency `json:"finalReduce256Dither"`
	// Probe: the color under the pointer; Thumbs: the twelve looks at 112 px.
	ProbeMs  float64 `json:"probeMs"`
	ThumbsMs float64 `json:"thumbs12Ms"`
	// Count colors: the preview (the proxy) and the full picture (exact).
	CountPreviewMs float64 `json:"countPreviewMs"`
	CountEditedMs  float64 `json:"countEditedMs"`
	CountPeakMB    float64 `json:"countPeakMB"`
	Distinct       int     `json:"distinct"`
	// Saves at full resolution: point chain + curves + unsharp as JPEG, the
	// same with the edge-preserving noise filter, and 256 colors as PNG.
	SaveMs        float64 `json:"saveColorJpegMs"`
	SavePeakMB    float64 `json:"saveColorPeakMB"`
	SaveDenoiseMs float64 `json:"saveDenoiseJpegMs"`
	SaveIndexedMs float64 `json:"saveIndexedPngMs"`
	IndexedMB     float64 `json:"indexedMB"`
}

type result struct {
	Stage   string       `json:"stage"`
	At      string       `json:"at"`
	CPUs    int          `json:"numCpu"`
	Workers int          `json:"workers"`
	Go      string       `json:"go"`
	Sizes   []sizeResult `json:"sizes"`
}

func heapMB() float64 {
	s := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
	metrics.Read(s)
	return float64(s[0].Value.Uint64()) / (1 << 20)
}

// peak samples the heap and the goroutine count while fn runs.
func peak(fn func()) (mb float64, goroutines int) {
	runtime.GC()
	var stop atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		for !stop.Load() {
			mb = math.Max(mb, heapMB())
			goroutines = max(goroutines, runtime.NumGoroutine())
			time.Sleep(2 * time.Millisecond)
		}
	}()
	fn()
	stop.Store(true)
	<-done
	return mb, goroutines
}

func ms(d time.Duration) float64 { return math.Round(float64(d.Microseconds())/10) / 100 }

// fixture writes a w×h JPEG with detail (a photo-like gradient with grain),
// in bands so a 100 MP picture does not need its RGBA form in memory twice.
func fixture(path string, w, h int) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	img := image.NewYCbCr(image.Rect(0, 0, w, h), image.YCbCrSubsampleRatio420)
	rng := rand.New(rand.NewSource(int64(w)))
	for y := range h {
		row := img.Y[y*img.YStride : y*img.YStride+w]
		for x := range row {
			v := 110 + 70*math.Sin(float64(x)/211)*math.Cos(float64(y)/173) + float64(rng.Intn(17)-8)
			row[x] = uint8(min(max(v, 0), 255))
		}
	}
	for y := range (h + 1) / 2 {
		for x := range (w + 1) / 2 {
			i := y*img.CStride + x
			img.Cb[i] = uint8(128 + 40*math.Sin(float64(x)/97))
			img.Cr[i] = uint8(128 + 40*math.Cos(float64(y)/131))
		}
	}
	f, err := os.Create(path + ".tmp")
	if err != nil {
		return err
	}
	bw := bufio.NewWriterSize(f, 1<<20)
	if err := jpeg.Encode(bw, img, &jpeg.Options{Quality: 90}); err != nil {
		f.Close()
		return err
	}
	if err := bw.Flush(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}

func ops(js string) imaging.EditList {
	var e imaging.EditList
	if err := json.Unmarshal([]byte(js), &e); err != nil {
		panic(err)
	}
	return e
}

func summarize(times []time.Duration, bytes, pixels int64) latency {
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	at := func(q float64) time.Duration { return times[min(int(float64(len(times))*q), len(times)-1)] }
	n := float64(len(times))
	return latency{P50Ms: ms(at(0.5)), P95Ms: ms(at(0.95)), MaxMs: ms(times[len(times)-1]),
		FrameKB: math.Round(float64(bytes)/n/102.4) / 10, FrameMP: math.Round(float64(pixels)/n/1e4) / 100}
}

// drag renders a list whose last operation changes with every step, the way
// a dragged control does. rev continues across calls.
func drag(s *editor.Session, rev *int64, steps, maxEdge int, draft bool, list func(i int) imaging.EditList) (latency, error) {
	times := make([]time.Duration, 0, steps)
	var bytes, pixels int64
	for i := range steps {
		*rev++
		start := time.Now()
		res, err := s.Render(context.Background(), editor.RenderRequest{Rev: *rev, Edits: list(i), MaxEdge: maxEdge, Draft: draft, Histogram: true})
		if err != nil {
			return latency{}, err
		}
		times = append(times, time.Since(start))
		if fi, err := os.Stat(res.File); err == nil {
			bytes += fi.Size()
		}
		pixels += int64(res.Width) * int64(res.Height)
	}
	return summarize(times, bytes, pixels), nil
}

func measure(m *editor.Manager, dir string, w, h, runs int) (sizeResult, error) {
	path := filepath.Join(dir, fmt.Sprintf("edit-%dx%d.jpg", w, h))
	if err := fixture(path, w, h); err != nil {
		return sizeResult{}, err
	}
	fi, err := os.Stat(path)
	if err != nil {
		return sizeResult{}, err
	}
	r := sizeResult{Megapixels: math.Round(float64(w)*float64(h)/1e4) / 100, Width: w, Height: h,
		FileMB: math.Round(float64(fi.Size())/(1<<20)*10) / 10}
	src := editor.Source{EntryID: 1, Path: path, Ext: "jpg"}
	ctx := context.Background()

	var s *editor.Session
	for i := range runs {
		var oerr error
		mb, _ := peak(func() {
			start := time.Now()
			s, oerr = m.Open(ctx, 1, src)
			r.OpenMs = append(r.OpenMs, ms(time.Since(start)))
		})
		if oerr != nil {
			return r, oerr
		}
		if i == 0 {
			r.OpenPeakMB = math.Round(mb)
		}
	}

	var rev int64
	const view = 1600 // a 1600 px canvas: about 2 MP frames for a 3:2 picture
	rotate := func(i int) imaging.EditList {
		return ops(fmt.Sprintf(`[{"op":"flip","p":{"axis":"h"}},{"op":"rotate","p":{"angle":%g,"mode":"crop"}}]`, -6+float64(i)*0.2))
	}
	resize := func(i int) imaging.EditList {
		return ops(fmt.Sprintf(`[{"op":"flip","p":{"axis":"h"}},{"op":"resize","p":{"mode":"percent","w":%d}}]`, 40+i))
	}
	crop := func(i int) imaging.EditList {
		return ops(fmt.Sprintf(`[{"op":"rotate","p":{"angle":90}},{"op":"crop","p":{"rect":{"x":%g,"y":0.1,"w":0.6,"h":0.7}}}]`, 0.05+float64(i)*0.005))
	}
	_, goroutines := peak(func() {
		if r.DragRotate, err = drag(s, &rev, 60, view, true, rotate); err != nil {
			return
		}
		if r.DragResize, err = drag(s, &rev, 60, view, true, resize); err != nil {
			return
		}
		if r.DragCrop, err = drag(s, &rev, 60, view, true, crop); err != nil {
			return
		}
		if r.Final, err = drag(s, &rev, 20, view, false, rotate); err != nil {
			return
		}
		r.FinalMax, err = drag(s, &rev, 20, editor.MaxFrameEdge, false, rotate)
	})
	if err != nil {
		return r, err
	}
	r.MaxGoroutine = goroutines
	runtime.GC()
	r.SessionMB = math.Round(heapMB())

	three := ops(`[{"op":"rotate","p":{"angle":3.5,"mode":"crop"}},{"op":"crop","p":{"rect":{"x":0.05,"y":0.05,"w":0.9,"h":0.9}}},{"op":"resize","p":{"mode":"percent","w":80}}]`)
	start := time.Now()
	est, err := s.Estimate(ctx, three, "jpeg", 92, imaging.MetaKeep)
	if err != nil {
		return r, err
	}
	r.EstimateMs, r.EstimateMB = ms(time.Since(start)), math.Round(float64(est)/(1<<20)*10)/10

	out := filepath.Join(dir, "edit-out")
	_ = os.MkdirAll(out, 0o755)
	save := func(format string) (time.Duration, int64, error) {
		dest := filepath.Join(out, "saved."+imaging.SaveFormats[format])
		_ = os.Remove(dest)
		start := time.Now()
		res, err := editor.Save(ctx, editor.SaveRequest{Source: src, Size: s.Size, MtimeNs: s.MtimeNs, Edits: three,
			Dest: dest, Format: format, Quality: 92, Policy: imaging.MetaKeep})
		return time.Since(start), res.Bytes, err
	}
	for i := range runs {
		var d time.Duration
		var n int64
		var serr error
		mb, _ := peak(func() { d, n, serr = save("jpeg") })
		if serr != nil {
			return r, serr
		}
		r.SaveJPEGMs = append(r.SaveJPEGMs, ms(d))
		if i == 0 {
			r.SavePeakMB, r.SavedMB = math.Round(mb), math.Round(float64(n)/(1<<20)*10)/10
		}
	}
	d, _, err := save("png")
	if err != nil {
		return r, err
	}
	r.SavePNGMs = ms(d)
	if r.Color, err = measureColor(ctx, s, src, out, &rev); err != nil {
		return r, err
	}
	m.Close(s.ID)
	_ = os.RemoveAll(out)
	return r, nil
}

const tone = `{"op":"colors","p":{"saturation":20,"temperature":10}},{"op":"curves","p":{"l":[[0,0],[64,48],[192,208],[255,255]]}}`

// measureColor times the Stage 13 tools on an open session.
func measureColor(ctx context.Context, s *editor.Session, src editor.Source, out string, rev *int64) (colorResult, error) {
	var c colorResult
	var err error
	const view = 1600
	point := func(i int) imaging.EditList {
		return ops(fmt.Sprintf(`[%s,{"op":"lighting","p":{"contrast":%d,"shadows":15}}]`, tone, i-30))
	}
	sharpen := func(i int) imaging.EditList {
		return ops(fmt.Sprintf(`[%s,{"op":"sharpen","p":{"amount":%d,"radius":1.5}}]`, tone, 60+i*3))
	}
	blur := func(i int) imaging.EditList {
		return ops(fmt.Sprintf(`[%s,{"op":"blur","p":{"radius":%g}}]`, tone, 2+float64(i)*0.5))
	}
	denoise := func(quality string) func(i int) imaging.EditList {
		return func(i int) imaging.EditList {
			return ops(fmt.Sprintf(`[%s,{"op":"denoise","p":{"luminance":%d,"color":20,"quality":%q}}]`, tone, 20+i, quality))
		}
	}
	reduce := func(i int) imaging.EditList {
		return ops(fmt.Sprintf(`[%s,{"op":"reduceColors","p":{"count":%d,"dither":"fs"}}]`, tone, 256-i))
	}
	// Levels asks for the histogram of the picture it is given as well.
	levels := func(steps int) (latency, error) {
		times := make([]time.Duration, 0, steps)
		for i := range steps {
			*rev++
			list := ops(fmt.Sprintf(`[%s,{"op":"levels","p":{"l":{"inBlack":%d,"inWhite":240,"outBlack":0,"outWhite":255}}}]`, tone, i))
			start := time.Now()
			if _, err := s.Render(ctx, editor.RenderRequest{Rev: *rev, Edits: list, MaxEdge: view, Draft: true,
				Histogram: true, Before: true, BeforeAt: 2}); err != nil {
				return latency{}, err
			}
			times = append(times, time.Since(start))
		}
		return summarize(times, 0, 0), nil
	}
	for _, run := range []struct {
		into  *latency
		steps int
		draft bool
		list  func(i int) imaging.EditList
	}{
		{&c.DragPoint, 60, true, point},
		{&c.DragSharpen, 60, true, sharpen},
		{&c.DragBlur, 60, true, blur},
		{&c.DragDenoise, 60, true, denoise("fast")},
		{&c.DragNLM, 30, true, denoise("high")},
		{&c.FinalPoint, 20, false, point},
		{&c.FinalSharpen, 20, false, sharpen},
		{&c.FinalDenoise, 10, false, denoise("fast")},
		{&c.FinalNLM, 5, false, denoise("high")},
		{&c.FinalReduce, 5, false, reduce},
	} {
		if *run.into, err = drag(s, rev, run.steps, view, run.draft, run.list); err != nil {
			return c, err
		}
	}
	if c.DragLevels, err = levels(60); err != nil {
		return c, err
	}

	start := time.Now()
	const probes = 20
	for i := range probes {
		if _, err := s.Probe(ctx, point(30), view, 0.1+float64(i)*0.04, 0.5, 2); err != nil {
			return c, err
		}
	}
	c.ProbeMs = ms(time.Since(start) / probes)

	looks := make([]imaging.EditList, 12)
	for i := range looks {
		looks[i] = point(i * 5)
	}
	start = time.Now()
	if _, err := s.Thumbs(ctx, looks, 112); err != nil {
		return c, err
	}
	c.ThumbsMs = ms(time.Since(start))

	start = time.Now()
	if _, err := s.CountColors(ctx, point(30), editor.ScopePreview, 32); err != nil {
		return c, err
	}
	c.CountPreviewMs = ms(time.Since(start))
	mb, _ := peak(func() {
		start := time.Now()
		var counted editor.Colors
		if counted, err = s.CountColors(ctx, point(30), editor.ScopeEdited, 32); err == nil {
			c.CountEditedMs, c.Distinct = ms(time.Since(start)), counted.Distinct
		}
	})
	if err != nil {
		return c, err
	}
	c.CountPeakMB = math.Round(mb)

	save := func(list imaging.EditList, format string) (time.Duration, int64, error) {
		dest := filepath.Join(out, "color."+imaging.SaveFormats[format])
		_ = os.Remove(dest)
		start := time.Now()
		res, err := editor.Save(ctx, editor.SaveRequest{Source: src, Size: s.Size, MtimeNs: s.MtimeNs, Edits: list,
			Dest: dest, Format: format, Quality: 92, Policy: imaging.MetaKeep})
		return time.Since(start), res.Bytes, err
	}
	var d time.Duration
	var n int64
	mb, _ = peak(func() { d, _, err = save(sharpen(20), "jpeg") })
	if err != nil {
		return c, err
	}
	c.SaveMs, c.SavePeakMB = ms(d), math.Round(mb)
	if d, _, err = save(denoise("fast")(20), "jpeg"); err != nil {
		return c, err
	}
	c.SaveDenoiseMs = ms(d)
	if d, n, err = save(reduce(0), "png"); err != nil {
		return c, err
	}
	c.SaveIndexedMs, c.IndexedMB = ms(d), math.Round(float64(n)/(1<<20)*10)/10
	return c, nil
}

func main() {
	fixtures := flag.String("fixtures", filepath.Join(os.TempDir(), "panelyth-fixtures"), "fixture root")
	out := flag.String("out", "", "write the JSON result here (default stdout)")
	runs := flag.Int("runs", 3, "runs per measurement")
	flag.Parse()

	dir := filepath.Join(*fixtures, "edit")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	m := editor.NewManager(editor.Config{TmpDir: filepath.Join(dir, "frames")})
	defer m.Shutdown()
	res := result{Stage: os.Getenv("BENCH_STAGE"), At: time.Now().Format(time.RFC3339), CPUs: runtime.NumCPU(),
		Workers: imaging.Workers(), Go: runtime.Version()}
	// 24 MP (6000×4000), 50 MP and 100 MP (just under the cap), all 3:2.
	for _, size := range [][2]int{{6000, 4000}, {8660, 5773}, {12240, 8160}} {
		r, err := measure(m, dir, size[0], size[1], *runs)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%dx%d: %v\n", size[0], size[1], err)
			os.Exit(1)
		}
		res.Sizes = append(res.Sizes, r)
		fmt.Fprintf(os.Stderr, "%.0f MP: open %v ms, drag rotate p95 %.1f ms, save %v ms, session %.0f MB, save peak %.0f MB\n",
			r.Megapixels, r.OpenMs, r.DragRotate.P95Ms, r.SaveJPEGMs, r.SessionMB, r.SavePeakMB)
		fmt.Fprintf(os.Stderr, "       color: drag p95 point %.1f, sharpen %.1f, denoise %.1f / %.1f ms; count %.0f ms; save %.0f ms, denoise %.0f ms, indexed %.0f ms\n",
			r.Color.DragPoint.P95Ms, r.Color.DragSharpen.P95Ms, r.Color.DragDenoise.P95Ms, r.Color.DragNLM.P95Ms,
			r.Color.CountEditedMs, r.Color.SaveMs, r.Color.SaveDenoiseMs, r.Color.SaveIndexedMs)
	}
	b, _ := json.MarshalIndent(res, "", "  ")
	b = append(b, '\n')
	if *out == "" {
		os.Stdout.Write(b)
		return
	}
	if err := os.WriteFile(*out, b, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
