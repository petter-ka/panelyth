import type {
  EventMap,
  MediaOpenResult,
  PreviewEnsureParams,
  PreviewEnsureResult,
} from "@fastview/contracts"

/**
 * What the media components need from an app's bridge. Each app configures
 * it once with its own narrow API (the viewer's or the commander's preload),
 * so this package never touches window.fastview itself.
 */
export interface MediaPort {
  isAvailable(): boolean
  openMedia(entryId: number): Promise<MediaOpenResult>
  ensurePreviews(params: PreviewEnsureParams): Promise<PreviewEnsureResult>
  /** "Open with default app" on a video the built-in player can't play. */
  openWithSystem(entryId: number): Promise<void>
  onPreviewReady(listener: (payload: EventMap["preview.ready"]) => void): () => void
}

let port: MediaPort | null = null

export function configureMedia(value: MediaPort): void {
  port = value
}

export function mediaPort(): MediaPort {
  if (!port) throw new Error("@fastview/media-ui: configureMedia() was not called")
  return port
}

export const isMediaAvailable = (): boolean => port?.isAvailable() ?? false

/** The error code of a failed bridge call (each app has its own error class). */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : "INTERNAL"
}
