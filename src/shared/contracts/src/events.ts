import type { EditRequestEvent } from "./edit"
import type { MenuCommandEvent, UpdateState } from "./update"
import type {
  AppId,
  Bookmark,
  FolderCoverItem,
  JobConflict,
  JobSnapshot,
  PreviewItem,
  QuerySnapshot,
  SavedConnection,
  SidecarStatus,
  Volume,
  OpenRequest,
} from "./rpc"

export type ScanState = "running" | "completed" | "cancelled" | "failed"

/** A search's progress (Stage C06): throttled, the final state always delivered. */
export interface FindProgress {
  findId: number
  state: ScanState
  /** Folders listed, entries looked at. */
  dirs: number
  entries: number
  /** Files whose content was read, and the bytes read. */
  searched: number
  bytes: number
  /** Folders or files that could not be read. */
  errors: number
  /** The folder being searched (display only). */
  current: string
  matches: number
  /** The search stopped at MAX_FIND_RESULTS. */
  truncated: boolean
  /** Time to the first result; -1 before it. */
  firstMatchMs: number
  elapsedMs: number
}

/** A directory compare's progress (Stage C08): throttled, the final state always delivered. */
export interface CompareProgress {
  compareId: number
  state: ScanState
  /** "listing": reading the two trees; "content": comparing files byte by byte. */
  phase: "listing" | "content"
  /** Folders and entries read, both sides together. */
  dirs: number
  entries: number
  /** Files compared by content, and the bytes read for it. */
  compared: number
  bytes: number
  /** Folders and entries that could not be read; they are left out on both sides. */
  errors: number
  /** Links and special files, never followed or compared. */
  links: number
  rows: number
  /** The compare stopped at MAX_COMPARE_ROWS. */
  truncated: boolean
  elapsedMs: number
}

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
  /** A job with the "ask" policy waits on this item (Stage P03); answer with jobs.resolve. */
  "job.conflict": { jobId: number; conflict: JobConflict }
  /** From main: this app view was shown or hidden by the app switch (ADR-0031). */
  "app.visibility": { app: AppId; visible: boolean }
  /** From main: a shared.* setting changed, so the other app can apply it (ADR-0031). */
  "settings.changed": { key: string; value: unknown }
  /** Drives came or went (Stage C03): the new list, coalesced. */
  "volumes.changed": { volumes: Volume[] }
  /** The shared bookmarks (the hotlist) changed in either app: the whole list (Stage C03). */
  "bookmarks.changed": { bookmarks: Bookmark[] }
  /** The saved connections changed (Stage C10.5, commander): the whole list, without secrets. */
  "connections.changed": { connections: SavedConnection[] }
  /** A search's progress (Stage C06, commander); results arrive through query.invalidated. */
  "find.progress": FindProgress
  /** A directory compare's progress (Stage C08, commander); rows arrive through query.invalidated. */
  "compare.progress": CompareProgress
  /** From main, to the window that opened a media window: find that window's next item (media.windowAnswer replies). */
  "mediaWindow.step": { requestId: number; key: number; direction: -1 | 0 | 1 }
  /** From main, to the viewer: open the editor on this picture (the commander's Edit button; Stage 12). */
  "edit.request": EditRequestEvent
  /** From main, to the viewer: open this folder and select this entry (a file opened from the OS). */
  "open.request": OpenRequest
  /** From main, to both apps (ADR-0038): the update state; a download reports at most 4 times a second. */
  "update.state": UpdateState
  /** From main, to the app on screen: an item of the native menu it carries out. */
  "menu.command": MenuCommandEvent
}

export type EventChannel = keyof EventMap

export const EVENT_CHANNELS = [
  "sidecar.status",
  "index.progress",
  "query.invalidated",
  "preview.ready",
  "folder.covers",
  "job.progress",
  "job.conflict",
  "app.visibility",
  "settings.changed",
  "volumes.changed",
  "bookmarks.changed",
  "connections.changed",
  "find.progress",
  "compare.progress",
  "mediaWindow.step",
  "edit.request",
  "open.request",
  "update.state",
  "menu.command",
] as const satisfies readonly EventChannel[]

/** Channels produced by the Go sidecar and forwarded by main unchanged. */
export const SIDECAR_EVENT_CHANNELS = [
  "index.progress",
  "query.invalidated",
  "preview.ready",
  "folder.covers",
  "job.progress",
  "job.conflict",
  "volumes.changed",
  "bookmarks.changed",
  "connections.changed",
  "find.progress",
  "compare.progress",
] as const satisfies readonly EventChannel[]

/** Payload of the single Electron push channel (IPC_EVENT). */
export interface EventMessage<C extends EventChannel = EventChannel> {
  ch: C
  p: EventMap[C]
}
