import type { ErrorCode } from "./errors"

// Method contracts. TypeScript is canonical (ADR-0012); the Go structs in
// native/fastview-go mirror these and golden fixtures pin both sides.

export type EmptyParams = Record<string, never>

export interface PingResult {
  pong: true
  serverTimeNs: number
}

export interface SystemInfo {
  version: string
  goVersion: string
  pid: number
  protocol: number
  uptimeMs: number
  goroutines: number
  heapBytes: number
  /** Total memory mapped by the Go runtime; an approximation of sidecar RSS. */
  runtimeMemBytes: number
  numCpu: number
}

export interface ShutdownResult {
  accepted: boolean
}

export interface EchoParams {
  payload: string
}

export interface EchoResult {
  payload: string
}

// Index (Stage 01, ADR-0015/0017) ------------------------------------------

export type EntryKind = "dir" | "image" | "video"
export const ENTRY_KINDS = ["dir", "image", "video"] as const satisfies readonly EntryKind[]

/**
 * `created` is 0 (sorts first) where the platform has no birth time (Linux).
 * `dimensions` sorts by pixel count and `duration` by video length; values
 * not known yet come last in both directions and are extracted in the
 * background while a session sorts by them (ADR-0021). `favorite`, `rating`
 * and `tags` (first tag alphabetically, untagged last) sort by user metadata.
 */
export type SortField =
  | "name"
  | "modified"
  | "size"
  | "type"
  | "created"
  | "dimensions"
  | "duration"
  | "favorite"
  | "rating"
  | "tags"
export const SORT_FIELDS = [
  "name",
  "modified",
  "size",
  "type",
  "created",
  "dimensions",
  "duration",
  "favorite",
  "rating",
  "tags",
] as const satisfies readonly SortField[]
export type SortDirection = "asc" | "desc"

export interface SortKey {
  field: SortField
  direction: SortDirection
}

export interface DirOpenParams {
  /** Absolute folder path (from the native dialog or navigation). */
  path: string
  /** Also index every visible subfolder (bounded, cancellable). */
  recursive: boolean
}

/** Opens a folder tile by its index id (no path building in the renderer). */
export interface DirOpenEntryParams {
  entryId: number
  recursive: boolean
}

export interface DirOpenResult {
  dirId: number
  path: string
  name: string
  scanId: number
  recursive: boolean
  /** The folder was fully listed before, so existing rows are usable now. */
  listedBefore: boolean
  lastListedAt: number | null
  /** Ancestors root first, ending with this folder (the renderer never parses paths). */
  crumbs: Crumb[]
}

export interface Crumb {
  name: string
  path: string
}

export interface CancelScanParams {
  scanId: number
}

export interface CancelScanResult {
  cancelled: boolean
}

export interface QueryDescriptor {
  dirId: number
  /** Files in the whole subtree instead of the folder's direct children. */
  recursive: boolean
  /** Up to 4 keys. Directories always come first; ties break by name, then id. */
  sort: SortKey[]
  /** Empty means all kinds. */
  kinds: EntryKind[]
  /**
   * File-name search: every whitespace-separated term must occur,
   * case-insensitive. "" means no search. At most MAX_SEARCH_CHARS.
   */
  search: string
  /** Lowercase extensions without dot; folders stay unless kinds excludes them. Empty = all. */
  exts: string[]
  /**
   * User-metadata filters (ADR-0021). Folders carry no user metadata, so any
   * of these leaves only files. Only favorites when true.
   */
  favorite: boolean
  /** 0 = no rating filter; otherwise at least this many stars (1..5). */
  minRating: number
  /** Files carrying all of these tags (case-insensitive). Empty = no filter. */
  tags: string[]
}

export const MAX_SEARCH_CHARS = 256
export const MAX_EXTS = 32
export const MAX_RATING = 5

/**
 * Color labels (Stage 08, ADR-0022). The stored value is the 1-based index
 * into this list, so the order is part of the contract; 0 = no label.
 */
export const COLOR_LABELS = ["red", "orange", "yellow", "green", "blue", "purple", "gray"] as const
export type ColorLabel = (typeof COLOR_LABELS)[number]
export const MAX_LABEL = COLOR_LABELS.length
export const MAX_TAG_CHARS = 64
export const MAX_TAG_FILTERS = 16

