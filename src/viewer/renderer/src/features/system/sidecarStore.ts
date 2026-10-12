import type { SystemInfo } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { createSidecarStore, followSidecar } from "@panelyth/renderer-core"
import { bridge, isBridgeAvailable } from "../../bridge"

interface ViewerSidecarState {
  info: SystemInfo | null
  /** Round trip renderer → main → Go → renderer of the last ping. */
  pingMs: number | null
}

// The status and its monitoring are shared with the commander
// (src/shared/renderer-core); the ping and the build info are the viewer's.
export const useSidecarStore = createSidecarStore<ViewerSidecarState>({ info: null, pingMs: null })

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

/** Follows the sidecar; measures the ping and reads the build info each time it becomes ready. */
export function startSidecarMonitoring(): () => void {
  if (!isBridgeAvailable()) {
    useSidecarStore.setState({ error: t("Panelyth bridge is not available") })
    return () => {}
  }
  return followSidecar(
    useSidecarStore,
    {
      getStatus: bridge.sidecarStatus,
      onStatus: (listener) => bridge.on("sidecar.status", listener),
    },
    () => {
      void measurePing()
      void refreshInfo()
    },
  )
}
