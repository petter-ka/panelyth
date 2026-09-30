# Domain API

The renderer-facing API is typed, narrow, asynchronous and batch-oriented.

## Navigation

```ts
navigate.openFolder(path)
navigate.back()
navigate.forward()
navigate.up()
navigate.refresh()
```

## Content

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

## Rules

- no raw ipcRenderer
- no arbitrary filesystem APIs
- no base64 thumbnails
- no full video payload over normal RPC
- no one-request-per-item hot paths where batching is practical
