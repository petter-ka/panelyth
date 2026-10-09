// Small runtime guards for untrusted input crossing a process boundary.
// Deliberately dependency-free; checks shape, not semantics.
import { ERROR_CODES, type RpcErrorShape } from "./errors"
import type { EventMap, FindProgress, IndexProgress } from "./events"
import {
  ARCHIVE_FORMATS,
  ENTRY_KINDS,
  JOB_KINDS,
  JOB_STATES,
  MAX_FOLDER_COVERS,
  MAX_LABEL,
  MAX_RATING,
  PREVIEW_PROFILES,
  type ClipState,
  type EntryRenameResult,
  type FsCanTrashResult,
  type FsMkdirResult,
  type FsMkfileResult,
  type FileResolveResult,
  type JobCancelResult,
  type JobConflict,
  type JobErrorsResult,
  type JobItemError,
  type JobListResult,
  type JobSnapshot,
  type Tag,
  type TagsResult,
  type Bookmark,
  type Crumb,
  type DirChild,
  type EntryPathResult,
  type ClipboardImageResult,
  type LibraryState,
  type ListDirsResult,
  type OkResult,
  type Properties,
  type QueryFacets,
  type RecentFolder,
  type SelectionDescriptor,
  type SelectionInfo,
  type SelectionPathsResult,
  type Volume,
  type VolumesResult,
  type MediaResolveResult,
  type PreviewEnsureResult,
  type CoverSlot,
  type FolderCoverItem,
  type FolderCoversResult,
  type PreviewItem,
  type Thumb,
  type CancelScanResult,
  type FindCancelResult,
  type ArchiveCheckResult,
  type ArchiveCloseResult,
  type ArchiveOpenResult,
  type ArchiveToolsResult,
  type ArchiveWarning,
  type FindStartResult,
  type ContentItem,
  type DirOpenResult,
  type EchoResult,
  type PingResult,
  type QueryCloseResult,
  type QueryPageResult,
  type QuerySnapshot,
  type QueryIndexOfResult,
  type QueryLocateResult,
  type QueryMatchResult,
  type SharedContext,
  type ShutdownResult,
  type SidecarMethodMap,
  type SidecarStatus,
  type SystemInfo,
} from "./rpc"
import type { EventFrame, HelloFrame, InboundFrame, ResponseFrame } from "./wire"

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isInt = (v: unknown): v is number => Number.isSafeInteger(v)
const isStr = (v: unknown): v is string => typeof v === "string"
const isBool = (v: unknown): v is boolean => typeof v === "boolean"
const errorCodes: ReadonlySet<string> = new Set(ERROR_CODES)
const entryKinds: ReadonlySet<string> = new Set(ENTRY_KINDS)
const archiveFormats: ReadonlySet<unknown> = new Set(ARCHIVE_FORMATS)
const previewProfiles: ReadonlySet<string> = new Set(PREVIEW_PROFILES)
const scanStates: ReadonlySet<string> = new Set(["running", "completed", "cancelled", "failed"])
const volumeKinds: ReadonlySet<string> = new Set([
  "fixed",
  "removable",
  "network",
  "optical",
  "other",
])
const isCount = (v: unknown): v is number => isInt(v) && v >= 0
const isRating = (v: unknown): v is number => isInt(v) && v >= 0 && v <= MAX_RATING
const isLabel = (v: unknown): v is number => isInt(v) && v >= 0 && v <= MAX_LABEL
const jobKinds: ReadonlySet<string> = new Set(JOB_KINDS)
const jobStates: ReadonlySet<string> = new Set(JOB_STATES)
const jobItemCodes: ReadonlySet<string> = new Set([
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
])
const intOrNull = (v: unknown): boolean => v === null || isInt(v)
const arrayOf = <T>(v: unknown, item: (x: unknown) => x is T): v is T[] =>
  Array.isArray(v) && v.every(item)

