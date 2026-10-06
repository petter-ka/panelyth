// The commander's sandboxed preload (ADR-0027, ADR-0031): bundled into one
// CommonJS file of its own. It exposes only the commander's methods; main
// rejects anything else from this app view anyway.
import { contextBridge, ipcRenderer } from "electron"
import {
  IPC_EVENT,
  IPC_INVOKE,
  type CommanderApi,
  type EventChannel,
  type EventMessage,
  type RendererMethod,
  type RpcEnvelope,
  type SelectionDescriptor,
} from "@fastview/contracts"

/** Only the descriptor's known fields cross the bridge. */
const copySelection = (s: SelectionDescriptor): SelectionDescriptor => ({
  queryId: s.queryId,
  version: s.version,
  ranges: s.ranges.map(([a, b]) => [a, b] as [number, number]),
  include: [...s.include],
  exclude: [...s.exclude],
})

const invoke = <R>(method: RendererMethod, params?: unknown): Promise<RpcEnvelope<R>> =>
  ipcRenderer.invoke(IPC_INVOKE, method, params) as Promise<RpcEnvelope<R>>

// The channels this app listens to; the others never reach its listeners.
const channels: ReadonlySet<string> = new Set<EventChannel>([
  "sidecar.status",
  "app.visibility",
  "settings.changed",
  "job.progress",
  "query.invalidated",
  "index.progress",
  "volumes.changed",
  "bookmarks.changed",
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
    switch: (to) => invoke("app.switch", { to }),
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
    open: ({ path, recursive }) => invoke("dir.open", { path, recursive }),
    openEntry: ({ entryId, recursive }) => invoke("dir.openEntry", { entryId, recursive }),
    cancelScan: (scanId) => invoke("dir.cancelScan", { scanId }),
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

contextBridge.exposeInMainWorld("fastview", api)
