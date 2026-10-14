import type {
  BatchParams,
  BatchPickFolderResult,
  BatchPlanResult,
  EditBatchParams,
  RecipeDeleteParams,
  RecipeListResult,
  RecipeSaveParams,
  RecipeSaveResult,
} from "./batch"
import type { ErrorCode } from "./errors"
import type { AboutInfo, AppOpenTargetParams, UpdateState } from "./update"
import type {
  EditEyesParams,
  EditEyesResult,
  AssetPickParams,
  AssetPickResult,
  AssetReleaseParams,
  EditAssetAddParams,
  EditAssetFile,
  EditFontsResult,
  EditColorsParams,
  EditColorsResult,
  EditEstimateParams,
  EditEstimateResult,
  EditFrameResult,
  EditProbeParams,
  EditProbeResult,
  EditThumbFramesResult,
  EditThumbsParams,
  EditThumbsResult,
  EditInfoResult,
  EditJobParams,
  EditOpenParams,
  EditOpenResult,
  EditRenderParams,
  EditRenderResult,
  EditSaveParams,
  EditSaveResult,
  EditSavedPathResult,
  EditSavedResult,
  EditSessionParams,
  EditWriteParams,
  EditWriteResult,
} from "./edit"

// Method contracts. TypeScript is canonical (ADR-0012); the Go structs in
// src/shared/sidecar mirror these and golden fixtures pin both sides.

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

/**
 * The calling app, added to a call by Electron main (Stage P02, ADR-0026):
 * a folder is watched while the app that opened it is on screen, and a
 * session counts against that app's budget. A renderer's own value is
 * replaced; main's own calls carry none.
 */
export interface CallerApp {
  app?: AppId
}

