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
} from "@fastview/contracts"

const invoke = <R>(method: RendererMethod, params?: unknown): Promise<RpcEnvelope<R>> =>
  ipcRenderer.invoke(IPC_INVOKE, method, params) as Promise<RpcEnvelope<R>>

// The channels this app listens to; the others never reach its listeners.
const channels: ReadonlySet<string> = new Set<EventChannel>([
  "sidecar.status",
  "app.visibility",
  "settings.changed",
  "job.progress",
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
