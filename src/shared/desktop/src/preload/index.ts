// Sandboxed preload: bundled into a single CommonJS file with no local
// requires. Exposes a narrow typed API; ipcRenderer itself never leaves here.
import { contextBridge, ipcRenderer } from "electron"
import {
  COMMANDER_ENABLED_ARG,
  DEV_METHODS_ARG,
  EVENT_CHANNELS,
  IPC_EVENT,
  IPC_INVOKE,
  TITLE_BAR_ARG,
  type EventChannel,
  type EventMessage,
  type PanelythApi,
  type JobStartParams,
  type RendererMethod,
  type RpcEnvelope,
  type SelectionDescriptor,
} from "@panelyth/contracts"

const invoke = <R>(method: RendererMethod, params?: unknown): Promise<RpcEnvelope<R>> =>
  ipcRenderer.invoke(IPC_INVOKE, method, params) as Promise<RpcEnvelope<R>>

// Rebuilt field by field: only the contract's fields cross IPC.
const selection = ({
  queryId,
  version,
  ranges,
  include,
  exclude,
}: SelectionDescriptor): SelectionDescriptor => ({
  queryId,
  version,
  ranges: ranges.map(([a, b]): [number, number] => [a, b]),
  include: [...include],
  exclude: [...exclude],
})

const source = (s: { selection: SelectionDescriptor }) => ({ selection: selection(s.selection) })

function jobParams(p: JobStartParams): JobStartParams {
  switch (p.kind) {
    case "copy":
    case "move":
      return {
        kind: p.kind,
        source: source(p.source),
        conflict: p.conflict,
        ...("destination" in p
          ? { destination: p.destination }
          : { destinationDirId: p.destinationDirId }),
        ...(p.verify !== undefined && { verify: p.verify }),
        ...(p.now !== undefined && { now: p.now }),
        ...(p.mask !== undefined && { mask: p.mask }),
        ...(p.name !== undefined && { name: p.name }),
      }
    case "trash":
    case "delete":
    case "dirSize":
      return { kind: p.kind, source: source(p.source) }
    case "rename":
      return { kind: p.kind, source: source(p.source), pattern: p.pattern, start: p.start }
    case "favorite":
      return { kind: p.kind, source: source(p.source), favorite: p.favorite }
    case "rating":
      return { kind: p.kind, source: source(p.source), rating: p.rating }
    case "label":
      return { kind: p.kind, source: source(p.source), label: p.label }
    case "tag":
      return { kind: p.kind, source: source(p.source), tag: p.tag, add: p.add }
  }
}

// One ipcRenderer listener fans out to subscribers per channel.
const knownChannels: ReadonlySet<string> = new Set(EVENT_CHANNELS)
const subscribers = new Map<EventChannel, Set<(payload: never) => void>>()

ipcRenderer.on(IPC_EVENT, (_event, message: EventMessage) => {
  subscribers.get(message.ch)?.forEach((listener) => {
    try {
      listener(message.p as never)
    } catch (error) {
      console.error("panelyth event listener failed", error)
    }
  })
})

