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
	"strings"
	"testing"
	"time"

	"panelyth/sidecar/internal/fixture"
	"panelyth/sidecar/internal/fsx"
	"panelyth/sidecar/internal/library"
	"panelyth/sidecar/internal/remote"
	"panelyth/sidecar/internal/remote/ftptest"
	"panelyth/sidecar/internal/rpc"
)

// Golden frames pin the wire contract shared with TypeScript
// (src/shared/contracts/test/fixtures.test.ts validates the same files).
// Regenerate with: go test ./internal/app -run TestGoldenFrames -update
var update = flag.Bool("update", false, "rewrite golden fixtures")

const fixturesDir = "../../../../shared/contracts/fixtures"

// volatile fields are replaced so fixtures are deterministic.
var volatile = map[string]any{
	"pid": 1234, "serverTimeNs": 1, "uptimeMs": 1, "goroutines": 1, "heapBytes": 1,
	"runtimeMemBytes": 1, "numCpu": 1, "goVersion": "go1.x", "cacheRoot": "/cache/Panelyth/v1",
	"configRoot": "/config/Panelyth", "path": "/fixtures/golden", "elapsedMs": 1, "lastListedAt": 1,
	"thumbnailRoot": "/cache/Panelyth/v1/thumbnails", "url": "panelyth-thumb://t/<key>.jpg",
	"crumbs":    []any{map[string]any{"name": "/", "path": "/"}, map[string]any{"name": "golden", "path": "/fixtures/golden"}},
	"volumes":   []any{map[string]any{"path": "/", "label": "", "kind": "fixed"}},
	"createdMs": 1, "accessedMs": 1, "lastOpenedAt": 1, "paths": []any{"/fixtures/golden/file"},
	"startedMs": 1, "finishedMs": 1, "file": "/cache/Panelyth/v1/tmp/clip.png",
	"firstMatchMs": 1, "dirPath": "/fixtures/golden",
	// Permission bits exist outside Windows only (Stage C09).
	"permissions": 420,
	// An edit session's id is random (Stage 12).
	"sessionId": "0123456789abcdef01234567",
	// Watcher rescans (inotify reports the test's own writes) take scan ids at
	// timing-dependent moments.
	"scanId": 1,
}