const isCrumb = (v: unknown): v is Crumb => isRec(v) && isStr(v.name) && isStr(v.path)
const isDirChild = (v: unknown): v is DirChild =>
  isRec(v) && isStr(v.name) && isStr(v.path) && isBool(v.hasChildren)
const isVolume = (v: unknown): v is Volume =>
  isRec(v) &&
  isStr(v.path) &&
  isStr(v.label) &&
  isStr(v.kind) &&
  volumeKinds.has(v.kind) &&
  (v.freeBytes === undefined || isCount(v.freeBytes)) &&
  (v.totalBytes === undefined || isCount(v.totalBytes)) &&
  (v.notReady === undefined || isBool(v.notReady))
const isBookmark = (v: unknown): v is Bookmark =>
  isRec(v) && isInt(v.id) && isStr(v.path) && isStr(v.label) && isStr(v.group)
const isRecent = (v: unknown): v is RecentFolder =>
  isRec(v) && isStr(v.path) && isInt(v.lastOpenedAt)
const isOk = (v: unknown): v is OkResult => isRec(v) && isBool(v.ok)
const isTag = (v: unknown): v is Tag => isRec(v) && isInt(v.id) && isStr(v.name) && isCount(v.count)
const isJobItemError = (v: unknown): v is JobItemError =>
  isRec(v) && isStr(v.name) && isStr(v.code) && jobItemCodes.has(v.code) && isStr(v.message)
const isClipState = (v: unknown): v is ClipState =>
  isRec(v) && (v.mode === "" || v.mode === "copy" || v.mode === "cut") && isCount(v.count)

export function isJobSnapshot(v: unknown): v is JobSnapshot {
  return (
    isRec(v) &&
    isInt(v.jobId) &&
    isStr(v.kind) &&
    jobKinds.has(v.kind) &&
    isStr(v.state) &&
    jobStates.has(v.state) &&
    isCount(v.total) &&
    isCount(v.done) &&
    isCount(v.failed) &&
    isCount(v.skipped) &&
    isCount(v.bytesTotal) &&
    isCount(v.bytesDone) &&
    isStr(v.current) &&
    isStr(v.destination) &&
    isStr(v.error) &&
    isCount(v.startedMs) &&
    isCount(v.finishedMs) &&
    isCount(v.bytesPerSec) &&
    isCount(v.etaMs) &&
    (v.conflict === undefined || isJobConflict(v.conflict))
  )
}

const isConflictSide = (v: unknown): boolean =>
  isRec(v) && isCount(v.id) && isCount(v.size) && isInt(v.modifiedMs) && isBool(v.isDir)

export function isJobConflict(v: unknown): v is JobConflict {
  return isRec(v) && isStr(v.name) && isConflictSide(v.source) && isConflictSide(v.target)
}

const isRange = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && isCount(v[0]) && isCount(v[1]) && v[0] <= v[1]

export function isSelectionDescriptor(v: unknown): v is SelectionDescriptor {
  return (
    isRec(v) &&
    isInt(v.queryId) &&
    isInt(v.version) &&
    arrayOf(v.ranges, isRange) &&
    arrayOf(v.include, isInt) &&
    arrayOf(v.exclude, isInt)
  )
}

export function isRpcError(v: unknown): v is RpcErrorShape {
  return (
    isRec(v) && isStr(v.code) && errorCodes.has(v.code) && isStr(v.message) && isBool(v.retryable)
  )
}

export function isHelloFrame(v: unknown): v is HelloFrame {
  return (
    isRec(v) &&
    v.t === "hello" &&
    isNum(v.protocol) &&
    isNum(v.pid) &&
    isStr(v.version) &&
    isStr(v.goVersion) &&
    isStr(v.cacheRoot) &&
    isStr(v.configRoot) &&
    isStr(v.thumbnailRoot)
  )
}

export function isResponseFrame(v: unknown): v is ResponseFrame {
  if (!isRec(v) || v.t !== "res" || !isNum(v.id)) return false
  if (v.ok === true) return "r" in v
  return v.ok === false && isRpcError(v.e)
}

