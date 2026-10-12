import { isAbsolute } from "node:path"
import {
  BATCH_FOLDER_ID,
  MAX_RECIPE_NAME_CHARS,
  recipeProblem,
  CONFLICT_DECISIONS,
  isContentItem,
  CONFLICT_POLICIES,
  MAX_MKDIR_PATH_CHARS,
  ENTRY_KINDS,
  MAX_COPY_TEXT_CHARS,
  MAX_JOB_ERRORS_PAGE,
  MAX_NAME_CHARS,
  MAX_LABEL,
  MAX_RATING,
  MAX_RENAME_PATTERN_CHARS,
  MAX_RENAME_START,
  MAX_TAG_CHARS,
  MAX_TAG_FILTERS,
  MAX_ENSURE_ITEMS,
  MAX_COVER_DIRS,
  MAX_EXTS,
  MAX_PAGE_SIZE,
  MAX_SEARCH_CHARS,
  MAX_SELECTION_IDS,
  MAX_SELECTION_RANGES,
  MAX_SETTING_JSON_CHARS,
  MAX_SETTING_KEY_CHARS,
  PREVIEW_PROFILES,
  SORT_FIELDS,
  QUERY_SCOPES,
  MAX_NAME_MASK_CHARS,
  FIND_ATTR_BITS,
  FIND_ENCODINGS,
  ARCHIVE_CREATE_FORMATS,
  COMPARE_SHOW,
  DIFF_ACTIONS,
  HASH_ALGORITHMS,
  MAX_COMPARE_TOLERANCE_MS,
  MAX_TEXT_DIFF_PAGE,
  MAX_ATTR_TIME_MS,
  MAX_RENAME_DIGITS,
  MAX_RENAME_MASK_BYTES,
  MAX_RENAME_PREVIEW_PAGE,
  MAX_RENAME_STEP,
  MIN_ATTR_TIME_MS,
  RENAME_CASES,
  SETTABLE_ATTRS,
  MAX_FIND_ROOTS,
  MAX_FIND_TEXT_CHARS,
  MAX_COMMAND_CHARS,
  isCommandText,
  EDIT_QUALITIES,
  MAX_DPI,
  MAX_EDIT_EDGE,
  MAX_JPEG_QUALITY,
  METADATA_POLICIES,
  SAVE_FORMATS,
  SAVE_TARGETS,
  ASSET_ID,
  COLOR_SCOPES,
  MAX_EDIT_THUMBS,
  MAX_SWATCHES,
  MAX_THUMB_EDGE,
  editListProblem,
  FINGERPRINT_HEX_CHARS,
  MAX_CONNECTION_NAME_CHARS,
  MAX_REMOTE_ENCODING_CHARS,
  MAX_REMOTE_HOST_CHARS,
  MAX_REMOTE_NAME_CHARS,
  MAX_REMOTE_PASSWORD_BYTES,
  MAX_REMOTE_PATH_CHARS,
  MAX_REMOTE_TRANSFERS,
  REMOTE_TLS,
  APP_TARGETS,
  type RendererMethod,
} from "@panelyth/contracts"

/** Returns null when params are valid, otherwise a reason. */
type Validator = (params: unknown) => string | null

type Obj = Record<string, unknown>

const isPlainObject = (v: unknown): v is Obj =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype

const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0

/** Object with exactly these keys (renderer input is never trusted). */
function shape(p: unknown, keys: readonly string[]): p is Obj {
  if (!isPlainObject(p)) return false
  const actual = Object.keys(p)
  return actual.length === keys.length && keys.every((k) => k in p)
}

/** Like shape, plus keys that may be absent. */
function shapeWithOptional(
  p: unknown,
  keys: readonly string[],
  optional: readonly string[],
): p is Obj {
  if (!isPlainObject(p) || !keys.every((k) => k in p)) return false
  return Object.keys(p).every((k) => keys.includes(k) || optional.includes(k))
}

const empty: Validator = (p) =>
  p === undefined || (isPlainObject(p) && Object.keys(p).length === 0) ? null : "expected no params"

const MAX_ECHO_CHARS = 1024 * 1024
const MAX_BOOKMARKS = 500 // library.MaxBookmarks
const MAX_GROUP_CHARS = 128 // library.MaxGroupLen (bytes; checked again in Go)
const isGroup = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_GROUP_CHARS
const MAX_PATH_CHARS = 32_767 // Windows extended-length limit
const sortFields: ReadonlySet<unknown> = new Set(SORT_FIELDS)
const kinds: ReadonlySet<unknown> = new Set(ENTRY_KINDS)
const scopes: ReadonlySet<unknown> = new Set(QUERY_SCOPES)
const profiles: ReadonlySet<unknown> = new Set(PREVIEW_PROFILES)
const EXT = /^[a-z0-9]{1,10}$/

function pathProblem(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_CHARS)
    return "invalid path"
  if (path.includes("\0")) return "invalid path"
  return isAbsolute(path) ? null : "path must be absolute"
}

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

function selectionProblem(sel: unknown): string | null {
  if (!shape(sel, ["queryId", "version", "ranges", "include", "exclude"]))
    return "expected { queryId, version, ranges, include, exclude }"
  if (!isId(sel.queryId) || !isId(sel.version)) return "invalid queryId or version"
  if (!Array.isArray(sel.ranges) || sel.ranges.length > MAX_SELECTION_RANGES)
    return "invalid ranges"
  for (const r of sel.ranges) {
    if (!Array.isArray(r) || r.length !== 2 || !isCount(r[0]) || !isCount(r[1]) || r[0] > r[1])
      return "ranges must be [start, end) pairs"
  }
  for (const k of ["include", "exclude"] as const) {
    const ids = sel[k]
    if (!Array.isArray(ids) || ids.length > MAX_SELECTION_IDS || !ids.every(isId))
      return `invalid ${k}`
  }
  return null
}

const conflicts: ReadonlySet<unknown> = new Set(CONFLICT_POLICIES)
const MAX_MASK_CHARS = 256 // index.MaxMaskLen

/** Exactly one destination: an absolute path or a folder id (Stage C04). */
function destinationProblem(p: Record<string, unknown>): string | null {
  const byPath = p.destination !== undefined
  const byId = p.destinationDirId !== undefined
  if (byPath === byId) return "expected destination or destinationDirId"
  return byId
    ? isId(p.destinationDirId)
      ? null
      : "invalid destinationDirId"
    : pathProblem(p.destination)
}
const decisions: ReadonlySet<unknown> = new Set(CONFLICT_DECISIONS)

/** A scan lane (Stage C06): the caller's foreground slot, such as "left". */
const isLane = (v: unknown): boolean => typeof v === "string" && /^[a-z0-9-]{1,16}$/.test(v)

const findEncodings: ReadonlySet<unknown> = new Set(FIND_ENCODINGS)
const archiveCreateFormats: ReadonlySet<unknown> = new Set(ARCHIVE_CREATE_FORMATS)
const FIND_KEYS = [
  "roots",
  "mask",
  "depth",
  "hidden",
  "text",
  "caseSensitive",
  "wholeWords",
  "encodings",
  "skipBinary",
  "minSize",
  "maxSize",
  "modifiedAfter",
  "modifiedBefore",
  "attrsSet",
  "attrsClear",
] as const
const isBound = (v: unknown): boolean => v === null || isCount(v)

