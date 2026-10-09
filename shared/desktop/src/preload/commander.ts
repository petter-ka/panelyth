// The commander's sandboxed preload (ADR-0027, ADR-0031): bundled into one
// CommonJS file of its own. It exposes only the commander's methods; main
// rejects anything else from this app view anyway.
import { contextBridge, ipcRenderer } from "electron"
import {
  IPC_EVENT,
  IPC_INVOKE,
  type CommanderApi,
  type CommanderJobParams,
  type EventChannel,
  type EventMessage,
  type RendererMethod,
  type RpcEnvelope,
  type SelectionDescriptor,
} from "@panelyth/contracts"

/** Only the descriptor's known fields cross the bridge. */
const copySelection = (s: SelectionDescriptor): SelectionDescriptor => ({
  queryId: s.queryId,
  version: s.version,
  ranges: s.ranges.map(([a, b]) => [a, b] as [number, number]),
  include: [...s.include],
  exclude: [...s.exclude],
})

/** Only the known fields of each job kind cross the bridge. */
function jobParams(p: CommanderJobParams): CommanderJobParams {
  const source = { selection: copySelection(p.source.selection) }
  switch (p.kind) {
    case "copy":
    case "move":
      return {
        kind: p.kind,
        source,
        destinationDirId: p.destinationDirId,
        conflict: p.conflict,
        ...(p.verify !== undefined && { verify: p.verify }),
        ...(p.now !== undefined && { now: p.now }),
        ...(p.mask !== undefined && { mask: p.mask }),
        ...(p.name !== undefined && { name: p.name }),
      }
    case "extract":
      return {
        kind: p.kind,
        source,
        destinationDirId: p.destinationDirId,
        conflict: p.conflict,
        ...(p.links !== undefined && { links: p.links }),
        ...(p.subfolders !== undefined && { subfolders: p.subfolders }),
      }
    case "pack":
      return {
        kind: p.kind,
        source,
        destinationDirId: p.destinationDirId,
        conflict: p.conflict,
        name: p.name,
        format: p.format,
        level: p.level,
        ...(p.deleteOriginals !== undefined && { deleteOriginals: p.deleteOriginals }),
      }
  }
  return { kind: p.kind, source }
}

const invoke = <R>(method: RendererMethod, params?: unknown): Promise<RpcEnvelope<R>> =>
  ipcRenderer.invoke(IPC_INVOKE, method, params) as Promise<RpcEnvelope<R>>

// The channels this app listens to; the others never reach its listeners.
const channels: ReadonlySet<string> = new Set<EventChannel>([
  "sidecar.status",
  "app.visibility",
  "settings.changed",
  "job.progress",
  "job.conflict",
  "query.invalidated",
  "index.progress",
  "volumes.changed",
  "bookmarks.changed",
  // Stage C06: find files.
  "find.progress",
  // Stage C05: quick view and lister images.
  "preview.ready",
])
const subscribers = new Map<EventChannel, Set<(payload: never) => void>>()

ipcRenderer.on(IPC_EVENT, (_event, message: EventMessage) => {
  subscribers.get(message.ch)?.forEach((listener) => {
    try {
      listener(message.p as never)
    } catch (error) {
      console.error("commander event listener failed", error)
    }
  })
})

