import type { ErrorCode } from "./errors"

// Method contracts. TypeScript is canonical (ADR-0012); the Go structs in
// shared/sidecar mirror these and golden fixtures pin both sides.

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

/**
 * `file` (any other file) and `link` (symlink, junction, mount point; never
 * followed) appear only in the `all` scope (Stage P02, ADR-0026).
 */
export type EntryKind = "dir" | "image" | "video" | "file" | "link"
export const ENTRY_KINDS = [
  "dir",
  "image",
  "video",
  "file",
  "link",
] as const satisfies readonly EntryKind[]

/**
 * Which stored entries a query sees (ADR-0026). `media` (the default, the
 * viewer's): folders, images and videos that are not hidden or system.
 * `all` (the commander's): every entry; hidden and system ones with showHidden.
 */
export type QueryScope = "media" | "all"
export const QUERY_SCOPES = ["media", "all"] as const satisfies readonly QueryScope[]

/** ContentItem.attrs bits (ADR-0026). Archive is Windows-only. */
export const ENTRY_ATTRS = {
  hidden: 1,
  system: 2,
  readOnly: 4,
  archive: 8,
  executable: 16,
  link: 32,
} as const
export const MAX_NAME_MASK_CHARS = 256

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
  | "attrs"
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
  "attrs",
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
  /**
   * The caller's foreground scan slot (Stage C06): a new scan cancels only the
   * previous one in its lane. The viewer sends none; each commander panel its side.
   */
  lane?: string
}

/** Opens a folder tile by its index id (no path building in the renderer). */
export interface DirOpenEntryParams {
  entryId: number
  recursive: boolean
  lane?: string
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
  /** Entry scope (Stage P02); omitted = "media". */
  scope?: QueryScope
  /** Include hidden and system entries; `all` scope only. */
  showHidden?: boolean
  /**
   * Wildcard masks for files ("*", "?"), separated by ";" or spaces; masks
   * after "|" exclude. Folders always pass. "" or omitted = all files.
   */
  nameMask?: string
  /**
   * A search's results instead of a folder (Stage C06, commander): sorted and
   * filtered by sort, showHidden and nameMask; needs the all scope and no recursion.
   */
  findId?: number
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
  /** ENTRY_ATTRS bits; omitted when 0. */
  attrs?: number
  /** Folders: the calculated size of everything below (Stage C02 dirSize jobs); omitted until calculated. */
  dirSizeBytes?: number
  /** The entry's folder, in sessions spanning folders: find results and branch views (Stage C06). */
  dirPath?: string
  /** Cached thumbnail for the page's thumbProfile, or null. */
  thumb: Thumb | null
}

export interface QueryPageResult extends QuerySnapshot {
  offset: number
  items: ContentItem[]
}

/** Where an entry sits in a session (cursor on the folder just left, carried-over focus). */
export interface QueryIndexOfParams {
  queryId: number
  entryId: number
}

export interface QueryIndexOfResult {
  /** -1 when the entry is not in the session. */
  index: number
  version: number
}

/** Quick search (Stage C02): the next name match at or after `from` (before it, backward), wrapping. */
export interface QueryLocateParams {
  queryId: number
  /** Prefix matches win over substring matches; "*" and "?" are wildcards. */
  pattern: string
  from: number
  direction: "forward" | "backward"
}

export interface QueryLocateResult {
  /** -1 when nothing matches. */
  index: number
  version: number
}

/** Marking by mask (Stage C02): the files (never folders) matching a name mask. */
export interface QueryMatchParams {
  queryId: number
  /** The nameMask syntax: "*.jpg;*.png|*_small.*". */
  mask: string
}