export interface QuerySnapshot {
  queryId: number
  version: number
  total: number
}

export const MAX_PAGE_SIZE = 1000

export interface QueryPageParams {
  queryId: number
  offset: number
  /** 1..MAX_PAGE_SIZE */
  limit: number
  /** Attach already-cached thumbnails of this profile (never generates). */
  thumbProfile: PreviewProfile | null
}

// Previews (Stage 02, CACHE-DESIGN.md) ---------------------------------------

/** Long edge in device pixels: grid-sm 192, grid-md 384, grid-lg 768, viewer-fit 2560. */
export type PreviewProfile = "grid-sm" | "grid-md" | "grid-lg" | "viewer-fit"
export const PREVIEW_PROFILES = [
  "grid-sm",
  "grid-md",
  "grid-lg",
  "viewer-fit",
] as const satisfies readonly PreviewProfile[]

/** 0 visible, 1 overscan, 2 forward buffer, 3 idle. */
export type PreviewPriority = 0 | 1 | 2 | 3

export const MAX_ENSURE_ITEMS = 500

export interface PreviewEnsureParams {
  /**
   * Requester lane (e.g. "grid"). A higher epoch in the same lane drops that
   * lane's queued work that was not requested again.
   */
  lane: string
  epoch: number
  profile: PreviewProfile
  /** At most MAX_ENSURE_ITEMS. */
  items: { id: number; priority: PreviewPriority }[]
  /** Regenerate even if cached (broken cache file) or failed (retry). */
  force: number[]
}

export interface Thumb {
  /** fastview-thumb://t/<key>.<ext>, served by Electron main from the disk cache. */
  url: string
  width: number
  height: number
}

export type PreviewItem =
  | ({ id: number; profile: PreviewProfile } & Thumb)
  | { id: number; profile: PreviewProfile; failed: ErrorCode }

export interface PreviewEnsureResult {
  /** Known now: cache hits and remembered failures. The rest arrives as preview.ready. */
  items: PreviewItem[]
  queued: number
  /** Not queued because the queue is full of more important work; request again later. */
  deferred: number
}

// Folder covers (Stage 08.6, ADR-0024) ---------------------------------------

/** At most this many folders per folder.covers call. */
export const MAX_COVER_DIRS = 200
/** A folder tile shows at most this many covers. */
export const MAX_FOLDER_COVERS = 4

export interface FolderCoversParams {
  /** Requester lane; a higher epoch drops the lane's queued cover work. */
  lane: string
  epoch: number
  profile: PreviewProfile
  /** Folder entry ids; at most MAX_COVER_DIRS. */
  items: { id: number; priority: PreviewPriority }[]
}

/** One cover: ready, failed, or pending (it arrives as a folder.covers event). */
export type CoverSlot = Thumb | { failed: ErrorCode } | { pending: true }

export interface FolderCover {
  dirId: number
  /** 0..MAX_FOLDER_COVERS slots; none when the folder holds no media (or cannot be read). */
  slots: CoverSlot[]
}

export interface FolderCoversResult {
  items: FolderCover[]
}

/** A finished cover slot. */
export type FolderCoverItem =
  | ({ dirId: number; slot: number; profile: PreviewProfile } & Thumb)
  | { dirId: number; slot: number; profile: PreviewProfile; failed: ErrorCode }

/** Compact row; detailed metadata is loaded on demand (Stage 05). */
export interface ContentItem {
  id: number
  kind: EntryKind
  name: string
  /** Lowercase, without dot; "" for folders. */
  ext: string
  sizeBytes: number
  modifiedMs: number
  /** User metadata; always false / 0 for folders. */
  favorite: boolean
  /** 0..5 stars; 0 = unrated. */
  rating: number
  /** Color label 0..7 (COLOR_LABELS[label - 1]); 0 = none. */
  label: number
  /** Cached thumbnail for the page's thumbProfile, or null. */
  thumb: Thumb | null
}

export interface QueryPageResult extends QuerySnapshot {
  offset: number
  items: ContentItem[]
}

export interface QueryCloseParams {
  queryId: number
}

export interface QueryCloseResult {
  closed: boolean
}

// Media (Stage 04, ADR-0009) -------------------------------------------------