/** find.start (Stage C06): read-only, so typed folder paths are allowed, like dir.open. */
function findStartProblem(p: unknown): string | null {
  if (!shape(p, FIND_KEYS)) return `expected { ${FIND_KEYS.join(", ")} }`
  if (!Array.isArray(p.roots) || p.roots.length === 0 || p.roots.length > MAX_FIND_ROOTS)
    return "give 1 to 16 folders"
  for (const r of p.roots) {
    const problem = pathProblem(r)
    if (problem) return problem
  }
  if (typeof p.mask !== "string" || p.mask.length > MAX_MASK_CHARS) return "invalid mask"
  if (!Number.isSafeInteger(p.depth) || (p.depth as number) < -1) return "invalid depth"
  if (typeof p.text !== "string" || p.text.length > MAX_FIND_TEXT_CHARS * 2) return "invalid text"
  for (const k of ["hidden", "caseSensitive", "wholeWords", "skipBinary"] as const) {
    if (typeof p[k] !== "boolean") return `invalid ${k}`
  }
  if (
    !Array.isArray(p.encodings) ||
    p.encodings.length > FIND_ENCODINGS.length ||
    !p.encodings.every((e) => findEncodings.has(e))
  )
    return "invalid encodings"
  for (const k of ["minSize", "maxSize", "modifiedAfter", "modifiedBefore"] as const) {
    if (!isBound(p[k])) return `invalid ${k}`
  }
  for (const k of ["attrsSet", "attrsClear"] as const) {
    const v = p[k]
    if (!isCount(v) || ((v as number) & ~FIND_ATTR_BITS) !== 0) return `invalid ${k}`
  }
  return null
}
const hashAlgorithms: ReadonlySet<unknown> = new Set(HASH_ALGORITHMS)
const compareShow: ReadonlySet<unknown> = new Set(COMPARE_SHOW)
const diffActions: ReadonlySet<unknown> = new Set([...DIFF_ACTIONS, "default"])

/** The date rules of a compare (Stage C08). */
function compareOptionsProblem(p: Obj): string | null {
  if (!isCount(p.toleranceMs) || p.toleranceMs > MAX_COMPARE_TOLERANCE_MS)
    return `toleranceMs must be 0..${MAX_COMPARE_TOLERANCE_MS}`
  if (typeof p.dst !== "boolean" || typeof p.ignoreDates !== "boolean")
    return "invalid dst or ignoreDates"
  return null
}
const compareIdParams: Validator = (p) =>
  shape(p, ["compareId"]) && isId(p.compareId) ? null : "expected { compareId }"

const renameCases: ReadonlySet<unknown> = new Set(RENAME_CASES)
const RENAME_PLAN_KEYS = [
  "nameMask",
  "extMask",
  "search",
  "replace",
  "regex",
  "matchCase",
  "case",
  "start",
  "step",
  "digits",
]
const isMaskText = (v: unknown): boolean =>
  typeof v === "string" && v.length <= MAX_RENAME_MASK_BYTES && !v.includes("\0")
const intIn = (v: unknown, min: number, max: number): boolean =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max

/**
 * A multi-rename plan (Stage C09): shape and bounds. Whether the masks and
 * the expression compile is Go's to say (rename.preview reports the field).
 */
function renamePlanProblem(plan: unknown): string | null {
  if (!shape(plan, RENAME_PLAN_KEYS)) return `expected plan { ${RENAME_PLAN_KEYS.join(", ")} }`
  for (const k of ["nameMask", "extMask", "search", "replace"]) {
    if (!isMaskText(plan[k])) return `invalid ${k}`
  }
  if (typeof plan.regex !== "boolean" || typeof plan.matchCase !== "boolean")
    return "invalid regex or matchCase"
  if (!renameCases.has(plan.case)) return "invalid case"
  if (!intIn(plan.start, -MAX_RENAME_START, MAX_RENAME_START)) return "invalid start"
  if (!intIn(plan.step, -MAX_RENAME_STEP, MAX_RENAME_STEP)) return "invalid step"
  return intIn(plan.digits, 1, MAX_RENAME_DIGITS) ? null : "invalid digits"
}

/** setAttributes: bits to set and to clear never overlap; at least one change. */
function attributesProblem(p: Obj): string | null {
  const bits = (set: unknown, clear: unknown, all: number): boolean =>
    (set === undefined || intIn(set, 0, all)) &&
    (clear === undefined || intIn(clear, 0, all)) &&
    (((set as number | undefined) ?? 0) & ((clear as number | undefined) ?? 0)) === 0 &&
    ((((set as number | undefined) ?? 0) | ((clear as number | undefined) ?? 0)) & ~all) === 0
  if (!bits(p.setAttrs, p.clearAttrs, SETTABLE_ATTRS)) return "invalid setAttrs or clearAttrs"
  if (!bits(p.setMode, p.clearMode, 0o777)) return "invalid setMode or clearMode"
  for (const k of ["modifiedMs", "accessedMs"]) {
    if (p[k] !== undefined && !intIn(p[k], MIN_ATTR_TIME_MS, MAX_ATTR_TIME_MS))
      return `invalid ${k}`
  }
  if (p.recursive !== undefined && typeof p.recursive !== "boolean") return "invalid recursive"
  const changes =
    ((p.setAttrs as number | undefined) ?? 0) |
    ((p.clearAttrs as number | undefined) ?? 0) |
    ((p.setMode as number | undefined) ?? 0) |
    ((p.clearMode as number | undefined) ?? 0)
  return changes !== 0 || p.modifiedMs !== undefined || p.accessedMs !== undefined
    ? null
    : "nothing to change"
}

const jobIdParams: Validator = (p) =>
  shape(p, ["jobId"]) && isId(p.jobId) ? null : "expected { jobId }"
const isLabel = (v: unknown): boolean =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_LABEL
const isRating = (v: unknown): boolean =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_RATING
const isTagName = (v: unknown): boolean =>
  typeof v === "string" && v.trim().length > 0 && v.length <= MAX_TAG_CHARS
const isName = (v: unknown): boolean =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_NAME_CHARS && !v.includes("\0")

function sourceProblem(source: unknown): string | null {
  return shape(source, ["selection"])
    ? selectionProblem(source.selection)
    : "expected source { selection }"
}