const api: PanelythApi = {
  app: {
    exit: () => invoke("app.exit", {}),
    openRequest: () => invoke("app.openRequest", {}),
    about: () => invoke("app.about", {}),
    openTarget: (target) => invoke("app.openTarget", { target }),
  },
  frame: {
    titleBar: process.argv.includes(TITLE_BAR_ARG),
    state: () => invoke("window.getState", {}),
    control: (action) => invoke("window.control", { action }),
  },
  settings: {
    openWindow: (tab, section) =>
      invoke("settings.openWindow", { ...(tab && { tab }), ...(section && { section }) }),
    closeWindow: (then) => invoke("settings.closeWindow", then ? { then } : {}),
  },
  update: {
    get: () => invoke("update.get", {}),
    check: () => invoke("update.check", {}),
    download: () => invoke("update.download", {}),
    install: () => invoke("update.install", {}),
  },
  system: {
    ping: () => invoke("system.ping", {}),
    info: () => invoke("system.info", {}),
  },
  sidecar: {
    getStatus: () => invoke("sidecar.getStatus", {}),
  },
  dialog: {
    openFolder: () => invoke("dialog.openFolder", {}),
  },
  // Arguments are rebuilt field by field so only the contract's fields cross IPC.
  dir: {
    open: ({ path, recursive }) => invoke("dir.open", { path, recursive }),
    openEntry: ({ entryId, recursive }) => invoke("dir.openEntry", { entryId, recursive }),
    cancelScan: (scanId) => invoke("dir.cancelScan", { scanId }),
  },
  media: {
    open: (entryId) => invoke("media.open", { entryId }),
    openWindow: (entryId, key, theme, lang) =>
      invoke("media.openWindow", {
        entryId,
        key,
        ...(theme && { theme }),
        ...(lang && { lang }),
      }),
    windowAnswer: (requestId, item, done) =>
      invoke("media.windowAnswer", { requestId, item, ...(done !== undefined && { done }) }),
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
  folder: {
    covers: ({ lane, epoch, profile, items }) =>
      invoke("folder.covers", {
        lane,
        epoch,
        profile,
        items: items.map(({ id, priority }) => ({ id, priority })),
      }),
  },
  query: {
    open: ({ dirId, recursive, sort, kinds, search, exts, favorite, minRating, tags }) =>
      // The viewer always queries the media scope (ADR-0026): scope fields
      // are never forwarded from this preload.
      invoke("query.open", {
        dirId,
        recursive,
        sort: sort.map(({ field, direction }) => ({ field, direction })),
        kinds: [...kinds],
        search,
        exts: [...exts],
        favorite,
        minRating,
        tags: [...tags],
      }),
    page: ({ queryId, offset, limit, thumbProfile }) =>
      invoke("query.page", { queryId, offset, limit, thumbProfile }),
    close: (queryId) => invoke("query.close", { queryId }),
    facets: (queryId) => invoke("query.facets", { queryId }),
    indexOf: (queryId, entryId) => invoke("query.indexOf", { queryId, entryId }),
  },
  selection: {
    info: (sel) => invoke("selection.info", { selection: selection(sel) }),
    rebase: (sel) => invoke("selection.rebase", { selection: selection(sel) }),
  },
  props: {
    get: (entryId) => invoke("props.get", { entryId }),
  },
  fs: {
    volumes: () => invoke("fs.volumes", {}),
    listDirs: (path) => invoke("fs.listDirs", { path }),
  },
  places: {
    list: () => invoke("places.list", {}),
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
    tags: () => invoke("library.tags", {}),
    deleteTag: (id) => invoke("library.deleteTag", { id }),
  },
  jobs: {
    start: (params) => invoke("jobs.start", jobParams(params)),
    cancel: (jobId) => invoke("jobs.cancel", { jobId }),
    errors: (jobId, offset, limit) => invoke("jobs.errors", { jobId, offset, limit }),
    list: () => invoke("jobs.list", {}),
    pause: (jobId) => invoke("jobs.pause", { jobId }),
    resume: (jobId) => invoke("jobs.resume", { jobId }),
    startNow: (jobId) => invoke("jobs.startNow", { jobId }),
    resolve: (jobId, decision, applyToAll) =>
      invoke("jobs.resolve", { jobId, decision, applyToAll }),
  },
  clip: {
    set: (sel, mode) => invoke("clip.set", { selection: selection(sel), mode }),
    get: () => invoke("clip.get", {}),
    paste: (destination, conflict) => invoke("clip.paste", { destination, conflict }),
  },
  entry: {
    rename: (entryId, name) => invoke("entry.rename", { entryId, name }),
  },
  shell: {
    open: (entryId) => invoke("shell.open", { entryId }),
    reveal: (entryId) => invoke("shell.reveal", { entryId }),
    revealPath: (path) => invoke("shell.revealPath", { path }),
  },
  // ADR-0044: only ids and the editable fields cross the bridge; never a program path.
  programs: {
    add: () => invoke("programs.add", {}),
    update: (programs) =>
      invoke("programs.update", {
        programs: programs.map(({ id, name, target }) => ({ id, name, target })),
      }),
    open: (programId, entryId) => invoke("programs.open", { programId, entryId }),
    openFolder: (programId, path) => invoke("programs.openFolder", { programId, path }),
  },
  clipboard: {
    copyPaths: (sel) => invoke("clipboard.copyPaths", { selection: selection(sel) }),
    copyText: (text) => invoke("clipboard.copyText", { text }),
    copyImage: (entryId) => invoke("clipboard.copyImage", { entryId }),
  },
  drag: {
    start: (sel) => invoke("drag.start", { selection: selection(sel) }),
  },
  // The image editor (Stage 12). An edit list is plain JSON from the editor's
  // store; main checks its structure and Go its meaning.
  edit: {
    open: (entryId) => invoke("edit.open", { entryId }),
    render: ({ sessionId, rev, editList, view, quality, histogram, histogramAt }) =>
      invoke("edit.render", {
        sessionId,
        rev,
        editList,
        view: { maxEdge: view.maxEdge },
        quality,
        histogram,
        ...(histogramAt !== undefined && { histogramAt }),
      }),
    info: (sessionId) => invoke("edit.info", { sessionId }),
    estimate: ({ sessionId, editList, format, quality, metadata }) =>
      invoke("edit.estimate", { sessionId, editList, format, quality, metadata }),
    save: ({ sessionId, editList, target, format, quality, metadata, dpi }) =>
      invoke("edit.save", { sessionId, editList, target, format, quality, metadata, dpi }),
    close: (sessionId) => invoke("edit.close", { sessionId }),
    saved: (jobId) => invoke("edit.saved", { jobId }),
    reveal: (jobId) => invoke("edit.reveal", { jobId }),
    probe: ({ sessionId, editList, view, x, y, radius }) =>
      invoke("edit.probe", { sessionId, editList, view: { maxEdge: view.maxEdge }, x, y, radius }),
    thumbs: ({ sessionId, editLists, edge }) =>
      invoke("edit.thumbs", { sessionId, editLists, edge }),
    colors: ({ sessionId, editList, scope, maxColors }) =>
      invoke("edit.colors", { sessionId, editList, scope, maxColors }),
    fonts: (sessionId) => invoke("edit.fonts", { sessionId }),
    pickAsset: (sessionId) => invoke("asset.pick", { sessionId }),
    releaseAsset: (sessionId, assetId) => invoke("asset.release", { sessionId, assetId }),
    eyes: ({ sessionId, editList }) => invoke("edit.eyes", { sessionId, editList }),
  },
  batch: {
    pickFolder: () => invoke("batch.pickFolder", {}),
    plan: ({ source, recipe, folderId }) =>
      invoke("batch.plan", { source, recipe, ...(folderId !== undefined && { folderId }) }),
    start: ({ source, recipe, folderId }) =>
      invoke("batch.start", { source, recipe, ...(folderId !== undefined && { folderId }) }),
    undo: (jobId) => invoke("batch.undo", { jobId }),
  },
  recipes: {
    list: () => invoke("recipe.list", {}),
    save: ({ id, name, recipe }) => invoke("recipe.save", { id, name, recipe }),
    remove: (id) => invoke("recipe.delete", { id }),
  },
  onEvent(channel, listener) {
    if (!knownChannels.has(channel)) throw new Error(`unknown event channel: ${String(channel)}`)
    let set = subscribers.get(channel)
    if (!set) subscribers.set(channel, (set = new Set()))
    const fn = listener as (payload: never) => void
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  },
}

// The app switch exists only while the commander is enabled (ADR-0031).
// The app switch and the shared context exist only while the commander is enabled (ADR-0031).
if (process.argv.includes(COMMANDER_ENABLED_ARG)) {
  api.app.switch = (to) => invoke("app.switch", { to })
  api.context = {
    publish: (dirId, focusId, sel) =>
      invoke("context.publish", {
        app: "viewer",
        dirId,
        focusId,
        selection: sel && selection(sel),
      }),
    get: () => invoke("context.get", {}),
    selection: (version, queryId) => invoke("selection.fromContext", { version, queryId }),
  }
}

if (process.argv.includes(DEV_METHODS_ARG)) {
  api.dev = { echo: (payload) => invoke("system.echo", { payload }) }
}

contextBridge.exposeInMainWorld("panelyth", api)
