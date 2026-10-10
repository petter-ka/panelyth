import type { SidecarStatus, SystemInfo } from "@panelyth/contracts"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../../bridge"

interface SidecarState {
  status: SidecarStatus | null
  info: SystemInfo | null
  /** Round trip renderer → main → Go → renderer of the last ping. */
  pingMs: number | null
  error: string | null
}

export const useSidecarStore = create<SidecarState>(() => ({
  status: null,
  info: null,
  pingMs: null,
  error: null,
}))

export async function measurePing(): Promise<void> {
  try {
    const started = performance.now()
    await bridge.ping()
    useSidecarStore.setState({ pingMs: performance.now() - started, error: null })
  } catch (error) {
    useSidecarStore.setState({ pingMs: null, error: String(error) })
  }
}

async function refreshInfo(): Promise<void> {
  try {
    useSidecarStore.setState({ info: await bridge.info() })
  } catch (error) {
    useSidecarStore.setState({ error: String(error) })
  }
}

function applyStatus(status: SidecarStatus): void {
  const previous = useSidecarStore.getState().status
  useSidecarStore.setState({ status })
  // Only on transitions into ready: no polling while idle.
  if (status.state === "ready" && (previous?.state !== "ready" || previous.pid !== status.pid)) {
    void measurePing()
    void refreshInfo()
  }
}

/**
 * Subscribes to sidecar status pushes and fetches the current status once,
 * in case the renderer loaded after the sidecar became ready.
 */
export function startSidecarMonitoring(): () => void {
  if (!isBridgeAvailable()) {
    useSidecarStore.setState({ error: "Panelyth bridge is not available" })
    return () => {}
  }
  const unsubscribe = bridge.on("sidecar.status", applyStatus)
  bridge.sidecarStatus().then(
    (status) => {
      // A push may already have delivered a newer status.
      const current = useSidecarStore.getState().status
      if (!current || current.since <= status.since) applyStatus(status)
    },
    (error: unknown) => useSidecarStore.setState({ error: String(error) }),
  )
  return unsubscribe
}