/** jobs.start: one exact shape per kind (ADR-0021). */
function jobStartProblem(p: unknown): string | null {
  if (!isPlainObject(p) || typeof p.kind !== "string") return "expected { kind, source, ... }"
  switch (p.kind) {
    case "copy":
    case "move":
      // copyLinks is added by main from the caller's profile, never sent by a renderer.
      if (
        !shapeWithOptional(
          p,
          ["kind", "source", "conflict"],
          ["destination", "destinationDirId", "verify", "now", "mask", "name"],
        )
      )
        return "expected { kind, source, destination | destinationDirId, conflict, verify?, now?, mask?, name? }"
      if (!conflicts.has(p.conflict)) return "invalid conflict policy"
      if (p.verify !== undefined && typeof p.verify !== "boolean") return "invalid verify"
      if (p.now !== undefined && typeof p.now !== "boolean") return "invalid now"
      if (p.mask !== undefined && (typeof p.mask !== "string" || p.mask.length > MAX_MASK_CHARS))
        return "invalid mask"
      if (p.name !== undefined && !isName(p.name)) return "invalid name"
      return destinationProblem(p) ?? sourceProblem(p.source)
    // remoteDelete (Stage C10.5): the selection is of a remote session; Go refuses any other.
    case "trash":
    case "delete":
    case "dirSize":
    case "remoteDelete":
      return shape(p, ["kind", "source"]) ? sourceProblem(p.source) : "expected { kind, source }"
    case "download":
      // Into a local folder by its id, never a path.
      if (!shapeWithOptional(p, ["kind", "source", "destinationDirId", "conflict"], ["move"]))
        return "expected { kind, source, destinationDirId, conflict, move? }"
      if (!isId(p.destinationDirId)) return "invalid destinationDirId"
      if (!conflicts.has(p.conflict)) return "invalid conflict policy"
      if (p.move !== undefined && typeof p.move !== "boolean") return "invalid move"
      return sourceProblem(p.source)
    case "upload":
      // Into a folder of a connection by its id from remote.open.
      if (!shapeWithOptional(p, ["kind", "source", "remoteDirId", "conflict"], ["move"]))
        return "expected { kind, source, remoteDirId, conflict, move? }"
      if (!isId(p.remoteDirId)) return "invalid remoteDirId"
      if (!conflicts.has(p.conflict)) return "invalid conflict policy"
      if (p.move !== undefined && typeof p.move !== "boolean") return "invalid move"
      return sourceProblem(p.source)
    case "rename":
      if (!shape(p, ["kind", "source", "pattern", "start"]))
        return "expected { kind, source, pattern, start }"
      if (
        typeof p.pattern !== "string" ||
        p.pattern.length < 1 ||
        p.pattern.length > MAX_RENAME_PATTERN_CHARS
      )
        return "invalid pattern"
      if (!isCount(p.start) || p.start > MAX_RENAME_START) return "invalid start"
      return sourceProblem(p.source)
    case "extract":
      if (
        !shapeWithOptional(
          p,
          ["kind", "source", "destinationDirId", "conflict"],
          ["links", "subfolders"],
        )
      )
        return "expected { kind, source, destinationDirId, conflict, links?, subfolders? }"
      if (!conflicts.has(p.conflict)) return "invalid conflict policy"
      if (!isId(p.destinationDirId)) return "invalid destinationDirId"
      for (const k of ["links", "subfolders"] as const) {
        if (p[k] !== undefined && typeof p[k] !== "boolean") return `invalid ${k}`
      }
      return sourceProblem(p.source)
    case "pack":
      if (
        !shapeWithOptional(
          p,
          ["kind", "source", "destinationDirId", "conflict", "name", "format", "level"],
          ["deleteOriginals"],
        )
      )
        return "expected { kind, source, destinationDirId, conflict, name, format, level, deleteOriginals? }"
      if (!conflicts.has(p.conflict)) return "invalid conflict policy"
      if (!isId(p.destinationDirId)) return "invalid destinationDirId"
      if (!isName(p.name)) return "invalid name"
      if (!archiveCreateFormats.has(p.format)) return "invalid format"
      if (!Number.isSafeInteger(p.level) || (p.level as number) < 0 || (p.level as number) > 9)
        return "level must be 0..9"
      if (p.deleteOriginals !== undefined && typeof p.deleteOriginals !== "boolean")
        return "invalid deleteOriginals"
      return sourceProblem(p.source)
    case "testArchive":
    case "hashVerify":
      return shape(p, ["kind", "source"]) ? sourceProblem(p.source) : "expected { kind, source }"
    case "sync":
      // A sync has no source: it applies the plan of a compare held in Go.
      if (!shapeWithOptional(p, ["kind", "compareId", "planVersion"], ["deletePermanently"]))
        return "expected { kind, compareId, planVersion, deletePermanently? }"
      if (!isId(p.compareId) || !isId(p.planVersion)) return "invalid compareId or planVersion"
      return p.deletePermanently === undefined || typeof p.deletePermanently === "boolean"
        ? null
        : "invalid deletePermanently"
    case "hashCreate":
      if (
        !shapeWithOptional(
          p,
          ["kind", "source", "algorithm", "perFile"],
          ["destinationDirId", "name"],
        )
      )
        return "expected { kind, source, algorithm, perFile, destinationDirId?, name? }"
      if (!hashAlgorithms.has(p.algorithm)) return "invalid algorithm"
      if (typeof p.perFile !== "boolean") return "invalid perFile"
      // One list needs its folder and name; one file per file takes neither.
      if (p.perFile && (p.destinationDirId !== undefined || p.name !== undefined))
        return "perFile takes no destinationDirId or name"
      if (!p.perFile && (!isId(p.destinationDirId) || !isName(p.name)))
        return "a checksum list needs destinationDirId and name"
      return sourceProblem(p.source)
    case "compareFiles":
      // Two entries by id, or (Stage C10.5) a selection against a folder by its id.
      if ("source" in p) {
        return shape(p, ["kind", "source", "destinationDirId"]) && isId(p.destinationDirId)
          ? sourceProblem(p.source)
          : "expected { kind, source, destinationDirId }"
      }
      return shape(p, ["kind", "leftId", "rightId"]) && isId(p.leftId) && isId(p.rightId)
        ? null
        : "expected { kind, leftId, rightId }"
    case "multiRename":
      if (!shape(p, ["kind", "source", "plan"])) return "expected { kind, source, plan }"
      return renamePlanProblem(p.plan) ?? sourceProblem(p.source)
    case "undoRename":
      // An undo has no source: it takes back the journal Go keeps.
      return shape(p, ["kind"]) ? null : "expected { kind }"
    case "setAttributes":
      if (
        !shapeWithOptional(
          p,
          ["kind", "source"],
          [
            "setAttrs",
            "clearAttrs",
            "setMode",
            "clearMode",
            "modifiedMs",
            "accessedMs",
            "recursive",
          ],
        )
      )
        return "expected { kind, source, setAttrs?, clearAttrs?, setMode?, clearMode?, modifiedMs?, accessedMs?, recursive? }"
      return attributesProblem(p) ?? sourceProblem(p.source)
    case "favorite":
      if (!shape(p, ["kind", "source", "favorite"]) || typeof p.favorite !== "boolean")
        return "expected { kind, source, favorite }"
      return sourceProblem(p.source)
    case "rating":
      if (!shape(p, ["kind", "source", "rating"]) || !isRating(p.rating))
        return "expected { kind, source, rating: 0..5 }"
      return sourceProblem(p.source)
    case "label":
      if (!shape(p, ["kind", "source", "label"]) || !isLabel(p.label))
        return `expected { kind, source, label: 0..${MAX_LABEL} }`
      return sourceProblem(p.source)
    case "tag":
      if (!shape(p, ["kind", "source", "tag", "add"]) || typeof p.add !== "boolean")
        return "expected { kind, source, tag, add }"
      return isTagName(p.tag) ? sourceProblem(p.source) : "invalid tag"
  }
  return "unknown job kind"
}

const selectionParams: Validator = (p) =>
  shape(p, ["selection"]) ? selectionProblem(p.selection) : "expected { selection }"

const entryParams: Validator = (p) =>
  shape(p, ["entryId"]) && isId(p.entryId) ? null : "expected { entryId }"

// Connections (Stage C10.5, ADR-0037). A host and a path on a server are
// the only typed inputs; both are one line of text without control
// characters, so nothing typed can start another command on the wire.
const remoteTls: ReadonlySet<unknown> = new Set(REMOTE_TLS)

