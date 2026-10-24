// The document window's sandboxed preload (ADR-0033, amended by ADR-0045): its
// title strip's window buttons and the window's state, nothing else. The page
// still reads only its one token; this preload can name no file.
import { contextBridge, ipcRenderer } from "electron"
import {
  IPC_EVENT,
  IPC_INVOKE,
  TITLE_BAR_ARG,
  type DocumentFrameApi,
  type EventChannel,
  type EventMessage,
  type RendererMethod,
  type RpcEnvelope,
} from "@panelyth/contracts"

const invoke = <R>(method: RendererMethod, params?: unknown): Promise<RpcEnvelope<R>> =>
  ipcRenderer.invoke(IPC_INVOKE, method, params) as Promise<RpcEnvelope<R>>

const channels: ReadonlySet<string> = new Set<EventChannel>(["window.state"])
const subscribers = new Map<EventChannel, Set<(payload: never) => void>>()

ipcRenderer.on(IPC_EVENT, (_event, message: EventMessage) => {
  subscribers.get(message.ch)?.forEach((listener) => {
    try {
      listener(message.p as never)
    } catch (error) {
      console.error("document window event listener failed", error)
    }
  })
})

const api: DocumentFrameApi = {
  frame: {
    titleBar: process.argv.includes(TITLE_BAR_ARG),
    state: () => invoke("window.getState", {}),
    control: (action) => invoke("window.control", { action }),
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