export interface MediaOpenParams {
  entryId: number
}

/** Sidecar → main only: the renderer never receives file paths. */
export interface MediaResolveResult {
  path: string
  kind: EntryKind
  mime: string
  sizeBytes: number
  /** Display dimensions (after EXIF orientation); 0 when unknown. */
  width: number
  height: number
  /** The original may be shown directly (browser-native image ≤ 50 MP; always for videos). */
  original: boolean
  /** Videos (ffprobe, ADR-0018): 0 / "" when unknown or ffprobe is unavailable. */
  durationMs: number
  videoCodec: string
  audioCodec: string
}

export interface MediaOpenResult {
  /** fastview-media://m/<token> for the original, or null when only previews can be shown. */
  url: string | null
  kind: EntryKind
  mime: string
  width: number
  height: number
  /** Videos only (see MediaResolveResult); 0 / "" when unknown. */
  durationMs: number
  videoCodec: string
  audioCodec: string
}

// Workspace (Stage 05) -------------------------------------------------------

export interface ExtCount {
  ext: string
  count: number
}

/** What the kind/extension filters can choose from (scope + search, filters ignored). */
export interface QueryFacets {
  folders: number
  images: number
  videos: number
  /** Most common first, at most 50. */
  exts: ExtCount[]
}

export interface QueryFacetsParams {
  queryId: number
}

/**
 * ADR-0017 selection: index ranges of one session version plus explicit ids.
 * The renderer never sends a list of every selected id.
 */
export interface SelectionDescriptor {
  queryId: number
  version: number
  /** [start, end) indexes into the session at `version`. */
  ranges: [number, number][]
  include: number[]
  exclude: number[]
}

export const MAX_SELECTION_RANGES = 10_000
export const MAX_SELECTION_IDS = 50_000

export interface SelectionParams {
  selection: SelectionDescriptor
}

export interface SelectionInfo {
  count: number
  /** Sum of file sizes; folders count but their contents do not. */
  bytes: number
  folders: number
  images: number
  videos: number
}

/** Sidecar -> main only (clipboard). */
export interface SelectionPathsParams {
  selection: SelectionDescriptor
  /** 0 = the maximum (10 000). */
  limit: number
}

export interface SelectionPathsResult {
  paths: string[]
  truncated: boolean
}

export interface EntryParams {
  entryId: number
}

/** Sidecar -> main only (open / reveal in the system file manager). */
export interface EntryPathResult {
  path: string
  kind: EntryKind
}

export interface Properties {
  id: number
  kind: EntryKind
  name: string
  ext: string
  path: string
  /** False when the file vanished since it was indexed. */
  exists: boolean
  sizeBytes: number
  modifiedMs: number
  createdMs: number | null
  accessedMs: number | null
  width: number | null
  height: number | null
  /** Folders: counts from the last complete listing; null before it. */
  childFolders: number | null
  childMedia: number | null
  /** User metadata (files only; folders: false, 0, []). */
  favorite: boolean
  rating: number
  /** Color label 0..7; 0 = none. */
  label: number
  /** Display names, alphabetical. */
  tags: string[]
}

export type VolumeKind = "fixed" | "removable" | "network" | "optical" | "other"

export interface Volume {
  path: string
  label: string
  kind: VolumeKind
}

export interface VolumesResult {
  volumes: Volume[]
}

export interface ListDirsParams {
  path: string
}

export interface DirChild {
  name: string
  path: string
  /** False only when the folder is known to have no visible subfolders. */
  hasChildren: boolean
}

export interface ListDirsResult {
  path: string
  /** Natural name order. */
  dirs: DirChild[]
  truncated: boolean
}

export interface Bookmark {
  id: number
  path: string
  label: string
}

export interface RecentFolder {
  path: string
  lastOpenedAt: number
}

export interface LibraryState {
  /** JSON values by key (e.g. "workspace"). */
  settings: Record<string, unknown>
  bookmarks: Bookmark[]
  /** Newest first, at most 20. */
  recent: RecentFolder[]
}

export interface SetSettingParams {
  key: string
  value: unknown
}

export interface OkResult {
  ok: boolean
}

export interface AddBookmarkParams {
  path: string
  /** "" = the folder name. */
  label: string
}

export interface RemoveBookmarkParams {
  id: number
}