export function isEventFrame(v: unknown): v is EventFrame {
  return isRec(v) && v.t === "evt" && isStr(v.ch) && isNum(v.seq) && "p" in v
}

export function isInboundFrame(v: unknown): v is InboundFrame {
  return isResponseFrame(v) || isEventFrame(v) || isHelloFrame(v)
}

export function isQuerySnapshot(v: unknown): v is QuerySnapshot {
  return isRec(v) && isInt(v.queryId) && isInt(v.version) && isInt(v.total) && v.total >= 0
}

const THUMB_PREFIX = "panelyth-thumb://t/"

function isThumb(v: unknown): v is Thumb {
  return (
    isRec(v) &&
    isStr(v.url) &&
    v.url.startsWith(THUMB_PREFIX) &&
    isInt(v.width) &&
    isInt(v.height) &&
    v.width > 0 &&
    v.height > 0
  )
}

export function isContentItem(v: unknown): v is ContentItem {
  return (
    isRec(v) &&
    isInt(v.id) &&
    isStr(v.kind) &&
    entryKinds.has(v.kind) &&
    isStr(v.name) &&
    isStr(v.ext) &&
    isInt(v.sizeBytes) &&
    isInt(v.modifiedMs) &&
    isBool(v.favorite) &&
    isRating(v.rating) &&
    isLabel(v.label) &&
    (v.attrs === undefined || (isCount(v.attrs) && v.attrs < 64)) &&
    (v.dirSizeBytes === undefined || isCount(v.dirSizeBytes)) &&
    (v.dirPath === undefined || isStr(v.dirPath)) &&
    (v.thumb === null || isThumb(v.thumb))
  )
}

export function isPreviewItem(v: unknown): v is PreviewItem {
  if (!isRec(v) || !isInt(v.id) || !isStr(v.profile) || !previewProfiles.has(v.profile))
    return false
  if ("failed" in v) return isStr(v.failed) && errorCodes.has(v.failed) && !("url" in v)
  return isThumb(v)
}

function isCoverSlot(v: unknown): v is CoverSlot {
  if (!isRec(v)) return false
  if ("pending" in v) return v.pending === true && !("url" in v)
  if ("failed" in v) return isStr(v.failed) && errorCodes.has(v.failed) && !("url" in v)
  return isThumb(v)
}

export function isFolderCoverItem(v: unknown): v is FolderCoverItem {
  if (!isRec(v) || !isInt(v.dirId) || !isInt(v.slot) || v.slot < 0 || v.slot >= MAX_FOLDER_COVERS)
    return false
  if (!isStr(v.profile) || !previewProfiles.has(v.profile)) return false
  if ("failed" in v) return isStr(v.failed) && errorCodes.has(v.failed) && !("url" in v)
  return isThumb(v)
}

export function isIndexProgress(v: unknown): v is IndexProgress {
  return (
    isRec(v) &&
    isInt(v.scanId) &&
    isInt(v.dirId) &&
    isBool(v.recursive) &&
    isStr(v.state) &&
    scanStates.has(v.state) &&
    isInt(v.dirsListed) &&
    isInt(v.dirsPending) &&
    isInt(v.entries) &&
    isInt(v.skipped) &&
    isInt(v.errors) &&
    isInt(v.elapsedMs)
  )
}

type ResultGuards = {
  [M in keyof SidecarMethodMap]: (v: unknown) => v is SidecarMethodMap[M]["result"]
}

