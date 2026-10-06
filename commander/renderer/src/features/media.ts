import { configureMedia, startViewerImageMonitoring } from "@fastview/media-ui"
import { bridge, isBridgeAvailable } from "../bridge"

// The shared media components (ADR-0025, shared/media-ui) on the
// commander's bridge: quick view and the lister show images and videos with
// the viewer's ImageViewer and VideoPlayer (Stage C05).

/** Preview lanes of their own, so the commander never drops the viewer's queued work. */
export const QUICK_LANE = "cmd-quick"
export const LISTER_LANE = "cmd-lister"

let configured = false

export function configureCommanderMedia(): void {
  if (configured) return
  configured = true
  configureMedia({
    isAvailable: isBridgeAvailable,
    openMedia: (entryId) => bridge.openMedia(entryId),
    ensurePreviews: (params) => bridge.ensurePreviews(params),
    openWithSystem: (entryId) => bridge.shellOpen(entryId),
    onPreviewReady: (listener) => bridge.on("preview.ready", listener),
  })
}

/** Configures the port and applies preview.ready events; returns the stop function. */
export function startMedia(): () => void {
  configureCommanderMedia()
  return startViewerImageMonitoring()
}

/** Tests: a fresh configuration on the next start. */
export function resetMediaConfig(): void {
  configured = false
}