export type PlaceId = "home" | "desktop" | "documents" | "downloads" | "pictures" | "videos"

export interface Place {
  id: PlaceId
  label: string
  path: string
}

export interface PlacesResult {
  places: Place[]
}

export interface CopyPathsResult {
  count: number
  truncated: boolean
}

export interface RevealPathParams {
  path: string
}

export interface CopyTextParams {
  text: string
}

/**
 * Sidecar -> main only (Stage 08.6): the picture for the OS clipboard as a
 * temp PNG in the cache (decoded and oriented in Go). Main reads and deletes
 * it; pixels never travel over IPC.
 */
export interface ClipboardImageResult {
  file: string
  width: number
  height: number
}

/** clipboard.copyImage: the size of the bitmap put on the clipboard. */
export interface CopyImageResult {
  width: number
  height: number
}

export const MAX_COPY_TEXT_CHARS = 64 * 1024

// Batch jobs and user metadata (Stage 07, ADR-0021) -------------------------

export type JobKind =
  "copy" | "move" | "trash" | "delete" | "rename" | "favorite" | "rating" | "label" | "tag"
export const JOB_KINDS = [
  "copy",
  "move",
  "trash",
  "delete",
  "rename",
  "favorite",
  "rating",
  "label",
  "tag",
] as const satisfies readonly JobKind[]

export type JobState = "queued" | "running" | "completed" | "cancelled" | "failed"
export const JOB_STATES = [
  "queued",
  "running",
  "completed",
  "cancelled",
  "failed",
] as const satisfies readonly JobState[]

/** What happens when the destination already has an item of that name. */
export type ConflictPolicy = "keepBoth" | "skip" | "replace"
export const CONFLICT_POLICIES = [
  "keepBoth",
  "skip",
  "replace",
] as const satisfies readonly ConflictPolicy[]

/** Items are resolved in Go when the job starts; the renderer never sends id lists. */
export interface JobSource {
  selection: SelectionDescriptor
}

export type JobStartParams =
  | {
      kind: "copy" | "move"
      source: JobSource
      /** Absolute folder path. */
      destination: string
      conflict: ConflictPolicy
    }
  | { kind: "trash" | "delete"; source: JobSource }
  | {
      kind: "rename"
      source: JobSource
      /** `{name}` = original name without extension, `{n}` or `{n:000}` = counter. Extension is kept. */
      pattern: string
      /** First counter value. */
      start: number
    }
  | { kind: "favorite"; source: JobSource; favorite: boolean }
  | { kind: "rating"; source: JobSource; rating: number }
  | { kind: "label"; source: JobSource; label: number }
  | { kind: "tag"; source: JobSource; tag: string; add: boolean }

export const MAX_RENAME_PATTERN_CHARS = 255
export const MAX_RENAME_START = 1_000_000_000

/** Full job state; job.progress carries it (at most 4 Hz per job, coalesced, final state always delivered). */
export interface JobSnapshot {
  jobId: number
  kind: JobKind
  state: JobState
  total: number
  done: number
  failed: number
  /** Unchanged names, folders in metadata jobs, conflicts under "skip". */
  skipped: number
  bytesTotal: number
  bytesDone: number
  /** Name of the item being processed ("" when idle or finished). */
  current: string
  /** Destination folder name for copy/move, else "". */
  destination: string
  /** Why the job failed as a whole (state "failed"), else "". */
  error: string
  startedMs: number
  /** 0 while queued or running. */
  finishedMs: number
}

export type JobItemErrorCode =
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "ALREADY_EXISTS"
  | "INVALID_NAME"
  | "TRASH_UNAVAILABLE"
  | "NO_SPACE"
  | "IN_USE"
  | "INTO_ITSELF"
  | "SKIPPED_LINK"
  | "IO_ERROR"

export interface JobItemError {
  name: string
  code: JobItemErrorCode
  /** User-facing explanation. */
  message: string
}

export interface JobIdParams {
  jobId: number
}

export interface JobCancelResult {
  cancelled: boolean
}

export interface JobErrorsParams {
  jobId: number
  offset: number
  /** 1..MAX_JOB_ERRORS_PAGE */
  limit: number
}

export const MAX_JOB_ERRORS_PAGE = 500

