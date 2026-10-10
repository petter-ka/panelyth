import { isAbsolute } from "node:path"
import {
  CONFLICT_DECISIONS,
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
  MAX_FIND_ROOTS,
  MAX_FIND_TEXT_CHARS,
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
    case "trash":
    case "delete":
    case "dirSize":
      return shape(p, ["kind", "source"]) ? sourceProblem(p.source) : "expected { kind, source }"
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
      return shape(p, ["kind", "source"]) ? sourceProblem(p.source) : "expected { kind, source }"
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

export const validators: Record<RendererMethod, Validator> = {
  "app.exit": empty,
  "app.switch": (p) =>
    shape(p, ["to"]) && (p.to === "viewer" || p.to === "commander") ? null : "expected { to }",
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
    const optional = ["scope", "showHidden", "nameMask", "findId", "archiveId", "archiveDirId"]
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
  "fs.listDirs": (p) => (shape(p, ["path"]) ? pathProblem(p.path) : "expected { path }"),
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
  "file.open": entryParams,
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
