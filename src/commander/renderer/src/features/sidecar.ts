import { createSidecarStore, followSidecar } from "@panelyth/renderer-core"
import { bridge, isBridgeAvailable } from "../bridge"

export const useSidecarStore = createSidecarStore()

/** Follows the shared sidecar's state (one sidecar serves both apps, ADR-0031). */
export function startSidecarMonitoring(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  return followSidecar(useSidecarStore, {
    getStatus: bridge.sidecarStatus,
    onStatus: (listener) => bridge.on("sidecar.status", listener),
  })
}