export interface JobErrorsResult {
  errors: JobItemError[]
  total: number
}

export interface JobListResult {
  /** Active and recently finished jobs, oldest first. */
  jobs: JobSnapshot[]
}

export type ClipMode = "copy" | "cut"

export interface ClipSetParams {
  selection: SelectionDescriptor
  mode: ClipMode
}

/** The internal clipboard (survives navigation; not the OS file clipboard). */
export interface ClipState {
  /** "" when empty. */
  mode: ClipMode | ""
  count: number
}

export interface ClipPasteParams {
  /** Absolute folder path, usually the open folder. */
  destination: string
  conflict: ConflictPolicy
}

export interface EntryRenameParams {
  entryId: number
  /** The full new name. Files must keep a supported extension of the same kind. */
  name: string
}

export interface EntryRenameResult {
  name: string
}

export const MAX_NAME_CHARS = 255

export interface Tag {
  id: number
  name: string
  /** Files carrying the tag. */
  count: number
}

export interface TagsResult {
  /** Alphabetical. */
  tags: Tag[]
}

export interface TagIdParams {
  id: number
}
export const MAX_SETTING_KEY_CHARS = 128
export const MAX_SETTING_JSON_CHARS = 64 * 1024

/** Methods implemented by the Go sidecar. */
export interface SidecarMethodMap {
  "system.ping": { params: EmptyParams; result: PingResult }
  "system.info": { params: EmptyParams; result: SystemInfo }
  "system.shutdown": { params: EmptyParams; result: ShutdownResult }
  /** Development/benchmark only; registered when FASTVIEW_DEV_METHODS=1. */
  "system.echo": { params: EchoParams; result: EchoResult }
  "dir.open": { params: DirOpenParams; result: DirOpenResult }
  "dir.openEntry": { params: DirOpenEntryParams; result: DirOpenResult }
  "dir.cancelScan": { params: CancelScanParams; result: CancelScanResult }
  "query.open": { params: QueryDescriptor; result: QuerySnapshot }
  "query.page": { params: QueryPageParams; result: QueryPageResult }
  "query.close": { params: QueryCloseParams; result: QueryCloseResult }
  "preview.ensure": { params: PreviewEnsureParams; result: PreviewEnsureResult }
  "folder.covers": { params: FolderCoversParams; result: FolderCoversResult }
  /** Electron main only (not in RENDERER_METHODS). */
  "media.resolve": { params: MediaOpenParams; result: MediaResolveResult }
  "query.facets": { params: QueryFacetsParams; result: QueryFacets }
  "selection.info": { params: SelectionParams; result: SelectionInfo }
  /** Maps a descriptor onto the session's current version (after query.invalidated). */
  "selection.rebase": { params: SelectionParams; result: SelectionDescriptor }
  /** Electron main only. */
  "selection.paths": { params: SelectionPathsParams; result: SelectionPathsResult }
  /** Electron main only. */
  "entry.path": { params: EntryParams; result: EntryPathResult }
  /** Electron main only: decodes an image to a temp PNG for the OS clipboard. */
  "clipboard.image": { params: EntryParams; result: ClipboardImageResult }
  "props.get": { params: EntryParams; result: Properties }
  "fs.volumes": { params: EmptyParams; result: VolumesResult }
  "fs.listDirs": { params: ListDirsParams; result: ListDirsResult }
  "library.get": { params: EmptyParams; result: LibraryState }
  "library.setSetting": { params: SetSettingParams; result: OkResult }
  "library.addBookmark": { params: AddBookmarkParams; result: Bookmark }
  "library.removeBookmark": { params: RemoveBookmarkParams; result: OkResult }
  "jobs.start": { params: JobStartParams; result: JobSnapshot }
  "jobs.cancel": { params: JobIdParams; result: JobCancelResult }
  "jobs.errors": { params: JobErrorsParams; result: JobErrorsResult }
  "jobs.list": { params: EmptyParams; result: JobListResult }
  "clip.set": { params: ClipSetParams; result: ClipState }
  "clip.get": { params: EmptyParams; result: ClipState }
  /** Copies (or, after a cut, moves) the clipboard into a folder; a completed move clears it. */
  "clip.paste": { params: ClipPasteParams; result: JobSnapshot }
  /** Synchronous single rename (F2); errors are INVALID_ARGUMENT with details.reason. */
  "entry.rename": { params: EntryRenameParams; result: EntryRenameResult }
  "library.tags": { params: EmptyParams; result: TagsResult }
  "library.deleteTag": { params: TagIdParams; result: OkResult }
}

