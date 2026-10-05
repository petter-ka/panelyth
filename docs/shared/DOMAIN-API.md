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

## Properties

```ts
properties.get(fileId)
```

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
context.publish({ app, dirId, focusId?, selection? }) // the app being left; selection is a descriptor
context.get()                                         // the app being shown: folder, focus, selection count
selection.fromContext({ version, queryId, queryVersion }) // carried selection as ranges of the new session
```

## Rules

- no raw ipcRenderer
- no arbitrary filesystem APIs
- no base64 thumbnails
- no full video payload over normal RPC
- no one-request-per-item hot paths where batching is practical
