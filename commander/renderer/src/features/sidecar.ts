import type { SidecarStatus } from "@fastview/contracts"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"

export const useSidecarStore = create<{ status: SidecarStatus | null }>(() => ({ status: null }))

/** Follows the shared sidecar's state (one sidecar serves both apps, ADR-0031). */
export function startSidecarMonitoring(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  const off = bridge.on("sidecar.status", (status) => useSidecarStore.setState({ status }))
  void bridge
    .sidecarStatus()
    .then((status) => useSidecarStore.setState({ status }))
    .catch(() => undefined)
  return off
}
