# Domain API (shared)

The renderer-facing API is typed, narrow, asynchronous and batch-oriented.

Both apps use this API through their own preload. Each app's main allows only its own method groups (ADR-0027). The
canonical contract is `src/shared/contracts/src/rpc.ts` (ADR-0012); this page is the conceptual map. The commander adds
listing extras (attributes, hidden toggle, name masks, `query.locate`), the job queue (ADR-0029), find, archive and
compare methods; they are specified in its stage documents (`docs/commander/stages/`).

## Navigation

```ts
navigate.openFolder(path)
navigate.back()
navigate.forward()
navigate.up()
navigate.refresh()
```

## Content

> Implemented in Stage 01 as query sessions (ADR-0017): `query.open(descriptor) → { queryId, version, total }`,
> `query.page({ queryId, offset, limit ≤ 1000 })`, `query.close(queryId)`, plus the `query.invalidated` event.
> Folders are opened with `dir.open({ path, recursive })`. Contracts: `src/shared/contracts/src/rpc.ts`.
>
> Stage C01 added `query.indexOf({ queryId, entryId }) → { index, version }` (−1 when absent): where an entry sits in
> a session, for the cursor on the folder just left and for a carried-over focus. `dir.open` now reads one name of
> the folder, so a folder the user cannot list fails with `PERMISSION_DENIED` instead of listing empty; a volume that
> is there but unreadable fails with `INVALID_PATH`, `retryable: true` and `details.reason` `"notReady"` (empty card
> reader, removed device) or `"network"` (unreachable share) (CFR-28). `fs.volumes` reports `freeBytes` and
> `totalBytes` for fixed and removable volumes.

```ts
content.page({
  folderId,
  offset,
  limit,
  sort: [
    { field: "modifiedAt", direction: "desc" },
    { field: "name", direction: "asc" }
  ],
  search: {
    query: "holiday",
    recursive: false
  },
  filters: {
    mediaKinds: ["image", "video"]
  }
})
```

## Search

```ts
search.query({
  folderId,
  query,
  recursive,
  offset,
  limit
})
```

## Preview

```ts
preview.ensure(items, profile)
preview.getUrl(cacheKey)
preview.metadata(fileId)
```

## Batch operations

```ts
batch.copy(ids, destination)
batch.move(ids, destination)
batch.delete(ids)
batch.rename(ids, pattern)
batch.favorite(ids, value)
batch.tag(ids, tag)
batch.rate(ids, rating)
batch.cancel(jobId)
```

> As built (ADR-0021, ADR-0029): every batch is `jobs.start({ kind, source: { selection }, … })`, with copy/move options
> `destination`, `conflict` (`ask`, `keepBoth`, `skip`, `replace`, `replaceOlder`, `replaceIfDifferentSize`,
> `renameNew`, `renameExisting`), `verify?` and `now?`. Stage C04 added `destinationDirId` (instead of `destination`; the
> commander must use it), `mask?` and `name?` (a single item under a new name), the same `destinationDirId` for
> `clip.paste`, `fs.mkdir({ parentDirId, path }) → { entryId, created }`, `fs.canTrash({ dirId }) → { trash }` and
> `clipboard.copyPaths({ selection, namesOnly? })`. Stage P03 added `jobs.pause`, `jobs.resume`, `jobs.startNow`
> and `jobs.resolve({ jobId, decision, applyToAll })`, the `job.conflict { jobId, conflict }` event, the states `paused`
> and `asking`, and `bytesPerSec`, `etaMs` and `conflict` on the snapshot. Main adds `copyLinks` for the commander.

## Properties

```ts
properties.get(fileId)
```

## View, open and edit (Stage C05)

```ts
media.open({ entryId })            // images and videos: token URL, size, codecs (both apps)
file.open({ entryId })             // commander: any file → { url, kind, mime, sizeBytes }; bytes by HTTP Range
shell.open({ entryId, allowProgram? })   // the default app; kinds per app profile (ADR-0027)
shell.edit({ entryId })            // commander, F4: the editor from commander.settings.editor, else the OS text editor
fs.mkfile({ parentDirId, name })   // commander, Shift+F4 → { entryId, created }
```

