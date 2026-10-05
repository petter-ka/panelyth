package app

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"fastview/sidecar/internal/fixture"
	"fastview/sidecar/internal/rpc"
)

// Golden frames pin the wire contract shared with TypeScript
// (shared/contracts/test/fixtures.test.ts validates the same files).
// Regenerate with: go test ./internal/app -run TestGoldenFrames -update
var update = flag.Bool("update", false, "rewrite golden fixtures")

const fixturesDir = "../../../../shared/contracts/fixtures"

// volatile fields are replaced so fixtures are deterministic.
var volatile = map[string]any{
	"pid": 1234, "serverTimeNs": 1, "uptimeMs": 1, "goroutines": 1, "heapBytes": 1,
	"runtimeMemBytes": 1, "numCpu": 1, "goVersion": "go1.x", "cacheRoot": "/cache/FastView/v1",
	"configRoot": "/config/FastView", "path": "/fixtures/golden", "elapsedMs": 1, "lastListedAt": 1,
	"thumbnailRoot": "/cache/FastView/v1/thumbnails", "url": "fastview-thumb://t/<key>.jpg",
	"crumbs":    []any{map[string]any{"name": "/", "path": "/"}, map[string]any{"name": "golden", "path": "/fixtures/golden"}},
	"volumes":   []any{map[string]any{"path": "/", "label": "", "kind": "fixed"}},
	"createdMs": 1, "accessedMs": 1, "lastOpenedAt": 1, "paths": []any{"/fixtures/golden/file"},
	"startedMs": 1, "finishedMs": 1, "file": "/cache/FastView/v1/tmp/clip.png",
}

// platformDependent values are replaced even when null (Linux has no birth time).
var platformDependent = map[string]bool{"createdMs": true, "accessedMs": true}

func normalize(v any) any {
	switch x := v.(type) {
	case map[string]any:
		// The archive attribute exists on Windows only (ADR-0026).
		if a, ok := x["attrs"].(float64); ok {
			if a = float64(int(a) &^ 8); a == 0 {
				delete(x, "attrs")
			} else {
				x["attrs"] = a
			}
		}
		for k, val := range x {
			if repl, ok := volatile[k]; ok && (val != nil || platformDependent[k]) {
				x[k] = repl
			} else {
				x[k] = normalize(val)
			}
		}
	case []any:
		for i := range x {
			x[i] = normalize(x[i])
		}
	}
	return v
}