export interface QueryMatchResult {
  version: number
  /** [start, end) indexes into the session at `version`. */
  ranges: [number, number][]
  count: number
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
  /** Other files and links (`all` scope only; omitted when 0). */
  files?: number
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

/**
 * shell.open (Stage C05, ADR-0027). The commander may open any kind; a
 * program opens only with `allowProgram`, sent after the user confirmed (or
 * with the "always" setting). The viewer's profile opens folders and media only.
 */
export interface ShellOpenParams {
  entryId: number
  allowProgram?: boolean
}

/** Sidecar -> main only (open / reveal in the system file manager). */
export interface EntryPathResult {
  path: string
  kind: EntryKind
  /** Opening it may run code (executables, scripts, installers, shortcuts, app bundles). */
  program: boolean
}

/** Sidecar -> main only (Stage C05): any indexed file, for the commander's lister and quick view. */
export interface FileResolveResult {
  path: string
  kind: EntryKind
  /** The media type for images and videos; application/octet-stream for everything else. */
  mime: string
  sizeBytes: number
}

/**
 * file.open (Stage C05, commander only): a read-only fastview-media token URL
 * for any file. Text and hex views read byte windows with HTTP Range; no file
 * bytes cross IPC (ADR-0027).
 */
export interface FileOpenResult {
  url: string
  kind: EntryKind
  mime: string
  sizeBytes: number
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
  /**
   * Bytes available to the user and the volume size (Stage C01); read for
   * fixed and removable volumes only, omitted when unknown.
   */
  freeBytes?: number
  totalBytes?: number
  /**
   * A drive without media, a disconnected share, or one that did not answer
   * within its timeout (Stage C03); its space is then unknown.
   */
  notReady?: boolean
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

/** The viewer's bookmarks are the commander's directory hotlist: one list (ADR-0031). */
export interface Bookmark {
  id: number
  path: string
  label: string
  /** Hotlist group (Stage C03); "" = none. The viewer shows a flat list. */
  group: string
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
  /** Hotlist group; omitted or "" = none (Stage C03). */
  group?: string
}

/** Hotlist edit (Stage C03); another bookmark with the path fails with reason "duplicate". */
export interface UpdateBookmarkParams {
  id: number
  path: string
  /** "" = the folder name. */
  label: string
  group: string
}

/** The listed bookmarks first, in this order; the rest keep their order after them. */
export interface ReorderBookmarksParams {
  ids: number[]
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

export interface CopyPathsParams {
  selection: SelectionDescriptor
  /** Names instead of full paths (the commander, Stage C04). */
  namesOnly?: boolean
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
  | "copy"
  | "move"
  | "trash"
  | "delete"
  | "rename"
  | "favorite"
  | "rating"
  | "label"
  | "tag"
  | "dirSize"
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
  "dirSize",
] as const satisfies readonly JobKind[]

/**
 * "paused": held by jobs.pause (a partial file is kept). "asking": waiting
 * for jobs.resolve on its `conflict` (Stage P03, ADR-0029).
 */
export type JobState =
  "queued" | "running" | "paused" | "asking" | "completed" | "cancelled" | "failed"
export const JOB_STATES = [
  "queued",
  "running",
  "paused",
  "asking",
  "completed",
  "cancelled",
  "failed",
] as const satisfies readonly JobState[]

/**
 * What happens when the destination already has an item of that name
 * (ADR-0029). "replace" and its variants merge a folder into an existing
 * folder; a file never replaces a folder. "ask" asks per item (job.conflict).
 */
export type ConflictPolicy =
  | "ask"
  | "keepBoth"
  | "skip"
  | "replace"
  | "replaceOlder"
  | "replaceIfDifferentSize"
  | "renameNew"
  | "renameExisting"
export const CONFLICT_POLICIES = [
  "ask",
  "keepBoth",
  "skip",
  "replace",
  "replaceOlder",
  "replaceIfDifferentSize",
  "renameNew",
  "renameExisting",
] as const satisfies readonly ConflictPolicy[]

/** An answer to a conflict: any policy but "ask". */
export type ConflictDecision = Exclude<ConflictPolicy, "ask">
export const CONFLICT_DECISIONS = CONFLICT_POLICIES.filter(
  (p): p is ConflictDecision => p !== "ask",
)

/** Items are resolved in Go when the job starts; the renderer never sends id lists. */
export interface JobSource {
  selection: SelectionDescriptor
}

/**
 * Where a copy or move goes: an absolute folder path (the viewer), or an
 * indexed folder's id, resolved in Go (the commander must use it, ADR-0027).
 */
export type JobDestination = { destination: string } | { destinationDirId: number }

export type JobStartParams =
  | ({
      kind: "copy" | "move"
      source: JobSource
      conflict: ConflictPolicy
      /** Hash source and copy; a mismatch fails the item (Stage P03). */
      verify?: boolean
      /** Start right away instead of after the jobs of its lane (Stage P03). */
      now?: boolean
      /** Only files matching this name mask (folders are walked); Stage C04. */
      mask?: string
      /** A new name for a single item (Shift+F5); Stage C04. */
      name?: string
    } & JobDestination)
  | { kind: "trash" | "delete"; source: JobSource }
  /** Folder sizes (Stage C02): results go to the index as ContentItem.dirSizeBytes. */
  | { kind: "dirSize"; source: JobSource }
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

/** The commander's jobs (Stage C04): copy and move name their destination by folder id. */
export type CommanderJobParams =
  | {
      kind: "copy" | "move"
      source: JobSource
      destinationDirId: number
      conflict: ConflictPolicy
      verify?: boolean
      now?: boolean
      mask?: string
      name?: string
    }
  | { kind: "trash" | "delete" | "dirSize"; source: JobSource }

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
  /** Moving average over the last seconds; 0 while unknown, paused or finished (Stage P03). */
  bytesPerSec: number
  /** Estimated time left; 0 while unknown. */
  etaMs: number
  /** The question a job in state "asking" waits on. */
  conflict?: JobConflict
}

export interface JobConflictSide {
  /** The indexed entry (for a preview), or 0. */
  id: number
  size: number
  modifiedMs: number
  isDir: boolean
}

/** An item whose name is taken in the destination (Stage P03, ADR-0029). */
export interface JobConflict {
  /** The item's name, or its path inside a folder being merged. */
  name: string
  source: JobConflictSide
  target: JobConflictSide
}

export interface JobResolveParams {
  jobId: number
  decision: ConflictDecision
  /** The decision becomes the job's policy for the conflicts still to come. */
  applyToAll: boolean
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
  /** The copy differed from the original (verify) and was removed. */
  | "VERIFY_FAILED"

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

/** Destination: an absolute folder path, or (the commander) an indexed folder's id. */
export type ClipPasteParams = { conflict: ConflictPolicy } & JobDestination

/** F7 (Stage C04): "a/b/c" creates the chain inside the folder. */
export interface FsMkdirParams {
  parentDirId: number
  path: string
}

/** Shift+F4 (Stage C05): one name, no separators. */
export interface FsMkfileParams {
  parentDirId: number
  name: string
}

export interface FsMkfileResult {
  entryId: number
  /** False when the file existed already (it is opened as it is). */
  created: boolean
}

export interface FsMkdirResult {
  /** The first component (the folder the panel lists). */
  entryId: number
  /** False when the whole chain existed already. */
  created: boolean
}

export interface DirIdParams {
  dirId: number
}

/** Whether items of the folder can go to the trash (else delete offers permanent delete). */
export interface FsCanTrashResult {
  trash: boolean
}

export const MAX_MKDIR_PATH_CHARS = 4096

/** "Go to file" (Stage C06): the entry's folder, scanned in the caller's lane. */
export interface DirOpenContainingParams {
  entryId: number
  lane?: string
}

/** Find files (Stage C06, commander). Optional bounds are null when unset. */
export interface FindStartParams {
  /** Absolute folders to search in (1..16). */
  roots: string[]
  /** Name masks ("*.txt;*.md"); after "|" exclusions, "name\" or "name/" excludes folders. */
  mask: string
  /** Subfolder levels: 0 = only the folders themselves; -1 = unlimited. */
  depth: number
  /** Include hidden and system entries and enter such folders. */
  hidden: boolean
  /** Keep only files containing this text; "" = no content search. */
  text: string
  caseSensitive: boolean
  wholeWords: boolean
  /** Encodings to search the text in; empty = UTF-8, UTF-16 LE and Windows-1252. */
  encodings: FindEncoding[]
  skipBinary: boolean
  minSize: number | null
  maxSize: number | null
  /** Modified time bounds, epoch ms. */
  modifiedAfter: number | null
  modifiedBefore: number | null
  /** Attribute bits (ATTR_*) that must be set, and that must be clear. */
  attrsSet: number
  attrsClear: number
}

export type FindEncoding =
  | "utf-8"
  | "utf-16le"
  | "utf-16be"
  | "windows-1252"
  | "windows-1250"
  | "windows-1251"
  | "iso-8859-2"
  | "koi8-r"

export const FIND_ENCODINGS = [
  "utf-8",
  "utf-16le",
  "utf-16be",
  "windows-1252",
  "windows-1250",
  "windows-1251",
  "iso-8859-2",
  "koi8-r",
] as const satisfies readonly FindEncoding[]

/** The ENTRY_ATTRS bits a search can require or exclude (not link: links are their own kind). */
export const FIND_ATTR_BITS =
  ENTRY_ATTRS.hidden |
  ENTRY_ATTRS.system |
  ENTRY_ATTRS.readOnly |
  ENTRY_ATTRS.archive |
  ENTRY_ATTRS.executable
export const MAX_FIND_ROOTS = 16
export const MAX_FIND_TEXT_CHARS = 1024
/** A search stops at this many results (find.progress reports truncated). */
export const MAX_FIND_RESULTS = 250_000

/** The results tab's session (found order) starts empty; results arrive as query.invalidated. */
export interface FindStartResult extends QuerySnapshot {
  findId: number
}

export interface FindIdParams {
  findId: number
}

export interface FindCancelResult {
  cancelled: boolean
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
// Shared context (Stage C01, ADR-0031, docs/shared/APP-SWITCHING.md) --------

export interface ContextPublishParams {
  /** The calling app; main rejects any other value. */
  app: AppId
  dirId: number
  /** The focused tile or the cursor entry; null when there is none. */
  focusId: number | null
  /**
   * The selection or the marks (Stage C02); Go keeps at most
   * MAX_CONTEXT_SELECTION ids. Sent on the switch (null = nothing selected);
   * omitted when only the folder changed, which keeps the carried selection
   * readable for the app being shown.
   */
  selection?: SelectionDescriptor | null
}

export const MAX_CONTEXT_SELECTION = 10_000

/** The carried selection as ranges of the shown app's session (`selection.fromContext`). */
export interface SelectionFromContextParams {
  /** The SharedContext.version the selection belongs to. */
  version: number
  queryId: number
}

export interface SharedContext {
  /**
   * Publishes so far in this run. 0 = none yet: `app` and `path` then come
   * from the previous run (the last used app; "" when there was none) and
   * `dirId` is 0.
   */
  version: number
  app: AppId | ""
  dirId: number
  path: string
  focusId: number | null
  /** Carried entries (0 = none). */
  selectionCount: number
  /** The selection had more than MAX_CONTEXT_SELECTION entries and was not carried. */
  selectionTooLarge: boolean
}

/** Settings → General: what carries over on a switch, and the app shown at start (`shared.switch`). */
export interface SharedSwitchSettings {
  v: 1
  carry: { folder: boolean; focus: boolean; selection: boolean }
  startWith: "last" | AppId
}

export const SHARED_SWITCH_KEY = "shared.switch"
export const DEFAULT_SWITCH_SETTINGS: SharedSwitchSettings = {
  v: 1,
  carry: { folder: true, focus: true, selection: true },
  startWith: "last",
}

/** Validated shared.switch; unknown shapes fall back to the defaults. */
export function readSwitchSettings(value: unknown): SharedSwitchSettings {
  const v = value as Partial<SharedSwitchSettings> | null | undefined
  if (v?.v !== 1) return DEFAULT_SWITCH_SETTINGS
  const c = (v.carry ?? {}) as Partial<SharedSwitchSettings["carry"]>
  return {
    v: 1,
    carry: {
      folder: c.folder !== false,
      focus: c.focus !== false,
      selection: c.selection !== false,
    },
    startWith: v.startWith === "viewer" || v.startWith === "commander" ? v.startWith : "last",
  }
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
  /** The folder holding an entry, opened like dir.open ("Go to file", Stage C06). */
  "dir.openContaining": { params: DirOpenContainingParams; result: DirOpenResult }
  "find.start": { params: FindStartParams; result: FindStartResult }
  "find.cancel": { params: FindIdParams; result: FindCancelResult }
  "query.open": { params: QueryDescriptor; result: QuerySnapshot }
  "query.page": { params: QueryPageParams; result: QueryPageResult }
  "query.close": { params: QueryCloseParams; result: QueryCloseResult }
  "query.indexOf": { params: QueryIndexOfParams; result: QueryIndexOfResult }
  "query.locate": { params: QueryLocateParams; result: QueryLocateResult }
  "query.match": { params: QueryMatchParams; result: QueryMatchResult }
  "selection.fromContext": { params: SelectionFromContextParams; result: SelectionDescriptor }
  /** The app being left: its folder and focused entry (only from the visible app). */
  "context.publish": { params: ContextPublishParams; result: OkResult }
  /** The app being shown (and main at startup): the latest context. */
  "context.get": { params: EmptyParams; result: SharedContext }
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
  "fs.mkdir": { params: FsMkdirParams; result: FsMkdirResult }
  "fs.mkfile": { params: FsMkfileParams; result: FsMkfileResult }
  /** Electron main only (Stage C05): any file, for the commander's token URLs. */
  "file.resolve": { params: MediaOpenParams; result: FileResolveResult }
  "fs.canTrash": { params: DirIdParams; result: FsCanTrashResult }
  "library.get": { params: EmptyParams; result: LibraryState }
  "library.setSetting": { params: SetSettingParams; result: OkResult }
  "library.addBookmark": { params: AddBookmarkParams; result: Bookmark }
  "library.removeBookmark": { params: RemoveBookmarkParams; result: OkResult }
  "library.updateBookmark": { params: UpdateBookmarkParams; result: Bookmark }
  "library.reorderBookmarks": { params: ReorderBookmarksParams; result: OkResult }
  "jobs.start": { params: JobStartParams; result: JobSnapshot }
  "jobs.cancel": { params: JobIdParams; result: JobCancelResult }
  "jobs.errors": { params: JobErrorsParams; result: JobErrorsResult }
  "jobs.list": { params: EmptyParams; result: JobListResult }
  /** Stage P03 (ADR-0029): hold, continue, start ahead of the lane, answer a conflict. */
  "jobs.pause": { params: JobIdParams; result: OkResult }
  "jobs.resume": { params: JobIdParams; result: OkResult }
  "jobs.startNow": { params: JobIdParams; result: OkResult }
  "jobs.resolve": { params: JobResolveParams; result: OkResult }
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

/** The apps hosted by the shell (ADR-0031). */
export type AppId = "viewer" | "commander"

export const APP_IDS = ["viewer", "commander"] as const satisfies readonly AppId[]

export interface AppSwitchParams {
  to: AppId
}

/** Methods answered by Electron main itself (never forwarded to Go). */
export interface MainMethodMap {
  /** Requests an orderly Electron app exit (sidecar shutdown remains main-owned). */
  "app.exit": { params: EmptyParams; result: OkResult }
  /** Shows the other app's view in the same window (ADR-0031). */
  "app.switch": { params: AppSwitchParams; result: OkResult }
  "sidecar.getStatus": { params: EmptyParams; result: SidecarStatus }
  "dialog.openFolder": { params: EmptyParams; result: OpenFolderDialogResult }
  /** Resolves through the sidecar and mints a fastview-media token. */
  "media.open": { params: MediaOpenParams; result: MediaOpenResult }
  /** Home, Desktop, Documents, Downloads, Pictures, Videos (those that exist). */
  "places.list": { params: EmptyParams; result: PlacesResult }
  /** Opens a file or folder with the system default application (kinds per app profile). */
  "shell.open": { params: ShellOpenParams; result: OkResult }
  /** Commander (Stage C05): a read-only token URL for any file (lister, quick view). */
  "file.open": { params: MediaOpenParams; result: FileOpenResult }
  /** Commander (Stage C05, F4): opens a file in the editor from settings, else the OS text editor. */
  "shell.edit": { params: EntryParams; result: OkResult }
  /** Shows an indexed entry in the system file manager. */
  "shell.reveal": { params: EntryParams; result: OkResult }
  /** Shows a folder from the sidebar or breadcrumb in the system file manager. */
  "shell.revealPath": { params: RevealPathParams; result: OkResult }
  /** Copies the selection's full paths, one per line (resolved in Go, never sent to the renderer). */
  "clipboard.copyPaths": { params: CopyPathsParams; result: CopyPathsResult }
  "clipboard.copyText": { params: CopyTextParams; result: OkResult }
  /** Puts an indexed image on the OS clipboard as a picture (decoded in Go). */
  "clipboard.copyImage": { params: EntryParams; result: CopyImageResult }
}

export type MethodMap = SidecarMethodMap & MainMethodMap
export type Method = keyof MethodMap
export type Params<M extends Method> = MethodMap[M]["params"]
export type Result<M extends Method> = MethodMap[M]["result"]

/** The viewer's app view (ADR-0027): main rejects everything else from it. */
export const VIEWER_METHODS = [
  "app.exit",
  "app.switch",
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
  "query.indexOf",
  "query.locate",
  "query.match",
  "context.publish",
  "context.get",
  "selection.fromContext",
  "preview.ensure",
  "folder.covers",
  "media.open",
  "query.facets",
  "selection.info",
  "selection.rebase",
  "props.get",
  "fs.volumes",
  "fs.listDirs",
  "fs.mkdir",
  "fs.canTrash",
  "library.get",
  "library.setSetting",
  "library.addBookmark",
  "library.removeBookmark",
  "library.updateBookmark",
  "library.reorderBookmarks",
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
  "jobs.pause",
  "jobs.resume",
  "jobs.startNow",
  "jobs.resolve",
  "clip.set",
  "clip.get",
  "clip.paste",
  "entry.rename",
  "library.tags",
  "library.deleteTag",
] as const

/** Methods only the commander's profile has (ADR-0027): any file's bytes, the editor, new files. */
export const COMMANDER_ONLY_METHODS = [
  "file.open",
  "shell.edit",
  "fs.mkfile",
  "find.start",
  "find.cancel",
  "dir.openContaining",
] as const

/** Every method some renderer may invoke. Main rejects everything else. */
export const RENDERER_METHODS = [...VIEWER_METHODS, ...COMMANDER_ONLY_METHODS] as const

/** Additionally allowed when dev methods are enabled (never in packaged builds). */
export const DEV_RENDERER_METHODS = ["system.echo"] as const

export type RendererMethod =
  (typeof RENDERER_METHODS)[number] | (typeof DEV_RENDERER_METHODS)[number]

/**
 * Methods the commander's app view may call (ADR-0027). It grows with the
 * commander stages; everything else is rejected for its web contents.
 */
export const COMMANDER_METHODS = [
  "app.exit",
  "app.switch",
  "system.ping",
  "system.info",
  "sidecar.getStatus",
  "library.get",
  "library.setSetting",
  // Stage C01: listing (all-entries scope), free space, home, the shared context.
  "dir.open",
  "dir.openEntry",
  "dir.cancelScan",
  "query.open",
  "query.page",
  "query.close",
  "query.indexOf",
  "fs.volumes",
  "places.list",
  "context.publish",
  "context.get",
  // Stage C02: marks, quick search, folder sizes (main allows only dirSize jobs until C04).
  "query.locate",
  "query.match",
  "selection.info",
  "selection.rebase",
  "selection.fromContext",
  "jobs.start",
  "jobs.cancel",
  // Stage C04: file operations (main requires folder ids as destinations).
  "jobs.pause",
  "jobs.resume",
  "jobs.startNow",
  "jobs.resolve",
  "jobs.errors",
  "jobs.list",
  "clip.set",
  "clip.get",
  "clip.paste",
  "entry.rename",
  "fs.mkdir",
  "fs.canTrash",
  "clipboard.copyPaths",
  "clipboard.copyText",
  // Stage C03: the directory hotlist (the shared bookmarks).
  "library.addBookmark",
  "library.removeBookmark",
  "library.updateBookmark",
  "library.reorderBookmarks",
  // Stage C05: quick view and lister (shared media components, any file's
  // bytes through tokens), open with the default app, the editor, new files.
  "media.open",
  "preview.ensure",
  "props.get",
  "file.open",
  "shell.open",
  "shell.edit",
  "fs.mkfile",
  // Stage C06: find files, "Go to file".
  "find.start",
  "find.cancel",
  "dir.openContaining",
] as const satisfies readonly RendererMethod[]

/** Each app view's allowlist. The viewer keeps the full list it always had, plus the C01 context methods. */
export const APP_METHODS: Record<AppId, readonly RendererMethod[]> = {
  viewer: VIEWER_METHODS,
  commander: COMMANDER_METHODS,
}

export const MAIN_METHODS = [
  "app.exit",
  "app.switch",
  "sidecar.getStatus",
  "dialog.openFolder",
  "media.open",
  "file.open",
  "places.list",
  "shell.open",
  "shell.edit",
  "shell.reveal",
  "shell.revealPath",
  "clipboard.copyPaths",
  "clipboard.copyText",
  "clipboard.copyImage",
] as const satisfies readonly (keyof MainMethodMap)[]