/** Electron main only (Stage P02): the app on screen; the watches follow it. */
export interface AppSetVisibleParams {
  app: AppId
  /**
   * Counts main's calls from 1. The sidecar handles requests concurrently and
   * drops a call overtaken by a later one (`ok: false`).
   */
  seq: number
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
   * With showHidden: keep system entries out (the hidden ones, dot-names
   * and the hidden attribute, are listed). An entry that is both is a system one.
   */
  hideSystem?: boolean
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
  /**
   * A folder of an open archive (Stage C07, commander, ADR-0030): its
   * entries come from the archive's listing in Go; needs the all scope and
   * no recursion. `dirId` is then the folder holding the archive.
   */
  archiveId?: number
  /** The archive folder's entry id; 0 or omitted = the archive's root. */
  archiveDirId?: number
  /**
   * A listed folder of a connection (Stage C10.5, commander, ADR-0037): its
   * entries come from the folder's listing in Go, and a session over it
   * costs no network. Needs the all scope and no recursion. `dirId` is then
   * the panel's last local folder.
   */
  remoteId?: number
  /** The folder's id from remote.open. */
  remoteDirId?: number
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
  /** panelyth-thumb://t/<key>.<ext>, served by Electron main from the disk cache. */
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
  /** The rows of a directory compare (Stage C08): both sides and what a sync does. */
  diff?: DiffInfo
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
  /** panelyth-media://m/<token> for the original, or null when only previews can be shown. */
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

/**
 * shell.run (Stage C10, ADR-0027): a command typed in the commander's
 * command line, run through the OS shell in the folder `dirId` (resolved in
 * Go). `console` runs it in a console window that stays open; with an empty
 * `command` it opens the console in that folder and runs nothing.
 */
export interface ShellRunParams {
  command: string
  dirId: number
  console?: boolean
}

/**
 * shell.runTool (Stage C10): a user command, named by its id in
 * commander.tools. Main reads the command from library.db and fills its
 * placeholders from these ids, which Go resolves to paths.
 */
export interface ShellRunToolParams {
  toolId: string
  /** The active panel's folder (%P, and the working folder unless the command names one). */
  dirId: number
  /** The other panel's folder (%T). */
  otherDirId?: number
  /** The cursor entry (%N). */
  cursorId?: number
  /** The marked entries, or the cursor entry (%S, %L). */
  selection?: SelectionDescriptor
}

/** Sidecar -> main only (open / reveal in the system file manager). */
export interface EntryPathResult {
  path: string
  kind: EntryKind
  /** Opening it may run code (executables, scripts, installers, shortcuts, app bundles). */
  program: boolean
}

/**
 * Main -> sidecar only ("Open with"): a picture or video the OS handed to the
 * app, by its path. No renderer names a path.
 */
export interface EntryFromPathParams {
  path: string
}

/** The file's folder (opened, listed in the background) and the file's entry, indexed at once. */
export interface EntryFromPathResult {
  dirId: number
  entryId: number
  kind: EntryKind
  /** The folder's listing is complete; false while a large folder is still being listed. */
  listed: boolean
}

/**
 * "Show this in the viewer": a folder to open and the entry to select there.
 * Main hands it to the viewer when a file opened from the OS is taken into the
 * app (the `open.request` event, or app.openRequest at start).
 */
export interface OpenRequest {
  dirId: number
  entryId: number
}

/** app.openRequest (viewer, once at start): what the app was started for, or null. */
export interface OpenRequestResult {
  request: OpenRequest | null
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
 * file.open (Stage C05, commander only): a read-only panelyth-media token URL
 * for any file. Text and hex views read byte windows with HTTP Range; no file
 * bytes cross IPC (ADR-0027).
 */
export interface FileOpenResult {
  url: string
  kind: EntryKind
  mime: string
  sizeBytes: number
}

/**
 * document.open (commander only, ADR-0033): shows a PDF or text file in a
 * document window of its own. Main resolves the entry, decides the document
 * kind from the file's extension and gives the window a read-only token; the
 * window has no preload and no IPC. `theme` is the commander's theme name (a-z and "-").
 */
export interface DocumentOpenParams {
  entryId: number
  theme?: string
  /** The interface language (a locale code, ADR-0034). */
  lang?: string
}

/**
 * media.openWindow (both apps, ADR-0033 amended): shows an image or a video
 * in a frameless full-screen window of its own, a child of the shell window.
 * The window is the shared media overlay on the commander's narrow profile.
 * The opener keeps the folder listing: `key` names this window in the
 * opener's own bookkeeping, and the window asks the opener for neighbours
 * through main (media.windowStep, the mediaWindow.step event, media.windowAnswer).
 * `theme` and `lang` are as for document.open.
 */
export interface MediaWindowOpenParams extends DocumentOpenParams {
  key: number
}

/** The tabs of Settings (ADR-0039); each app's own tab is shown in that app's window only. */
export const SETTINGS_TABS = [
  "general",
  "viewer",
  "commander",
  "appearance",
  "shortcuts",
  "about",
] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

/**
 * settings.openWindow (both apps, ADR-0039): Settings in a native window, a
 * child of the shell window that blocks it until closed. The page runs on the
 * calling app's origin and profile. `tab` is shown first; asking again while
 * the window is open focuses it.
 */
export interface SettingsWindowOpenParams {
  tab?: SettingsTab
}

/**
 * settings.closeWindow (both apps, ADR-0039): the settings window closes
 * itself; `then: "shortcuts"` has its app view open the keyboard shortcuts
 * (a menu.command event). Only the settings window may call it.
 */
export interface SettingsWindowCloseParams {
  then?: "shortcuts"
}

/** media.windowStep (the media window): 0 = the first item, -1 / 1 = previous / next. */
export interface MediaWindowStepParams {
  direction: -1 | 0 | 1
}

/** The item the opener found, or null at either end. */
export interface MediaWindowStepResult {
  item: ContentItem | null
}

/** media.windowAnswer (the opener): the reply to one mediaWindow.step event. */
export interface MediaWindowAnswerParams {
  requestId: number
  item: ContentItem | null
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
  /** ENTRY_ATTRS bits as they are now (Stage C09); omitted when none is set. */
  attrs?: number
  /** Permission bits (0o777) outside Windows; null on Windows, which has none. */
  permissions: number | null
  /** Where a link points, as it is stored; null for everything else. */
  linkTarget: string | null
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
  /**
   * Hidden and system folders too (the commander's tree when its panel
   * shows hidden files, Stage C10.5). Main refuses it from the viewer.
   */
  showHidden?: boolean
  /** With showHidden: keep system folders out. */
  hideSystem?: boolean
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
  | "extract"
  | "pack"
  | "testArchive"
  | "sync"
  | "hashCreate"
  | "hashVerify"
  | "compareFiles"
  | "multiRename"
  | "undoRename"
  | "setAttributes"
  /** Stage C10.5: between a connection and this computer, and deletes on the server. */
  | "download"
  | "upload"
  | "remoteDelete"
  /** Stage 12: an edited picture being written; started by edit.save, never by jobs.start. */
  | "editSave"
  /** Stage 16: a recipe run over a selection (batch.start), and its undo (batch.undo). */
  | "edit"
  | "undoEdit"
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
  "extract",
  "pack",
  "testArchive",
  "sync",
  "hashCreate",
  "hashVerify",
  "compareFiles",
  "multiRename",
  "undoRename",
  "setAttributes",
  "download",
  "upload",
  "remoteDelete",
  "editSave",
  "edit",
  "undoEdit",
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

/**
 * Archive jobs (Stage C07, ADR-0030). extract: entries of an archive panel
 * (copy out, F5) or whole archives (unpack, Alt+F9) into a folder. pack
 * (Alt+F5): the marked entries into a new archive. testArchive
 * (Alt+Shift+F9): reads archives through, checking their checksums.
 */
export type ArchiveJobParams =
  | {
      kind: "extract"
      source: JobSource
      destinationDirId: number
      conflict: ConflictPolicy
      /** Create links stored in archives (inside the target only). */
      links?: boolean
      /** Unpack each archive into a folder named after it. */
      subfolders?: boolean
    }
  | {
      kind: "pack"
      source: JobSource
      destinationDirId: number
      conflict: ConflictPolicy
      /** The new archive's file name. */
      name: string
      format: ArchiveCreateFormat
      /** 0 (store) .. 9. */
      level: number
      /** Delete the entries that were packed completely. */
      deleteOriginals?: boolean
    }
  | { kind: "testArchive"; source: JobSource }

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
  | ArchiveJobParams
  | CompareJobParams
  | RenameJobParams
  | RemoteJobParams

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
  /** Archives (Stage C07): a name that would leave the target (zip-slip), never extracted. */
  | "UNSAFE_PATH"
  /** The archive or entry is damaged (checksum, truncation). */
  | "CORRUPT"
  /** Password-protected; not supported. */
  | "ENCRYPTED"
  /** An entry expanded beyond its stored size (a bomb), or is too large to view. */
  | "TOO_LARGE"
  /** Sync (Stage C08): the entry is not as the compare saw it, so it was left alone. */
  | "CHANGED"
  /** compareFiles: the two files are not the same. */
  | "DIFFERENT"
  /** hashVerify: the file's checksum is not the one its list has. */
  | "CHECKSUM_MISMATCH"
  /** A batch edit (Stage 16): the picture can't be read, or is of a kind that is not edited. */
  | "DECODE_FAILED"
  | "UNSUPPORTED"

export const JOB_ITEM_ERROR_CODES = [
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "ALREADY_EXISTS",
  "INVALID_NAME",
  "TRASH_UNAVAILABLE",
  "NO_SPACE",
  "IN_USE",
  "INTO_ITSELF",
  "SKIPPED_LINK",
  "IO_ERROR",
  "VERIFY_FAILED",
  "UNSAFE_PATH",
  "CORRUPT",
  "ENCRYPTED",
  "TOO_LARGE",
  "CHANGED",
  "DIFFERENT",
  "CHECKSUM_MISMATCH",
  "DECODE_FAILED",
  "UNSUPPORTED",
] as const satisfies readonly JobItemErrorCode[]

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

// Archives (Stage C07, commander, ADR-0030) ---------------------------------

/** zip, tar, tar.gz, tar.bz2 and .gz built in; "7z" is everything 7-Zip opens. */
export type ArchiveFormat = "zip" | "tar" | "tgz" | "tbz2" | "gz" | "7z"
export const ARCHIVE_FORMATS = [
  "zip",
  "tar",
  "tgz",
  "tbz2",
  "gz",
  "7z",
] as const satisfies readonly ArchiveFormat[]

/** What Alt+F5 creates (7z needs 7-Zip). */
export type ArchiveCreateFormat = "zip" | "tgz" | "7z"
export const ARCHIVE_CREATE_FORMATS = [
  "zip",
  "tgz",
  "7z",
] as const satisfies readonly ArchiveCreateFormat[]

/**
 * archive.open: an archive file (an index entry) listed in Go and held until
 * archive.close; its folders open with query.open { archiveId, archiveDirId }.
 * Errors carry details.reason "notArchive", "noTool" (7-Zip missing),
 * "corrupt", "encrypted" or "tooLarge".
 */
export interface ArchiveOpenResult {
  archiveId: number
  format: ArchiveFormat
  /** Listed entries, folders included. */
  entries: number
  /** Entries with unsafe names (zip-slip, absolute paths): never listed or extracted. */
  rejected: number
  /** Expanded size of all files. */
  bytes: number
  /** The archive file's size. */
  packedBytes: number
}

export interface ArchiveIdParams {
  archiveId: number
}

export interface ArchiveCloseResult {
  closed: boolean
}

/** archive.check: sizes an extraction before it starts (entries of an archive panel, or archives to unpack). */
export interface ArchiveCheckParams {
  selection: SelectionDescriptor
  destinationDirId: number
}

/** "space": larger than the free space; "ratio": expands > 100× its packed size (a bomb). */
export type ArchiveWarning = "space" | "ratio"

export interface ArchiveCheckResult {
  files: number
  bytes: number
  packedBytes: number
  /** -1 when the free space could not be read in time. */
  freeBytes: number
  warnings: ArchiveWarning[]
  /** Only the first 64 archives were looked at. */
  partial: boolean
}

/** archive.tools: whether 7-Zip was found (7z, rar and others; creating 7z). */
export interface ArchiveToolsResult {
  sevenZip: boolean
}

// Compare, synchronize and checksums (Stage C08, commander) ------------------

/**
 * The date rules of a compare: file systems keep dates at different
 * resolutions (FAT: 2 s), and some shift them by an hour with daylight
 * saving time.
 */
export interface CompareOptions {
  /** Dates this close are the same; 0 = exact. At most MAX_COMPARE_TOLERANCE_MS. */
  toleranceMs: number
  /** Dates exactly one hour apart (within the tolerance) are the same. */
  dst: boolean
  /** Compare by name and size (and content) only. */
  ignoreDates: boolean
}

export const MAX_COMPARE_TOLERANCE_MS = 60_000
/** A compare stops at this many rows (compare.progress reports truncated). */
export const MAX_COMPARE_ROWS = 500_000

/**
 * compare.dirs: a recursive compare of two indexed folders. Its rows are a
 * query session (ADR-0017) that starts empty and fills when the walk has
 * finished; pages carry ContentItem.diff. Links are never followed or
 * compared. Errors carry details.reason "nested" when one folder is inside
 * the other.
 */
export interface CompareDirsParams extends CompareOptions {
  leftDirId: number
  rightDirId: number
  /** Also compare files of the same size byte by byte. */
  content: boolean
  /** Left to right only: the right side becomes a copy of the left; files only there are deleted. */
  asymmetric: boolean
}

export interface CompareStartResult extends QuerySnapshot {
  compareId: number
}

export interface CompareIdParams {
  compareId: number
}

export interface CompareCancelResult {
  cancelled: boolean
}

export interface CompareCloseResult {
  closed: boolean
}

/** How the two sides of a compare row relate. "mismatch": a file on one side, a folder on the other. */
export type DiffState =
  "equal" | "leftNewer" | "rightNewer" | "different" | "leftOnly" | "rightOnly" | "mismatch"
export const DIFF_STATES = [
  "equal",
  "leftNewer",
  "rightNewer",
  "different",
  "leftOnly",
  "rightOnly",
  "mismatch",
] as const satisfies readonly DiffState[]

/**
 * What a sync does with a row: "copyRight" (→), "copyLeft" (←), "none" (=
 * for equal rows, ≠ otherwise) and the deletes of one-sided entries (×).
 */
export type DiffAction = "none" | "copyRight" | "copyLeft" | "deleteRight" | "deleteLeft"
export const DIFF_ACTIONS = [
  "none",
  "copyRight",
  "copyLeft",
  "deleteRight",
  "deleteLeft",
] as const satisfies readonly DiffAction[]

export interface DiffSide {
  sizeBytes: number
  modifiedMs: number
}

/** A row of a directory compare. Folders have rows only when they exist on one side. */
export interface DiffInfo {
  /** The row's folder below the two roots, "/"-separated; "" = the roots. */
  dir: string
  state: DiffState
  action: DiffAction
  /** null when the entry is not on that side. */
  left: DiffSide | null
  right: DiffSide | null
}

/** The rows a compare's session lists, by the symbol of their action: → ← = ≠ ×. */
export type CompareShow = "copyRight" | "copyLeft" | "equal" | "different" | "delete"
export const COMPARE_SHOW = [
  "copyRight",
  "copyLeft",
  "equal",
  "different",
  "delete",
] as const satisfies readonly CompareShow[]

export interface CompareShowParams {
  compareId: number
  show: CompareShow[]
}

/**
 * compare.setAction: a direction for the selected rows of the compare's
 * session, or "default" for the one the compare chose. Rows an action does
 * not apply to keep theirs: a copy needs its source, and only one-sided
 * entries can be deleted.
 */
export interface CompareSetActionParams {
  compareId: number
  selection: SelectionDescriptor
  action: DiffAction | "default"
}

export interface CompareAmount {
  files: number
  bytes: number
}

/**
 * What a sync would do now. It covers the shown rows only: a sync never
 * touches a row the table does not show. The version changes with every
 * change of the filter or of a direction; a sync job must name it.
 */
export interface ComparePlan {
  version: number
  /** Every row by symbol, shown or not. */
  counts: Record<CompareShow, number>
  copyRight: CompareAmount
  copyLeft: CompareAmount
  deleteRight: number
  deleteLeft: number
  /** Folders a sync creates. */
  folders: number
  /** Copies that replace a newer file. */
  overwriteNewer: number
}

/** The table after a change of the filter or of a direction: its session and its plan. */
export interface CompareView extends QuerySnapshot {
  plan: ComparePlan
}

/** compare.marks (Shift+F2): the files that are unique or newer in each of two listings. */
export interface CompareMarksParams extends CompareOptions {
  leftQueryId: number
  rightQueryId: number
}

export interface CompareMarksResult {
  left: SelectionDescriptor
  right: SelectionDescriptor
  leftCount: number
  rightCount: number
}

export type HashAlgorithm = "sha256" | "sha1" | "md5" | "crc32"
export const HASH_ALGORITHMS = [
  "sha256",
  "sha1",
  "md5",
  "crc32",
] as const satisfies readonly HashAlgorithm[]

/**
 * Compare jobs (Stage C08). sync: applies the plan of a finished compare
 * (copies first, then deletes; an entry that changed since the compare is
 * reported as CHANGED and left alone). hashCreate: one checksum file beside
 * each file, or one list in a folder. hashVerify: the selected .sha256,
 * .sha1, .md5 and .sfv files; every listed file is an item. compareFiles:
 * two files byte by byte; done = identical, a DIFFERENT item otherwise. Its
 * other form (Stage C10.5) takes a selection and a folder: each selected
 * file is compared with the file of its name in that folder (done =
 * identical, DIFFERENT, or NOT_FOUND when the folder has no such file;
 * folders in the selection are skipped).
 */
export type CompareJobParams =
  | {
      kind: "sync"
      compareId: number
      /** ComparePlan.version the user confirmed; an older one is refused (details.reason "stalePlan"). */
      planVersion: number
      /** Delete instead of moving to the trash. */
      deletePermanently?: boolean
    }
  | { kind: "hashCreate"; source: JobSource; algorithm: HashAlgorithm; perFile: true }
  | {
      kind: "hashCreate"
      source: JobSource
      algorithm: HashAlgorithm
      perFile: false
      /** The folder of the list; its paths are relative to it. */
      destinationDirId: number
      name: string
    }
  | { kind: "hashVerify"; source: JobSource }
  | { kind: "compareFiles"; leftId: number; rightId: number }
  | { kind: "compareFiles"; source: JobSource; destinationDirId: number }

/** A text diff takes files up to this size; larger ones are compared by content only. */
export const MAX_TEXT_DIFF_BYTES = 50 * 1024 * 1024
export const MAX_TEXT_DIFF_PAGE = 500

export interface TextDiffOpenParams {
  leftId: number
  rightId: number
}

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252"

export interface TextDiffFile {
  name: string
  sizeBytes: number
  lines: number
  /** "" when the file was not read as text. */
  encoding: TextEncoding | ""
}

/**
 * diff.open: two files compared line by line in Go (the text stays in the
 * files; rows are paged with diff.page). Files that are not text, or larger
 * than MAX_TEXT_DIFF_BYTES, come back with diffId 0 and a reason: compare
 * them with a compareFiles job.
 */
export interface TextDiffOpenResult {
  diffId: number
  reason: "" | "binary" | "tooLarge"
  left: TextDiffFile
  right: TextDiffFile
  /** Rows of the side-by-side view. */
  rows: number
  /** Changed places; blocks lists the first 10,000 as [first row, rows]. */
  changes: number
  blocks: [number, number][]
  /** The same bytes. Files without a changed line can still differ in line ends or encoding. */
  identical: boolean
}

export interface TextDiffPageParams {
  diffId: number
  offset: number
  /** 1..MAX_TEXT_DIFF_PAGE */
  limit: number
}

export type TextDiffOp = "equal" | "changed" | "removed" | "added"

export interface TextDiffRow {
  op: TextDiffOp
  /** Line numbers from 1; 0 where a side has no line. */
  l: number
  r: number
  /** The left line; an equal row carries its text here only. */
  left: string
  right?: string
  /** A line was longer than 4 KiB and is cut. */
  cut?: boolean
  /**
   * A changed row only (Stage C10.5): what differs inside the line once the
   * common start and end are taken away, as [left from, left to, right from,
   * right to] in string positions of `left` and `right`.
   */
  spans?: [number, number, number, number]
}

export interface TextDiffPageResult {
  offset: number
  rows: TextDiffRow[]
}

export interface TextDiffIdParams {
  diffId: number
}

// Multi-rename, attributes and dates (Stage C09, commander) -----------------

/** How the new names are cased; "first" and "words" leave the extension as it is. */
export type RenameCase = "" | "lower" | "upper" | "first" | "words"
export const RENAME_CASES = [
  "",
  "lower",
  "upper",
  "first",
  "words",
] as const satisfies readonly RenameCase[]

/** Each mask and the search and replace texts take this many UTF-8 bytes. */
export const MAX_RENAME_MASK_BYTES = 255
export const MAX_RENAME_STEP = 1_000_000
export const MAX_RENAME_DIGITS = 10
/** A multi-rename (and its preview) takes this many entries. */
export const MAX_MULTI_RENAME = 100_000
export const MAX_RENAME_PREVIEW_PAGE = 500

/**
 * A multi-rename in Total Commander's syntax (the viewer's `{name}{n}`
 * pattern compiles to the same plan in Go). Placeholders of the masks:
 * `[N]` the name and `[E]` the extension, both with ranges (`[N2-5]`,
 * `[N2-]`, `[N2,3]`, `[N2]`); `[C]` the counter (`[C10+2:3]` = from 10,
 * step 2, 3 digits); `[Y] [M] [D] [h] [m] [s]` from the modification time;
 * `[[]` and `[]]` for brackets. Search and replace runs on the name the
 * masks give (with its extension); a regular expression is Go RE2 syntax
 * with `$1` in the replacement. The case conversion comes last.
 */
export interface RenamePlan {
  nameMask: string
  /** "" = no extension. */
  extMask: string
  /** "" = no search and replace. */
  search: string
  replace: string
  regex: boolean
  matchCase: boolean
  case: RenameCase
  /** The counter of `[C]`: first value, step and minimum digits (1..MAX_RENAME_DIGITS). */
  start: number
  step: number
  digits: number
}

/**
 * rename.preview: the selection named with the plan, one page of it. The
 * whole batch is resolved in Go on every call (conflicts depend on all of
 * it); the counts are the batch's. A plan that cannot be compiled is
 * INVALID_ARGUMENT with details { reason: "plan", field } (field: nameMask,
 * extMask, search, case or counter); more than MAX_MULTI_RENAME entries is
 * details.reason "tooMany".
 */
export interface RenamePreviewParams {
  selection: SelectionDescriptor
  plan: RenamePlan
  offset: number
  /** 1..MAX_RENAME_PREVIEW_PAGE */
  limit: number
}

export type RenameStatus = "rename" | "unchanged" | "invalid" | "conflict"
export const RENAME_STATUSES = [
  "rename",
  "unchanged",
  "invalid",
  "conflict",
] as const satisfies readonly RenameStatus[]

/**
 * Why a new name is not free: another entry of the batch gets it too
 * ("duplicate"), an entry that keeps its name has it ("exists"), or entries
 * exchange names ("cycle"; that needs a third name, which a job never uses).
 */
export type RenameConflict = "duplicate" | "exists" | "cycle"

export interface RenamePreviewRow {
  id: number
  name: string
  newName: string
  status: RenameStatus
  /** A RenameConflict for "conflict"; the reason in words for "invalid". */
  reason?: string
}

export interface RenamePreviewResult {
  total: number
  renamed: number
  unchanged: number
  invalid: number
  conflicts: number
  /** Position of the first invalid or conflicting row; -1 without one. */
  firstProblem: number
  offset: number
  rows: RenamePreviewRow[]
}

/** rename.undoInfo: the multi-rename an undoRename job would take back; count 0 = none. */
export interface RenameUndoInfo {
  count: number
  /** The folder of the renamed entries (the first one's). */
  dir: string
  finishedMs: number
}

/**
 * Rename and attribute jobs (Stage C09). multiRename: renames what the
 * preview calls "rename" and fails the rest per item; what it renamed is
 * the journal of one undo. undoRename: takes the last multi-rename back
 * (no selection); an entry that is gone, or whose old name is taken again,
 * fails and stays. setAttributes: Windows attributes (ENTRY_ATTRS readOnly,
 * hidden, system, archive) or, elsewhere, permission bits, each set or
 * cleared, and dates; links are never changed or followed.
 */
export type RenameJobParams =
  | { kind: "multiRename"; source: JobSource; plan: RenamePlan }
  | { kind: "undoRename" }
  | {
      kind: "setAttributes"
      source: JobSource
      /** ENTRY_ATTRS bits to set and to clear; they apply on Windows. */
      setAttrs?: number
      clearAttrs?: number
      /** Permission bits (0..0o777) to set and to clear; they apply outside Windows. */
      setMode?: number
      clearMode?: number
      /** New dates; omitted = unchanged. From 1980 to 9999. */
      modifiedMs?: number
      accessedMs?: number
      /** Also everything below the selected folders. */
      recursive?: boolean
    }

/** The attribute bits a setAttributes job may set or clear. */
export const SETTABLE_ATTRS =
  ENTRY_ATTRS.hidden | ENTRY_ATTRS.system | ENTRY_ATTRS.readOnly | ENTRY_ATTRS.archive
export const MIN_ATTR_TIME_MS = Date.UTC(1980, 0, 1)
export const MAX_ATTR_TIME_MS = Date.UTC(9999, 11, 31, 23, 59, 59)

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

// Remote connections: FTP and FTPS (Stage C10.5, commander, ADR-0037) ---------

/** How a connection is encrypted; "none" is plain FTP and only ever the user's choice. */
export type RemoteTls = "explicit" | "implicit" | "none"
export const REMOTE_TLS = ["explicit", "implicit", "none"] as const satisfies readonly RemoteTls[]

export const MAX_CONNECTION_NAME_CHARS = 128
export const MAX_REMOTE_HOST_CHARS = 253
export const MAX_REMOTE_PATH_CHARS = 4096
/** A password is at most this many UTF-8 bytes, on one line. */
export const MAX_REMOTE_PASSWORD_BYTES = 1024
export const MAX_REMOTE_TRANSFERS = 4
export const MAX_REMOTE_NAME_CHARS = 1024
export const MAX_REMOTE_ENCODING_CHARS = 32
/** A certificate fingerprint: SHA-256, 64 hex digits. */
export const FINGERPRINT_HEX_CHARS = 64

/**
 * A saved connection. It never carries a password: `hasPassword` says
 * whether one is stored (as ciphertext made by Electron main).
 */
export interface SavedConnection {
  /** 0 for a connection that is not saved yet. */
  id: number
  name: string
  group: string
  host: string
  port: number
  tls: RemoteTls
  /** "" = anonymous. */
  user: string
  /** The folder on the server to open first; "" = "/". */
  startPath: string
  /** A folder for the other panel; "" = leave it. */
  localPath: string
  /** The server connects back for data (active mode) instead of passive mode. */
  active: boolean
  /** Names' encoding: "" = UTF-8, else a code page's name ("windows-1252"). */
  encoding: string
  /** Transfers that may run at once, 1..MAX_REMOTE_TRANSFERS. */
  transfers: number
  /** The certificate the user accepted for this connection, or "". */
  fingerprint: string
  hasPassword: boolean
}

export interface ConnectionsResult {
  connections: SavedConnection[]
}

/**
 * remote.saveConnection as a renderer sends it. `password` is write-only:
 * main encrypts it with the system's secret store before anything is
 * stored, and no method returns it. Without it the stored password stays;
 * `forget` drops the stored one.
 */
export interface SaveConnectionParams {
  connection: SavedConnection
  password?: string
  forget?: boolean
}

/** Main → sidecar: the connection with its password as ciphertext (base64). */
export interface StoreConnectionParams {
  connection: SavedConnection
  secret?: string
  forget?: boolean
}

export interface ConnectionIdParams {
  connectionId: number
}

/** Main only: a stored password's ciphertext (base64), "" when none is stored. */
export interface ConnectionSecretResult {
  secret: string
}

export interface RemoteTrustParams {
  connectionId: number
  /** "" forgets the accepted certificate. */
  fingerprint: string
}

/** A connection that is not saved (quick connect). */
export interface RemoteQuick {
  host: string
  port: number
  tls: RemoteTls
  user: string
  active: boolean
  encoding: string
  transfers: number
}

/**
 * remote.connect as a renderer sends it: a saved connection or a typed one.
 * `password` is one typed for this connect; a saved connection's stored
 * password is put in by main. `accept` trusts a certificate with that
 * fingerprint for this connect. `attempt` names the connect for remote.cancel
 * (attempts of connects and of remote.open share one numbering).
 */
export type RemoteConnectParams = ({ connectionId: number } | { quick: RemoteQuick }) & {
  password?: string
  accept?: string
  attempt: number
}

/** Main → sidecar: the same connect with the clear password in place. */
export interface RemoteDialParams {
  connectionId?: number
  quick?: RemoteQuick
  password: string
  accept?: string
  attempt: number
}

export interface RemoteFeatures {
  mlsd: boolean
  /** A transfer that is cut off can go on where it stopped. */
  resume: boolean
  utf8: boolean
}

export interface RemoteConnectResult {
  remoteId: number
  host: string
  port: number
  user: string
  /** The control and data connections use TLS. */
  encrypted: boolean
  features: RemoteFeatures
  /** Where the connection's panel opens first. */
  startPath: string
  /** The folder a saved connection names for the other panel, or "". */
  localPath: string
}

/**
 * Why a connect or a command on a connection failed (`details.reason`).
 * "certificate" comes with `details.fingerprint`, `subject` and `changed`;
 * "refused" carries the server's own words as the message.
 */
export type RemoteFailureReason =
  | "auth"
  | "needsPassword"
  | "host"
  | "timeout"
  | "unreachable"
  | "tlsRequired"
  | "certificate"
  | "refused"
  | "closed"
  | "notFound"
  | "name"
  | "tooLarge"
  | "unsupported"
  | "noSecureStore"

export interface RemoteAttemptParams {
  attempt: number
}

export interface RemoteIdParams {
  remoteId: number
}

/**
 * A folder by its path on the server, or by its entry id. `attempt` names
 * the listing for remote.cancel (a server that stops answering).
 */
export type RemoteOpenParams = (
  { remoteId: number; path: string } | { remoteId: number; dirId: number }
) & { attempt?: number }

export interface RemoteOpenResult {
  remoteDirId: number
  path: string
  name: string
  /** The folder's ancestors, the server's root first. */
  crumbs: Crumb[]
  /** Entries left out because their names cannot be listed. */
  rejected: number
}

export interface RemoteMkdirParams {
  remoteDirId: number
  name: string
}

export interface RemoteRenameParams {
  entryId: number
  name: string
}

/** Whether the system offers a secret store, so passwords can be saved. */
export interface SecureStoreResult {
  available: boolean
}

/**
 * Jobs between a connection and this computer (Stage C10.5). download: the
 * selected entries of a remote session into a local folder. upload: the
 * selected local entries into a folder of a connection. remoteDelete: the
 * selected entries on the server, for good (a server has no trash). `move`
 * removes each source once its copy is whole.
 */
export type RemoteJobParams =
  | {
      kind: "download"
      source: JobSource
      destinationDirId: number
      conflict: ConflictPolicy
      move?: boolean
    }
  | {
      kind: "upload"
      source: JobSource
      remoteDirId: number
      conflict: ConflictPolicy
      move?: boolean
    }
  | { kind: "remoteDelete"; source: JobSource }

/** Methods implemented by the Go sidecar. */
export interface SidecarMethodMap {
  "system.ping": { params: EmptyParams; result: PingResult }
  "system.info": { params: EmptyParams; result: SystemInfo }
  "system.shutdown": { params: EmptyParams; result: ShutdownResult }
  /** Development/benchmark only; registered when PANELYTH_DEV_METHODS=1. */
  "system.echo": { params: EchoParams; result: EchoResult }
  "dir.open": { params: DirOpenParams & CallerApp; result: DirOpenResult }
  "dir.openEntry": { params: DirOpenEntryParams & CallerApp; result: DirOpenResult }
  "dir.cancelScan": { params: CancelScanParams; result: CancelScanResult }
  /** The folder holding an entry, opened like dir.open ("Go to file", Stage C06). */
  "dir.openContaining": { params: DirOpenContainingParams & CallerApp; result: DirOpenResult }
  "find.start": { params: FindStartParams; result: FindStartResult }
  "find.cancel": { params: FindIdParams; result: FindCancelResult }
  "archive.open": { params: EntryParams; result: ArchiveOpenResult }
  "archive.close": { params: ArchiveIdParams; result: ArchiveCloseResult }
  "archive.check": { params: ArchiveCheckParams; result: ArchiveCheckResult }
  "archive.tools": { params: EmptyParams; result: ArchiveToolsResult }
  /** Stage C08: a recursive compare of two folders; its rows are a query session. */
  "compare.dirs": { params: CompareDirsParams; result: CompareStartResult }
  "compare.cancel": { params: CompareIdParams; result: CompareCancelResult }
  "compare.close": { params: CompareIdParams; result: CompareCloseResult }
  "compare.show": { params: CompareShowParams; result: CompareView }
  "compare.setAction": { params: CompareSetActionParams; result: CompareView }
  "compare.plan": { params: CompareIdParams; result: ComparePlan }
  "compare.marks": { params: CompareMarksParams; result: CompareMarksResult }
  "diff.open": { params: TextDiffOpenParams; result: TextDiffOpenResult }
  "diff.page": { params: TextDiffPageParams; result: TextDiffPageResult }
  "diff.close": { params: TextDiffIdParams; result: OkResult }
  /** Stage C09: a multi-rename's names, paged; multiRename and undoRename jobs apply and undo. */
  "rename.preview": { params: RenamePreviewParams; result: RenamePreviewResult }
  "rename.undoInfo": { params: EmptyParams; result: RenameUndoInfo }
  /** Stage C10.5 (ADR-0037): saved connections, without their secrets. */
  "remote.connections": { params: EmptyParams; result: ConnectionsResult }
  /** Main only: stores a connection; a password arrives as ciphertext. */
  "remote.storeConnection": { params: StoreConnectionParams; result: SavedConnection }
  "remote.removeConnection": { params: ConnectionIdParams; result: OkResult }
  /** Main only: the ciphertext main decrypts for one connect. */
  "remote.secret": { params: ConnectionIdParams; result: ConnectionSecretResult }
  /** Remembers the certificate the user accepted for a saved connection. */
  "remote.trust": { params: RemoteTrustParams; result: OkResult }
  /** Main only: connects and logs in, with the clear password of this one call. */
  "remote.dial": { params: RemoteDialParams; result: RemoteConnectResult }
  /** Stops a connect that is under way. */
  "remote.cancel": { params: RemoteAttemptParams; result: OkResult }
  "remote.disconnect": { params: RemoteIdParams; result: OkResult }
  /** Lists a folder from the server (the remote counterpart of dir.open). */
  "remote.open": { params: RemoteOpenParams; result: RemoteOpenResult }
  "remote.mkdir": { params: RemoteMkdirParams; result: OkResult }
  "remote.rename": { params: RemoteRenameParams; result: OkResult }
  "query.open": { params: QueryDescriptor & CallerApp; result: QuerySnapshot }
  "query.page": { params: QueryPageParams; result: QueryPageResult }
  "query.close": { params: QueryCloseParams; result: QueryCloseResult }
  "query.indexOf": { params: QueryIndexOfParams; result: QueryIndexOfResult }
  "query.locate": { params: QueryLocateParams; result: QueryLocateResult }
  "query.match": { params: QueryMatchParams; result: QueryMatchResult }
  "selection.fromContext": { params: SelectionFromContextParams; result: SelectionDescriptor }
  /** The app being left: its folder and focused entry (only from the visible app). */
  "context.publish": { params: ContextPublishParams; result: OkResult }
  /** Electron main only: the app on screen, at start and on every switch (Stage P02). */
  "app.setVisible": { params: AppSetVisibleParams; result: OkResult }
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
  /** Electron main only ("Open with"): a file the OS handed over, by its path. */
  "entry.fromPath": { params: EntryFromPathParams; result: EntryFromPathResult }
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
  /** Archive, compare, multi-rename and attribute jobs are the commander's (main checks the caller's profile). */
  "jobs.start": {
    params: JobStartParams | ArchiveJobParams | CompareJobParams | RenameJobParams | RemoteJobParams
    result: JobSnapshot
  }
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
  /** Stage 12 (ADR-0035): opens an edit session; main adds the calling window as `owner`. */
  "edit.open": { params: EditOpenParams; result: EditOpenResult }
  /** Electron main only: renders a frame into the cache's tmp folder (edit.render mints its token). */
  "edit.frame": { params: EditRenderParams; result: EditFrameResult }
  "edit.info": { params: EditSessionParams; result: EditInfoResult }
  "edit.estimate": { params: EditEstimateParams; result: EditEstimateResult }
  /** Electron main only: starts the save job; a "save as" path comes from main's dialog. */
  "edit.write": { params: EditWriteParams; result: EditWriteResult }
  "edit.close": { params: EditSessionParams; result: OkResult }
  /** The entry a finished save wrote, once it is indexed. */
  "edit.saved": { params: EditJobParams; result: EditSavedResult }
  /** Electron main only: where a save wrote (edit.reveal shows it). */
  "edit.savedPath": { params: EditJobParams; result: EditSavedPathResult }
  /** Electron main only: the session's file, so a "save as" dialog opens beside it. */
  "edit.source": { params: EditSessionParams; result: EditSavedPathResult }
  /** Stage 13: the color at a point of the rendered picture (eyedroppers). */
  "edit.probe": { params: EditProbeParams; result: EditProbeResult }
  /** Electron main only: small renderings of several edit lists (edit.thumbs mints their tokens). */
  "edit.thumbFrames": { params: EditThumbsParams; result: EditThumbFramesResult }
  /** Count colors: the exact number of distinct colors and the dominant palette. */
  "edit.colors": { params: EditColorsParams; result: EditColorsResult }
  /** Stage 15: red pupils in the rendered picture, for the red-eye tool's Auto. */
  "edit.eyes": { params: EditEyesParams; result: EditEyesResult }
  /** Stage 14: the font families text can be drawn with, by name. */
  "edit.fonts": { params: EditSessionParams; result: EditFontsResult }
  /** Electron main only: registers the picture its file dialog returned (asset.pick). */
  "edit.assetAdd": { params: EditAssetAddParams; result: EditAssetFile }
  /** Electron main only: forgets an asset (asset.release). */
  "edit.assetDrop": { params: AssetReleaseParams; result: OkResult }
  /** Electron main only (Stage 16, ADR-0036): what a batch would do; the folder is a path from main's dialog. */
  "edit.plan": { params: EditBatchParams; result: BatchPlanResult }
  /** Electron main only: starts the edit job (batch.start). */
  "edit.batch": { params: EditBatchParams; result: JobSnapshot }
  /** Sends the files a finished edit job created to the trash (never the originals); a batch is undone once. */
  "batch.undo": { params: JobIdParams; result: JobSnapshot }
  /** The built-in recipes, then the saved ones by name. */
  "recipe.list": { params: EmptyParams; result: RecipeListResult }
  "recipe.save": { params: RecipeSaveParams; result: RecipeSaveResult }
  "recipe.delete": { params: RecipeDeleteParams; result: OkResult }
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
  /** Commander only (Stage 12): show the viewer and open its editor on this picture. */
  edit?: number
}

/** Methods answered by Electron main itself (never forwarded to Go). */
export interface MainMethodMap {
  /** Requests an orderly Electron app exit (sidecar shutdown remains main-owned). */
  "app.exit": { params: EmptyParams; result: OkResult }
  /** Shows the other app's view in the same window (ADR-0031). */
  "app.switch": { params: AppSwitchParams; result: OkResult }
  /** Both apps (Stage P06): the product's version and what it runs on. */
  "app.about": { params: EmptyParams; result: AboutInfo }
  /** Both apps: opens the log folder, the licence notices or a page of the project; never a renderer's URL. */
  "app.openTarget": { params: AppOpenTargetParams; result: OkResult }
  /** Both apps (ADR-0038): the update state; changes arrive as update.state events. */
  "update.get": { params: EmptyParams; result: UpdateState }
  /** Looks for a newer version now; the answer is the state the check started from. */
  "update.check": { params: EmptyParams; result: UpdateState }
  /** Downloads the version a check found ("auto" builds); progress arrives as events. */
  "update.download": { params: EmptyParams; result: UpdateState }
  /** Quits, installs the downloaded version and starts it. */
  "update.install": { params: EmptyParams; result: OkResult }
  "sidecar.getStatus": { params: EmptyParams; result: SidecarStatus }
  "dialog.openFolder": { params: EmptyParams; result: OpenFolderDialogResult }
  /** Resolves through the sidecar and mints a panelyth-media token. */
  "media.open": { params: MediaOpenParams; result: MediaOpenResult }
  /** Both apps (ADR-0033): an image or video in a frameless full-screen window. */
  "media.openWindow": { params: MediaWindowOpenParams; result: OkResult }
  /** Both apps (ADR-0039): Settings in a native window that blocks the shell window. */
  "settings.openWindow": { params: SettingsWindowOpenParams; result: OkResult }
  /** The settings window closes itself, optionally handing the shortcuts to its app view. */
  "settings.closeWindow": { params: SettingsWindowCloseParams; result: OkResult }
  /** The media window (commander profile): the next, previous or first item, asked of the opener. */
  "media.windowStep": { params: MediaWindowStepParams; result: MediaWindowStepResult }
  /** The opener's answer to a mediaWindow.step event (both apps). */
  "media.windowAnswer": { params: MediaWindowAnswerParams; result: OkResult }
  /**
   * The media window of a file opened from the OS (commander profile): show
   * its picture in the viewer, at its folder. The window closes.
   */
  "media.windowReveal": { params: EmptyParams; result: OkResult }
  /** Viewer, once at start: the folder and entry the app was started to show, if any. */
  "app.openRequest": { params: EmptyParams; result: OpenRequestResult }
  /** Home, Desktop, Documents, Downloads, Pictures, Videos (those that exist). */
  "places.list": { params: EmptyParams; result: PlacesResult }
  /** Opens a file or folder with the system default application (kinds per app profile). */
  "shell.open": { params: ShellOpenParams; result: OkResult }
  /** Commander (Stage C05): a read-only token URL for any file (lister, quick view). */
  "file.open": { params: MediaOpenParams; result: FileOpenResult }
  /** Commander (ADR-0033): opens a PDF or text file in a document window. */
  "document.open": { params: DocumentOpenParams; result: OkResult }
  /** Commander (Stage C05, F4): opens a file in the editor from settings, else the OS text editor. */
  "shell.edit": { params: EntryParams; result: OkResult }
  /** Commander (Stage C10): runs a typed command through the OS shell in a panel's folder. */
  "shell.run": { params: ShellRunParams; result: OkResult }
  /** Commander (Stage C10): runs a user command from commander.tools on the panel's entries. */
  "shell.runTool": { params: ShellRunToolParams; result: OkResult }
  /** Shows an indexed entry in the system file manager. */
  "shell.reveal": { params: EntryParams; result: OkResult }
  /** Shows a folder from the sidebar or breadcrumb in the system file manager. */
  "shell.revealPath": { params: RevealPathParams; result: OkResult }
  /** Copies the selection's full paths, one per line (resolved in Go, never sent to the renderer). */
  "clipboard.copyPaths": { params: CopyPathsParams; result: CopyPathsResult }
  "clipboard.copyText": { params: CopyTextParams; result: OkResult }
  /** Puts an indexed image on the OS clipboard as a picture (decoded in Go). */
  "clipboard.copyImage": { params: EntryParams; result: CopyImageResult }
  /** Viewer (Stage 12): a frame of the edit session as a one-shot token URL. */
  "edit.render": { params: EditRenderParams; result: EditRenderResult }
  /** Viewer: starts a save; "save as" opens the native dialog here, so no path comes from a renderer. */
  "edit.save": { params: EditSaveParams; result: EditSaveResult }
  /** Viewer: shows a finished save in the system file manager. */
  "edit.reveal": { params: EditJobParams; result: OkResult }
  /** Viewer (Stage 13): preset thumbnails as token URLs, a batch at a time. */
  "edit.thumbs": { params: EditThumbsParams; result: EditThumbsResult }
  /**
   * Viewer (Stage 14): picks a picture for a watermark, a mask or a texture in the native dialog.
   * The renderer gets an id and a thumbnail token, never the path.
   */
  "asset.pick": { params: AssetPickParams; result: AssetPickResult }
  "asset.release": { params: AssetReleaseParams; result: OkResult }
  /**
   * Viewer (Stage 16): the folder a batch writes into, picked in the native dialog.
   * The renderer gets a handle and the folder's name.
   */
  "batch.pickFolder": { params: EmptyParams; result: BatchPickFolderResult }
  /** Viewer: what a batch would do (counts, names, warnings, samples); main puts the folder's path in. */
  "batch.plan": { params: BatchParams; result: BatchPlanResult }
  /** Viewer: starts the batch as a job. */
  "batch.start": { params: BatchParams; result: JobSnapshot }
  /**
   * Commander (Stage C10.5): saves a connection. A password is encrypted here
   * with the system's secret store; without one, it is refused (noSecureStore).
   */
  "remote.saveConnection": { params: SaveConnectionParams; result: SavedConnection }
  /** Commander: connects; a saved connection's stored password is decrypted here for this call. */
  "remote.connect": { params: RemoteConnectParams; result: RemoteConnectResult }
  /** Commander: whether passwords can be saved on this computer. */
  "remote.secureStore": { params: EmptyParams; result: SecureStoreResult }
}

export type MethodMap = SidecarMethodMap & MainMethodMap
export type Method = keyof MethodMap
export type Params<M extends Method> = MethodMap[M]["params"]
export type Result<M extends Method> = MethodMap[M]["result"]

/** The viewer's app view (ADR-0027): main rejects everything else from it. */
export const VIEWER_METHODS = [
  "app.exit",
  "app.switch",
  "app.about",
  "app.openTarget",
  "update.get",
  "update.check",
  "update.download",
  "update.install",
  "app.openRequest",
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
  "media.openWindow",
  "settings.openWindow",
  "settings.closeWindow",
  "media.windowAnswer",
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
  // Stage 12: the image editor (ADR-0035); the commander's profile has none of these.
  "edit.open",
  "edit.render",
  "edit.info",
  "edit.estimate",
  "edit.save",
  "edit.close",
  "edit.saved",
  "edit.reveal",
  // Stage 13: eyedroppers, preset thumbnails, Count colors.
  "edit.probe",
  "edit.thumbs",
  "edit.colors",
  // Stage 14: fonts by name, and pictures picked through main's dialog.
  "edit.fonts",
  "asset.pick",
  "asset.release",
  // Stage 15: Auto of the red-eye tool.
  "edit.eyes",
  // Stage 16: batch mode (ADR-0036).
  "batch.pickFolder",
  "batch.plan",
  "batch.start",
  "batch.undo",
  "recipe.list",
  "recipe.save",
  "recipe.delete",
] as const

/** Methods only the commander's profile has (ADR-0027): any file's bytes, the editor, new files, commands. */
export const COMMANDER_ONLY_METHODS = [
  "file.open",
  "document.open",
  "media.windowStep",
  "media.windowReveal",
  "shell.edit",
  "fs.mkfile",
  "find.start",
  "find.cancel",
  "dir.openContaining",
  "archive.open",
  "archive.close",
  "archive.check",
  "archive.tools",
  "compare.dirs",
  "compare.cancel",
  "compare.close",
  "compare.show",
  "compare.setAction",
  "compare.plan",
  "compare.marks",
  "diff.open",
  "diff.page",
  "diff.close",
  "rename.preview",
  "rename.undoInfo",
  "shell.run",
  "shell.runTool",
  // Stage C10.5: connections (ADR-0037). remote.storeConnection, remote.dial
  // and remote.secret are main's alone and are not listed.
  "remote.connections",
  "remote.saveConnection",
  "remote.removeConnection",
  "remote.trust",
  "remote.connect",
  "remote.cancel",
  "remote.disconnect",
  "remote.open",
  "remote.mkdir",
  "remote.rename",
  "remote.secureStore",
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
  "app.about",
  "app.openTarget",
  "update.get",
  "update.check",
  "update.download",
  "update.install",
  "system.ping",
  "system.info",
  "sidecar.getStatus",
  "library.get",
  "library.setSetting",
  // Stage C10.5: the folder tree lists one level of subfolders at a time.
  "fs.listDirs",
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
  "media.openWindow",
  "settings.openWindow",
  "settings.closeWindow",
  "media.windowStep",
  "media.windowAnswer",
  "media.windowReveal",
  "preview.ensure",
  "props.get",
  "file.open",
  "document.open",
  "shell.open",
  "shell.edit",
  "fs.mkfile",
  // Stage C06: find files, "Go to file".
  "find.start",
  "find.cancel",
  "dir.openContaining",
  // Stage C07: archives as folders; pack, unpack and test are jobs.
  "archive.open",
  "archive.close",
  "archive.check",
  "archive.tools",
  // Stage C08: compare and synchronize directories, the text diff; sync,
  // checksum and compare-by-content jobs go through jobs.start.
  "compare.dirs",
  "compare.cancel",
  "compare.close",
  "compare.show",
  "compare.setAction",
  "compare.plan",
  "compare.marks",
  "diff.open",
  "diff.page",
  "diff.close",
  // Stage C09: the multi-rename preview and its undo; multiRename,
  // undoRename and setAttributes jobs go through jobs.start.
  "rename.preview",
  "rename.undoInfo",
  // Stage C10: the command line and user commands (main runs them; ADR-0027).
  "shell.run",
  "shell.runTool",
  // Stage C10.5: connections to FTP servers (ADR-0037). Passwords pass
  // through main (saveConnection, connect); transfers go through jobs.start.
  "remote.connections",
  "remote.saveConnection",
  "remote.removeConnection",
  "remote.trust",
  "remote.connect",
  "remote.cancel",
  "remote.disconnect",
  "remote.open",
  "remote.mkdir",
  "remote.rename",
  "remote.secureStore",
] as const satisfies readonly RendererMethod[]

/** Each app view's allowlist. The viewer keeps the full list it always had, plus the C01 context methods. */
export const APP_METHODS: Record<AppId, readonly RendererMethod[]> = {
  viewer: VIEWER_METHODS,
  commander: COMMANDER_METHODS,
}

export const MAIN_METHODS = [
  "app.exit",
  "app.switch",
  "app.about",
  "app.openTarget",
  "update.get",
  "update.check",
  "update.download",
  "update.install",
  "app.openRequest",
  "sidecar.getStatus",
  "dialog.openFolder",
  "media.open",
  "media.openWindow",
  "settings.openWindow",
  "settings.closeWindow",
  "media.windowStep",
  "media.windowAnswer",
  "media.windowReveal",
  "file.open",
  "document.open",
  "places.list",
  "shell.open",
  "shell.edit",
  "shell.run",
  "shell.runTool",
  "shell.reveal",
  "shell.revealPath",
  "clipboard.copyPaths",
  "clipboard.copyText",
  "clipboard.copyImage",
  "edit.render",
  "edit.save",
  "edit.reveal",
  "edit.thumbs",
  "asset.pick",
  "asset.release",
  "batch.pickFolder",
  "batch.plan",
  "batch.start",
  "remote.saveConnection",
  "remote.connect",
  "remote.secureStore",
] as const satisfies readonly (keyof MainMethodMap)[]
