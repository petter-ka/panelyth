// Small runtime guards for untrusted input crossing a process boundary.
// Deliberately dependency-free; checks shape, not semantics.
import {
  BATCH_SKIP_REASONS,
  BATCH_WARNINGS,
  MAX_BATCH_SAMPLES,
  MAX_PLAN_NAMES,
  MAX_RECIPE_NAME_CHARS,
  RECIPE_PROBLEM_CODES,
  recipeProblem,
  type BatchPlanResult,
  type RecipeListResult,
  type RecipeSaveResult,
} from "./batch"
import { ERROR_CODES, type RpcErrorShape } from "./errors"
import {
  EDIT_INFO_GROUPS,
  SAVE_FORMATS,
  type EditAssetFile,
  type EditColorsResult,
  type EditEyesResult,
  type EditFontsResult,
  type EditEstimateResult,
  type EditFrameResult,
  type EditProbeResult,
  type EditThumbFramesResult,
  type EditHistogram,
  type EditInfoResult,
  type EditOpenResult,
  type EditSavedPathResult,
  type EditSavedResult,
  type EditWriteResult,
} from "./edit"
import type { CompareProgress, EventMap, FindProgress, IndexProgress } from "./events"
import {
  ARCHIVE_FORMATS,
  DIFF_ACTIONS,
  DIFF_STATES,
  ENTRY_KINDS,
  RENAME_STATUSES,
  JOB_ITEM_ERROR_CODES,
  JOB_KINDS,
  JOB_STATES,
  MAX_FOLDER_COVERS,
  MAX_LABEL,
  MAX_RATING,
  MAX_REMOTE_TRANSFERS,
  PREVIEW_PROFILES,
  REMOTE_TLS,
  type ClipState,
  type ConnectionSecretResult,
  type ConnectionsResult,
  type RemoteConnectResult,
  type RemoteOpenResult,
  type SavedConnection,
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
  type EntryFromPathResult,
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
  type CompareCancelResult,
  type CompareCloseResult,
  type CompareMarksResult,
  type ComparePlan,
  type CompareStartResult,
  type CompareView,
  type DiffInfo,
  type TextDiffOpenResult,
  type TextDiffPageResult,
  type TextDiffRow,
  type RenamePreviewResult,
  type RenamePreviewRow,
  type RenameUndoInfo,
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
const jobItemCodes: ReadonlySet<string> = new Set(JOB_ITEM_ERROR_CODES)
const diffStates: ReadonlySet<unknown> = new Set(DIFF_STATES)
const diffActions: ReadonlySet<unknown> = new Set(DIFF_ACTIONS)
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
const remoteTls: ReadonlySet<unknown> = new Set(REMOTE_TLS)
/** A saved connection as Go sends it: no secret, only whether one is stored. */
const isSavedConnection = (v: unknown): v is SavedConnection =>
  isRec(v) &&
  isCount(v.id) &&
  isStr(v.name) &&
  isStr(v.group) &&
  isStr(v.host) &&
  isInt(v.port) &&
  v.port >= 1 &&
  v.port <= 65535 &&
  remoteTls.has(v.tls) &&
  isStr(v.user) &&
  isStr(v.startPath) &&
  isStr(v.localPath) &&
  isBool(v.active) &&
  isStr(v.encoding) &&
  isInt(v.transfers) &&
  v.transfers >= 1 &&
  v.transfers <= MAX_REMOTE_TRANSFERS &&
  isStr(v.fingerprint) &&
  isBool(v.hasPassword) &&
  // Nothing that could be a secret rides along.
  !("secret" in v) &&
  !("password" in v)
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

/** [first row, rows] of a text diff's changed place. */
const isBlock = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && isCount(v[0]) && isCount(v[1])

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

const isDiffSide = (v: unknown): boolean =>
  v === null || (isRec(v) && isCount(v.sizeBytes) && isInt(v.modifiedMs))

/** A compare row has at least one side. */
export function isDiffInfo(v: unknown): v is DiffInfo {
  return (
    isRec(v) &&
    isStr(v.dir) &&
    diffStates.has(v.state) &&
    diffActions.has(v.action) &&
    isDiffSide(v.left) &&
    isDiffSide(v.right) &&
    (v.left !== null || v.right !== null)
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
    (v.diff === undefined || isDiffInfo(v.diff)) &&
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

const isAmount = (v: unknown): boolean => isRec(v) && isCount(v.files) && isCount(v.bytes)

export function isComparePlan(v: unknown): v is ComparePlan {
  return (
    isRec(v) &&
    isCount(v.version) &&
    isRec(v.counts) &&
    isCount(v.counts.copyRight) &&
    isCount(v.counts.copyLeft) &&
    isCount(v.counts.equal) &&
    isCount(v.counts.different) &&
    isCount(v.counts.delete) &&
    isAmount(v.copyRight) &&
    isAmount(v.copyLeft) &&
    isCount(v.deleteRight) &&
    isCount(v.deleteLeft) &&
    isCount(v.folders) &&
    isCount(v.overwriteNewer)
  )
}

const isCompareView = (v: unknown): v is CompareView =>
  isRec(v) && isQuerySnapshot(v) && isComparePlan(v.plan)

const textEncodings: ReadonlySet<unknown> = new Set([
  "",
  "utf-8",
  "utf-16le",
  "utf-16be",
  "windows-1252",
])
const isTextDiffFile = (v: unknown): boolean =>
  isRec(v) &&
  isStr(v.name) &&
  isCount(v.sizeBytes) &&
  isCount(v.lines) &&
  textEncodings.has(v.encoding)
const textDiffOps: ReadonlySet<unknown> = new Set(["equal", "changed", "removed", "added"])
/** [left from, left to, right from, right to] of a changed row. */
const isDiffSpans = (v: unknown): boolean => {
  if (!Array.isArray(v) || v.length !== 4 || !v.every(isCount)) return false
  const [leftFrom, leftTo, rightFrom, rightTo] = v as [number, number, number, number]
  return leftFrom <= leftTo && rightFrom <= rightTo
}
const isTextDiffRow = (v: unknown): v is TextDiffRow =>
  isRec(v) &&
  textDiffOps.has(v.op) &&
  isCount(v.l) &&
  isCount(v.r) &&
  isStr(v.left) &&
  (v.right === undefined || isStr(v.right)) &&
  (v.cut === undefined || isBool(v.cut)) &&
  (v.spans === undefined || isDiffSpans(v.spans))

const renameStatuses: ReadonlySet<unknown> = new Set(RENAME_STATUSES)
const isRenamePreviewRow = (v: unknown): v is RenamePreviewRow =>
  isRec(v) &&
  isInt(v.id) &&
  isStr(v.name) &&
  isStr(v.newName) &&
  renameStatuses.has(v.status) &&
  (v.reason === undefined || isStr(v.reason))

const saveFormats: ReadonlySet<unknown> = new Set(SAVE_FORMATS)
const infoGroups: ReadonlySet<unknown> = new Set(EDIT_INFO_GROUPS)
const isDpi = (v: unknown): boolean => isRec(v) && isNum(v.x) && isNum(v.y) && v.x >= 0 && v.y >= 0
const isBins = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length === 256 && v.every(isCount)

export function isEditHistogram(v: unknown): v is EditHistogram {
  return (
    isRec(v) &&
    isBins(v.lum) &&
    isBins(v.r) &&
    isBins(v.g) &&
    isBins(v.b) &&
    isCount(v.pixels) &&
    isCount(v.clipLow) &&
    isCount(v.clipHigh) &&
    isNum(v.mean)
  )
}

/** edit.frame from the sidecar: a frame file with its output size, or superseded. */
export function isEditFrameResult(v: unknown): v is EditFrameResult {
  if (!isRec(v) || !isCount(v.rev)) return false
  if (v.superseded === true) return v.frame === undefined
  const { frame: f, output: o } = v
  return (
    isRec(f) &&
    isStr(f.file) &&
    f.file.length > 0 &&
    isStr(f.mime) &&
    isCount(f.width) &&
    isCount(f.height) &&
    isRec(o) &&
    isCount(o.width) &&
    isCount(o.height) &&
    isDpi(o.dpi) &&
    (v.histogram === undefined || isEditHistogram(v.histogram)) &&
    (v.before === undefined || isEditHistogram(v.before))
  )
}

/** edit.assetAdd from the sidecar: the asset and its thumbnail file. */
export function isEditAssetFile(v: unknown): v is EditAssetFile {
  return (
    isRec(v) &&
    isStr(v.assetId) &&
    /^[0-9a-f]{32}$/.test(v.assetId) &&
    isStr(v.name) &&
    v.name.length > 0 &&
    v.name.length <= 255 &&
    isCount(v.width) &&
    isCount(v.height) &&
    isRec(v.thumb) &&
    isStr(v.thumb.file) &&
    v.thumb.file.length > 0 &&
    isCount(v.thumb.width) &&
    isCount(v.thumb.height)
  )
}

const isByte = (v: unknown): boolean => isCount(v) && (v as number) <= 255
const HEX_COLOR = /^#[0-9a-f]{6}$/

/** edit.thumbFrames from the sidecar: a file per list, or null. */
export function isEditThumbFramesResult(v: unknown): v is EditThumbFramesResult {
  return (
    isRec(v) &&
    Array.isArray(v.thumbs) &&
    v.thumbs.length <= 16 &&
    v.thumbs.every(
      (t) =>
        t === null ||
        (isRec(t) && isStr(t.file) && t.file.length > 0 && isCount(t.width) && isCount(t.height)),
    )
  )
}

const skipReasons: ReadonlySet<unknown> = new Set(BATCH_SKIP_REASONS)
const batchWarnings: ReadonlySet<unknown> = new Set(BATCH_WARNINGS)
const problemCodes: ReadonlySet<unknown> = new Set(RECIPE_PROBLEM_CODES)
const isFileName = (v: unknown): v is string =>
  isStr(v) && v.length > 0 && v.length <= 255 && !/[/\\]/.test(v)

/** edit.plan from the sidecar: counts, names without folders, and nothing that is a path. */
export function isBatchPlanResult(v: unknown): v is BatchPlanResult {
  return (
    isRec(v) &&
    isCount(v.count) &&
    Array.isArray(v.skipped) &&
    v.skipped.every((s) => isRec(s) && skipReasons.has(s.reason) && isCount(s.count)) &&
    Array.isArray(v.names) &&
    v.names.length <= MAX_PLAN_NAMES &&
    v.names.every(isFileName) &&
    isCount(v.bytes) &&
    isCount(v.estimateBytes) &&
    Array.isArray(v.warnings) &&
    v.warnings.every((w) => batchWarnings.has(w)) &&
    Array.isArray(v.problems) &&
    v.problems.every(
      (p) => isRec(p) && problemCodes.has(p.code) && isStr(p.op) && isStr(p.detail),
    ) &&
    Array.isArray(v.samples) &&
    v.samples.length <= MAX_BATCH_SAMPLES &&
    v.samples.every((s) => isRec(s) && isInt(s.id) && s.id > 0 && isFileName(s.name))
  )
}

/** recipe.list from the sidecar: every recipe passes the check a renderer's recipe has to pass. */
export function isRecipeListResult(v: unknown): v is RecipeListResult {
  return (
    isRec(v) &&
    Array.isArray(v.recipes) &&
    v.recipes.every(
      (r) =>
        isRec(r) &&
        isCount(r.id) &&
        isStr(r.builtin) &&
        isStr(r.name) &&
        r.name.length > 0 &&
        r.name.length <= MAX_RECIPE_NAME_CHARS &&
        recipeProblem(r.recipe) === null,
    )
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
  "compare.dirs": (v): v is CompareStartResult =>
    isRec(v) && isInt(v.compareId) && isQuerySnapshot(v),
  "compare.cancel": (v): v is CompareCancelResult => isRec(v) && isBool(v.cancelled),
  "compare.close": (v): v is CompareCloseResult => isRec(v) && isBool(v.closed),
  "compare.show": isCompareView,
  "compare.setAction": isCompareView,
  "compare.plan": isComparePlan,
  "compare.marks": (v): v is CompareMarksResult =>
    isRec(v) &&
    isSelectionDescriptor(v.left) &&
    isSelectionDescriptor(v.right) &&
    isCount(v.leftCount) &&
    isCount(v.rightCount),
  "diff.open": (v): v is TextDiffOpenResult =>
    isRec(v) &&
    isCount(v.diffId) &&
    (v.reason === "" || v.reason === "binary" || v.reason === "tooLarge") &&
    isTextDiffFile(v.left) &&
    isTextDiffFile(v.right) &&
    isCount(v.rows) &&
    isCount(v.changes) &&
    arrayOf(v.blocks, isBlock) &&
    isBool(v.identical),
  "diff.page": (v): v is TextDiffPageResult =>
    isRec(v) && isCount(v.offset) && arrayOf(v.rows, isTextDiffRow),
  "diff.close": isOk,
  "rename.preview": (v): v is RenamePreviewResult =>
    isRec(v) &&
    isCount(v.total) &&
    isCount(v.renamed) &&
    isCount(v.unchanged) &&
    isCount(v.invalid) &&
    isCount(v.conflicts) &&
    isInt(v.firstProblem) &&
    v.firstProblem >= -1 &&
    isCount(v.offset) &&
    arrayOf(v.rows, isRenamePreviewRow),
  "rename.undoInfo": (v): v is RenameUndoInfo =>
    isRec(v) && isCount(v.count) && isStr(v.dir) && isCount(v.finishedMs),
  "remote.connections": (v): v is ConnectionsResult =>
    isRec(v) &&
    Array.isArray(v.connections) &&
    v.connections.length <= 200 &&
    v.connections.every(isSavedConnection),
  "remote.storeConnection": isSavedConnection,
  "remote.removeConnection": isOk,
  "remote.secret": (v): v is ConnectionSecretResult => isRec(v) && isStr(v.secret),
  "remote.trust": isOk,
  "remote.dial": (v): v is RemoteConnectResult =>
    isRec(v) &&
    isInt(v.remoteId) &&
    v.remoteId > 0 &&
    isStr(v.host) &&
    isInt(v.port) &&
    isStr(v.user) &&
    isBool(v.encrypted) &&
    isRec(v.features) &&
    isBool(v.features.mlsd) &&
    isBool(v.features.resume) &&
    isBool(v.features.utf8) &&
    isStr(v.startPath) &&
    isStr(v.localPath),
  "remote.cancel": isOk,
  "remote.disconnect": isOk,
  "remote.open": (v): v is RemoteOpenResult =>
    isRec(v) &&
    isInt(v.remoteDirId) &&
    v.remoteDirId > 0 &&
    isStr(v.path) &&
    isStr(v.name) &&
    arrayOf(v.crumbs, isCrumb) &&
    isCount(v.rejected),
  "remote.mkdir": isOk,
  "remote.rename": isOk,
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
  "entry.fromPath": (v): v is EntryFromPathResult =>
    isRec(v) &&
    isInt(v.dirId) &&
    v.dirId > 0 &&
    isInt(v.entryId) &&
    v.entryId > 0 &&
    isStr(v.kind) &&
    entryKinds.has(v.kind) &&
    isBool(v.listed),
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
    (v.attrs === undefined || (isCount(v.attrs) && v.attrs < 64)) &&
    (v.permissions === null || (isCount(v.permissions) && v.permissions <= 0o777)) &&
    (v.linkTarget === null || isStr(v.linkTarget)) &&
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
  "edit.open": (v): v is EditOpenResult =>
    isRec(v) &&
    isStr(v.sessionId) &&
    v.sessionId.length > 0 &&
    isStr(v.name) &&
    isCount(v.width) &&
    isCount(v.height) &&
    (saveFormats.has(v.format) || v.format === "webp") &&
    isBool(v.hasAlpha) &&
    isDpi(v.dpi) &&
    (v.notice === undefined || v.notice === "bitDepth") &&
    saveFormats.has(v.saveFormat) &&
    isBool(v.canReplace),
  "edit.frame": isEditFrameResult,
  "edit.info": (v): v is EditInfoResult =>
    isRec(v) &&
    Array.isArray(v.groups) &&
    v.groups.every(
      (g) =>
        isRec(g) &&
        infoGroups.has(g.name) &&
        Array.isArray(g.items) &&
        g.items.every(
          (i) =>
            isRec(i) && isStr(i.id) && isStr(i.value) && (i.code === undefined || isStr(i.code)),
        ),
    ),
  "edit.estimate": (v): v is EditEstimateResult => isRec(v) && isCount(v.bytes),
  "edit.write": (v): v is EditWriteResult => isRec(v) && isInt(v.jobId) && isStr(v.name),
  "edit.close": isOk,
  "edit.saved": (v): v is EditSavedResult => isRec(v) && isCount(v.entryId) && isStr(v.name),
  "edit.savedPath": (v): v is EditSavedPathResult => isRec(v) && isStr(v.path) && v.path.length > 0,
  "edit.source": (v): v is EditSavedPathResult => isRec(v) && isStr(v.path) && v.path.length > 0,
  "edit.probe": (v): v is EditProbeResult =>
    isRec(v) &&
    Array.isArray(v.rgba) &&
    v.rgba.length === 4 &&
    v.rgba.every(isByte) &&
    isStr(v.hex) &&
    HEX_COLOR.test(v.hex),
  "edit.thumbFrames": isEditThumbFramesResult,
  "edit.fonts": (v): v is EditFontsResult =>
    isRec(v) &&
    Array.isArray(v.families) &&
    v.families.length <= 10_000 &&
    v.families.every((f) => isStr(f) && f.length > 0 && f.length <= 128),
  "edit.eyes": (v): v is EditEyesResult =>
    isRec(v) &&
    Array.isArray(v.eyes) &&
    v.eyes.length <= 32 &&
    v.eyes.every(
      (e) => isRec(e) && isNum(e.x) && isNum(e.y) && isNum(e.w) && isNum(e.h) && e.w > 0 && e.h > 0,
    ),
  "edit.assetAdd": isEditAssetFile,
  "edit.assetDrop": isOk,
  "edit.plan": isBatchPlanResult,
  "edit.batch": isJobSnapshot,
  "batch.undo": isJobSnapshot,
  "recipe.list": isRecipeListResult,
  "recipe.save": (v): v is RecipeSaveResult =>
    isRec(v) && isInt(v.id) && v.id > 0 && isStr(v.name) && v.name.length > 0,
  "recipe.delete": isOk,
  "edit.colors": (v): v is EditColorsResult =>
    isRec(v) &&
    isCount(v.distinct) &&
    isBool(v.hasAlpha) &&
    isCount(v.width) &&
    isCount(v.height) &&
    Array.isArray(v.palette) &&
    v.palette.length <= 32 &&
    v.palette.every(
      (s) =>
        isRec(s) &&
        isStr(s.hex) &&
        HEX_COLOR.test(s.hex) &&
        isNum(s.share) &&
        s.share >= 0 &&
        s.share <= 1,
    ),
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

export function isCompareProgress(v: unknown): v is CompareProgress {
  return (
    isRec(v) &&
    isInt(v.compareId) &&
    SCAN_STATES.includes(v.state) &&
    (v.phase === "listing" || v.phase === "content") &&
    isCount(v.dirs) &&
    isCount(v.entries) &&
    isCount(v.compared) &&
    isCount(v.bytes) &&
    isCount(v.errors) &&
    isCount(v.links) &&
    isCount(v.rows) &&
    isBool(v.truncated) &&
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
    isRec(v) && (v.app === "viewer" || v.app === "commander") && typeof v.visible === "boolean",
  "settings.changed": (v): v is EventMap["settings.changed"] =>
    isRec(v) && isStr(v.key) && v.key.startsWith("shared."),
  "volumes.changed": (v): v is EventMap["volumes.changed"] =>
    isRec(v) && Array.isArray(v.volumes) && v.volumes.length <= 256 && v.volumes.every(isVolume),
  "bookmarks.changed": (v): v is EventMap["bookmarks.changed"] =>
    isRec(v) &&
    Array.isArray(v.bookmarks) &&
    v.bookmarks.length <= 500 &&
    v.bookmarks.every(isBookmark),
  "connections.changed": (v): v is EventMap["connections.changed"] =>
    isRec(v) &&
    Array.isArray(v.connections) &&
    v.connections.length <= 200 &&
    v.connections.every(isSavedConnection),
  "find.progress": isFindProgress,
  "compare.progress": isCompareProgress,
  "mediaWindow.step": (v): v is EventMap["mediaWindow.step"] =>
    isRec(v) &&
    isInt(v.requestId) &&
    isInt(v.key) &&
    (v.direction === -1 || v.direction === 0 || v.direction === 1),
  "edit.request": (v): v is EventMap["edit.request"] =>
    isRec(v) && isInt(v.entryId) && v.entryId > 0,
  "open.request": (v): v is EventMap["open.request"] =>
    isRec(v) && isInt(v.dirId) && v.dirId > 0 && isInt(v.entryId) && v.entryId > 0,
}