/** One line of text of at most `max` characters; `min` 0 allows "". */
const isLine = (v: unknown, max: number, min = 0): v is string =>
  typeof v === "string" &&
  v.length >= min &&
  v.length <= max &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f]/.test(v)

const isHost = (v: unknown): boolean =>
  isLine(v, MAX_REMOTE_HOST_CHARS, 1) && !/[\s/\\@]/.test(v as string)

const isPort = (v: unknown): boolean =>
  Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 65535

const isTransfers = (v: unknown): boolean =>
  Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= MAX_REMOTE_TRANSFERS

const isFingerprint = (v: unknown, allowEmpty: boolean): boolean =>
  typeof v === "string" &&
  ((allowEmpty && v === "") || (v.length === FINGERPRINT_HEX_CHARS && /^[0-9a-fA-F]+$/.test(v)))

/** A password: one line, bounded in UTF-8 bytes. Never logged, never echoed in a reason. */
const isPassword = (v: unknown): boolean =>
  typeof v === "string" &&
  Buffer.byteLength(v, "utf8") <= MAX_REMOTE_PASSWORD_BYTES &&
  // eslint-disable-next-line no-control-regex
  !/[\r\n\u0000]/.test(v)

function connectionProblem(c: unknown): string | null {
  const keys = [
    "id",
    "name",
    "group",
    "host",
    "port",
    "tls",
    "user",
    "startPath",
    "localPath",
    "active",
    "encoding",
    "transfers",
    "fingerprint",
    "hasPassword",
  ]
  if (!shape(c, keys)) return `expected connection { ${keys.join(", ")} }`
  if (!isCount(c.id)) return "invalid connection id"
  if (!isLine(c.name, MAX_CONNECTION_NAME_CHARS, 1) || (c.name as string).trim() === "")
    return "invalid connection name"
  if (!isLine(c.group, MAX_CONNECTION_NAME_CHARS)) return "invalid group"
  if (!isHost(c.host)) return "invalid host"
  if (!isPort(c.port)) return "invalid port"
  if (!remoteTls.has(c.tls)) return "invalid encryption"
  if (!isLine(c.user, MAX_CONNECTION_NAME_CHARS)) return "invalid user"
  if (
    !isLine(c.startPath, MAX_REMOTE_PATH_CHARS) ||
    (c.startPath !== "" && !c.startPath.startsWith("/"))
  )
    return "invalid startPath"
  if (!isLine(c.localPath, MAX_REMOTE_PATH_CHARS)) return "invalid localPath"
  if (typeof c.active !== "boolean" || typeof c.hasPassword !== "boolean") return "invalid flag"
  if (!isLine(c.encoding, MAX_REMOTE_ENCODING_CHARS)) return "invalid encoding"
  if (!isTransfers(c.transfers)) return "invalid transfers"
  if (!isFingerprint(c.fingerprint, true)) return "invalid fingerprint"
  return null
}

function quickProblem(q: unknown): string | null {
  const keys = ["host", "port", "tls", "user", "active", "encoding", "transfers"]
  if (!shape(q, keys)) return `expected quick { ${keys.join(", ")} }`
  if (!isHost(q.host)) return "invalid host"
  if (!isPort(q.port)) return "invalid port"
  if (!remoteTls.has(q.tls)) return "invalid encryption"
  if (!isLine(q.user, MAX_CONNECTION_NAME_CHARS)) return "invalid user"
  if (typeof q.active !== "boolean") return "invalid active"
  if (!isLine(q.encoding, MAX_REMOTE_ENCODING_CHARS)) return "invalid encoding"
  if (!isTransfers(q.transfers)) return "invalid transfers"
  return null
}

/** A name typed for a new folder or a rename on a server: one path element. */
const isRemoteName = (v: unknown): boolean =>
  isLine(v, MAX_REMOTE_NAME_CHARS, 1) &&
  !/[/\\]/.test(v as string) &&
  v !== "." &&
  v !== ".." &&
  (v as string).trim() !== ""

/** document.open and media.openWindow: an entry, the theme name and the language. */
const windowParams: Validator = (p) =>
  shapeWithOptional(p, ["entryId"], ["theme", "lang"]) &&
  isId(p.entryId) &&
  (p.theme === undefined || (typeof p.theme === "string" && /^[a-z-]{1,32}$/.test(p.theme))) &&
  (p.lang === undefined || (typeof p.lang === "string" && /^[a-z]{2,3}$/.test(p.lang)))
    ? null
    : "expected { entryId, theme?, lang? }"

// The image editor (Stage 12, ADR-0035). An edit list is checked for its
// structure here (editListProblem) and for its meaning in Go.
const SESSION_ID = /^[0-9a-f]{24}$/
const isSessionId = (v: unknown): v is string => typeof v === "string" && SESSION_ID.test(v)
const editQualities: ReadonlySet<unknown> = new Set(EDIT_QUALITIES)
const saveFormats: ReadonlySet<unknown> = new Set(SAVE_FORMATS)
const saveTargets: ReadonlySet<unknown> = new Set(SAVE_TARGETS)
const metadataPolicies: ReadonlySet<unknown> = new Set(METADATA_POLICIES)
const isQuality = (v: unknown): boolean =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_JPEG_QUALITY
const sessionParams: Validator = (p) =>
  shape(p, ["sessionId"]) && isSessionId(p.sessionId) ? null : "expected { sessionId }"

const isView = (v: unknown): boolean =>
  shape(v, ["maxEdge"]) &&
  Number.isSafeInteger(v.maxEdge) &&
  (v.maxEdge as number) >= 1 &&
  (v.maxEdge as number) <= MAX_EDIT_EDGE
const colorScopes: ReadonlySet<unknown> = new Set(COLOR_SCOPES)
const isUnit = (v: unknown): boolean => typeof v === "number" && v >= 0 && v <= 1

function editProbeProblem(p: unknown): string | null {
  if (!shape(p, ["sessionId", "editList", "view", "x", "y", "radius"]))
    return "expected { sessionId, editList, view, x, y, radius }"
  if (!isSessionId(p.sessionId) || !isView(p.view)) return "invalid sessionId or view"
  if (!isUnit(p.x) || !isUnit(p.y)) return "the point is 0..1 of the picture"
  if (!isCount(p.radius) || p.radius > 16) return "invalid radius"
  return editListProblem(p.editList)
}

function editThumbsProblem(p: unknown): string | null {
  if (!shape(p, ["sessionId", "editLists", "edge"]))
    return "expected { sessionId, editLists, edge }"
  if (!isSessionId(p.sessionId)) return "invalid sessionId"
  if (
    !Number.isSafeInteger(p.edge) ||
    (p.edge as number) < 32 ||
    (p.edge as number) > MAX_THUMB_EDGE
  )
    return "invalid edge"
  if (!Array.isArray(p.editLists) || p.editLists.length > MAX_EDIT_THUMBS)
    return `at most ${MAX_EDIT_THUMBS} thumbnails`
  for (const list of p.editLists) {
    const problem = editListProblem(list)
    if (problem) return problem
  }
  return null
}