func TestGoldenFrames(t *testing.T) {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	env := map[string]string{"FASTVIEW_DEV_METHODS": "1", "FASTVIEW_CACHE_DIR": t.TempDir(), "FASTVIEW_CONFIG_DIR": t.TempDir(),
		// Deterministic across machines: no ffprobe (video fields stay empty).
		"FASTVIEW_FFMPEG": "off"}
	done := make(chan error, 1)
	go func() {
		done <- Run(context.Background(), Config{
			In: inR, Out: outW, Logger: slog.New(slog.DiscardHandler), Version: "test",
			Getenv: func(k string) string { return env[k] },
		})
		_ = outW.Close()
	}()
	fr := rpc.NewFrameReader(outR)
	read := func() any {
		p, err := fr.ReadFrame()
		if err != nil {
			t.Fatal(err)
		}
		var v any
		if err := json.Unmarshal(p, &v); err != nil {
			t.Fatal(err)
		}
		return normalize(v)
	}
	send := func(s string) {
		if err := rpc.WriteFrame(inW, []byte(s)); err != nil {
			t.Fatal(err)
		}
	}

	// call reads until the response for id, keeping events aside.
	var events []map[string]any
	call := func(id int, req string) any {
		send(req)
		for {
			f := read().(map[string]any)
			if f["t"] == "evt" {
				events = append(events, f)
				continue
			}
			if f["id"] != float64(id) {
				t.Fatalf("unexpected frame %v", f)
			}
			return f
		}
	}
	waitEvent := func(ch, state string) map[string]any {
		for i := 0; ; i++ {
			for _, e := range events {
				p, _ := e["p"].(map[string]any)
				if e["ch"] == ch && (state == "" || p["state"] == state) {
					return e
				}
			}
			f := read().(map[string]any)
			if f["t"] != "evt" {
				t.Fatalf("unexpected frame while waiting for %s: %v", ch, f)
			}
			events = append(events, f)
		}
	}

	fixtureDir := filepath.Join(t.TempDir(), "golden")
	if _, err := fixture.Generate(fixtureDir, fixture.Spec{Files: 4, Depth: 1, Fanout: 1, NonMediaEvery: 4}); err != nil {
		t.Fatal(err)
	}
	openReq, _ := json.Marshal(map[string]any{"t": "req", "id": 10, "m": "dir.open", "p": map[string]any{"path": fixtureDir, "recursive": false}})

	golden := map[string]any{"hello.json": read()}
	send(`{"t":"req","id":1,"m":"system.ping","p":{}}`)
	golden["res-system.ping.json"] = read()
	send(`{"t":"req","id":2,"m":"system.info","p":{}}`)
	golden["res-system.info.json"] = read()
	send(`{"t":"req","id":3,"m":"system.echo","p":{"payload":"abc"}}`)
	golden["res-system.echo.json"] = read()
	send(`{"t":"req","id":4,"m":"no.such.method","p":{}}`)
	golden["res-error.json"] = read()
	golden["res-dir.open.json"] = call(10, string(openReq))
	golden["evt-index.progress.json"] = waitEvent("index.progress", "completed")
	golden["res-query.open.json"] = call(11, `{"t":"req","id":11,"m":"query.open","p":{"dirId":1,"recursive":false,"sort":[{"field":"name","direction":"asc"}],"kinds":[]}}`)
	golden["res-query.page.json"] = call(12, `{"t":"req","id":12,"m":"query.page","p":{"queryId":1,"offset":0,"limit":3}}`)
	// Stage 05 workspace methods against the same session.
	fileID := golden["res-query.page.json"].(map[string]any)["r"].(map[string]any)["items"].([]any)[1].(map[string]any)["id"]
	// "folder 1" sorts first; hidden entries are indexed too (ADR-0026), so
	// its id depends on directory order.
	folderID := golden["res-query.page.json"].(map[string]any)["r"].(map[string]any)["items"].([]any)[0].(map[string]any)["id"]
	byID := func(id int, m string, p map[string]any) string {
		b, _ := json.Marshal(map[string]any{"t": "req", "id": id, "m": m, "p": p})
		return string(b)
	}
	sel := map[string]any{"queryId": 1, "version": 1, "ranges": []any{[]int{0, 2}}, "include": []any{}, "exclude": []any{}}
	golden["res-query.facets.json"] = call(30, `{"t":"req","id":30,"m":"query.facets","p":{"queryId":1}}`)
	golden["res-selection.info.json"] = call(31, byID(31, "selection.info", map[string]any{"selection": sel}))
	golden["res-selection.rebase.json"] = call(32, byID(32, "selection.rebase", map[string]any{"selection": sel}))
	golden["res-selection.paths.json"] = call(33, byID(33, "selection.paths", map[string]any{"selection": sel, "limit": 0}))
	golden["res-selection.info-stale.json"] = call(34, byID(34, "selection.info", map[string]any{"selection": map[string]any{
		"queryId": 1, "version": 7, "ranges": []any{}, "include": []any{}, "exclude": []any{}}}))
	golden["res-props.get.json"] = call(35, byID(35, "props.get", map[string]any{"entryId": fileID}))
	golden["res-entry.path.json"] = call(36, byID(36, "entry.path", map[string]any{"entryId": fileID}))
	golden["res-fs.listDirs.json"] = call(37, byID(37, "fs.listDirs", map[string]any{"path": fixtureDir}))
	golden["res-fs.volumes.json"] = call(38, `{"t":"req","id":38,"m":"fs.volumes","p":{}}`)
	golden["res-library.setSetting.json"] = call(39, `{"t":"req","id":39,"m":"library.setSetting","p":{"key":"workspace","value":{"tileSize":"large"}}}`)
	golden["res-library.addBookmark.json"] = call(40, byID(40, "library.addBookmark", map[string]any{"path": fixtureDir, "label": ""}))
	golden["res-library.get.json"] = call(41, `{"t":"req","id":41,"m":"library.get","p":{}}`)
	golden["res-library.removeBookmark.json"] = call(42, `{"t":"req","id":42,"m":"library.removeBookmark","p":{"id":1}}`)
	golden["res-query.open-search.json"] = call(43, `{"t":"req","id":43,"m":"query.open","p":{"dirId":1,"recursive":false,"sort":[{"field":"dimensions","direction":"desc"},{"field":"created","direction":"asc"}],"kinds":["image"],"search":"img","exts":["jpg","png"]}}`)
	// Stage 07: clipboard, jobs and user metadata against session 1.
	jobDone := func(id any) map[string]any {
		for {
			for i, e := range events {
				p, _ := e["p"].(map[string]any)
				if e["ch"] == "job.progress" && p["jobId"] == id && p["state"] == "completed" {
					events = append(events[:i], events[i+1:]...)
					return e
				}
			}
			events = append(events, read().(map[string]any))
		}
	}
	golden["res-clip.get.json"] = call(45, `{"t":"req","id":45,"m":"clip.get","p":{}}`)
	golden["res-clip.set.json"] = call(46, byID(46, "clip.set", map[string]any{"selection": sel, "mode": "copy"}))
	golden["res-jobs.start.json"] = call(47, byID(47, "jobs.start", map[string]any{"kind": "favorite",
		"source": map[string]any{"selection": sel}, "favorite": true}))
	favJob := golden["res-jobs.start.json"].(map[string]any)["r"].(map[string]any)["jobId"]
	fav := jobDone(favJob)
	fav["seq"] = float64(1)
	golden["evt-job.progress.json"] = fav
	tagRes := call(48, byID(48, "jobs.start", map[string]any{"kind": "tag",
		"source": map[string]any{"selection": sel}, "tag": "Holiday", "add": true}))
	jobDone(tagRes.(map[string]any)["r"].(map[string]any)["jobId"])
	golden["res-jobs.list.json"] = call(49, `{"t":"req","id":49,"m":"jobs.list","p":{}}`)
	golden["res-jobs.errors.json"] = call(50, byID(50, "jobs.errors", map[string]any{"jobId": favJob, "offset": 0, "limit": 10}))
	golden["res-jobs.cancel.json"] = call(51, `{"t":"req","id":51,"m":"jobs.cancel","p":{"jobId":999}}`)
	golden["res-library.tags.json"] = call(52, `{"t":"req","id":52,"m":"library.tags","p":{}}`)
	golden["res-query.open-user.json"] = call(53, `{"t":"req","id":53,"m":"query.open","p":{"dirId":1,"recursive":false,"sort":[{"field":"rating","direction":"desc"},{"field":"tags","direction":"asc"}],"kinds":[],"favorite":true,"minRating":0,"tags":["holiday"]}}`)
	golden["res-entry.rename-invalid.json"] = call(54, byID(54, "entry.rename", map[string]any{"entryId": fileID, "name": "a/b.jpg"}))
	fileName := golden["res-query.page.json"].(map[string]any)["r"].(map[string]any)["items"].([]any)[1].(map[string]any)["name"].(string)
	golden["res-entry.rename.json"] = call(55, byID(55, "entry.rename", map[string]any{"entryId": fileID, "name": "renamed " + fileName}))
	golden["res-clip.paste.json"] = call(56, byID(56, "clip.paste", map[string]any{"destination": fixtureDir, "conflict": "keepBoth"}))
	jobDone(golden["res-clip.paste.json"].(map[string]any)["r"].(map[string]any)["jobId"])
	golden["res-library.deleteTag.json"] = call(57, `{"t":"req","id":57,"m":"library.deleteTag","p":{"id":1}}`)
	// Stage P02 (ADR-0026): the commander's scope lists every entry.
	golden["res-query.open-all.json"] = call(58, `{"t":"req","id":58,"m":"query.open","p":{"dirId":1,"recursive":false,"sort":[{"field":"name","direction":"asc"}],"kinds":[],"scope":"all","showHidden":true,"nameMask":"*|*.tmp;.fastview*"}}`)
	allQuery := golden["res-query.open-all.json"].(map[string]any)["r"].(map[string]any)["queryId"]
	golden["res-query.page-all.json"] = call(59, byID(59, "query.page", map[string]any{"queryId": allQuery, "offset": 0, "limit": 4}))
	golden["res-query.open-badscope.json"] = call(60, `{"t":"req","id":60,"m":"query.open","p":{"dirId":1,"recursive":false,"sort":[],"kinds":[],"scope":"everything"}}`)
	golden["res-query.close.json"] = call(13, `{"t":"req","id":13,"m":"query.close","p":{"queryId":1}}`)
	// Folder tile: open "folder 1" (id 2) of the golden fixture by entry id.
	golden["res-dir.openEntry.json"] = call(16, byID(16, "dir.openEntry", map[string]any{"entryId": folderID, "recursive": false}))
	// Folder covers for "folder 1" (id 2): shallow discovery, pending slots.
	golden["res-folder.covers.json"] = call(18, byID(18, "folder.covers", map[string]any{"lane": "covers", "epoch": 1, "profile": "grid-sm",
		"items": []any{map[string]any{"id": folderID, "priority": 0}}}))
	// Its pending slots finish as folder.covers events (any order, any batching).
	coverSlots := len(golden["res-folder.covers.json"].(map[string]any)["r"].(map[string]any)["items"].([]any)[0].(map[string]any)["slots"].([]any))
	var covers []any
	var coversFrame map[string]any
	for len(covers) < coverSlots {
		for i := 0; i < len(events); i++ {
			if events[i]["ch"] == "folder.covers" {
				coversFrame = events[i]
				covers = append(covers, events[i]["p"].(map[string]any)["items"].([]any)...)
				events = append(events[:i], events[i+1:]...)
				i--
			}
		}
		if len(covers) < coverSlots {
			events = append(events, read().(map[string]any))
		}
	}
	slices.SortFunc(covers, func(a, b any) int {
		return int(a.(map[string]any)["slot"].(float64) - b.(map[string]any)["slot"].(float64))
	})
	coversFrame["p"] = map[string]any{"items": covers}
	coversFrame["seq"] = float64(1)
	golden["evt-folder.covers.json"] = coversFrame
	golden["res-dir.openEntry-missing.json"] = call(17, `{"t":"req","id":17,"m":"dir.openEntry","p":{"entryId":999999,"recursive":false}}`)
	golden["res-dir.cancelScan.json"] = call(14, `{"t":"req","id":14,"m":"dir.cancelScan","p":{"scanId":999}}`)
	golden["res-query.page-expired.json"] = call(15, `{"t":"req","id":15,"m":"query.page","p":{"queryId":1,"offset":0,"limit":3}}`)
	// Previews: real images, ensure → preview.ready → page with cached thumbs.
	imagesDir := filepath.Join(t.TempDir(), "images")
	if err := fixture.GenerateImages(imagesDir, fixture.ImageSpec{Count: 2, Width: 64, Height: 48}); err != nil {
		t.Fatal(err)
	}
	imgReq, _ := json.Marshal(map[string]any{"t": "req", "id": 20, "m": "dir.open", "p": map[string]any{"path": imagesDir, "recursive": false}})
	imgDir := call(20, string(imgReq)).(map[string]any)["r"].(map[string]any)
	waitEvent2 := func() {
		for {
			for _, e := range events {
				p, _ := e["p"].(map[string]any)
				if e["ch"] == "index.progress" && p["state"] == "completed" && p["dirId"] == imgDir["dirId"] {
					return
				}
			}
			events = append(events, read().(map[string]any))
		}
	}
	waitEvent2()
	qReq, _ := json.Marshal(map[string]any{"t": "req", "id": 21, "m": "query.open", "p": map[string]any{
		"dirId": imgDir["dirId"], "recursive": false, "sort": []any{}, "kinds": []any{}}})
	qid := call(21, string(qReq)).(map[string]any)["r"].(map[string]any)["queryId"]
	pageReq := func(id int) string {
		b, _ := json.Marshal(map[string]any{"t": "req", "id": id, "m": "query.page", "p": map[string]any{
			"queryId": qid, "offset": 0, "limit": 10, "thumbProfile": "grid-sm"}})
		return string(b)
	}
	cold := call(22, pageReq(22)).(map[string]any)["r"].(map[string]any)["items"].([]any)
	var ensureItems []any
	for _, it := range cold {
		ensureItems = append(ensureItems, map[string]any{"id": it.(map[string]any)["id"], "priority": 0})
	}
	ensReq, _ := json.Marshal(map[string]any{"t": "req", "id": 23, "m": "preview.ensure", "p": map[string]any{
		"lane": "grid", "epoch": 1, "profile": "grid-sm", "items": ensureItems, "force": []any{}}})
	golden["res-preview.ensure.json"] = call(23, string(ensReq))
	// Workers finish in any order and results may span batches: merge all
	// preview.ready items and sort by id for a canonical fixture.
	var ready []any
	var readyFrame map[string]any
	for len(ready) < len(ensureItems) {
		for i := 0; i < len(events); i++ {
			if events[i]["ch"] == "preview.ready" {
				readyFrame = events[i]
				ready = append(ready, events[i]["p"].(map[string]any)["items"].([]any)...)
				events = append(events[:i], events[i+1:]...)
				i--
			}
		}
		if len(ready) < len(ensureItems) {
			events = append(events, read().(map[string]any))
		}
	}
	slices.SortFunc(ready, func(a, b any) int {
		return int(a.(map[string]any)["id"].(float64) - b.(map[string]any)["id"].(float64))
	})
	readyFrame["p"] = map[string]any{"items": ready}
	readyFrame["seq"] = float64(1)
	golden["evt-preview.ready.json"] = readyFrame
	golden["res-query.page-thumbs.json"] = call(24, pageReq(24))
	// media.resolve (main-only method): path is normalized as volatile.
	firstImage := cold[0].(map[string]any)["id"]
	mr, _ := json.Marshal(map[string]any{"t": "req", "id": 25, "m": "media.resolve", "p": map[string]any{"entryId": firstImage}})
	golden["res-media.resolve.json"] = call(25, string(mr))
	golden["res-media.resolve-missing.json"] = call(26, `{"t":"req","id":26,"m":"media.resolve","p":{"entryId":999999}}`)
	// clipboard.image (main-only, Stage 08.6): the temp PNG path is volatile.
	golden["res-clipboard.image.json"] = call(27, byID(27, "clipboard.image", map[string]any{"entryId": firstImage}))
	// A video resolves with a token-able original even without ffprobe.
	videosDir := filepath.Join(t.TempDir(), "videos")
	if err := os.MkdirAll(videosDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(videosDir, "clip.mp4"), []byte("not decoded here"), 0o644); err != nil {
		t.Fatal(err)
	}
	vReq, _ := json.Marshal(map[string]any{"t": "req", "id": 27, "m": "dir.open", "p": map[string]any{"path": videosDir, "recursive": false}})
	vDir := call(27, string(vReq)).(map[string]any)["r"].(map[string]any)
	for done := false; !done; {
		for _, e := range events {
			p, _ := e["p"].(map[string]any)
			if e["ch"] == "index.progress" && p["state"] == "completed" && p["dirId"] == vDir["dirId"] {
				done = true
			}
		}
		if !done {
			events = append(events, read().(map[string]any))
		}
	}
	vq, _ := json.Marshal(map[string]any{"t": "req", "id": 28, "m": "query.open", "p": map[string]any{
		"dirId": vDir["dirId"], "recursive": false, "sort": []any{}, "kinds": []any{}}})
	vqid := call(28, string(vq)).(map[string]any)["r"].(map[string]any)["queryId"]
	vp, _ := json.Marshal(map[string]any{"t": "req", "id": 29, "m": "query.page", "p": map[string]any{"queryId": vqid, "offset": 0, "limit": 1}})
	clipID := call(29, string(vp)).(map[string]any)["r"].(map[string]any)["items"].([]any)[0].(map[string]any)["id"]
	golden["res-media.resolve-video.json"] = call(44, byID(44, "media.resolve", map[string]any{"entryId": clipID}))
	golden["res-system.shutdown.json"] = call(5, `{"t":"req","id":5,"m":"system.shutdown","p":{}}`)
	if err := <-done; err != nil {
		t.Fatalf("run: %v", err)
	}

	for name, v := range golden {
		got, _ := json.MarshalIndent(v, "", "  ")
		got = append(got, '\n')
		path := filepath.Join(fixturesDir, name)
		if *update {
			if err := os.WriteFile(path, got, 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: %v (run with -update to create)", name, err)
		}
		if !bytes.Equal(bytes.ReplaceAll(want, []byte("\r\n"), []byte("\n")), got) {
			t.Errorf("%s drifted from golden fixture; if intentional, update TS contracts and rerun with -update\nwant:\n%s\ngot:\n%s", name, want, got)
		}
	}
}