export type SidecarMethod = keyof SidecarMethodMap

export type SidecarState = "starting" | "ready" | "restarting" | "stopping" | "stopped" | "failed"

export interface SidecarStatus {
  state: SidecarState
  pid: number | null
  protocol: number | null
  version: string | null
  restarts: number
  lastError: string | null
  /** Epoch ms of the last state change. */
  since: number
}

export interface OpenFolderDialogResult {
  /** null when the user cancelled the dialog. */
  path: string | null
}

/** Methods answered by Electron main itself (never forwarded to Go). */
export interface MainMethodMap {
  /** Requests an orderly Electron app exit (sidecar shutdown remains main-owned). */
  "app.exit": { params: EmptyParams; result: OkResult }
  "sidecar.getStatus": { params: EmptyParams; result: SidecarStatus }
  "dialog.openFolder": { params: EmptyParams; result: OpenFolderDialogResult }
  /** Resolves through the sidecar and mints a fastview-media token. */
  "media.open": { params: MediaOpenParams; result: MediaOpenResult }
  /** Home, Desktop, Documents, Downloads, Pictures, Videos (those that exist). */
  "places.list": { params: EmptyParams; result: PlacesResult }
  /** Opens a file or folder with the system default application. */
  "shell.open": { params: EntryParams; result: OkResult }
  /** Shows an indexed entry in the system file manager. */
  "shell.reveal": { params: EntryParams; result: OkResult }
  /** Shows a folder from the sidebar or breadcrumb in the system file manager. */
  "shell.revealPath": { params: RevealPathParams; result: OkResult }
  /** Copies the selection's full paths, one per line (resolved in Go, never sent to the renderer). */
  "clipboard.copyPaths": { params: SelectionParams; result: CopyPathsResult }
  "clipboard.copyText": { params: CopyTextParams; result: OkResult }
  /** Puts an indexed image on the OS clipboard as a picture (decoded in Go). */
  "clipboard.copyImage": { params: EntryParams; result: CopyImageResult }
}

export type MethodMap = SidecarMethodMap & MainMethodMap
export type Method = keyof MethodMap
export type Params<M extends Method> = MethodMap[M]["params"]
export type Result<M extends Method> = MethodMap[M]["result"]

/** Methods the renderer may invoke. Main rejects everything else. */
export const RENDERER_METHODS = [
  "app.exit",
  "system.ping",
  "system.info",
  "sidecar.getStatus",
  "dialog.openFolder",
  "dir.open",
  "dir.openEntry",
  "dir.cancelScan",
  "query.open",
  "query.page",
  "query.close",
  "preview.ensure",
  "folder.covers",
  "media.open",
  "query.facets",
  "selection.info",
  "selection.rebase",
  "props.get",
  "fs.volumes",
  "fs.listDirs",
  "library.get",
  "library.setSetting",
  "library.addBookmark",
  "library.removeBookmark",
  "places.list",
  "shell.open",
  "shell.reveal",
  "shell.revealPath",
  "clipboard.copyPaths",
  "clipboard.copyText",
  "clipboard.copyImage",
  "jobs.start",
  "jobs.cancel",
  "jobs.errors",
  "jobs.list",
  "clip.set",
  "clip.get",
  "clip.paste",
  "entry.rename",
  "library.tags",
  "library.deleteTag",
] as const

/** Additionally allowed when dev methods are enabled (never in packaged builds). */
export const DEV_RENDERER_METHODS = ["system.echo"] as const

export type RendererMethod =
  (typeof RENDERER_METHODS)[number] | (typeof DEV_RENDERER_METHODS)[number]

export const MAIN_METHODS = [
  "app.exit",
  "sidecar.getStatus",
  "dialog.openFolder",
  "media.open",
  "places.list",
  "shell.open",
  "shell.reveal",
  "shell.revealPath",
  "clipboard.copyPaths",
  "clipboard.copyText",
  "clipboard.copyImage",
] as const satisfies readonly (keyof MainMethodMap)[]
