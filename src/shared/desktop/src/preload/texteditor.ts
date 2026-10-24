// The text editor window's sandboxed preload (ADR-0046): bundled into one
// CommonJS file of its own. It exposes the editor's own file and nothing
// else; main binds the window to its session and rejects anything else from
// this origin anyway.
import { contextBridge, ipcRenderer } from "electron"
import {
  IPC_EVENT,
  IPC_INVOKE,
  TITLE_BAR_ARG,
  type EventChannel,
  type EventMessage,
  type RendererMethod,
  type RpcEnvelope,
  type TextEditorApi,
} from "@panelyth/contracts"

const invoke = <R>(method: RendererMethod, params?: unknown): Promise<RpcEnvelope<R>> =>
  ipcRenderer.invoke(IPC_INVOKE, method, params) as Promise<RpcEnvelope<R>>

// The channels this window listens to; the others never reach its listeners.
const channels: ReadonlySet<string> = new Set<EventChannel>([
  "texteditor.closeRequest",
  "texteditor.editable",
  "window.state",
  "settings.changed",
])
const subscribers = new Map<EventChannel, Set<(payload: never) => void>>()

ipcRenderer.on(IPC_EVENT, (_event, message: EventMessage) => {
  subscribers.get(message.ch)?.forEach((listener) => {
    try {
      listener(message.p as never)
    } catch (error) {
      console.error("text editor event listener failed", error)
    }
  })
})

const api: TextEditorApi = {
  frame: {
    titleBar: process.argv.includes(TITLE_BAR_ARG),
    state: () => invoke("window.getState", {}),
    control: (action) => invoke("window.control", { action }),
  },
  session: () => invoke("texteditor.session", {}),
  write: (seq, text) => invoke("texteditor.write", { seq, text }),
  commit: (params) => invoke("texteditor.commit", params),
  check: () => invoke("texteditor.check", {}),
  setDirty: (dirty) => invoke("texteditor.setDirty", { dirty }),
  close: (discard) => invoke("texteditor.close", { discard }),
  assetChunk: (seq, data) => invoke("texteditor.assetChunk", { seq, data }),
  assetCommit: (name) => invoke("texteditor.assetCommit", { name }),
  resolveImages: (links) => invoke("texteditor.resolveImages", { links }),
  exportPdf: (params) => invoke("texteditor.exportPdf", params),
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