> As built (Stage C05, ADR-0027): `file.open` mints a read-only `panelyth-media://m/<token>` for any file kind (a
> folder is refused); files that are not media are served as `application/octet-stream` with `nosniff`. The token is
> bound to the commander's origin, and only the commander's CSP allows `fetch()` of token URLs (`connect-src`), so the
> viewer can never read a token's bytes. Main resolves entries through the main-only sidecar methods `file.resolve`
> and `entry.path` (which reports `program`: executables, scripts, installers, shortcuts, app bundles). `shell.open`
> from the viewer opens folders and media only, never a program; from the commander it opens any kind, and a program
> only with `allowProgram` (otherwise `PERMISSION_DENIED` with `details.reason: "program"`, which the commander answers
> per its "Run programs with Enter" setting). `shell.edit` starts the editor without a shell; under
> `PANELYTH_TEST_SHELL=record` both are recorded instead.
>
> As built (Stage C10, ADR-0027): `shell.run({ command, dirId, console? })` runs a typed line through the OS shell in
> the folder `dirId`; `shell.runTool({ toolId, dirId, otherDirId?, cursorId?, selection? })` runs a user command that
> main reads from `commander.tools` and fills from these ids. Both are the commander's, answered in main, and accepted
> only from the commander's own view while it is shown. Refusals carry `details.reason`: `hidden`, `folder`, `unc`,
> `noEntry`, `noOther`, `tooMany`, `tooLong`, `dir`, `shadowed`, `name`.

## Files opened from the OS ("Open with", ADR-0033 amended)

```ts
entry.fromPath({ path })     // main -> sidecar only: { dirId, entryId, kind, listed }; images and videos only
media.windowReveal()         // the media window of such a file (commander profile): show it in the viewer; no parameters
app.openRequest()            // viewer, once at start: { request: { dirId, entryId } | null }
// event, main -> viewer:    open.request { dirId, entryId }
```

> A picture or video the OS hands to the app opens in a media window with no app window behind it. The path is
> read by main from the launch's arguments and given to the sidecar; no renderer method takes one. The window's
> items come through the existing `media.windowStep`, answered by main from a session over the file's folder.
> `media.windowReveal` is accepted only from a window main opened for a file, and takes the viewer to the folder
> and entry main already knows; `app.openRequest` hands that pair to a viewer started for it.

## Connections (Stage C10.5, commander only, ADR-0037)

```ts
remote.connections()                                  // → { connections }: saved connections, no secrets (hasPassword)
remote.saveConnection({ connection, password?, forget? })   // main encrypts the password; none is ever returned
remote.removeConnection({ connectionId })
remote.trust({ connectionId, fingerprint })           // remember an accepted certificate ("" forgets it)
remote.connect({ connectionId } | { quick }, { attempt, password?, accept? })   // → { remoteId, host, port, user, encrypted, features, startPath, localPath }
remote.cancel({ attempt })                            // a connect or a listing that is under way
remote.disconnect({ remoteId })
remote.open({ remoteId, path | dirId, attempt? })     // lists a folder on the server → { remoteDirId, path, name, crumbs, rejected }
remote.mkdir({ remoteDirId, name })
remote.rename({ entryId, name })
remote.secureStore()                                  // → { available }: can this computer keep passwords?
query.open({ …, remoteId, remoteDirId })              // a session over a listed folder
files.start({ kind: "download", source, destinationDirId, conflict, move? })
files.start({ kind: "upload", source, remoteDirId, conflict, move? })
files.start({ kind: "remoteDelete", source })
```