function editColorsProblem(p: unknown): string | null {
  if (!shape(p, ["sessionId", "editList", "scope", "maxColors"]))
    return "expected { sessionId, editList, scope, maxColors }"
  if (!isSessionId(p.sessionId) || !colorScopes.has(p.scope)) return "invalid sessionId or scope"
  if (!isCount(p.maxColors) || p.maxColors < 1 || p.maxColors > MAX_SWATCHES)
    return "invalid maxColors"
  return editListProblem(p.editList)
}

function editRenderProblem(p: unknown): string | null {
  if (
    !shapeWithOptional(
      p,
      ["sessionId", "rev", "editList", "view", "quality", "histogram"],
      ["histogramAt"],
    )
  )
    return "expected { sessionId, rev, editList, view, quality, histogram, histogramAt? }"
  if (!isSessionId(p.sessionId) || !isId(p.rev)) return "invalid sessionId or rev"
  if (p.histogramAt !== undefined && (!isCount(p.histogramAt) || p.histogramAt > 512))
    return "invalid histogramAt"
  if (!isView(p.view)) return "invalid view"
  if (!editQualities.has(p.quality) || typeof p.histogram !== "boolean")
    return "invalid quality or histogram"
  return editListProblem(p.editList)
}

function editEstimateProblem(p: unknown): string | null {
  if (!shape(p, ["sessionId", "editList", "format", "quality", "metadata"]))
    return "expected { sessionId, editList, format, quality, metadata }"
  if (!isSessionId(p.sessionId)) return "invalid sessionId"
  if (!saveFormats.has(p.format) || !isQuality(p.quality) || !metadataPolicies.has(p.metadata))
    return "invalid format, quality or metadata"
  return editListProblem(p.editList)
}

function editSaveProblem(p: unknown): string | null {
  // No path: a "save as" destination comes from main's own dialog (ADR-0027).
  if (!shape(p, ["sessionId", "editList", "target", "format", "quality", "metadata", "dpi"]))
    return "expected { sessionId, editList, target, format, quality, metadata, dpi }"
  if (!isSessionId(p.sessionId)) return "invalid sessionId"
  if (!saveTargets.has(p.target) || !saveFormats.has(p.format)) return "invalid target or format"
  if (!isQuality(p.quality) || !metadataPolicies.has(p.metadata))
    return "invalid quality or metadata"
  if (typeof p.dpi !== "number" || !(p.dpi >= 0 && p.dpi <= MAX_DPI)) return "invalid dpi"
  return editListProblem(p.editList)
}

/** A batch (Stage 16): a selection and a recipe; the folder is a handle of main's, never a path. */
function batchProblem(p: unknown): string | null {
  if (!shapeWithOptional(p, ["source", "recipe"], ["folderId"]))
    return "expected { source, recipe, folderId? }"
  if (
    p.folderId !== undefined &&
    !(typeof p.folderId === "string" && BATCH_FOLDER_ID.test(p.folderId))
  )
    return "invalid folderId"
  return sourceProblem(p.source) ?? recipeProblem(p.recipe)
}

