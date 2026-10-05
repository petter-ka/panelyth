import type {
  AppId,
  FolderCoverItem,
  JobSnapshot,
  PreviewItem,
  QuerySnapshot,
  SidecarStatus,
} from "./rpc"

export type ScanState = "running" | "completed" | "cancelled" | "failed"

/** Throttled (≤ ~10/s per scan) and coalesced; the latest snapshot wins. */
export interface IndexProgress {
  scanId: number
  dirId: number
  recursive: boolean
  state: ScanState
  dirsListed: number
  dirsPending: number
  /** Rows written (folders + media). */
  entries: number
  /** Non-media files seen and not indexed. */
  skipped: number
  /** Folders that could not be read. */
  errors: number
  elapsedMs: number
}

/**
 * Push channels delivered to the renderer. Producers coalesce: an event
 * carries a batch or the latest state, never one message per file.
 */
export interface EventMap {
  "sidecar.status": SidecarStatus
  "index.progress": IndexProgress
  /** A query session was re-materialized; refetch the pages you hold. */
  "query.invalidated": QuerySnapshot
  /** Finished previews (and failures), batched: at most 500 items per event. */
  "preview.ready": { items: PreviewItem[] }
  /** Finished folder covers, batched like preview.ready. */
  "folder.covers": { items: FolderCoverItem[] }
  /** A job's full state, at most 4 Hz per job; the final state is always delivered. */
  "job.progress": JobSnapshot
  /** From main: this app view was shown or hidden by the app switch (ADR-0031). */
  "app.visibility": { app: AppId; visible: boolean }
  /** From main: a shared.* setting changed, so the other app can apply it (ADR-0031). */
  "settings.changed": { key: string; value: unknown }
}

export type EventChannel = keyof EventMap

export const EVENT_CHANNELS = [
  "sidecar.status",
  "index.progress",
  "query.invalidated",
  "preview.ready",
  "folder.covers",
  "job.progress",
  "app.visibility",
  "settings.changed",
] as const satisfies readonly EventChannel[]

/** Channels produced by the Go sidecar and forwarded by main unchanged. */
export const SIDECAR_EVENT_CHANNELS = [
  "index.progress",
  "query.invalidated",
  "preview.ready",
  "folder.covers",
  "job.progress",
] as const satisfies readonly EventChannel[]

/** Payload of the single Electron push channel (IPC_EVENT). */
export interface EventMessage<C extends EventChannel = EventChannel> {
  ch: C
  p: EventMap[C]
}