const api: CommanderApi = {
  app: {
    exit: () => invoke("app.exit", {}),
    switch: (to, options) => invoke("app.switch", { to, ...options }),
  },
  system: {
    ping: () => invoke("system.ping", {}),
    info: () => invoke("system.info", {}),
  },
  sidecar: {
    getStatus: () => invoke("sidecar.getStatus", {}),
  },
  library: {
    get: () => invoke("library.get", {}),
    setSetting: (key, value) => invoke("library.setSetting", { key, value }),
    addBookmark: (path, label, group) =>
      invoke("library.addBookmark", { path, label, ...(group !== undefined && { group }) }),
    removeBookmark: (id) => invoke("library.removeBookmark", { id }),
    updateBookmark: ({ id, path, label, group }) =>
      invoke("library.updateBookmark", { id, path, label, group }),
    reorderBookmarks: (ids) => invoke("library.reorderBookmarks", { ids: [...ids] }),
  },
  dir: {
    open: ({ path, recursive, lane }) =>
      invoke("dir.open", { path, recursive, ...(lane !== undefined && { lane }) }),
    openEntry: ({ entryId, recursive, lane }) =>
      invoke("dir.openEntry", { entryId, recursive, ...(lane !== undefined && { lane }) }),
    cancelScan: (scanId) => invoke("dir.cancelScan", { scanId }),
    openContaining: (entryId, lane) =>
      invoke("dir.openContaining", { entryId, ...(lane !== undefined && { lane }) }),
  },
  find: {
    // Copied field by field: only known fields cross the bridge.
    start: (s) =>
      invoke("find.start", {
        roots: [...s.roots],
        mask: s.mask,
        depth: s.depth,
        hidden: s.hidden,
        text: s.text,
        caseSensitive: s.caseSensitive,
        wholeWords: s.wholeWords,
        encodings: [...s.encodings],
        skipBinary: s.skipBinary,
        minSize: s.minSize,
        maxSize: s.maxSize,
        modifiedAfter: s.modifiedAfter,
        modifiedBefore: s.modifiedBefore,
        attrsSet: s.attrsSet,
        attrsClear: s.attrsClear,
      }),
    cancel: (findId) => invoke("find.cancel", { findId }),
  },
  archive: {
    open: (entryId) => invoke("archive.open", { entryId }),
    close: (archiveId) => invoke("archive.close", { archiveId }),
    check: (selection, destinationDirId) =>
      invoke("archive.check", { selection: copySelection(selection), destinationDirId }),
    tools: () => invoke("archive.tools", {}),
  },
  query: {
    // Copied field by field: only known fields cross the bridge.
    open: (d) =>
      invoke("query.open", {
        dirId: d.dirId,
        recursive: d.recursive,
        sort: d.sort.map(({ field, direction }) => ({ field, direction })),
        kinds: [...d.kinds],
        search: d.search,
        exts: [...d.exts],
        favorite: d.favorite,
        minRating: d.minRating,
        tags: [...d.tags],
        ...(d.scope !== undefined && { scope: d.scope }),
        ...(d.showHidden !== undefined && { showHidden: d.showHidden }),
        ...(d.nameMask !== undefined && { nameMask: d.nameMask }),
        ...(d.findId !== undefined && { findId: d.findId }),
        ...(d.archiveId !== undefined && { archiveId: d.archiveId }),
        ...(d.archiveDirId !== undefined && { archiveDirId: d.archiveDirId }),
      }),
    page: ({ queryId, offset, limit, thumbProfile }) =>
      invoke("query.page", { queryId, offset, limit, thumbProfile }),
    close: (queryId) => invoke("query.close", { queryId }),
    indexOf: (queryId, entryId) => invoke("query.indexOf", { queryId, entryId }),
    locate: ({ queryId, pattern, from, direction }) =>
      invoke("query.locate", { queryId, pattern, from, direction }),
    match: (queryId, mask) => invoke("query.match", { queryId, mask }),
  },
  selection: {
    info: (selection) => invoke("selection.info", { selection: copySelection(selection) }),
    rebase: (selection) => invoke("selection.rebase", { selection: copySelection(selection) }),
  },
  jobs: {
    dirSize: (selection) =>
      invoke("jobs.start", { kind: "dirSize", source: { selection: copySelection(selection) } }),
    cancel: (jobId) => invoke("jobs.cancel", { jobId }),
  },
  fs: {
    volumes: () => invoke("fs.volumes", {}),
    mkdir: (parentDirId, path) => invoke("fs.mkdir", { parentDirId, path }),
    canTrash: (dirId) => invoke("fs.canTrash", { dirId }),
    mkfile: (parentDirId, name) => invoke("fs.mkfile", { parentDirId, name }),
  },
  media: {
    open: (entryId) => invoke("media.open", { entryId }),
  },
  preview: {
    ensure: ({ lane, epoch, profile, items, force }) =>
      invoke("preview.ensure", {
        lane,
        epoch,
        profile,
        items: items.map(({ id, priority }) => ({ id, priority })),
        force: [...force],
      }),
  },
  props: {
    get: (entryId) => invoke("props.get", { entryId }),
  },
  file: {
    open: (entryId) => invoke("file.open", { entryId }),
  },
  shell: {
    open: (entryId, allowProgram) =>
      invoke("shell.open", { entryId, ...(allowProgram !== undefined && { allowProgram }) }),
    edit: (entryId) => invoke("shell.edit", { entryId }),
  },
  files: {
    start: (p) => invoke("jobs.start", jobParams(p)),
    pause: (jobId) => invoke("jobs.pause", { jobId }),
    resume: (jobId) => invoke("jobs.resume", { jobId }),
    startNow: (jobId) => invoke("jobs.startNow", { jobId }),
    resolve: (jobId, decision, applyToAll) =>
      invoke("jobs.resolve", { jobId, decision, applyToAll }),
    errors: (jobId, offset, limit) => invoke("jobs.errors", { jobId, offset, limit }),
    list: () => invoke("jobs.list", {}),
    rename: (entryId, name) => invoke("entry.rename", { entryId, name }),
  },
  clip: {
    set: (selection, mode) => invoke("clip.set", { selection: copySelection(selection), mode }),
    get: () => invoke("clip.get", {}),
    paste: (destinationDirId, conflict) => invoke("clip.paste", { destinationDirId, conflict }),
  },
  clipboard: {
    copyPaths: (selection, namesOnly) =>
      invoke("clipboard.copyPaths", {
        selection: copySelection(selection),
        ...(namesOnly !== undefined && { namesOnly }),
      }),
    copyText: (text) => invoke("clipboard.copyText", { text }),
  },
  places: {
    list: () => invoke("places.list", {}),
  },
  context: {
    publish: (dirId, focusId, selection) =>
      invoke("context.publish", {
        app: "commander",
        dirId,
        focusId,
        selection: selection && copySelection(selection),
      }),
    get: () => invoke("context.get", {}),
    selection: (version, queryId) => invoke("selection.fromContext", { version, queryId }),
  },
  onEvent(channel, listener) {
    if (!channels.has(channel)) throw new Error(`unknown event channel: ${String(channel)}`)
    let set = subscribers.get(channel)
    if (!set) subscribers.set(channel, (set = new Set()))
    const fn = listener as (payload: never) => void
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  },
}

contextBridge.exposeInMainWorld("panelyth", api)
