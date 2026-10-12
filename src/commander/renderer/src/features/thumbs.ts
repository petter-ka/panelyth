import { createThumbStore, type ThumbStore } from "@panelyth/media-ui"
import type { Side } from "./panels"

// Thumbnails of the Thumbnails view (Stage C10, ADR-0028): one store per
// panel on the thumbnail store shared with the viewer (@panelyth/media-ui),
// each on a preview lane of its own, so a panel's request never drops the
// other panel's or the viewer's queued work.

const stores: Record<Side, ThumbStore> = {
  left: createThumbStore("cmd-tiles-left"),
  right: createThumbStore("cmd-tiles-right"),
}

export const thumbsOf = (side: Side): ThumbStore => stores[side]

/** Applies preview.ready events to both panels' stores; returns the stop function. */
export function startThumbs(): () => void {
  const stops = [stores.left.start(), stores.right.start()]
  return () => stops.forEach((stop) => stop())
}

/** Tests. */
export function resetThumbs(): void {
  stores.left.reset()
  stores.right.reset()
}