export const validators: Record<RendererMethod, Validator> = {
  "app.exit": empty,
  "app.about": empty,
  // A fixed list: main opens its own folders and the project's pages, never a renderer's URL.
  "app.openTarget": (p) =>
    shape(p, ["target"]) && (APP_TARGETS as readonly unknown[]).includes(p.target)
      ? null
      : "expected { target }",
  "update.get": empty,
  "update.check": empty,
  "update.download": empty,
  "update.install": empty,
  "app.openRequest": empty,
  "media.windowReveal": empty,
  "app.switch": (p) =>
    shapeWithOptional(p, ["to"], ["edit"]) &&
    (p.to === "viewer" || p.to === "commander") &&
    (p.edit === undefined || isId(p.edit))
      ? null
      : "expected { to, edit? }",
  "edit.open": (p) => (shape(p, ["entryId"]) && isId(p.entryId) ? null : "expected { entryId }"),
  "edit.render": editRenderProblem,
  "edit.info": sessionParams,
  "edit.estimate": editEstimateProblem,
  "edit.save": editSaveProblem,
  "edit.close": sessionParams,
  "edit.saved": jobIdParams,
  "edit.reveal": jobIdParams,
  "edit.probe": editProbeProblem,
  "edit.thumbs": editThumbsProblem,
  "edit.colors": editColorsProblem,
  "edit.fonts": sessionParams,
  "edit.eyes": (p) => {
    if (!shape(p, ["sessionId", "editList"])) return "expected { sessionId, editList }"
    if (!isSessionId(p.sessionId)) return "invalid sessionId"
    return editListProblem(p.editList)
  },
  "asset.pick": sessionParams,
  "batch.pickFolder": empty,
  "batch.plan": batchProblem,
  "batch.start": batchProblem,
  "batch.undo": jobIdParams,
  "recipe.list": empty,
  "recipe.save": (p) => {
    if (!shape(p, ["id", "name", "recipe"])) return "expected { id, name, recipe }"
    if (!isCount(p.id)) return "invalid id"
    if (typeof p.name !== "string" || p.name.length === 0 || p.name.length > MAX_RECIPE_NAME_CHARS)
      return "invalid name"
    return recipeProblem(p.recipe)
  },
  "recipe.delete": (p) => (shape(p, ["id"]) && isId(p.id) ? null : "expected { id }"),
  "asset.release": (p) =>
    shape(p, ["sessionId", "assetId"]) &&
    isSessionId(p.sessionId) &&
    typeof p.assetId === "string" &&
    ASSET_ID.test(p.assetId)
      ? null
      : "expected { sessionId, assetId }",
  "system.ping": empty,
  "system.info": empty,
  "sidecar.getStatus": empty,
  "dialog.openFolder": empty,
  "system.echo": (p) => {
    if (!shape(p, ["payload"]) || typeof p.payload !== "string")
      return "expected { payload: string }"
    return p.payload.length > MAX_ECHO_CHARS ? "payload too large" : null
  },
  "dir.open": (p) => {
    if (
      !shapeWithOptional(p, ["path", "recursive"], ["lane"]) ||
      typeof p.path !== "string" ||
      typeof p.recursive !== "boolean"
    ) {
      return "expected { path: string, recursive: boolean } and optionally lane"
    }
    if (p.lane !== undefined && !isLane(p.lane)) return "invalid lane"
    return pathProblem(p.path)
  },
  "media.open": (p) => (shape(p, ["entryId"]) && isId(p.entryId) ? null : "expected { entryId }"),
  "dir.openEntry": (p) =>
    shapeWithOptional(p, ["entryId", "recursive"], ["lane"]) &&
    isId(p.entryId) &&
    typeof p.recursive === "boolean" &&
    (p.lane === undefined || isLane(p.lane))
      ? null
      : "expected { entryId, recursive } and optionally lane",
  "dir.openContaining": (p) =>
    shapeWithOptional(p, ["entryId"], ["lane"]) &&
    isId(p.entryId) &&
    (p.lane === undefined || isLane(p.lane))
      ? null
      : "expected { entryId } and optionally lane",
  "find.start": (p) => findStartProblem(p),
  "find.cancel": (p) => (shape(p, ["findId"]) && isId(p.findId) ? null : "expected { findId }"),
  "archive.open": entryParams,
  "archive.close": (p) =>
    shape(p, ["archiveId"]) && isId(p.archiveId) ? null : "expected { archiveId }",
  "archive.check": (p) => {
    if (!shape(p, ["selection", "destinationDirId"]) || !isId(p.destinationDirId))
      return "expected { selection, destinationDirId }"
    return selectionProblem(p.selection)
  },
  "archive.tools": empty,
  // Stage C10.5 (ADR-0037): connections. The password is a write-only field
  // of saveConnection and connect; main answers both.
  "remote.connections": empty,
  "remote.secureStore": empty,
  "remote.saveConnection": (p) => {
    if (!shapeWithOptional(p, ["connection"], ["password", "forget"]))
      return "expected { connection, password?, forget? }"
    if (p.password !== undefined && (!isPassword(p.password) || p.password === ""))
      return "invalid password"
    if (p.forget !== undefined && typeof p.forget !== "boolean") return "invalid forget"
    if (p.password !== undefined && p.forget === true) return "a password is saved or forgotten"
    return connectionProblem(p.connection)
  },
  "remote.removeConnection": (p) =>
    shape(p, ["connectionId"]) && isId(p.connectionId) ? null : "expected { connectionId }",
  "remote.trust": (p) =>
    shape(p, ["connectionId", "fingerprint"]) &&
    isId(p.connectionId) &&
    isFingerprint(p.fingerprint, true)
      ? null
      : "expected { connectionId, fingerprint }",
  "remote.connect": (p) => {
    if (!isPlainObject(p)) return "expected { connectionId | quick, attempt, password?, accept? }"
    const saved = "connectionId" in p
    if (saved === "quick" in p) return "a saved connection or a typed one"
    if (
      !shapeWithOptional(p, [saved ? "connectionId" : "quick", "attempt"], ["password", "accept"])
    )
      return "expected { connectionId | quick, attempt, password?, accept? }"
    if (!isId(p.attempt)) return "invalid attempt"
    if (p.password !== undefined && !isPassword(p.password)) return "invalid password"
    if (p.accept !== undefined && !isFingerprint(p.accept, false)) return "invalid accept"
    return saved ? (isId(p.connectionId) ? null : "invalid connectionId") : quickProblem(p.quick)
  },
  "remote.cancel": (p) =>
    shape(p, ["attempt"]) && isId(p.attempt) ? null : "expected { attempt }",
  "remote.disconnect": (p) =>
    shape(p, ["remoteId"]) && isId(p.remoteId) ? null : "expected { remoteId }",
  "remote.open": (p) => {
    if (!isPlainObject(p) || !isId(p.remoteId))
      return "expected { remoteId, path | dirId, attempt? }"
    if (p.attempt !== undefined && !isId(p.attempt)) return "invalid attempt"
    if ("dirId" in p)
      return shapeWithOptional(p, ["remoteId", "dirId"], ["attempt"]) && isId(p.dirId)
        ? null
        : "invalid dirId"
    // A path on the server: absolute, one line. Go cleans it and refuses "..".
    return shapeWithOptional(p, ["remoteId", "path"], ["attempt"]) &&
      isLine(p.path, MAX_REMOTE_PATH_CHARS, 1) &&
      p.path.startsWith("/")
      ? null
      : "expected { remoteId, path | dirId, attempt? }"
  },
  "remote.mkdir": (p) =>
    shape(p, ["remoteDirId", "name"]) && isId(p.remoteDirId) && isRemoteName(p.name)
      ? null
      : "expected { remoteDirId, name }",
  "remote.rename": (p) =>
    shape(p, ["entryId", "name"]) && isId(p.entryId) && isRemoteName(p.name)
      ? null
      : "expected { entryId, name }",
  // Stage C08. The roots of a compare are folder ids: a sync writes to them.
  "compare.dirs": (p) => {
    const keys = [
      "leftDirId",
      "rightDirId",
      "toleranceMs",
      "dst",
      "ignoreDates",
      "content",
      "asymmetric",
    ]
    if (!shape(p, keys)) return `expected { ${keys.join(", ")} }`
    if (!isId(p.leftDirId) || !isId(p.rightDirId)) return "invalid leftDirId or rightDirId"
    if (typeof p.content !== "boolean" || typeof p.asymmetric !== "boolean")
      return "invalid content or asymmetric"
    return compareOptionsProblem(p)
  },
  "compare.cancel": compareIdParams,
  "compare.close": compareIdParams,
  "compare.plan": compareIdParams,
  "compare.show": (p) =>
    shape(p, ["compareId", "show"]) &&
    isId(p.compareId) &&
    Array.isArray(p.show) &&
    p.show.length <= COMPARE_SHOW.length &&
    p.show.every((s) => compareShow.has(s))
      ? null
      : "expected { compareId, show }",
  "compare.setAction": (p) => {
    if (!shape(p, ["compareId", "selection", "action"]) || !isId(p.compareId))
      return "expected { compareId, selection, action }"
    return diffActions.has(p.action) ? selectionProblem(p.selection) : "invalid action"
  },
  "compare.marks": (p) => {
    const keys = ["leftQueryId", "rightQueryId", "toleranceMs", "dst", "ignoreDates"]
    if (!shape(p, keys)) return `expected { ${keys.join(", ")} }`
    if (!isId(p.leftQueryId) || !isId(p.rightQueryId) || p.leftQueryId === p.rightQueryId)
      return "expected two different sessions"
    return compareOptionsProblem(p)
  },
  "diff.open": (p) =>
    shape(p, ["leftId", "rightId"]) && isId(p.leftId) && isId(p.rightId)
      ? null
      : "expected { leftId, rightId }",
  "diff.page": (p) => {
    if (!shape(p, ["diffId", "offset", "limit"]) || !isId(p.diffId) || !isCount(p.offset))
      return "expected { diffId, offset, limit }"
    const limit = p.limit as number
    return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_TEXT_DIFF_PAGE
      ? null
      : `limit must be 1..${MAX_TEXT_DIFF_PAGE}`
  },
  "diff.close": (p) => (shape(p, ["diffId"]) && isId(p.diffId) ? null : "expected { diffId }"),
  // Stage C09: the multi-rename preview, one page of it.
  "rename.preview": (p) => {
    if (!shape(p, ["selection", "plan", "offset", "limit"]) || !isCount(p.offset))
      return "expected { selection, plan, offset, limit }"
    if (!intIn(p.limit, 1, MAX_RENAME_PREVIEW_PAGE))
      return `limit must be 1..${MAX_RENAME_PREVIEW_PAGE}`
    return renamePlanProblem(p.plan) ?? selectionProblem(p.selection)
  },
  "rename.undoInfo": empty,
  "dir.cancelScan": (p) => (shape(p, ["scanId"]) && isId(p.scanId) ? null : "expected { scanId }"),
  "query.open": (p) => {
    const keys = [
      "dirId",
      "recursive",
      "sort",
      "kinds",
      "search",
      "exts",
      "favorite",
      "minRating",
      "tags",
    ]
    const optional = [
      "scope",
      "showHidden",
      "nameMask",
      "findId",
      "archiveId",
      "archiveDirId",
      "remoteId",
      "remoteDirId",
    ]
    if (!shapeWithOptional(p, keys, optional))
      return `expected { ${keys.join(", ")} } and optionally ${optional.join(", ")}`
    if (p.scope !== undefined && !scopes.has(p.scope)) return "invalid scope"
    if (p.showHidden !== undefined && (typeof p.showHidden !== "boolean" || p.scope !== "all"))
      return "showHidden needs the all scope"
    if (
      p.nameMask !== undefined &&
      (typeof p.nameMask !== "string" || p.nameMask.length > MAX_NAME_MASK_CHARS)
    )
      return "invalid nameMask"
    if (p.findId !== undefined && (!isId(p.findId) || p.scope !== "all" || p.recursive !== false))
      return "findId needs the all scope and no recursion"
    if (
      p.archiveId !== undefined &&
      (!isId(p.archiveId) || p.scope !== "all" || p.recursive !== false || p.findId !== undefined)
    )
      return "archiveId needs the all scope, no recursion and no findId"
    if (p.archiveDirId !== undefined && (p.archiveId === undefined || !isCount(p.archiveDirId)))
      return "archiveDirId needs an archiveId"
    // Stage C10.5: a listed folder of a connection, by the ids remote.open gave.
    if ((p.remoteId === undefined) !== (p.remoteDirId === undefined))
      return "remoteId and remoteDirId go together"
    if (
      p.remoteId !== undefined &&
      (!isId(p.remoteId) ||
        !isId(p.remoteDirId) ||
        p.scope !== "all" ||
        p.recursive !== false ||
        p.findId !== undefined ||
        p.archiveId !== undefined)
    )
      return "remoteId needs the all scope, no recursion, no findId and no archiveId"
    if (typeof p.favorite !== "boolean" || !isRating(p.minRating))
      return "invalid favorite or minRating"
    if (!Array.isArray(p.tags) || p.tags.length > MAX_TAG_FILTERS || !p.tags.every(isTagName))
      return "invalid tags"
    if (typeof p.search !== "string" || p.search.length > MAX_SEARCH_CHARS) return "invalid search"
    if (!Array.isArray(p.exts) || p.exts.length > MAX_EXTS) return "invalid exts"
    if (!p.exts.every((e) => typeof e === "string" && EXT.test(e))) return "invalid extension"
    if (!isId(p.dirId) || typeof p.recursive !== "boolean") return "invalid dirId or recursive"
    if (!Array.isArray(p.sort) || p.sort.length > 4)
      return "sort must be an array of at most 4 keys"
    for (const k of p.sort) {
      if (!shape(k, ["field", "direction"]) || !sortFields.has(k.field)) return "invalid sort field"
      if (k.direction !== "asc" && k.direction !== "desc") return "invalid sort direction"
    }
    if (!Array.isArray(p.kinds) || p.kinds.length > ENTRY_KINDS.length) return "invalid kinds"
    return p.kinds.every((k) => kinds.has(k)) ? null : "invalid kind"
  },
  "query.page": (p) => {
    if (!shape(p, ["queryId", "offset", "limit", "thumbProfile"]) || !isId(p.queryId)) {
      return "expected { queryId, offset, limit, thumbProfile }"
    }
    if (!Number.isSafeInteger(p.offset) || (p.offset as number) < 0) return "offset must be >= 0"
    if (p.thumbProfile !== null && !profiles.has(p.thumbProfile)) return "invalid thumbProfile"
    const limit = p.limit as number
    return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_PAGE_SIZE
      ? null
      : `limit must be 1..${MAX_PAGE_SIZE}`
  },
  "preview.ensure": (p) => {
    if (!shape(p, ["lane", "epoch", "profile", "items", "force"])) {
      return "expected { lane, epoch, profile, items, force }"
    }
    if (typeof p.lane !== "string" || p.lane.length < 1 || p.lane.length > 32) return "invalid lane"
    if (!Number.isSafeInteger(p.epoch) || (p.epoch as number) < 0) return "invalid epoch"
    if (!profiles.has(p.profile)) return "invalid profile"
    if (!Array.isArray(p.items) || p.items.length > MAX_ENSURE_ITEMS) return "invalid items"
    for (const it of p.items) {
      if (!shape(it, ["id", "priority"]) || !isId(it.id)) return "invalid item"
      if (![0, 1, 2, 3].includes(it.priority as number)) return "invalid priority"
    }
    if (!Array.isArray(p.force) || p.force.length > MAX_ENSURE_ITEMS || !p.force.every(isId)) {
      return "invalid force"
    }
    return null
  },
  "folder.covers": (p) => {
    if (!shape(p, ["lane", "epoch", "profile", "items"])) {
      return "expected { lane, epoch, profile, items }"
    }
    if (typeof p.lane !== "string" || p.lane.length < 1 || p.lane.length > 32) return "invalid lane"
    if (!Number.isSafeInteger(p.epoch) || (p.epoch as number) < 0) return "invalid epoch"
    if (!profiles.has(p.profile)) return "invalid profile"
    if (!Array.isArray(p.items) || p.items.length > MAX_COVER_DIRS) return "invalid items"
    for (const it of p.items) {
      if (!shape(it, ["id", "priority"]) || !isId(it.id)) return "invalid item"
      if (![0, 1, 2, 3].includes(it.priority as number)) return "invalid priority"
    }
    return null
  },
  "query.close": (p) => (shape(p, ["queryId"]) && isId(p.queryId) ? null : "expected { queryId }"),
  "query.indexOf": (p) =>
    shape(p, ["queryId", "entryId"]) && isId(p.queryId) && isId(p.entryId)
      ? null
      : "expected { queryId, entryId }",
  "context.publish": (p) => {
    if (
      !shapeWithOptional(p, ["app", "dirId", "focusId"], ["selection"]) ||
      (p.app !== "viewer" && p.app !== "commander") ||
      !isId(p.dirId) ||
      (p.focusId !== null && !isId(p.focusId))
    )
      return "expected { app, dirId, focusId, selection? }"
    return p.selection === undefined || p.selection === null ? null : selectionProblem(p.selection)
  },
  "selection.fromContext": (p) =>
    shape(p, ["version", "queryId"]) && isId(p.version) && isId(p.queryId)
      ? null
      : "expected { version, queryId }",
  "query.locate": (p) =>
    shape(p, ["queryId", "pattern", "from", "direction"]) &&
    isId(p.queryId) &&
    typeof p.pattern === "string" &&
    p.pattern.length <= MAX_SEARCH_CHARS &&
    Number.isSafeInteger(p.from) &&
    (p.direction === "forward" || p.direction === "backward")
      ? null
      : "expected { queryId, pattern, from, direction }",
  "query.match": (p) =>
    shape(p, ["queryId", "mask"]) &&
    isId(p.queryId) &&
    typeof p.mask === "string" &&
    p.mask.length > 0 &&
    p.mask.length <= MAX_NAME_MASK_CHARS
      ? null
      : "expected { queryId, mask }",
  "context.get": empty,
  "query.facets": (p) => (shape(p, ["queryId"]) && isId(p.queryId) ? null : "expected { queryId }"),
  "selection.info": selectionParams,
  "selection.rebase": selectionParams,
  "props.get": entryParams,
  "fs.volumes": empty,
  "fs.listDirs": (p) => {
    if (!shapeWithOptional(p, ["path"], ["showHidden"])) return "expected { path, showHidden? }"
    if (p.showHidden !== undefined && typeof p.showHidden !== "boolean") return "invalid showHidden"
    return pathProblem(p.path)
  },
  "library.get": empty,
  "library.setSetting": (p) => {
    if (!shape(p, ["key", "value"])) return "expected { key, value }"
    if (typeof p.key !== "string" || p.key.length < 1 || p.key.length > MAX_SETTING_KEY_CHARS)
      return "invalid key"
    let json: string | undefined
    try {
      json = JSON.stringify(p.value)
    } catch {
      return "value must be JSON"
    }
    if (json === undefined) return "value must be JSON"
    return json.length > MAX_SETTING_JSON_CHARS ? "value too large" : null
  },
  "library.addBookmark": (p) => {
    if (!shapeWithOptional(p, ["path", "label"], ["group"]))
      return "expected { path, label, group? }"
    if (typeof p.label !== "string" || p.label.length > 256) return "invalid label"
    if (p.group !== undefined && !isGroup(p.group)) return "invalid group"
    return pathProblem(p.path)
  },
  "library.removeBookmark": (p) => (shape(p, ["id"]) && isId(p.id) ? null : "expected { id }"),
  "library.updateBookmark": (p) => {
    if (!shape(p, ["id", "path", "label", "group"])) return "expected { id, path, label, group }"
    if (!isId(p.id)) return "invalid id"
    if (typeof p.label !== "string" || p.label.length > 256) return "invalid label"
    if (!isGroup(p.group)) return "invalid group"
    return pathProblem(p.path)
  },
  "library.reorderBookmarks": (p) =>
    shape(p, ["ids"]) && Array.isArray(p.ids) && p.ids.length <= MAX_BOOKMARKS && p.ids.every(isId)
      ? null
      : "expected { ids } (at most 500)",
  "places.list": empty,
  "shell.open": (p) =>
    shapeWithOptional(p, ["entryId"], ["allowProgram"]) &&
    isId(p.entryId) &&
    (p.allowProgram === undefined || typeof p.allowProgram === "boolean")
      ? null
      : "expected { entryId, allowProgram? }",
  "shell.edit": entryParams,
  // Stage C10: a typed line and the folder id it runs in; never a path.
  "shell.run": (p) =>
    shapeWithOptional(p, ["command", "dirId"], ["console"]) &&
    isCommandText(p.command, MAX_COMMAND_CHARS) &&
    isId(p.dirId) &&
    (p.console === undefined || typeof p.console === "boolean") &&
    // An empty line only opens a console (Shift+Enter); it never runs.
    (p.command.trim() !== "" || p.console === true)
      ? null
      : "expected { command, dirId, console? }",
  // A user command by its id, with entry ids and a selection: main reads the
  // command itself from library.db.
  "shell.runTool": (p) => {
    if (
      !shapeWithOptional(p, ["toolId", "dirId"], ["otherDirId", "cursorId", "selection"]) ||
      typeof p.toolId !== "string" ||
      !/^[a-z0-9]{1,16}$/.test(p.toolId) ||
      !isId(p.dirId) ||
      (p.otherDirId !== undefined && !isId(p.otherDirId)) ||
      (p.cursorId !== undefined && !isId(p.cursorId))
    ) {
      return "expected { toolId, dirId, otherDirId?, cursorId?, selection? }"
    }
    return p.selection === undefined ? null : selectionProblem(p.selection)
  },
  "file.open": entryParams,
  "document.open": windowParams,
  "media.openWindow": (p) =>
    shapeWithOptional(p, ["entryId", "key"], ["theme", "lang"]) &&
    isId(p.entryId) &&
    isId(p.key) &&
    (p.theme === undefined || (typeof p.theme === "string" && /^[a-z-]{1,32}$/.test(p.theme))) &&
    (p.lang === undefined || (typeof p.lang === "string" && /^[a-z]{2,3}$/.test(p.lang)))
      ? null
      : "expected { entryId, key, theme?, lang? }",
  "media.windowStep": (p) =>
    shape(p, ["direction"]) && (p.direction === -1 || p.direction === 0 || p.direction === 1)
      ? null
      : "expected { direction: -1 | 0 | 1 }",
  "media.windowAnswer": (p) =>
    shape(p, ["requestId", "item"]) &&
    Number.isSafeInteger(p.requestId) &&
    (p.item === null || isContentItem(p.item))
      ? null
      : "expected { requestId, item }",
  "shell.reveal": entryParams,
  "shell.revealPath": (p) => (shape(p, ["path"]) ? pathProblem(p.path) : "expected { path }"),
  "clipboard.copyPaths": (p) => {
    if (!shapeWithOptional(p, ["selection"], ["namesOnly"]))
      return "expected { selection, namesOnly? }"
    if (p.namesOnly !== undefined && typeof p.namesOnly !== "boolean") return "invalid namesOnly"
    return selectionProblem(p.selection)
  },
  "clipboard.copyImage": entryParams,
  "clipboard.copyText": (p) =>
    shape(p, ["text"]) && typeof p.text === "string" && p.text.length <= MAX_COPY_TEXT_CHARS
      ? null
      : "expected { text } (at most 64 KiB)",
  "jobs.start": jobStartProblem,
  "jobs.cancel": (p) => (shape(p, ["jobId"]) && isId(p.jobId) ? null : "expected { jobId }"),
  "jobs.errors": (p) => {
    if (!shape(p, ["jobId", "offset", "limit"]) || !isId(p.jobId) || !isCount(p.offset))
      return "expected { jobId, offset, limit }"
    const limit = p.limit as number
    return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_JOB_ERRORS_PAGE
      ? null
      : `limit must be 1..${MAX_JOB_ERRORS_PAGE}`
  },
  "jobs.list": empty,
  "jobs.pause": jobIdParams,
  "jobs.resume": jobIdParams,
  "jobs.startNow": jobIdParams,
  "jobs.resolve": (p) =>
    shape(p, ["jobId", "decision", "applyToAll"]) &&
    isId(p.jobId) &&
    decisions.has(p.decision) &&
    typeof p.applyToAll === "boolean"
      ? null
      : "expected { jobId, decision, applyToAll }",
  "clip.set": (p) => {
    if (!shape(p, ["selection", "mode"])) return "expected { selection, mode }"
    if (p.mode !== "copy" && p.mode !== "cut") return "invalid mode"
    return selectionProblem(p.selection)
  },
  "clip.get": empty,
  "clip.paste": (p) => {
    if (!shapeWithOptional(p, ["conflict"], ["destination", "destinationDirId"]))
      return "expected { destination | destinationDirId, conflict }"
    return conflicts.has(p.conflict) ? destinationProblem(p) : "invalid conflict policy"
  },
  "fs.mkdir": (p) =>
    shape(p, ["parentDirId", "path"]) &&
    isId(p.parentDirId) &&
    typeof p.path === "string" &&
    p.path.trim().length > 0 &&
    p.path.length <= MAX_MKDIR_PATH_CHARS &&
    !p.path.includes("\0")
      ? null
      : "expected { parentDirId, path }",
  "fs.mkfile": (p) =>
    shape(p, ["parentDirId", "name"]) && isId(p.parentDirId) && isName(p.name)
      ? null
      : "expected { parentDirId, name }",
  "fs.canTrash": (p) => (shape(p, ["dirId"]) && isId(p.dirId) ? null : "expected { dirId }"),
  "entry.rename": (p) =>
    shape(p, ["entryId", "name"]) && isId(p.entryId) && isName(p.name)
      ? null
      : "expected { entryId, name }",
  "library.tags": empty,
  "library.deleteTag": (p) => (shape(p, ["id"]) && isId(p.id) ? null : "expected { id }"),
}
