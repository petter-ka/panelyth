import type {
  EventMap,
  FolderCoversParams,
  FolderCoversResult,
  MediaOpenResult,
  PreviewEnsureParams,
  PreviewEnsureResult,
} from "@panelyth/contracts"

/**
 * What the media components need from an app's bridge. Each app configures
 * it once with its own narrow API (the viewer's or the commander's preload),
 * so this package never touches window.panelyth itself.
 */
export interface MediaPort {
  isAvailable(): boolean
  openMedia(entryId: number): Promise<MediaOpenResult>
  ensurePreviews(params: PreviewEnsureParams): Promise<PreviewEnsureResult>
  /** "Open with default app" on a video the built-in player can't play. */
  openWithSystem(entryId: number): Promise<void>
  onPreviewReady(listener: (payload: EventMap["preview.ready"]) => void): () => void
  /**
   * Folder covers for tiles (Stage C10: the tile parts moved here). Absent in
   * an app whose profile has no folder.covers: folders show their symbol.
   */
  folderCovers?(params: FolderCoversParams): Promise<FolderCoversResult>
  onFolderCovers?(listener: (payload: EventMap["folder.covers"]) => void): () => void
  /**
   * library.db settings, read fresh and written whole: where a long video
   * stopped (resume.ts). Absent: positions are not remembered.
   */
  settings?: {
    read(key: string): Promise<unknown>
    write(key: string, value: unknown): Promise<void>
    /** A setting another window wrote (the settings window's, ADR-0039). Absent: re-read on focus only. */
    onChanged?(listener: (key: string, value: unknown) => void): () => void
  }
}

let port: MediaPort | null = null

export function configureMedia(value: MediaPort): void {
  port = value
}

export function mediaPort(): MediaPort {
  if (!port) throw new Error("@panelyth/media-ui: configureMedia() was not called")
  return port
}

export const isMediaAvailable = (): boolean => port?.isAvailable() ?? false

/** The error code of a failed bridge call (each app has its own error class). */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : "INTERNAL"
}
