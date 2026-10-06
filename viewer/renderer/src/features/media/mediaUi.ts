import { configureMedia } from "@fastview/media-ui"
import { bridge, isBridgeAvailable } from "../../bridge"

// The shared media components (ADR-0025, moved to shared/media-ui in Stage
// C05) on the viewer's bridge. Viewer code imports them from here, so the
// port is configured before anything uses it.
configureMedia({
  isAvailable: isBridgeAvailable,
  openMedia: (entryId) => bridge.openMedia(entryId),
  ensurePreviews: (params) => bridge.ensurePreviews(params),
  openWithSystem: (entryId) => bridge.openWithSystem(entryId),
  onPreviewReady: (listener) => bridge.on("preview.ready", listener),
})

export * from "@fastview/media-ui"
