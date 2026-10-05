import type {
  AppId,
  CommanderApi,
  EventChannel,
  EventMap,
  LibraryState,
  RpcEnvelope,
  SidecarStatus,
} from "@fastview/contracts"

/** The commander's narrow API (ADR-0027); everything goes through here. */
function api(): CommanderApi {
  const value = window.fastview
  if (!value) throw new Error("FastView bridge unavailable")
  return value
}

async function unwrap<T>(call: () => Promise<RpcEnvelope<T>>): Promise<T> {
  const res = await call()
  if (!res.ok) throw new Error(res.e.message)
  return res.r
}

export const isBridgeAvailable = (): boolean => window.fastview !== undefined

let library: Promise<LibraryState> | null = null

export const bridge = {
  switchTo: async (to: AppId): Promise<void> => {
    await unwrap(() => api().app.switch(to))
  },
  exit: async (): Promise<void> => {
    await unwrap(() => api().app.exit())
  },
  sidecarStatus: (): Promise<SidecarStatus> => unwrap(() => api().sidecar.getStatus()),
  /** library.db, read once per start; both the layout and the appearance use it. */
  library: (): Promise<LibraryState> => {
    library ??= unwrap(() => api().library.get()).catch((error: unknown) => {
      library = null
      throw error
    })
    return library
  },
  setSetting: async (key: string, value: unknown): Promise<void> => {
    await unwrap(() => api().library.setSetting(key, value))
  },
  on: <C extends EventChannel>(
    channel: C,
    listener: (payload: EventMap[C]) => void,
  ): (() => void) => api().onEvent(channel, listener),
}
