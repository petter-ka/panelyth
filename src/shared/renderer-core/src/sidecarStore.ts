import type { SidecarStatus } from "@panelyth/contracts"
import { create, type StoreApi, type UseBoundStore } from "zustand"

export interface SidecarState {
  /** The shared sidecar's state (one process serves both apps, ADR-0031). */
  status: SidecarStatus | null
  error: string | null
}

export type SidecarStore<Extra extends object = object> = UseBoundStore<
  StoreApi<SidecarState & Extra>
>

export interface SidecarPort {
  getStatus(): Promise<SidecarStatus>
  onStatus(listener: (status: SidecarStatus) => void): () => void
}

/** `extra`: what an app keeps beside the status (the viewer's ping and build info). */
export function createSidecarStore<Extra extends object = object>(
  extra?: Extra,
): SidecarStore<Extra> {
  return create<SidecarState & Extra>(
    () => ({ status: null, error: null, ...extra }) as SidecarState & Extra,
  )
}

/**
 * Subscribes to sidecar status pushes and fetches the current status once,
 * in case the renderer loaded after the sidecar became ready. `onReady` runs
 * on each transition into ready (the start, and a restart with a new
 * process), never while idle.
 */
export function followSidecar<Extra extends object>(
  store: SidecarStore<Extra>,
  port: SidecarPort,
  onReady?: (status: SidecarStatus) => void,
): () => void {
  const set = (patch: Partial<SidecarState>): void =>
    store.setState(patch as Partial<SidecarState & Extra>)
  const apply = (status: SidecarStatus): void => {
    const previous = store.getState().status
    set({ status })
    if (status.state === "ready" && (previous?.state !== "ready" || previous.pid !== status.pid))
      onReady?.(status)
  }
  const unsubscribe = port.onStatus(apply)
  port.getStatus().then(
    (status) => {
      // A push may already have delivered a newer status.
      const current = store.getState().status
      if (!current || current.since <= status.since) apply(status)
    },
    (error: unknown) => set({ error: String(error) }),
  )
  return unsubscribe
}