/** Result guards; used by contract tests against the Go golden fixtures. */
export const sidecarResultGuards: ResultGuards = {
  "system.ping": (v): v is PingResult => isRec(v) && v.pong === true && isNum(v.serverTimeNs),
  "system.info": (v): v is SystemInfo =>
    isRec(v) &&
    isStr(v.version) &&
    isStr(v.goVersion) &&
    isNum(v.pid) &&
    isNum(v.protocol) &&
    isNum(v.uptimeMs) &&
    isNum(v.goroutines) &&
    isNum(v.heapBytes) &&
    isNum(v.runtimeMemBytes) &&
    isNum(v.numCpu),
  "system.shutdown": (v): v is ShutdownResult => isRec(v) && isBool(v.accepted),
  "system.echo": (v): v is EchoResult => isRec(v) && isStr(v.payload),
  "dir.open": (v): v is DirOpenResult =>
    isRec(v) &&
    isInt(v.dirId) &&
    isStr(v.path) &&
    isStr(v.name) &&
    isInt(v.scanId) &&
    isBool(v.recursive) &&
    isBool(v.listedBefore) &&
    (v.lastListedAt === null || isInt(v.lastListedAt)) &&
    arrayOf(v.crumbs, isCrumb) &&
    v.crumbs.length > 0,
  "dir.openEntry": (v): v is DirOpenResult => sidecarResultGuards["dir.open"](v),
  "dir.cancelScan": (v): v is CancelScanResult => isRec(v) && isBool(v.cancelled),
  "dir.openContaining": (v): v is DirOpenResult => sidecarResultGuards["dir.open"](v),
  "find.start": (v): v is FindStartResult => isRec(v) && isInt(v.findId) && isQuerySnapshot(v),
  "find.cancel": (v): v is FindCancelResult => isRec(v) && isBool(v.cancelled),
  "archive.open": (v): v is ArchiveOpenResult =>
    isRec(v) &&
    isInt(v.archiveId) &&
    archiveFormats.has(v.format) &&
    isCount(v.entries) &&
    isCount(v.rejected) &&
    isCount(v.bytes) &&
    isCount(v.packedBytes),
  "archive.close": (v): v is ArchiveCloseResult => isRec(v) && isBool(v.closed),
  "archive.check": (v): v is ArchiveCheckResult =>
    isRec(v) &&
    isCount(v.files) &&
    isCount(v.bytes) &&
    isCount(v.packedBytes) &&
    isInt(v.freeBytes) &&
    v.freeBytes >= -1 &&
    arrayOf(v.warnings, (w): w is ArchiveWarning => w === "space" || w === "ratio") &&
    isBool(v.partial),
  "archive.tools": (v): v is ArchiveToolsResult => isRec(v) && isBool(v.sevenZip),
  "query.open": isQuerySnapshot,
  "query.page": (v): v is QueryPageResult =>
    isRec(v) &&
    isQuerySnapshot(v) &&
    isInt(v.offset) &&
    Array.isArray(v.items) &&
    v.items.every(isContentItem),
  "query.close": (v): v is QueryCloseResult => isRec(v) && isBool(v.closed),
  "query.indexOf": (v): v is QueryIndexOfResult =>
    isRec(v) && isInt(v.index) && v.index >= -1 && isInt(v.version),
  "context.publish": isOk,
  "context.get": (v): v is SharedContext =>
    isRec(v) &&
    isCount(v.version) &&
    (v.app === "" || v.app === "viewer" || v.app === "commander") &&
    isCount(v.dirId) &&
    isStr(v.path) &&
    intOrNull(v.focusId) &&
    isCount(v.selectionCount) &&
    isBool(v.selectionTooLarge),
  "query.locate": (v): v is QueryLocateResult =>
    isRec(v) && isInt(v.index) && v.index >= -1 && isInt(v.version),
  "query.match": (v): v is QueryMatchResult =>
    isRec(v) && isInt(v.version) && isCount(v.count) && arrayOf(v.ranges, isRange),
  "selection.fromContext": (v): v is SelectionDescriptor => isSelectionDescriptor(v),
  // Only images and videos are ever served (ADR-0026, ADR-0027).
  "media.resolve": (v): v is MediaResolveResult =>
    isRec(v) &&
    isStr(v.path) &&
    (v.kind === "image" || v.kind === "video") &&
    isStr(v.mime) &&
    isInt(v.sizeBytes) &&
    isInt(v.width) &&
    isInt(v.height) &&
    isBool(v.original) &&
    isInt(v.durationMs) &&
    v.durationMs >= 0 &&
    isStr(v.videoCodec) &&
    isStr(v.audioCodec),
  "preview.ensure": (v): v is PreviewEnsureResult =>
    isRec(v) &&
    Array.isArray(v.items) &&
    v.items.every(isPreviewItem) &&
    isInt(v.queued) &&
    isInt(v.deferred),
  "folder.covers": (v): v is FolderCoversResult =>
    isRec(v) &&
    arrayOf(
      v.items,
      (c): c is FolderCoversResult["items"][number] =>
        isRec(c) &&
        isInt(c.dirId) &&
        Array.isArray(c.slots) &&
        c.slots.length <= MAX_FOLDER_COVERS &&
        c.slots.every(isCoverSlot),
    ),
  "query.facets": (v): v is QueryFacets =>
    isRec(v) &&
    isCount(v.folders) &&
    isCount(v.images) &&
    isCount(v.videos) &&
    (v.files === undefined || isCount(v.files)) &&
    arrayOf(
      v.exts,
      (e): e is { ext: string; count: number } => isRec(e) && isStr(e.ext) && isCount(e.count),
    ),
  "selection.info": (v): v is SelectionInfo =>
    isRec(v) &&
    isCount(v.count) &&
    isCount(v.bytes) &&
    isCount(v.folders) &&
    isCount(v.images) &&
    isCount(v.videos),
  "selection.rebase": isSelectionDescriptor,
  "selection.paths": (v): v is SelectionPathsResult =>
    isRec(v) && arrayOf(v.paths, isStr) && isBool(v.truncated),
  "entry.path": (v): v is EntryPathResult =>
    isRec(v) && isStr(v.path) && isStr(v.kind) && entryKinds.has(v.kind) && isBool(v.program),
  "file.resolve": (v): v is FileResolveResult =>
    isRec(v) &&
    isStr(v.path) &&
    isStr(v.kind) &&
    entryKinds.has(v.kind) &&
    isStr(v.mime) &&
    isCount(v.sizeBytes),
  "clipboard.image": (v): v is ClipboardImageResult =>
    isRec(v) && isStr(v.file) && isCount(v.width) && isCount(v.height),
  "props.get": (v): v is Properties =>
    isRec(v) &&
    isInt(v.id) &&
    isStr(v.kind) &&
    entryKinds.has(v.kind) &&
    isStr(v.name) &&
    isStr(v.ext) &&
    isStr(v.path) &&
    isBool(v.exists) &&
    isCount(v.sizeBytes) &&
    isInt(v.modifiedMs) &&
    intOrNull(v.createdMs) &&
    intOrNull(v.accessedMs) &&
    intOrNull(v.width) &&
    intOrNull(v.height) &&
    intOrNull(v.childFolders) &&
    intOrNull(v.childMedia) &&
    isBool(v.favorite) &&
    isRating(v.rating) &&
    isLabel(v.label) &&
    arrayOf(v.tags, isStr),
  "fs.volumes": (v): v is VolumesResult => isRec(v) && arrayOf(v.volumes, isVolume),
  "fs.mkdir": (v): v is FsMkdirResult => isRec(v) && isInt(v.entryId) && isBool(v.created),
  "fs.mkfile": (v): v is FsMkfileResult => isRec(v) && isInt(v.entryId) && isBool(v.created),
  "fs.canTrash": (v): v is FsCanTrashResult => isRec(v) && isBool(v.trash),
  "fs.listDirs": (v): v is ListDirsResult =>
    isRec(v) && isStr(v.path) && arrayOf(v.dirs, isDirChild) && isBool(v.truncated),
  "library.get": (v): v is LibraryState =>
    isRec(v) &&
    isRec(v.settings) &&
    arrayOf(v.bookmarks, isBookmark) &&
    arrayOf(v.recent, isRecent),
  "library.setSetting": isOk,
  "library.addBookmark": isBookmark,
  "library.updateBookmark": isBookmark,
  "library.reorderBookmarks": isOk,
  "library.removeBookmark": isOk,
  "jobs.start": isJobSnapshot,
  "jobs.cancel": (v): v is JobCancelResult => isRec(v) && isBool(v.cancelled),
  "jobs.errors": (v): v is JobErrorsResult =>
    isRec(v) && arrayOf(v.errors, isJobItemError) && isCount(v.total),
  "jobs.list": (v): v is JobListResult => isRec(v) && arrayOf(v.jobs, isJobSnapshot),
  "jobs.pause": isOk,
  "jobs.resume": isOk,
  "jobs.startNow": isOk,
  "jobs.resolve": isOk,
  "clip.set": isClipState,
  "clip.get": isClipState,
  "clip.paste": isJobSnapshot,
  "entry.rename": (v): v is EntryRenameResult => isRec(v) && isStr(v.name) && v.name.length > 0,
  "library.tags": (v): v is TagsResult => isRec(v) && arrayOf(v.tags, isTag),
  "library.deleteTag": isOk,
}