> As built (Stage C10.5): every `remote.*` method and the three job kinds are in the commander's profile only; main
> refuses them, and `query.open` with `remoteId`, from the viewer. `remote.saveConnection`, `remote.connect` and
> `remote.secureStore` are answered in main, which is the only place a password is ever in the clear outside the
> one `remote.dial` call: it encrypts with Electron's `safeStorage` before `remote.storeConnection` (main-only), and
> for a saved connection reads the ciphertext with `remote.secret` (main-only) and decrypts it for `remote.dial`
> (main-only). No method returns a password. A connection is `{ id, name, group, host, port, tls: "explicit" |
> "implicit" | "none", user, startPath, localPath, active, encoding, transfers, fingerprint, hasPassword }`; main
> checks every field (one line, no control characters, lengths, port 1–65535, 1–4 transfers, a fingerprint of 64
> hex digits), a host without spaces or separators, and a server path that starts with `/`. Failures carry
> `details.reason`: `auth`, `needsPassword` (a stored password that can't be decrypted here), `noSecureStore`,
> `host`, `timeout`, `unreachable`, `tlsRequired`, `certificate` (with `fingerprint`, `subject` and `changed`),
> `refused` (the server's own words as the message), `closed`, `notFound`, `name`, `tooLarge`, `unsupported`,
> `duplicate` (a connection's name is taken). The `connections.changed` event carries the saved connections after
> any change. Entries of a connection have ids from 7·2^50 up; `selection.info` and `props.get` answer for them,
> `file.resolve` serves a temporary copy to view (at most 256 MiB), and every other entry method and job refuses
> them ("this is not available on a connection").

## Image editor (Stages 12 to 15, viewer only)

```ts
edit.open({ entryId })             // → { sessionId, name, width, height, format, hasAlpha, dpi, saveFormat, canReplace }
edit.render({ sessionId, rev, editList, view: { maxEdge }, quality, histogram })
                                   // → { rev, frame: { url, width, height }, output, histogram? } | { rev, superseded }
edit.info({ sessionId })           // EXIF tags in groups
edit.estimate({ sessionId, editList, format, quality, metadata })   // → { bytes }
edit.save({ sessionId, editList, target, format, quality, metadata, dpi })   // → { jobId, name }; an editSave job
edit.close({ sessionId })
edit.saved({ jobId })              // → { entryId, name } once the saved file is indexed
edit.reveal({ jobId })             // shows the saved file in the file manager
// Stage 13
edit.render({ …, histogramAt })    // also → before: the histogram after that many active operations
edit.probe({ sessionId, editList, view, x, y, radius })       // → { rgba, hex }: the color around a point (0..1)
edit.thumbs({ sessionId, editLists, edge })                   // → { thumbs: ({ url, width, height } | null)[] }
edit.colors({ sessionId, editList, scope, maxColors })        // → { distinct, palette: { hex, share }[], hasAlpha, width, height }
// Stage 14
edit.fonts({ sessionId })          // → { families: string[] }: names only, the built-in ones first
asset.pick({ sessionId })          // → { asset: { assetId, name, width, height, thumbUrl } | null }: main's file dialog
asset.release({ sessionId, assetId })
// Stage 15
edit.eyes({ sessionId, editList })  // → { eyes: { x, y, w, h }[] }: red pupils in the rendered picture, in pairs
// Stage 16: batch mode (ADR-0036)
batch.pickFolder()                              // → { folder: { folderId, name } | null }: main's folder dialog
batch.plan({ source, recipe, folderId? })       // → { count, skipped, names, bytes, estimateBytes, warnings, problems, samples }
batch.start({ source, recipe, folderId? })      // → JobSnapshot (kind "edit")
batch.undo({ jobId })                           // → JobSnapshot (kind "undoEdit"): the created files go to the trash
recipe.list()                                   // → { recipes: { id, builtin, name, recipe }[] }
recipe.save({ id, name, recipe })               // → { id, name }
recipe.delete({ id })
```

> As built (Stage 12, ADR-0035, ADR-0027): the methods are in the viewer's profile only. An edit list is
> `{ op, p, off? }[]` (`rotate`, `flip`, `crop`, `resize`, `canvas`, `dpi`); main checks its structure
> (`editListProblem`: at most 512 operations, 1 MB, plain JSON with finite numbers) and Go its meaning. `rev` orders
> renders: a higher one replaces every lower one, which answers `superseded`. A frame is a JPEG in `<cache>/tmp/edit`
> behind a `panelyth-media:` token; `edit.render`, `edit.save` and `edit.reveal` are answered in main, which calls the
> main-only sidecar methods `edit.frame`, `edit.source`, `edit.write` and `edit.savedPath`, so no path reaches a
> renderer: a "save as" destination comes from main's save dialog. `target` is `copy` (`name (edited).ext` beside
> the original), `as` or `replace` (the original goes to the trash first; `TRASH_UNAVAILABLE` where there is none).
> The commander's Edit is `app.switch({ to: "viewer", edit: entryId })`; main shows the viewer and sends it
> `edit.request`.
>
> As built (Stage 13): the list also takes `lighting`, `colors`, `levels`, `curves`, `grayscale`, `sepia`,
> `negative`, `swapChannels`, `replaceColor`, `sharpen`, `blur`, `denoise` and `reduceColors`; a missing parameter is
> the value that changes nothing. `edit.probe` is how an eyedropper reads a color (no pixel reaches the renderer);
> `edit.thumbs` renders at most 16 lists at up to 256 px in one call and is answered in main through the main-only
> `edit.thumbFrames`; `edit.colors` counts the proxy (`preview`, an estimate for the palette display) or the whole
> picture (`edited`, `original`: exact, decodes the source again). All three are in the viewer's profile only.
>
> As built (Stage 14): the list also takes `border`, `frameMask`, `watermark`, `obscure`, `lens`, `bump`, `sketch`
> and `oil`; sizes are percentages of the picture's shorter edge. A picture for a watermark, a mask or a texture is
> an **asset**: `asset.pick` opens the native dialog in main, which hands the path to the main-only `edit.assetAdd`;
> the sidecar checks the file (a regular PNG, JPEG, WebP or GIF by content, at most 16 MB and 8,000 px, not
> animated; otherwise `EDIT_ASSET_INVALID`) and answers with an id that is a hash of its content and a thumbnail
> file, which main turns into a token. An edit list names the asset by that id (`assetId`); no renderer method takes
> a path. Fonts are named by family; an unknown family is drawn with the built-in default.
>
> As built (Stage 15): `draw { strokes }` (one drawing; a stroke is `{ tool, color, size, hardness, opacity,
> points, … }` with `tool` one of brush, eraser, line, arrow, rect, ellipse, text, fill), `clone { points, source,
> size, … }`, `heal { mode: "spot" | "brush", points, source?, size }` and `redeye { rect | auto, strength, pupil }`.
> Points are `[x, y]` or `[x, y, pressure]`, 0..1 of the picture. A stroke in progress is sent as an ordinary
> `edit.render` of the list as it is, once per animation frame; there is no incremental parameter. The whole list
> is at most 1 MB. None of these operations is batchable. `edit.eyes` only finds; the editor adds a `redeye` step
> per pupil.
>
> As built (Stage 16): a recipe is `{ version: 1, ops, output }` with `output { format: "keep" | SaveFormat,
> quality?, metadata, dpi?, destination: "beside" | "folder" | "replace", template?, conflict: "keepBoth" | "skip" |
> "replace" }`; `ops` holds at most 64 operations and none of `draw`, `clone`, `heal`, `redeye`. `source` is
> `{ selection }`. Main checks a recipe's structure (`recipeProblem`) and answers `batch.pickFolder`, `batch.plan`
> and `batch.start` itself: a picked folder is a 16-digit handle to the renderer, and main puts its path in when it
> calls the main-only `edit.plan` and `edit.batch`. `jobs.start` refuses the kinds `edit` and `undoEdit`. The plan
> reads no pixels: `skipped` is `{ reason: "folder" | "video" | "other" | "unsupported" | "notWritable", count }[]`,
> `warnings` are `trashUnavailable`, `formatChange` and `alphaLoss`, `problems` are `{ code, op, detail }` (the
> recipe cannot run), `names` the first five result names and `samples` up to twelve `{ id, name }` to judge the
> recipe on. Item errors of an edit job add `DECODE_FAILED` and `UNSUPPORTED` to the job codes. All of it is in the
> viewer's profile only.

## About, updates and the native menu (Stage P06, both apps, ADR-0038)

Answered in Electron main. No method takes a URL, a path or a version.

```ts
app.about()                       // { name, version, sidecarVersion, electron, chrome, node, platform, packaged, copyright }
app.openTarget({ target })        // "logs" | "notices" | "releases" | "issues" | "website": main opens the fixed place
update.get()                      // UpdateState; an app calls it once it listens to the two events below
update.check()                    // look for a newer version now
update.download()                 // "auto" builds, after a version was found
update.install()                  // quit, install the downloaded version, start it; { ok: false } when none is ready
onUpdateState(state)              // update.state: { mode, phase, currentVersion, version, notes[], percent, …, auto }
                                  //   mode: auto | manual | off; phase: idle | checking | upToDate | available |
                                  //   downloading | ready | error; a download reports at most 4 times a second;
                                  //   notes are plain text (main strips a feed's markup), at most 20 × 8,000 characters
onMenuCommand({ command })        // menu.command, to the app on screen: about | checkForUpdates | settings | shortcuts
```

`shared.updates` (`{ v: 1, auto }`, through `library.setSetting`) turns the automatic check on and off; main
follows it. The state shown comes from the events alone: the answer of `check` or `download` can be older than an
event that overtook it.

## Events

Coalesce events into batches:

```ts
onFolderChanged(changeSet)
onPreviewReady(previewBatch)
onBatchProgress(progressBatch)
onIndexProgress(progress)
```

## App switch and shared context

Both apps (ADR-0031, `docs/shared/APP-SWITCHING.md`):

```ts
app.switch({ to: "viewer" | "commander" })            // renderer → main: switch app views
onAppVisibility({ app, visible })                     // main → renderer: app view shown or hidden
context.publish({ app, dirId, focusId, selection? })  // the visible app, as itself (main checks both); selection on the switch only
context.get()                                         // { version, app, dirId, path, focusId, selectionCount, selectionTooLarge }
selection.fromContext({ version, queryId })           // C02: the carried selection as ranges of this session
```

Commander listing extras (Stage C02):

```ts
query.locate({ queryId, pattern, from, direction })  // quick search: next match (prefix, then substring; * and ?), -1 when none
query.match({ queryId, mask })                        // mark by mask: { version, ranges, count } of the matching files
jobs.start({ kind: "dirSize", source })              // folder sizes → ContentItem.dirSizeBytes (and selection.info bytes)
```

Drives, the hotlist and recent locations (Stage C03; the bookmark methods in both apps' profiles):

```ts
fs.volumes()                                   // { volumes: { path, label, kind, freeBytes?, totalBytes?, notReady? }[] }
                                               //   space read per volume with a timeout (0.5 s local, 1.5 s network)
onVolumesChanged({ volumes })                  // volumes.changed: drives came or went (polled every 2 s, coalesced)
library.addBookmark({ path, label, group? })   // bookmarks = the commander's hotlist; group "" = none
library.updateBookmark({ id, path, label, group })  // INVALID_ARGUMENT, details.reason "duplicate" for a taken path
library.reorderBookmarks({ ids })              // listed first in this order; the rest keep their order
library.removeBookmark({ id })
onBookmarksChanged({ bookmarks })              // bookmarks.changed: the whole list after any change, either app
```

## Rules

- no raw ipcRenderer
- no arbitrary filesystem APIs
- no base64 thumbnails
- no full video payload over normal RPC
- no one-request-per-item hot paths where batching is practical