// platformDependent values are replaced even when null (Linux has no birth time).
var platformDependent = map[string]bool{"createdMs": true, "accessedMs": true, "permissions": true}

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
	env := map[string]string{"PANELYTH_DEV_METHODS": "1", "PANELYTH_CACHE_DIR": t.TempDir(), "PANELYTH_CONFIG_DIR": t.TempDir(),
		// Deterministic across machines: no ffprobe (video fields stay empty).
		"PANELYTH_FFMPEG": "off"}
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
	// Stage C03: hotlist edits on the shared bookmarks.
	golden["res-library.updateBookmark.json"] = call(140, byID(140, "library.updateBookmark", map[string]any{"id": 1, "path": fixtureDir, "label": "Golden", "group": "Work"}))
	golden["res-library.reorderBookmarks.json"] = call(141, `{"t":"req","id":141,"m":"library.reorderBookmarks","p":{"ids":[1]}}`)
	// The last bookmarks.changed carries the edited list (edits coalesce).
	for {
		var last map[string]any
		for _, e := range events {
			if e["ch"] == "bookmarks.changed" {
				last = e
			}
		}
		p, _ := last["p"].(map[string]any)
		if bs, _ := p["bookmarks"].([]any); len(bs) == 1 && bs[0].(map[string]any)["group"] == "Work" {
			last["seq"] = float64(1) // how many edits coalesced varies
			golden["evt-bookmarks.changed.json"] = last
			break
		}
		events = append(events, read().(map[string]any))
	}
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
	// Stage P03 (ADR-0029): a copy that asks about a conflict; pause,
	// resume, the answer, start-now of a finished job.
	conflictSrc := filepath.Join(t.TempDir(), "conflict-src")
	conflictDst := filepath.Join(t.TempDir(), "conflict-dst")
	for _, d := range []string{conflictSrc, conflictDst} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "x.jpg"), []byte("not decoded here"), 0o644); err != nil {
			t.Fatal(err)
		}
		fixed := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
		if err := os.Chtimes(filepath.Join(d, "x.jpg"), fixed, fixed); err != nil {
			t.Fatal(err)
		}
	}
	cDir := call(70, byID(70, "dir.open", map[string]any{"path": conflictSrc, "recursive": false})).(map[string]any)["r"].(map[string]any)
	for done := false; !done; {
		for _, e := range events {
			p, _ := e["p"].(map[string]any)
			if e["ch"] == "index.progress" && p["state"] == "completed" && p["dirId"] == cDir["dirId"] {
				done = true
			}
		}
		if !done {
			events = append(events, read().(map[string]any))
		}
	}
	cq := call(71, byID(71, "query.open", map[string]any{"dirId": cDir["dirId"], "recursive": false, "sort": []any{}, "kinds": []any{}})).(map[string]any)["r"].(map[string]any)
	cSel := map[string]any{"queryId": cq["queryId"], "version": cq["version"], "ranges": []any{[]int{0, 1}}, "include": []any{}, "exclude": []any{}}
	golden["res-jobs.start-ask.json"] = call(72, byID(72, "jobs.start", map[string]any{"kind": "copy", "source": map[string]any{"selection": cSel},
		"destination": conflictDst, "conflict": "ask", "verify": true, "now": false, "copyLinks": false}))
	askJob := golden["res-jobs.start-ask.json"].(map[string]any)["r"].(map[string]any)["jobId"]
	for found := false; !found; {
		for i, e := range events {
			p, _ := e["p"].(map[string]any)
			if e["ch"] == "job.conflict" && p["jobId"] == askJob {
				e["seq"] = float64(1)
				golden["evt-job.conflict.json"] = e
				events = append(events[:i], events[i+1:]...)
				found = true
				break
			}
		}
		if !found {
			events = append(events, read().(map[string]any))
		}
	}
	golden["res-jobs.pause.json"] = call(73, byID(73, "jobs.pause", map[string]any{"jobId": askJob}))
	golden["res-jobs.resume.json"] = call(74, byID(74, "jobs.resume", map[string]any{"jobId": askJob}))
	golden["res-jobs.resolve-invalid.json"] = call(75, byID(75, "jobs.resolve", map[string]any{"jobId": askJob, "decision": "ask", "applyToAll": false}))
	golden["res-jobs.resolve.json"] = call(76, byID(76, "jobs.resolve", map[string]any{"jobId": askJob, "decision": "renameNew", "applyToAll": true}))
	jobDone(askJob)
	golden["res-jobs.startNow.json"] = call(77, byID(77, "jobs.startNow", map[string]any{"jobId": askJob}))
	// Stage C04: a nested new folder, the trash question, a copy into a folder named by id.
	golden["res-fs.mkdir.json"] = call(78, byID(78, "fs.mkdir", map[string]any{"parentDirId": cDir["dirId"], "path": "new/nested"}))
	golden["res-fs.canTrash.json"] = call(79, byID(79, "fs.canTrash", map[string]any{"dirId": cDir["dirId"]}))
	newDir := golden["res-fs.mkdir.json"].(map[string]any)["r"].(map[string]any)["entryId"]
	golden["res-jobs.start-dirid.json"] = call(80, byID(80, "jobs.start", map[string]any{"kind": "copy", "source": map[string]any{"selection": cSel},
		"destinationDirId": newDir, "conflict": "keepBoth", "mask": "*.jpg", "copyLinks": true}))
	jobDone(golden["res-jobs.start-dirid.json"].(map[string]any)["r"].(map[string]any)["jobId"])
	golden["res-library.deleteTag.json"] = call(57, `{"t":"req","id":57,"m":"library.deleteTag","p":{"id":1}}`)
	// Stage P02 (ADR-0026): the commander's scope lists every entry.
	golden["res-query.open-all.json"] = call(58, `{"t":"req","id":58,"m":"query.open","p":{"dirId":1,"recursive":false,"sort":[{"field":"name","direction":"asc"}],"kinds":[],"scope":"all","showHidden":true,"nameMask":"*|*.tmp;.panelyth*"}}`)
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
	// Stage C05: any file for the commander's lister (main-only), and Shift+F4's new file.
	golden["res-file.resolve.json"] = call(81, byID(81, "file.resolve", map[string]any{"entryId": clipID}))
	golden["res-fs.mkfile.json"] = call(82, byID(82, "fs.mkfile", map[string]any{"parentDirId": vDir["dirId"], "name": "notes.txt"}))
	// Stage C06: find by name in the golden fixture, its results as a panel
	// session, and "Go to file".
	findReq, _ := json.Marshal(map[string]any{"t": "req", "id": 83, "m": "find.start", "p": map[string]any{
		"roots": []string{fixtureDir}, "mask": "*.jpg;*.txt|*0000*", "depth": 0, "hidden": false, "text": "", "caseSensitive": false,
		"wholeWords": false, "encodings": []string{}, "skipBinary": true, "minSize": nil, "maxSize": nil,
		"modifiedAfter": nil, "modifiedBefore": nil, "attrsSet": 0, "attrsClear": 0}})
	golden["res-find.start.json"] = call(83, string(findReq))
	findID := golden["res-find.start.json"].(map[string]any)["r"].(map[string]any)["findId"]
	findDone := waitEvent("find.progress", "completed")
	findDone["seq"] = float64(1) // depends on the events before it
	findDone["p"].(map[string]any)["current"] = "/fixtures/golden"
	golden["evt-find.progress.json"] = findDone
	golden["res-find.cancel.json"] = call(84, byID(84, "find.cancel", map[string]any{"findId": findID}))
	fq := call(85, byID(85, "query.open", map[string]any{"dirId": 0, "recursive": false, "sort": []any{map[string]any{"field": "name", "direction": "asc"}},
		"kinds": []any{}, "search": "", "exts": []any{}, "favorite": false, "minRating": 0, "tags": []any{}, "scope": "all", "findId": findID}))
	golden["res-query.open-find.json"] = fq
	foundPage := call(86, byID(86, "query.page", map[string]any{"queryId": fq.(map[string]any)["r"].(map[string]any)["queryId"], "offset": 0, "limit": 10}))
	golden["res-query.page-find.json"] = foundPage
	firstFound := foundPage.(map[string]any)["r"].(map[string]any)["items"].([]any)[0].(map[string]any)["id"]
	golden["res-dir.openContaining.json"] = call(87, byID(87, "dir.openContaining", map[string]any{"entryId": firstFound, "lane": "left"}))
	// Stage C07: an archive opened like a folder, its entries paged from the
	// listing, an extraction checked, and the archive closed.
	archDir := filepath.Join(t.TempDir(), "archives")
	_ = os.MkdirAll(archDir, 0o755)
	writeTestZip(t, filepath.Join(archDir, "set.zip"), map[string]string{"docs/a.txt": "a", "b.txt": "bb"})
	aDir := call(90, byID(90, "dir.open", map[string]any{"path": archDir, "recursive": false})).(map[string]any)["r"].(map[string]any)
	for done := false; !done; {
		for _, e := range events {
			p, _ := e["p"].(map[string]any)
			if e["ch"] == "index.progress" && p["state"] == "completed" && p["dirId"] == aDir["dirId"] {
				done = true
			}
		}
		if !done {
			events = append(events, read().(map[string]any))
		}
	}
	aq := call(91, byID(91, "query.open", map[string]any{"dirId": aDir["dirId"], "recursive": false, "sort": []any{}, "kinds": []any{}, "scope": "all"})).(map[string]any)["r"].(map[string]any)
	zipID := call(92, byID(92, "query.page", map[string]any{"queryId": aq["queryId"], "offset": 0, "limit": 1})).(map[string]any)["r"].(map[string]any)["items"].([]any)[0].(map[string]any)["id"]
	golden["res-archive.open.json"] = call(93, byID(93, "archive.open", map[string]any{"entryId": zipID}))
	archiveID := golden["res-archive.open.json"].(map[string]any)["r"].(map[string]any)["archiveId"]
	golden["res-query.open-archive.json"] = call(94, byID(94, "query.open", map[string]any{"dirId": aDir["dirId"], "recursive": false,
		"sort": []any{map[string]any{"field": "name", "direction": "asc"}}, "kinds": []any{}, "search": "", "exts": []any{}, "favorite": false,
		"minRating": 0, "tags": []any{}, "scope": "all", "archiveId": archiveID, "archiveDirId": 0}))
	archQuery := golden["res-query.open-archive.json"].(map[string]any)["r"].(map[string]any)
	golden["res-query.page-archive.json"] = call(95, byID(95, "query.page", map[string]any{"queryId": archQuery["queryId"], "offset": 0, "limit": 10}))
	archSel := map[string]any{"queryId": archQuery["queryId"], "version": archQuery["version"], "ranges": []any{[]int{0, 2}}, "include": []any{}, "exclude": []any{}}
	check := call(96, byID(96, "archive.check", map[string]any{"selection": archSel, "destinationDirId": aDir["dirId"]}))
	check.(map[string]any)["r"].(map[string]any)["freeBytes"] = float64(1 << 30)
	golden["res-archive.check.json"] = check
	golden["res-archive.tools.json"] = call(97, `{"t":"req","id":97,"m":"archive.tools","p":{}}`)
	golden["res-archive.tools.json"].(map[string]any)["r"].(map[string]any)["sevenZip"] = false
	golden["res-archive.close.json"] = call(98, byID(98, "archive.close", map[string]any{"archiveId": archiveID}))
	golden["res-archive.open-notarchive.json"] = call(99, byID(99, "archive.open", map[string]any{"entryId": firstImage}))
	// Stage C01: the shared context and query.indexOf.
	imgSel := map[string]any{"queryId": qid, "version": 1, "ranges": []any{[]int{0, 2}}, "include": []any{}, "exclude": []any{}}
	golden["res-context.publish.json"] = call(61, byID(61, "context.publish", map[string]any{"app": "viewer", "dirId": imgDir["dirId"], "focusId": firstImage, "selection": imgSel}))
	golden["res-context.get.json"] = call(62, `{"t":"req","id":62,"m":"context.get","p":{}}`)
	// Stage P02: main names the app on screen (the watches follow it).
	golden["res-app.setVisible.json"] = call(67, `{"t":"req","id":67,"m":"app.setVisible","p":{"app":"viewer","seq":1}}`)
	golden["res-query.indexOf.json"] = call(63, byID(63, "query.indexOf", map[string]any{"queryId": qid, "entryId": firstImage}))
	// Stage C02: the carried selection, quick search and marking by mask.
	ctxVersion := golden["res-context.get.json"].(map[string]any)["r"].(map[string]any)["version"]
	golden["res-selection.fromContext.json"] = call(64, byID(64, "selection.fromContext", map[string]any{"version": ctxVersion, "queryId": qid}))
	golden["res-query.locate.json"] = call(65, byID(65, "query.locate", map[string]any{"queryId": qid, "pattern": "PHOTO_0001", "from": 0, "direction": "forward"}))
	golden["res-query.match.json"] = call(66, byID(66, "query.match", map[string]any{"queryId": qid, "mask": "photo_*.jpg|*0000.jpg"}))
	// Stage C03: volumes.changed comes from the volume monitor's polling,
	// which a test cannot trigger; its payload is the fs.volumes result type.
	golden["evt-volumes.changed.json"] = eventFrame(t, evVolumesChanged, fsVolumesResult{Volumes: []fsx.Volume{
		{Path: "C:\\", Label: "System", Kind: "fixed", FreeBytes: 1 << 30, TotalBytes: 1 << 40},
		{Path: "E:\\", Kind: "removable", NotReady: true},
		{Path: "Z:\\", Kind: "network", NotReady: true},
	}})
	// Stage C08: two folders compared (a mirror), the compare's rows as a
	// session, a filter and a direction change, the plan, Shift+F2's marks,
	// and a text diff.
	cmpDir := filepath.Join(t.TempDir(), "compare")
	cmpAt := time.Date(2024, 5, 6, 7, 8, 10, 0, time.UTC)
	for rel, data := range map[string]string{
		"left/same.txt": "same", "right/same.txt": "same",
		"left/notes.txt": "one\ntwo\nthree\n", "right/notes.txt": "one\n2\nthree\nfour\n",
		"left/only-left.txt": "l", "right/sub/only-right.txt": "r",
	} {
		p := filepath.Join(cmpDir, filepath.FromSlash(rel))
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// The left notes are a minute newer; everything else has one date.
	_ = filepath.WalkDir(cmpDir, func(p string, _ os.DirEntry, _ error) error {
		at := cmpAt
		if filepath.Base(p) == "notes.txt" && filepath.Base(filepath.Dir(p)) == "left" {
			at = cmpAt.Add(time.Minute)
		}
		return os.Chtimes(p, at, at)
	})
	openListedDir := func(id int, path string) (dir map[string]any, q map[string]any) {
		dir = call(id, byID(id, "dir.open", map[string]any{"path": path, "recursive": false})).(map[string]any)["r"].(map[string]any)
		for done := false; !done; {
			for _, e := range events {
				p, _ := e["p"].(map[string]any)
				if e["ch"] == "index.progress" && p["state"] == "completed" && p["dirId"] == dir["dirId"] {
					done = true
				}
			}
			if !done {
				events = append(events, read().(map[string]any))
			}
		}
		q = call(id+1, byID(id+1, "query.open", map[string]any{"dirId": dir["dirId"], "recursive": false,
			"sort": []any{map[string]any{"field": "name", "direction": "asc"}}, "kinds": []any{}, "scope": "all"})).(map[string]any)["r"].(map[string]any)
		return dir, q
	}
	cmpLeft, cmpLeftQ := openListedDir(150, filepath.Join(cmpDir, "left"))
	cmpRight, cmpRightQ := openListedDir(152, filepath.Join(cmpDir, "right"))
	cmpOpts := map[string]any{"toleranceMs": 2000, "dst": false, "ignoreDates": false}
	golden["res-compare.marks.json"] = call(154, byID(154, "compare.marks", map[string]any{
		"leftQueryId": cmpLeftQ["queryId"], "rightQueryId": cmpRightQ["queryId"], "toleranceMs": 2000, "dst": false, "ignoreDates": false}))
	golden["res-compare.dirs.json"] = call(155, byID(155, "compare.dirs", map[string]any{
		"leftDirId": cmpLeft["dirId"], "rightDirId": cmpRight["dirId"], "toleranceMs": cmpOpts["toleranceMs"], "dst": false,
		"ignoreDates": false, "content": true, "asymmetric": true}))
	cmpStart := golden["res-compare.dirs.json"].(map[string]any)["r"].(map[string]any)
	cmpDone := waitEvent("compare.progress", "completed")
	cmpDone["seq"] = float64(1) // depends on the events before it
	golden["evt-compare.progress.json"] = cmpDone
	golden["res-compare.show.json"] = call(156, byID(156, "compare.show", map[string]any{"compareId": cmpStart["compareId"],
		"show": []any{"copyRight", "copyLeft", "equal", "different", "delete"}}))
	cmpView := golden["res-compare.show.json"].(map[string]any)["r"].(map[string]any)
	golden["res-query.page-compare.json"] = call(157, byID(157, "query.page", map[string]any{"queryId": cmpView["queryId"], "offset": 0, "limit": 10}))
	cmpSel := map[string]any{"queryId": cmpView["queryId"], "version": cmpView["version"], "ranges": []any{[]int{0, 1}}, "include": []any{}, "exclude": []any{}}
	golden["res-compare.setAction.json"] = call(158, byID(158, "compare.setAction", map[string]any{"compareId": cmpStart["compareId"],
		"selection": cmpSel, "action": "none"}))
	golden["res-compare.plan.json"] = call(159, byID(159, "compare.plan", map[string]any{"compareId": cmpStart["compareId"]}))
	golden["res-compare.cancel.json"] = call(160, byID(160, "compare.cancel", map[string]any{"compareId": cmpStart["compareId"]}))
	golden["res-compare.close.json"] = call(161, byID(161, "compare.close", map[string]any{"compareId": cmpStart["compareId"]}))
	cmpPage := func(id int, q map[string]any, name string) any {
		items := call(id, byID(id, "query.page", map[string]any{"queryId": q["queryId"], "offset": 0, "limit": 10})).(map[string]any)["r"].(map[string]any)["items"].([]any)
		for _, it := range items {
			if it.(map[string]any)["name"] == name {
				return it.(map[string]any)["id"]
			}
		}
		t.Fatalf("no %s in the compare fixture", name)
		return nil
	}
	golden["res-diff.open.json"] = call(164, byID(164, "diff.open", map[string]any{
		"leftId": cmpPage(162, cmpLeftQ, "notes.txt"), "rightId": cmpPage(163, cmpRightQ, "notes.txt")}))
	diffID := golden["res-diff.open.json"].(map[string]any)["r"].(map[string]any)["diffId"]
	golden["res-diff.page.json"] = call(165, byID(165, "diff.page", map[string]any{"diffId": diffID, "offset": 0, "limit": 10}))
	golden["res-diff.close.json"] = call(166, byID(166, "diff.close", map[string]any{"diffId": diffID}))
	// Stage C09: a multi-rename previewed (a page with a conflict and an
	// invalid name), a plan that cannot be compiled, and the undo's state.
	renDir := filepath.Join(t.TempDir(), "rename")
	for i, name := range []string{"IMG_1.jpg", "IMG_2.jpg", "notes.txt", "taken.txt"} {
		p := filepath.Join(renDir, name)
		_ = os.MkdirAll(renDir, 0o755)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		at := time.Date(2024, 3, 9, 7, 5, i, 0, time.UTC)
		_ = os.Chtimes(p, at, at)
	}
	_, renQ := openListedDir(170, renDir)
	renSel := map[string]any{"queryId": renQ["queryId"], "version": renQ["version"], "ranges": []any{[]int{0, 3}}, "include": []any{}, "exclude": []any{}}
	// Both pictures become img.jpg (a duplicate); the notes get an invalid name.
	renPlan := map[string]any{"nameMask": "[N1-3]", "extMask": "[E]", "search": "not", "replace": "taken/", "regex": false,
		"matchCase": false, "case": "lower", "start": 1, "step": 1, "digits": 1}
	golden["res-rename.preview.json"] = call(172, byID(172, "rename.preview", map[string]any{"selection": renSel, "plan": renPlan, "offset": 0, "limit": 10}))
	renPlan["nameMask"] = "[N"
	golden["res-rename.preview-invalid.json"] = call(173, byID(173, "rename.preview", map[string]any{"selection": renSel, "plan": renPlan, "offset": 0, "limit": 10}))
	golden["res-rename.undoInfo.json"] = call(174, `{"t":"req","id":174,"m":"rename.undoInfo","p":{}}`)
	// Stage 12: the image editor. edit.frame, edit.write and edit.savedPath
	// are answered to Electron main only (a frame file, a job, a path).
	edit := call(180, byID(180, "edit.open", map[string]any{"entryId": firstImage, "owner": 1})).(map[string]any)
	golden["res-edit.open.json"] = edit
	// normalize() replaced the id in the frame; ask the sidecar for a second
	// session to drive, and keep its real id out of the fixtures.
	var realSession string
	{
		send(byID(181, "edit.open", map[string]any{"entryId": firstImage, "owner": 1}))
		for {
			p, err := fr.ReadFrame()
			if err != nil {
				t.Fatal(err)
			}
			var f struct {
				T  string `json:"t"`
				ID int    `json:"id"`
				R  struct {
					SessionID string `json:"sessionId"`
				} `json:"r"`
			}
			if err := json.Unmarshal(p, &f); err != nil {
				t.Fatal(err)
			}
			if f.T != "evt" && f.ID == 181 {
				realSession = f.R.SessionID
				break
			}
		}
	}
	ops := []any{map[string]any{"op": "rotate", "p": map[string]any{"angle": 90}},
		map[string]any{"op": "crop", "p": map[string]any{"rect": map[string]any{"x": 0, "y": 0, "w": 0.5, "h": 0.5}}}}
	golden["res-edit.frame.json"] = call(182, byID(182, "edit.frame", map[string]any{"sessionId": realSession, "rev": 1,
		"editList": ops, "view": map[string]any{"maxEdge": 256}, "quality": "final", "histogram": true}))
	golden["res-edit.frame-superseded.json"] = call(183, byID(183, "edit.frame", map[string]any{"sessionId": realSession, "rev": 1,
		"editList": ops, "view": map[string]any{"maxEdge": 256}, "quality": "draft", "histogram": false}))
	golden["res-edit.info.json"] = call(184, byID(184, "edit.info", map[string]any{"sessionId": realSession}))
	// Stage 13: a color tool, the histogram it is given, a probe, preset
	// thumbnails and Count colors.
	tone := []any{map[string]any{"op": "lighting", "p": map[string]any{"contrast": 30}},
		map[string]any{"op": "reduceColors", "p": map[string]any{"count": 4}}}
	golden["res-edit.frame-before.json"] = call(192, byID(192, "edit.frame", map[string]any{"sessionId": realSession, "rev": 2,
		"editList": tone, "view": map[string]any{"maxEdge": 256}, "quality": "draft", "histogram": false, "histogramAt": 1}))
	golden["res-edit.probe.json"] = call(193, byID(193, "edit.probe", map[string]any{"sessionId": realSession,
		"editList": tone, "view": map[string]any{"maxEdge": 256}, "x": 0.5, "y": 0.5, "radius": 2}))
	golden["res-edit.thumbFrames.json"] = call(194, byID(194, "edit.thumbFrames", map[string]any{"sessionId": realSession,
		"editLists": []any{[]any{}, tone, []any{map[string]any{"op": "nope", "p": map[string]any{}}}}, "edge": 64}))
	golden["res-edit.colors.json"] = call(195, byID(195, "edit.colors", map[string]any{"sessionId": realSession,
		"editList": tone, "scope": "edited", "maxColors": 8}))
	golden["res-edit.source.json"] = call(191, byID(191, "edit.source", map[string]any{"sessionId": realSession}))
	golden["res-edit.estimate.json"] = call(185, byID(185, "edit.estimate", map[string]any{"sessionId": realSession,
		"editList": ops, "format": "png", "quality": 0, "metadata": "keep"}))
	golden["res-edit.write.json"] = call(186, byID(186, "edit.write", map[string]any{"sessionId": realSession,
		"editList": ops, "target": "copy", "format": "png", "quality": 0, "metadata": "strip", "dpi": 0}))
	editJob := golden["res-edit.write.json"].(map[string]any)["r"].(map[string]any)["jobId"]
	editDone := jobDone(editJob)
	editDone["seq"] = float64(1)
	golden["evt-job.progress-editSave.json"] = editDone
	golden["res-edit.saved.json"] = call(187, byID(187, "edit.saved", map[string]any{"jobId": editJob}))
	// The new entry's id depends on how many entries the platform indexed before it.
	golden["res-edit.saved.json"].(map[string]any)["r"].(map[string]any)["entryId"] = float64(1)
	golden["res-edit.savedPath.json"] = call(188, byID(188, "edit.savedPath", map[string]any{"jobId": editJob}))
	// Stage 14: a picture picked in Electron main becomes an asset (main-only
	// methods: they take a path), and the font families by name.
	pics, _ := filepath.Glob(filepath.Join(imagesDir, "*.jpg"))
	if len(pics) == 0 {
		t.Fatal("no picture to use as an asset")
	}
	asset := call(196, byID(196, "edit.assetAdd", map[string]any{"sessionId": realSession, "path": pics[0]})).(map[string]any)
	realAsset := asset["r"].(map[string]any)["assetId"]
	// The id is a hash of the file, whose bytes the fixtures do not pin.
	asset["r"].(map[string]any)["assetId"] = "0123456789abcdef0123456789abcdef"
	golden["res-edit.assetAdd.json"] = asset
	golden["res-edit.assetAdd-invalid.json"] = call(197, byID(197, "edit.assetAdd", map[string]any{"sessionId": realSession,
		"path": filepath.Join(videosDir, "clip.mp4")}))
	families := call(198, byID(198, "edit.fonts", map[string]any{"sessionId": realSession})).(map[string]any)
	// The built-in families come first; what follows is the machine's.
	families["r"].(map[string]any)["families"] = families["r"].(map[string]any)["families"].([]any)[:2]
	golden["res-edit.fonts.json"] = families
	golden["res-edit.assetDrop.json"] = call(199, byID(199, "edit.assetDrop", map[string]any{"sessionId": realSession, "assetId": realAsset}))
	// Stage 15: strokes are operations like any other; red pupils are found on request.
	strokes := []any{map[string]any{"op": "draw", "p": map[string]any{"strokes": []any{map[string]any{
		"tool": "brush", "color": "#ff0000", "size": 5, "points": []any{[]any{0.2, 0.2}, []any{0.8, 0.8, 0.7}}}}}}}
	golden["res-edit.frame-strokes.json"] = call(200, byID(200, "edit.frame", map[string]any{"sessionId": realSession, "rev": 3,
		"editList": strokes, "view": map[string]any{"maxEdge": 256}, "quality": "draft", "histogram": false}))
	golden["res-edit.eyes.json"] = call(201, byID(201, "edit.eyes", map[string]any{"sessionId": realSession, "editList": strokes}))
	golden["res-edit.close.json"] = call(189, byID(189, "edit.close", map[string]any{"sessionId": realSession}))
	golden["res-edit.frame-gone.json"] = call(190, byID(190, "edit.frame", map[string]any{"sessionId": realSession, "rev": 2,
		"editList": ops, "view": map[string]any{"maxEdge": 256}, "quality": "final", "histogram": false}))
	// Stage 16: a recipe over a selection. edit.plan and edit.batch are
	// answered to Electron main only (their folder is a path).
	batchDir := filepath.Join(t.TempDir(), "batch")
	if err := fixture.GenerateImages(batchDir, fixture.ImageSpec{Count: 2, Width: 64, Height: 48}); err != nil {
		t.Fatal(err)
	}
	_, batchQ := openListedDir(210, batchDir)
	batchSel := map[string]any{"queryId": batchQ["queryId"], "version": batchQ["version"], "ranges": []any{[]int{0, 2}}, "include": []any{}, "exclude": []any{}}
	recipe := map[string]any{"version": 1,
		"ops":    []any{map[string]any{"op": "resize", "p": map[string]any{"mode": "percent", "w": 50}}},
		"output": map[string]any{"format": "jpeg", "quality": 80, "metadata": "keep", "destination": "beside", "template": "{name}-half", "conflict": "keepBoth"}}
	batch := map[string]any{"source": map[string]any{"selection": batchSel}, "recipe": recipe}
	plan := call(212, byID(212, "edit.plan", batch)).(map[string]any)
	// Sizes follow the JPEG encoder, ids the entries indexed before.
	planR := plan["r"].(map[string]any)
	planR["bytes"], planR["estimateBytes"] = float64(2000), float64(500)
	for i, s := range planR["samples"].([]any) {
		s.(map[string]any)["id"] = float64(i + 1)
	}
	golden["res-edit.plan.json"] = plan
	golden["res-edit.batch.json"] = call(213, byID(213, "edit.batch", batch))
	batchJob := golden["res-edit.batch.json"].(map[string]any)["r"].(map[string]any)["jobId"]
	jobDone(batchJob)
	// The two results go to the trash; the originals stay.
	golden["res-batch.undo.json"] = call(214, byID(214, "batch.undo", map[string]any{"jobId": batchJob}))
	jobDone(golden["res-batch.undo.json"].(map[string]any)["r"].(map[string]any)["jobId"])
	golden["res-recipe.save.json"] = call(215, byID(215, "recipe.save", map[string]any{"id": 0, "name": "Half size", "recipe": recipe}))
	golden["res-recipe.list.json"] = call(216, byID(216, "recipe.list", map[string]any{}))
	golden["res-recipe.delete.json"] = call(217, byID(217, "recipe.delete", map[string]any{"id": 1}))
	// Stage C10.5 (ADR-0037): a connection saved with its password as
	// ciphertext, a loopback FTP server browsed, and the list's change event.
	ftpRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(ftpRoot, "readme.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	ftp, err := ftptest.Start(ftptest.Options{Root: ftpRoot})
	if err != nil {
		t.Fatal(err)
	}
	defer ftp.Close()
	saved := library.Connection{Name: "Example", Group: "Work", Host: "ftp.example.org", Port: 21, TLS: "explicit",
		User: "alice", StartPath: "/pub", Transfers: 2}
	golden["res-remote.storeConnection.json"] = call(220, byID(220, "remote.storeConnection", map[string]any{"connection": saved, "secret": "AAEC"}))
	golden["res-remote.connections.json"] = call(221, byID(221, "remote.connections", map[string]any{}))
	golden["res-remote.secret.json"] = call(222, byID(222, "remote.secret", map[string]any{"connectionId": 1}))
	golden["res-remote.trust.json"] = call(223, byID(223, "remote.trust", map[string]any{"connectionId": 1, "fingerprint": strings.Repeat("ab", 32)}))
	dial := call(224, byID(224, "remote.dial", map[string]any{"password": "", "attempt": 1,
		"quick": map[string]any{"host": ftp.Host, "port": ftp.Port, "tls": "none", "user": "", "active": false, "encoding": "", "transfers": 2}})).(map[string]any)
	// The test server's port is the system's choice.
	dial["r"].(map[string]any)["port"] = float64(21)
	golden["res-remote.dial.json"] = dial
	remoteID := int64(dial["r"].(map[string]any)["remoteId"].(float64))
	golden["res-remote.open.json"] = call(225, byID(225, "remote.open", map[string]any{"remoteId": remoteID, "path": "/"}))
	remoteDir := golden["res-remote.open.json"].(map[string]any)["r"].(map[string]any)["remoteDirId"]
	golden["res-remote.mkdir.json"] = call(226, byID(226, "remote.mkdir", map[string]any{"remoteDirId": remoteDir, "name": "new folder"}))
	// readme.txt is the first entry the connection listed (the root is entry 0).
	golden["res-remote.rename.json"] = call(227, byID(227, "remote.rename", map[string]any{"entryId": remote.EntryID(remoteID, 1), "name": "read me.txt"}))
	golden["res-remote.cancel.json"] = call(228, byID(228, "remote.cancel", map[string]any{"attempt": 99}))
	golden["res-remote.disconnect.json"] = call(229, byID(229, "remote.disconnect", map[string]any{"remoteId": remoteID}))
	golden["res-remote.removeConnection.json"] = call(230, byID(230, "remote.removeConnection", map[string]any{"connectionId": 1}))
	saved.ID, saved.HasPassword, saved.Fingerprint = 1, true, strings.Repeat("ab", 32)
	golden["evt-connections.changed.json"] = eventFrame(t, evConnectionsChanged, connectionsEvent{Connections: []library.Connection{saved}})
	// "Open with" (main only): a picture the OS handed over, by its path. The
	// folder was listed above, so the entry is the one the listing made.
	batchPics, _ := filepath.Glob(filepath.Join(batchDir, "*.jpg"))
	if len(batchPics) == 0 {
		t.Fatal("no picture to open by path")
	}
	golden["res-entry.fromPath.json"] = call(231, byID(231, "entry.fromPath", map[string]any{"path": batchPics[0]}))
	golden["res-system.shutdown.json"] = call(5, `{"t":"req","id":5,"m":"system.shutdown","p":{}}`)
	if err := <-done; err != nil {
		t.Fatalf("run: %v", err)
	}

	// A started job's answer races the queue: it may already be running.
	for _, name := range []string{"res-jobs.start.json", "res-jobs.start-ask.json", "res-jobs.start-dirid.json",
		"res-edit.batch.json", "res-batch.undo.json"} {
		if r, ok := golden[name].(map[string]any)["r"].(map[string]any); ok && r["state"] == "running" {
			r["state"] = "queued"
		}
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

// eventFrame builds an event frame as the sidecar writes it, for channels
// the golden run cannot trigger.
func eventFrame(t *testing.T, ch string, payload any) map[string]any {
	t.Helper()
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var p any
	if err := json.Unmarshal(b, &p); err != nil {
		t.Fatal(err)
	}
	return map[string]any{"t": "evt", "ch": ch, "seq": float64(1), "p": p}
}