type EventGuards = { [C in keyof EventMap]: (v: unknown) => v is EventMap[C] }

const SCAN_STATES: readonly unknown[] = ["running", "completed", "cancelled", "failed"]

export function isFindProgress(v: unknown): v is FindProgress {
  return (
    isRec(v) &&
    isInt(v.findId) &&
    SCAN_STATES.includes(v.state) &&
    isInt(v.dirs) &&
    isInt(v.entries) &&
    isInt(v.searched) &&
    isInt(v.bytes) &&
    isInt(v.errors) &&
    isStr(v.current) &&
    isInt(v.matches) &&
    isBool(v.truncated) &&
    isInt(v.firstMatchMs) &&
    isInt(v.elapsedMs)
  )
}

export const eventGuards: EventGuards = {
  "sidecar.status": (v): v is SidecarStatus =>
    isRec(v) && isStr(v.state) && isNum(v.restarts) && isNum(v.since),
  "index.progress": isIndexProgress,
  "query.invalidated": isQuerySnapshot,
  "preview.ready": (v): v is EventMap["preview.ready"] =>
    isRec(v) && Array.isArray(v.items) && v.items.length <= 500 && v.items.every(isPreviewItem),
  "folder.covers": (v): v is EventMap["folder.covers"] =>
    isRec(v) && Array.isArray(v.items) && v.items.length <= 500 && v.items.every(isFolderCoverItem),
  "job.progress": isJobSnapshot,
  "job.conflict": (v): v is EventMap["job.conflict"] =>
    isRec(v) && isInt(v.jobId) && isJobConflict(v.conflict),
  "app.visibility": (v): v is EventMap["app.visibility"] =>
    isRec(v) &&
    (v.app === "viewer" || v.app === "commander") &&
    typeof v.visible === "boolean" &&
    (v.openMedia === undefined || typeof v.openMedia === "boolean"),
  "app.mediaLaunch": (v): v is EventMap["app.mediaLaunch"] =>
    isRec(v) && isInt(v.requestId) && v.requestId > 0,
  "settings.changed": (v): v is EventMap["settings.changed"] =>
    isRec(v) && isStr(v.key) && v.key.startsWith("shared."),
  "volumes.changed": (v): v is EventMap["volumes.changed"] =>
    isRec(v) && Array.isArray(v.volumes) && v.volumes.length <= 256 && v.volumes.every(isVolume),
  "bookmarks.changed": (v): v is EventMap["bookmarks.changed"] =>
    isRec(v) &&
    Array.isArray(v.bookmarks) &&
    v.bookmarks.length <= 500 &&
    v.bookmarks.every(isBookmark),
  "find.progress": isFindProgress,
}
