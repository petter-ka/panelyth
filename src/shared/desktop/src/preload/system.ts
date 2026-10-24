// Panelyth System's sandboxed preload (ADR-0042, ADR-0027): bundled into one
// CommonJS file of its own. It exposes only System's methods; main rejects
// anything else from this app view anyway.
import { contextBridge, ipcRenderer } from "electron"
import {
  IPC_EVENT,
  IPC_INVOKE,
  TITLE_BAR_ARG,
  type EventChannel,
  type EventMessage,
  type FindStartParams,
  type RendererMethod,
  type RpcEnvelope,
  type SystemApi,
} from "@panelyth/contracts"

const invoke = <R>(method: RendererMethod, params?: unknown): Promise<RpcEnvelope<R>> =>
  ipcRenderer.invoke(IPC_INVOKE, method, params) as Promise<RpcEnvelope<R>>

/** Only the search's known fields cross the bridge. */
const copyFind = (p: FindStartParams): FindStartParams => ({
  roots: [...p.roots],
  mask: p.mask,
  depth: p.depth,
  hidden: p.hidden,
  text: p.text,
  caseSensitive: p.caseSensitive,
  wholeWords: p.wholeWords,
  encodings: [...p.encodings],
  skipBinary: p.skipBinary,
  minSize: p.minSize,
  maxSize: p.maxSize,
  modifiedAfter: p.modifiedAfter,
  modifiedBefore: p.modifiedBefore,
  attrsSet: p.attrsSet,
  attrsClear: p.attrsClear,
})

// The channels this app listens to; the others never reach its listeners.
const channels: ReadonlySet<string> = new Set<EventChannel>([
  "sidecar.status",
  "app.visibility",
  "window.state",
  "settings.changed",
  "volumes.changed",
  "find.progress",
  "query.invalidated",
  "update.state",
  "menu.command",
])
const subscribers = new Map<EventChannel, Set<(payload: never) => void>>()

ipcRenderer.on(IPC_EVENT, (_event, message: EventMessage) => {
  subscribers.get(message.ch)?.forEach((listener) => {
    try {
      listener(message.p as never)
    } catch (error) {
      console.error("system event listener failed", error)
    }
  })
})

const api: SystemApi = {
  app: {
    exit: () => invoke("app.exit", {}),
    switch: (to) => invoke("app.switch", { to }),
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
  sidecar: {
    getStatus: () => invoke("sidecar.getStatus", {}),
  },
  library: {
    get: () => invoke("library.get", {}),
    setSetting: (key, value) => invoke("library.setSetting", { key, value }),
  },
  system: {
    hardware: () => invoke("system.hardware", {}),
    load: () => invoke("system.load", {}),
  },
  fs: {
    volumes: () => invoke("fs.volumes", {}),
  },
  find: {
    start: (params) => invoke("find.start", copyFind(params)),
    cancel: (findId) => invoke("find.cancel", { findId }),
  },
  query: {
    page: ({ queryId, offset, limit, thumbProfile }) =>
      invoke("query.page", { queryId, offset, limit, thumbProfile }),
    close: (queryId) => invoke("query.close", { queryId }),
  },
  dir: {
    openContaining: (entryId) => invoke("dir.openContaining", { entryId }),
  },
  context: {
    publish: (dirId, focusId) => invoke("context.publish", { app: "system", dirId, focusId }),
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
