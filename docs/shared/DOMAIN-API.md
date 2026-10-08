# Domain API (shared)

The renderer-facing API is typed, narrow, asynchronous and batch-oriented.

Both apps use this API through their own preload. Each app's main allows only its own method groups (ADR-0027). The
canonical contract is `shared/contracts/src/rpc.ts` (ADR-0012); this page is the conceptual map. The commander adds
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
> Folders are opened with `dir.open({ path, recursive })`. Contracts: `shared/contracts/src/rpc.ts`.
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
app.switch({ to: "viewer" | "commander" })            // renderer → main: show the other app view
onAppVisibility({ app, visible })                     // main → renderer
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
