import {
  ENTRY_ATTRS,
  type Bookmark,
  type CommanderApi,
  type CommanderJobParams,
  type CompareDirsParams,
  type CompareMarksParams,
  type ComparePlan,
  type CompareProgress,
  type CompareShow,
  type DiffAction,
  type JobSnapshot,
  type TextDiffOpenResult,
  type TextDiffRow,
  type ContentItem,
  type Crumb,
  type ErrorCode,
  type EventChannel,
  type EventMap,
  type FindProgress,
  type FindStartParams,
  type QueryDescriptor,
  type RenamePlan,
  type RenamePreviewRow,
  type RecentFolder,
  type RemoteConnectParams,
  type RemoteFailureReason,
  type SavedConnection,
  type SelectionDescriptor,
  type SharedContext,
  type Volume,
} from "@panelyth/contracts"
import { vi } from "vitest"
import { setRangeFetch } from "../features/bytes"

// An in-memory commander API: folders, query sessions sorted "in Go",
// paging, indexOf, the shared context and settings. Tests drive it the way
// the sidecar would.

export interface FakeFolder {
  dirId: number
  path: string
  crumbs: Crumb[]
  entries: ContentItem[]
}

export function item(id: number, name: string, over: Partial<ContentItem> = {}): ContentItem {
  const dot = name.lastIndexOf(".")
  const kind = over.kind ?? "file"
  return {
    id,
    kind,
    name,
    ext: kind === "dir" || dot <= 0 ? "" : name.slice(dot + 1).toLowerCase(),
    sizeBytes: 0,
    modifiedMs: 1_700_000_000_000,
    favorite: false,
    rating: 0,
    label: 0,
    thumb: null,
    ...over,
  }
}

/** A folder with `dirs` subfolders and `files` files; ids are dirId * 1_000_000 + n. */
export function folder(
  dirId: number,
  path: string,
  crumbs: Crumb[],
  dirs: number,
  files: number,
  extra: ContentItem[] = [],
): FakeFolder {
  const entries: ContentItem[] = []
  for (let i = 0; i < dirs; i++) {
    entries.push(item(dirId * 1_000_000 + i, `dir${String(i).padStart(6, "0")}`, { kind: "dir" }))
  }
  for (let i = 0; i < files; i++) {
    entries.push(
      item(dirId * 1_000_000 + dirs + i, `file${String(i).padStart(6, "0")}.txt`, {
        sizeBytes: (i * 7919) % 100_000,
      }),
    )
  }
  return { dirId, path, crumbs, entries: [...entries, ...extra] }
}

/**
 * Stage C07: an archive file (entry `entryId` of some folder) and its
 * listing: the root's entries and each inner folder's, by folder entry id.
 * `error` makes archive.open fail (details.reason).
 */
export interface FakeArchive {
  entryId: number
  archiveId: number
  root: ContentItem[]
  dirs?: Record<number, ContentItem[]>
  error?: { code: ErrorCode; reason: string; message: string }
}

/**
 * Stage C10.5: an FTP server the fake "dials" (ADR-0037): its folders by
 * path, and how a connect to it goes. Entries of a folder that are folders
 * themselves are entered by their ids, as in a panel.
 */
export interface FakeServer {
  host: string
  /** Default 21. */
  port?: number
  /** The password it wants; without it any is accepted (and "anonymous"). */
  password?: string
  /** Whether it offers TLS (default true). */
  tls?: boolean
  /** A certificate no authority vouches for: connecting needs it accepted. */
  fingerprint?: string
  subject?: string
  folders: Record<string, ContentItem[]>
  /** Entries left out of a folder's listing, by path. */
  rejected?: Record<string, number>
  /** A connect waits for this (a slow server). */
  delay?: Promise<void>
  /** It accepts the login, then never answers a listing. */
  stall?: boolean
  /** A connect fails with this reason. */
  fail?: RemoteFailureReason
}

export interface FakeOptions {
  folders: FakeFolder[]
  /** Stage C10.5: servers, saved connections, and what the secret store holds. */
  servers?: FakeServer[]
  connections?: SavedConnection[]
  /** Passwords "in the secret store", by connection id. */
  passwords?: Record<number, string>
  /** Whether this computer can keep passwords (default true). */
  secureStore?: boolean
  archives?: FakeArchive[]
  /** archive.check's warnings. */
  archiveWarnings?: ("space" | "ratio")[]
  sevenZip?: boolean
  settings?: Record<string, unknown>
  context?: SharedContext
  home?: string
  volumes?: Volume[]
  /** dir.open of these paths fails with the given error. */
  fail?: Record<string, { code: ErrorCode; message: string; details?: unknown }>
  /** Ids carried by the initial context. */
  carried?: number[]
  /**
   * Stage C10.5: fs.listDirs answers these subfolder names for a path. A
   * path without an entry lists the fake folders right below it. Names that
   * start with a dot are hidden folders.
   */
  dirs?: Record<string, string[]>
  /** fs.listDirs waits for this (a slow drive under the tree). */
  dirsDelay?: Promise<void>
  bookmarks?: Bookmark[]
  recent?: RecentFolder[]
  /** fs.volumes waits for this (a slow network drive). */
  volumesDelay?: Promise<void>
  /** fs.canTrash answers this (default true). */
  trash?: boolean
  /** library.get waits for this (a slow library.db at startup). */
  libraryDelay?: Promise<void>
  /** Stage C05: file contents by entry id, served through token URLs with Range. */
  contents?: Record<number, Uint8Array>
  /** Entry ids main resolves as programs (shell.open needs allowProgram). */
  programs?: number[]
  /**
   * Stage C08: what diff.open answers. `rows` is the side-by-side view of a
   * text diff; `reason` says the files are not compared as text.
   */
  textDiff?: { rows?: TextDiffRow[]; reason?: "binary" | "tooLarge"; identical?: boolean }
  /** Stage C10: shell.run and shell.runTool fail with this (main refused, details.reason). */
  runFails?: { code: ErrorCode; message: string; reason?: string }
  /**
   * Stage C09: props.get reports these permission bits (a system that is
   * not Windows); without it, permissions are null as on Windows.
   */
  permissions?: number
}

/**
 * Stage C09: what Go's rename engine does, as far as the tests need it:
 * [N], [E] and [C] in the masks, search and replace, lower and upper case.
 * A mask with an open bracket or a bad expression throws its field.
 */
export function fakeRename(plan: RenamePlan, name: string, isDir: boolean, index: number): string {
  const dot = name.lastIndexOf(".")
  const stem = isDir || dot <= 0 ? name : name.slice(0, dot)
  const ext = isDir || dot <= 0 ? "" : name.slice(dot + 1)
  const build = (mask: string, field: string): string => {
    if ((mask.match(/\[/g) ?? []).length !== (mask.match(/\]/g) ?? []).length)
      throw { field, message: "a [ has no ]" }
    return mask.replace(/\[([^\]]*)\]/g, (_all, token: string) => {
      if (token === "N") return stem
      if (token === "E") return ext
      if (token === "C") return String(plan.start + index * plan.step).padStart(plan.digits, "0")
      throw { field, message: `unknown placeholder [${token}]` }
    })
  }
  let out = build(plan.nameMask, "nameMask")
  const newExt = build(plan.extMask, "extMask")
  if (newExt !== "") out += "." + newExt
  if (plan.search !== "") {
    let re: RegExp
    try {
      const source = plan.regex ? plan.search : plan.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      re = new RegExp(source, plan.matchCase ? "g" : "gi")
    } catch {
      throw { field: "search", message: "missing closing )" }
    }
    // A plain replacement is text, not a template.
    out = plan.regex ? out.replace(re, plan.replace) : out.replace(re, () => plan.replace)
  }
  if (plan.case === "lower") out = out.toLowerCase()
  if (plan.case === "upper") out = out.toUpperCase()
  return out
}

/** Stage C08: a row of a fake directory compare. */
export function diffRow(
  id: number,
  name: string,
  state: NonNullable<ContentItem["diff"]>["state"],
  action: DiffAction,
  over: { dir?: string; kind?: ContentItem["kind"]; left?: number; right?: number } = {},
): ContentItem {
  const side = (size: number | undefined) =>
    size === undefined ? null : { sizeBytes: size, modifiedMs: 1_700_000_000_000 }
  const hasLeft = state !== "rightOnly"
  const hasRight = state !== "leftOnly"
  return item(id, name, {
    kind: over.kind ?? "file",
    sizeBytes: over.left ?? over.right ?? 10,
    diff: {
      dir: over.dir ?? "",
      state,
      action,
      left: side(hasLeft ? (over.left ?? 10) : undefined),
      right: side(hasRight ? (over.right ?? 10) : undefined),
    },
  })
}

const symbolOf = (d: NonNullable<ContentItem["diff"]>): CompareShow =>
  d.action === "copyRight"
    ? "copyRight"
    : d.action === "copyLeft"
      ? "copyLeft"
      : d.action !== "none"
        ? "delete"
        : d.state === "equal"
          ? "equal"
          : "different"

/** Go's rules for a direction: a copy needs its source, deletes are for one-sided entries. */
const allowed = (state: string, action: DiffAction): boolean => {
  switch (action) {
    case "none":
      return true
    case "copyRight":
      return state !== "rightOnly" && state !== "mismatch"
    case "copyLeft":
      return state !== "leftOnly" && state !== "mismatch"
    case "deleteRight":
      return state === "rightOnly"
    case "deleteLeft":
      return state === "leftOnly"
  }
}

/** What main would have done for shell.open / shell.edit (PANELYTH_TEST_SHELL=record). */
export interface ShellRecord {
  action: "open" | "edit" | "document"
  entryId: number
}

/**
 * Stage C10: what main would have run for shell.run (a typed line) and
 * shell.runTool (a user command by id, with the ids it was given).
 */
export type RunRecord =
  | { action: "run"; command: string; dirId: number; console: boolean }
  | {
      action: "runTool"
      toolId: string
      dirId: number
      otherDirId: number | null
      cursorId: number | null
      selection: SelectionDescriptor | null
    }

const ok = <R>(r: R) => ({ ok: true as const, r })
const err = (code: ErrorCode, message: string, details?: unknown) => ({
  ok: false as const,
  e: { code, message, retryable: false, ...(details !== undefined && { details }) },
})

const compare = (field: string, a: ContentItem, b: ContentItem): number => {
  switch (field) {
    case "size":
      return a.sizeBytes - b.sizeBytes
    case "modified":
      return a.modifiedMs - b.modifiedMs
    case "type":
      return a.ext.localeCompare(b.ext)
    case "attrs":
      return (a.attrs ?? 0) - (b.attrs ?? 0)
    default:
      return a.name.localeCompare(b.name)
  }
}

export function installFakeCommander(options: FakeOptions) {
  const byPath = new Map(options.folders.map((f) => [f.path, f]))
  const byId = new Map(options.folders.map((f) => [f.dirId, f]))
  const sessions = new Map<number, ContentItem[]>()
  /** Session versions; query.invalidated emitted by a test moves them on. */
  const versions = new Map<number, number>()
  const settings: Record<string, unknown> = { ...options.settings }
  let context: SharedContext = options.context ?? {
    version: 0,
    app: "",
    dirId: 0,
    path: "",
    focusId: null,
    selectionCount: 0,
    selectionTooLarge: false,
  }
  /** Ids the context carries (what Go would keep). */
  let carried: number[] = options.carried ?? []
  let carriedVersion = options.context?.version ?? 0
  let nextJob = 0
  /** Stage C09: the journal of the last multi-rename (entry, old name, new name). */
  let undo: { dir: string; steps: { entry: ContentItem; old: string; next: string }[] } | null =
    null
  const setName = (e: ContentItem, name: string): void => {
    e.name = name
    const dot = name.lastIndexOf(".")
    e.ext = e.kind === "dir" || dot <= 0 ? "" : name.slice(dot + 1).toLowerCase()
  }
  /** The folder listing an entry (by identity: sessions hold the same objects). */
  const folderOf = (e: ContentItem): FakeFolder | undefined =>
    options.folders.find((f) => f.entries.some((x) => x.id === e.id))
  /** Names a selection as Go's rename.Resolve would. */
  const renameRows = (sel: SelectionDescriptor, plan: RenamePlan): RenamePreviewRow[] => {
    const rows = resolve(sel)
    const named = rows.map((e, i) => fakeRename(plan, e.name, e.kind === "dir", i))
    // Entries that keep their name still have it; so do the unselected ones.
    const moving = new Set(rows.filter((e, i) => named[i] !== e.name).map((e) => e.id))
    const lower = named.map((n, i) => (moving.has(rows[i]!.id) ? n.toLowerCase() : `\0${i}`))
    return rows.map((e, i): RenamePreviewRow => {
      const base = { id: e.id, name: e.name, newName: named[i]! }
      if (named[i] === e.name) return { ...base, status: "unchanged" }
      if (named[i] === "" || /[/\\]/.test(named[i]!))
        return { ...base, status: "invalid", reason: "The name can't contain / or \\." }
      if (lower.indexOf(lower[i]!) !== lower.lastIndexOf(lower[i]!))
        return { ...base, status: "conflict", reason: "duplicate" }
      const taken = folderOf(e)?.entries.some(
        (x) => !moving.has(x.id) && x.name.toLowerCase() === lower[i],
      )
      return taken
        ? { ...base, status: "conflict", reason: "exists" }
        : { ...base, status: "rename" }
    })
  }
  let nextEntry = 900_000_000
  const jobs: JobSnapshot[] = []
  let clip: { mode: "" | "copy" | "cut"; count: number } = { mode: "", count: 0 }
  const job = (over: Partial<JobSnapshot>): JobSnapshot => ({
    jobId: ++nextJob,
    kind: "copy",
    state: "queued",
    total: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    bytesTotal: 0,
    bytesDone: 0,
    current: "",
    destination: "",
    error: "",
    startedMs: 1,
    finishedMs: 0,
    bytesPerSec: 0,
    etaMs: 0,
    ...over,
  })
  let bookmarks: Bookmark[] = [...(options.bookmarks ?? [])]
  let nextBookmark = Math.max(0, ...bookmarks.map((b) => b.id))
  const bookmarksChanged = (): void =>
    listeners
      .get("bookmarks.changed")
      ?.forEach((l) => (l as (p: EventMap["bookmarks.changed"]) => void)({ bookmarks }))
  const glob = (pattern: string, name: string): boolean =>
    new RegExp(
      "^" +
        pattern
          .toLowerCase()
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$",
    ).test(name.toLowerCase())
  const rangesOf = (sorted: number[]): [number, number][] => {
    const out: [number, number][] = []
    for (const i of sorted) {
      const last = out.at(-1)
      if (last && last[1] === i) last[1]++
      else out.push([i, i + 1])
    }
    return out
  }
  const resolve = (sel: SelectionDescriptor): ContentItem[] => {
    const rows = sessions.get(sel.queryId) ?? []
    const out = new Set<ContentItem>()
    for (const [a, b] of sel.ranges) rows.slice(a, b).forEach((r) => out.add(r))
    for (const r of rows) if (sel.exclude.includes(r.id)) out.delete(r)
    for (const r of rows) if (sel.include.includes(r.id)) out.add(r)
    return [...out]
  }
  let nextQuery = 0
  const descriptors = new Map<number, QueryDescriptor>()
  /** Stage C06: searches (results in found order) and the specs they ran with. */
  const finds = new Map<number, { spec: FindStartParams; results: ContentItem[] }>()
  let nextFind = 0
  const maskMatch = (mask: string, name: string): boolean => {
    const [inc = "", exc = ""] = mask.split("|")
    const split = (m: string) => m.split(/[;\s]+/).filter((x) => x !== "")
    const includes = split(inc).map((m) => (m === "*.*" ? "*" : m))
    if (includes.length > 0 && !includes.some((m) => glob(m, name))) return false
    return !split(exc).some((m) => glob(m, name))
  }
  const sep = (path: string): string => (path.includes("\\") ? "\\" : "/")
  /** A folder and every folder below it (by path). */
  const subtree = (f: FakeFolder): FakeFolder[] =>
    options.folders.filter((g) => g === f || g.path.startsWith(f.path + sep(f.path)))
  /** A session's rows as Go would sort them. */
  const rowsOf = (d: QueryDescriptor): ContentItem[] => {
    const key = d.sort[0] ?? { field: "name", direction: "asc" }
    const hidden = ENTRY_ATTRS.hidden | ENTRY_ATTRS.system
    let rows: ContentItem[]
    if (d.remoteId !== undefined) {
      const dir = remoteDirs.get(d.remoteDirId ?? 0)
      rows = (dir ? (opens.get(dir.remoteId)?.server.folders[dir.path] ?? []) : []).slice()
    } else if (d.archiveId !== undefined) {
      const a = (options.archives ?? []).find((x) => x.archiveId === d.archiveId)!
      rows = (d.archiveDirId ? (a.dirs?.[d.archiveDirId] ?? []) : a.root).slice()
    } else if (d.findId !== undefined) {
      rows = (finds.get(d.findId)?.results ?? []).slice()
    } else if (d.recursive) {
      // Branch view: every file below the folder, each with its folder.
      rows = subtree(byId.get(d.dirId)!).flatMap((g) =>
        g.entries.filter((e) => e.kind !== "dir").map((e) => ({ ...e, dirPath: g.path })),
      )
    } else {
      rows = byId.get(d.dirId)!.entries.slice()
    }
    rows = rows.filter(
      (e) =>
        (d.showHidden || ((e.attrs ?? 0) & hidden) === 0) &&
        (!d.nameMask || e.kind === "dir" || maskMatch(d.nameMask, e.name)),
    )
    // Search results without sort keys stay in found order.
    if (d.findId !== undefined && d.sort.length === 0) return rows
    return rows.sort((a, b) => {
      const dirs = Number(b.kind === "dir") - Number(a.kind === "dir")
      if (dirs !== 0) return dirs
      const c = compare(key.field, a, b)
      return (key.direction === "desc" ? -c : c) || a.name.localeCompare(b.name)
    })
  }
  let nextScan = 0
  const listeners = new Map<EventChannel, Set<(p: never) => void>>()
  // Stage C10.5: saved connections, the "secret store", and the open connections.
  let connections: SavedConnection[] = (options.connections ?? []).map((c) => ({ ...c }))
  let nextConnection = Math.max(0, ...connections.map((c) => c.id))
  const passwords = new Map<number, string>(
    Object.entries(options.passwords ?? {}).map(([id, p]) => [Number(id), p]),
  )
  const opens = new Map<number, { server: FakeServer }>()
  let nextRemote = 0
  /** Listed folders of open connections, by their ids. */
  const remoteDirs = new Map<number, { remoteId: number; path: string }>()
  // Above the ids tests give to the entries of their servers.
  let nextRemoteDir = 7 * 2 ** 50 + 900_000
  let nextRemoteEntry = 7 * 2 ** 50 + 950_000
  const cancelledAttempts = new Set<number>()
  /** Listings a server never answers, by attempt: resolved when cancelled. */
  const stalled = new Map<number, () => void>()
  const connectionsChanged = (): void =>
    listeners
      .get("connections.changed")
      ?.forEach((l) => (l as (p: EventMap["connections.changed"]) => void)({ connections }))
  const joinRemote = (dir: string, name: string): string =>
    dir === "/" ? `/${name}` : `${dir}/${name}`
  /** A listed folder's id: as in Go, the id of its entry in its parent's listing. */
  const remoteDirId = (remoteId: number, path: string): number => {
    for (const [id, d] of remoteDirs) if (d.remoteId === remoteId && d.path === path) return id
    const cut = path.lastIndexOf("/")
    const parent = cut <= 0 ? "/" : path.slice(0, cut)
    const entry =
      path === "/"
        ? undefined
        : opens
            .get(remoteId)
            ?.server.folders[parent]?.find(
              (e) => e.kind === "dir" && e.name === path.slice(cut + 1),
            )
    const id = entry?.id ?? ++nextRemoteDir
    remoteDirs.set(id, { remoteId, path })
    return id
  }
  /** The folder a folder entry of a connection stands for. */
  const remotePathOf = (remoteId: number, entryId: number): string | null => {
    const known = remoteDirs.get(entryId)
    if (known?.remoteId === remoteId) return known.path
    const server = opens.get(remoteId)?.server
    for (const [path, entries] of Object.entries(server?.folders ?? {})) {
      const e = entries.find((x) => x.id === entryId && x.kind === "dir")
      if (e) return joinRemote(path, e.name)
    }
    return null
  }
  /** The open connection and folder an entry of a server is listed in. */
  const remoteEntry = (
    entryId: number,
  ): { server: FakeServer; path: string; entry: ContentItem } | null => {
    for (const { server } of opens.values()) {
      for (const [path, entries] of Object.entries(server.folders)) {
        const entry = entries.find((x) => x.id === entryId)
        if (entry) return { server, path, entry }
      }
    }
    return null
  }
  const closedError = () => err("NOT_FOUND", "The connection is closed.", { reason: "closed" })
  /** Stage C08: directory compares: all their rows, the filter, and the session that lists them. */
  interface FakeCompare {
    params: CompareDirsParams
    queryId: number
    rows: ContentItem[]
    defaults: Map<number, DiffAction>
    show: CompareShow[]
    planVersion: number
    done: boolean
  }
  const compares = new Map<number, FakeCompare>()
  let nextCompare = 0
  const planOf = (c: FakeCompare): ComparePlan => {
    const plan: ComparePlan = {
      version: c.planVersion,
      counts: { copyRight: 0, copyLeft: 0, equal: 0, different: 0, delete: 0 },
      copyRight: { files: 0, bytes: 0 },
      copyLeft: { files: 0, bytes: 0 },
      deleteRight: 0,
      deleteLeft: 0,
      folders: 0,
      overwriteNewer: 0,
    }
    for (const r of c.rows) {
      const d = r.diff!
      const sym = symbolOf(d)
      plan.counts[sym]++
      if (!c.show.includes(sym)) continue
      const dir = r.kind === "dir"
      if (d.action === "copyRight" || d.action === "copyLeft") {
        const amount = d.action === "copyRight" ? plan.copyRight : plan.copyLeft
        if (dir) plan.folders++
        else {
          amount.files++
          amount.bytes += (d.action === "copyRight" ? d.left : d.right)?.sizeBytes ?? 0
          if (d.state === (d.action === "copyRight" ? "rightNewer" : "leftNewer"))
            plan.overwriteNewer++
        }
      } else if (d.action === "deleteRight") plan.deleteRight++
      else if (d.action === "deleteLeft") plan.deleteLeft++
    }
    return plan
  }
  /** Re-lists a compare's session (its shown rows) as a new version. */
  const relistCompare = (c: FakeCompare, emit: boolean) => {
    const version = (versions.get(c.queryId) ?? 1) + 1
    const rows = c.rows.filter((r) => c.show.includes(symbolOf(r.diff!)))
    sessions.set(c.queryId, rows)
    versions.set(c.queryId, version)
    const snap = { queryId: c.queryId, version, total: rows.length }
    if (emit)
      listeners
        .get("query.invalidated")
        ?.forEach((l) => (l as (p: EventMap["query.invalidated"]) => void)(snap))
    return snap
  }
  let nextDiff = 0
  const diffs = new Map<number, TextDiffRow[]>()
  /** Sessions over folders of connections (one folder, or all) show their listing again. */
  const relistRemote = (dirId?: number): void => {
    for (const [queryId, d] of descriptors) {
      if (d.remoteId === undefined || !sessions.has(queryId)) continue
      if (dirId !== undefined && d.remoteDirId !== dirId) continue
      const version = (versions.get(queryId) ?? 1) + 1
      sessions.set(queryId, rowsOf(d))
      versions.set(queryId, version)
      listeners.get("query.invalidated")?.forEach((l) =>
        (l as (p: EventMap["query.invalidated"]) => void)({
          queryId,
          version,
          total: sessions.get(queryId)!.length,
        }),
      )
    }
  }

  const opened = (f: FakeFolder) =>
    ok({
      dirId: f.dirId,
      path: f.path,
      name: f.crumbs.at(-1)?.name ?? f.path,
      scanId: ++nextScan,
      recursive: false,
      listedBefore: true,
      lastListedAt: 1,
      crumbs: f.crumbs,
    })

  const openDir = (path: string) => {
    const failure = options.fail?.[path]
    if (failure) return err(failure.code, failure.message, failure.details)
    const f = byPath.get(path)
    return f ? opened(f) : err("NOT_FOUND", "folder does not exist")
  }

  const api = {
    app: {
      exit: vi.fn(async () => ok({ ok: true })),
      switch: vi.fn(async () => ok({ ok: true })),
    },
    system: { ping: vi.fn(), info: vi.fn() },
    sidecar: { getStatus: vi.fn(async () => ok({ state: "ready" })) },
    library: {
      get: vi.fn(async () => {
        await options.libraryDelay
        return ok({ settings, bookmarks, recent: options.recent ?? [] })
      }),
      setSetting: vi.fn(async (key: string, value: unknown) => {
        settings[key] = value
        return ok({ ok: true })
      }),
      addBookmark: vi.fn(async (path: string, label: string, group = "") => {
        const existing = bookmarks.find((b) => b.path === path)
        if (existing) return ok(existing)
        const b = { id: ++nextBookmark, path, label: label || path.split(/[\\/]/).pop()!, group }
        bookmarks = [...bookmarks, b]
        bookmarksChanged()
        return ok(b)
      }),
      removeBookmark: vi.fn(async (id: number) => {
        bookmarks = bookmarks.filter((b) => b.id !== id)
        bookmarksChanged()
        return ok({ ok: true })
      }),
      updateBookmark: vi.fn(async (b: Bookmark) => {
        if (bookmarks.some((x) => x.path === b.path && x.id !== b.id))
          return err("INVALID_ARGUMENT", "duplicate", { reason: "duplicate" })
        bookmarks = bookmarks.map((x) => (x.id === b.id ? { ...b } : x))
        bookmarksChanged()
        return ok({ ...b })
      }),
      reorderBookmarks: vi.fn(async (ids: number[]) => {
        bookmarks = [
          ...ids.map((id) => bookmarks.find((b) => b.id === id)!).filter(Boolean),
          ...bookmarks.filter((b) => !ids.includes(b.id)),
        ]
        bookmarksChanged()
        return ok({ ok: true })
      }),
    },
    dir: {
      open: vi.fn(async ({ path }: { path: string }) => openDir(path)),
      openEntry: vi.fn(async ({ entryId }: { entryId: number }) => {
        const f = byId.get(entryId)
        return f ? opened(f) : err("NOT_FOUND", "folder is not in the index")
      }),
      cancelScan: vi.fn(async () => ok({ cancelled: true })),
      openContaining: vi.fn(async (entryId: number) => {
        const f = options.folders.find((g) => g.entries.some((e) => e.id === entryId))
        return f ? opened(f) : err("NOT_FOUND", "not in the index")
      }),
    },
    find: {
      start: vi.fn(async (spec: FindStartParams) => {
        const root = byPath.get(spec.roots[0] ?? "")
        if (!root) return err("NOT_FOUND", "folder does not exist")
        const findId = ++nextFind
        finds.set(findId, { spec, results: [] })
        const d: QueryDescriptor = {
          dirId: root.dirId,
          recursive: false,
          sort: [],
          kinds: [],
          search: "",
          exts: [],
          favorite: false,
          minRating: 0,
          tags: [],
          scope: "all",
          showHidden: true,
          findId,
        }
        sessions.set(++nextQuery, [])
        descriptors.set(nextQuery, d)
        return ok({ findId, queryId: nextQuery, version: 1, total: 0 })
      }),
      cancel: vi.fn(async (findId: number) => ok({ cancelled: finds.has(findId) })),
    },
    archive: {
      open: vi.fn(async (entryId: number) => {
        const a = (options.archives ?? []).find((x) => x.entryId === entryId)
        if (!a) return err("UNSUPPORTED_MEDIA", "not an archive", { reason: "notArchive" })
        if (a.error) return err(a.error.code, a.error.message, { reason: a.error.reason })
        const all = [...a.root, ...Object.values(a.dirs ?? {}).flat()]
        return ok({
          archiveId: a.archiveId,
          format: "zip" as const,
          entries: all.length,
          rejected: 0,
          bytes: all.reduce((n, e) => n + (e.kind === "dir" ? 0 : e.sizeBytes), 0),
          packedBytes: 100,
        })
      }),
      close: vi.fn(async () => ok({ closed: true })),
      check: vi.fn(async (selection: SelectionDescriptor) =>
        ok({
          files: resolve(selection).length,
          bytes: 1000,
          packedBytes: 100,
          freeBytes: 1e12,
          warnings: options.archiveWarnings ?? [],
          partial: false,
        }),
      ),
      tools: vi.fn(async () => ok({ sevenZip: options.sevenZip ?? false })),
    },
    compare: {
      dirs: vi.fn(async (p: CompareDirsParams) => {
        if (!byId.get(p.leftDirId) || !byId.get(p.rightDirId))
          return err("NOT_FOUND", "the folder is not in the index")
        if (p.leftDirId === p.rightDirId)
          return err("INVALID_ARGUMENT", "choose two separate folders", { reason: "nested" })
        const compareId = ++nextCompare
        sessions.set(++nextQuery, [])
        compares.set(compareId, {
          params: p,
          queryId: nextQuery,
          rows: [],
          defaults: new Map(),
          show: ["copyRight", "copyLeft", "different", "delete"],
          planVersion: 1,
          done: false,
        })
        return ok({ compareId, queryId: nextQuery, version: 1, total: 0 })
      }),
      cancel: vi.fn(async (compareId: number) =>
        ok({ cancelled: compares.get(compareId)?.done === false }),
      ),
      close: vi.fn(async (compareId: number) => {
        const c = compares.get(compareId)
        if (c) sessions.delete(c.queryId)
        return ok({ closed: compares.delete(compareId) })
      }),
      show: vi.fn(async (compareId: number, show: readonly CompareShow[]) => {
        const c = compares.get(compareId)
        if (!c) return err("NOT_FOUND", "the comparison is no longer available; compare again")
        c.show = [...show]
        c.planVersion++
        return ok({ ...relistCompare(c, false), plan: planOf(c) })
      }),
      setAction: vi.fn(
        async (compareId: number, sel: SelectionDescriptor, action: DiffAction | "default") => {
          const c = compares.get(compareId)
          if (!c) return err("NOT_FOUND", "the comparison is no longer available; compare again")
          let changed = false
          for (const r of resolve(sel)) {
            const d = r.diff!
            const next = action === "default" ? c.defaults.get(r.id)! : action
            if (next !== d.action && allowed(d.state, next)) {
              d.action = next
              changed = true
            }
          }
          if (changed) c.planVersion++
          return ok({ ...relistCompare(c, false), plan: planOf(c) })
        },
      ),
      plan: vi.fn(async (compareId: number) => {
        const c = compares.get(compareId)
        return c ? ok(planOf(c)) : err("NOT_FOUND", "the comparison is no longer available")
      }),
      // Unique or newer (by modifiedMs) files; another size at the same date marks both.
      marks: vi.fn(async (p: CompareMarksParams) => {
        const l = sessions.get(p.leftQueryId)
        const r = sessions.get(p.rightQueryId)
        if (!l || !r) return err("NOT_FOUND", "query session expired; reopen it")
        const side = (mine: ContentItem[], theirs: ContentItem[], queryId: number) => {
          const hits: number[] = []
          mine.forEach((e, i) => {
            if (e.kind === "dir") return
            const o = theirs.find((x) => x.kind !== "dir" && x.name === e.name)
            const newer = o && !p.ignoreDates && e.modifiedMs - o.modifiedMs > p.toleranceMs
            const older = o && !p.ignoreDates && o.modifiedMs - e.modifiedMs > p.toleranceMs
            if (!o || newer || (!older && o.sizeBytes !== e.sizeBytes)) hits.push(i)
          })
          return {
            sel: {
              queryId,
              version: versions.get(queryId) ?? 1,
              ranges: rangesOf(hits),
              include: [],
              exclude: [],
            },
            count: hits.length,
          }
        }
        const left = side(l, r, p.leftQueryId)
        const right = side(r, l, p.rightQueryId)
        return ok({
          left: left.sel,
          right: right.sel,
          leftCount: left.count,
          rightCount: right.count,
        })
      }),
    },
    diff: {
      open: vi.fn(async (leftId: number, rightId: number) => {
        const l = entryById(leftId)
        const r = entryById(rightId)
        if (!l || !r) return err("NOT_FOUND", "not in the index")
        const spec = options.textDiff ?? {}
        const file = (e: ContentItem, lines: number) => ({
          name: e.name,
          sizeBytes: e.sizeBytes,
          lines,
          encoding: spec.reason ? ("" as const) : ("utf-8" as const),
        })
        const rows = spec.rows ?? []
        const blocks: [number, number][] = []
        rows.forEach((row, i) => {
          if (row.op === "equal") return
          const last = blocks.at(-1)
          if (last && last[0] + last[1] === i) last[1]++
          else blocks.push([i, 1])
        })
        const diffId = spec.reason ? 0 : ++nextDiff
        if (diffId) diffs.set(diffId, rows)
        const res: TextDiffOpenResult = {
          diffId,
          reason: spec.reason ?? "",
          left: file(l, rows.filter((x) => x.l > 0).length),
          right: file(r, rows.filter((x) => x.r > 0).length),
          rows: rows.length,
          changes: blocks.length,
          blocks,
          identical: spec.identical ?? (blocks.length === 0 && !spec.reason),
        }
        return ok(res)
      }),
      page: vi.fn(async (diffId: number, offset: number, limit: number) => {
        const rows = diffs.get(diffId)
        if (!rows) return err("NOT_FOUND", "the comparison is no longer open; compare again")
        return ok({ offset, rows: rows.slice(offset, offset + limit) })
      }),
      close: vi.fn(async (diffId: number) => ok({ ok: diffs.delete(diffId) })),
    },
    // Stage C09: the multi-rename preview, one page of the named batch.
    rename: {
      preview: vi.fn(
        async (sel: SelectionDescriptor, plan: RenamePlan, offset: number, limit: number) => {
          let rows: RenamePreviewRow[]
          try {
            rows = renameRows(sel, plan)
          } catch (e) {
            const { field, message } = e as { field: string; message: string }
            return err("INVALID_ARGUMENT", message, { reason: "plan", field })
          }
          const count = (status: RenamePreviewRow["status"]): number =>
            rows.filter((r) => r.status === status).length
          return ok({
            total: rows.length,
            renamed: count("rename"),
            unchanged: count("unchanged"),
            invalid: count("invalid"),
            conflicts: count("conflict"),
            firstProblem: rows.findIndex((r) => r.status === "invalid" || r.status === "conflict"),
            offset,
            rows: rows.slice(offset, offset + limit),
          })
        },
      ),
      undoInfo: vi.fn(async () =>
        ok({ count: undo?.steps.length ?? 0, dir: undo?.dir ?? "", finishedMs: undo ? 1 : 0 }),
      ),
    },
    query: {
      open: vi.fn(async (d: QueryDescriptor) => {
        if (d.findId !== undefined && !finds.has(d.findId))
          return err("NOT_FOUND", "the search results are no longer available")
        if (!byId.get(d.dirId)) return err("NOT_FOUND", "folder is not indexed")
        if (d.remoteId !== undefined && !opens.has(d.remoteId)) return closedError()
        const rows = rowsOf(d)
        sessions.set(++nextQuery, rows)
        descriptors.set(nextQuery, d)
        return ok({ queryId: nextQuery, version: 1, total: rows.length })
      }),
      page: vi.fn(
        async ({ queryId, offset, limit }: { queryId: number; offset: number; limit: number }) => {
          const rows = sessions.get(queryId)
          if (!rows) return err("NOT_FOUND", "query session expired; reopen it")
          return ok({
            queryId,
            version: versions.get(queryId) ?? 1,
            total: rows.length,
            offset,
            items: rows.slice(offset, offset + limit),
          })
        },
      ),
      close: vi.fn(async (queryId: number) => ok({ closed: sessions.delete(queryId) })),
      indexOf: vi.fn(async (queryId: number, entryId: number) => {
        const rows = sessions.get(queryId)
        if (!rows) return err("NOT_FOUND", "query session expired; reopen it")
        return ok({ index: rows.findIndex((r) => r.id === entryId), version: 1 })
      }),
      // Prefix first, then substring, wrapping; "*" and "?" are wildcards.
      locate: vi.fn(
        async (p: { queryId: number; pattern: string; from: number; direction: string }) => {
          const rows = sessions.get(p.queryId) ?? []
          const n = rows.length
          const pat = p.pattern.toLowerCase()
          const wild = /[*?]/.test(pat)
          const tests = [
            (name: string) => (wild ? glob(pat + "*", name) : name.startsWith(pat)),
            (name: string) => (wild ? glob("*" + pat + "*", name) : name.includes(pat)),
          ]
          for (const t of tests) {
            for (let k = 0; k < n; k++) {
              const i = (((p.direction === "backward" ? p.from - k : p.from + k) % n) + n) % n
              if (t(rows[i]!.name.toLowerCase())) return ok({ index: i, version: 1 })
            }
          }
          return ok({ index: -1, version: 1 })
        },
      ),
      // Files only; "a;b|c" masks.
      match: vi.fn(async (queryId: number, mask: string) => {
        const rows = sessions.get(queryId) ?? []
        const [inc = "", exc = ""] = mask.split("|")
        const split = (m: string) => m.split(/[;\s]+/).filter((x) => x !== "")
        const includes = split(inc).map((m) => (m === "*.*" ? "*" : m))
        const hits: number[] = []
        rows.forEach((r, i) => {
          if (r.kind === "dir") return
          if (includes.length > 0 && !includes.some((m) => glob(m, r.name))) return
          if (split(exc).some((m) => glob(m, r.name))) return
          hits.push(i)
        })
        return ok({
          version: versions.get(queryId) ?? 1,
          ranges: rangesOf(hits),
          count: hits.length,
        })
      }),
    },
    selection: {
      info: vi.fn(async (sel: SelectionDescriptor) => {
        const items = resolve(sel)
        return ok({
          count: items.length,
          bytes: items.reduce(
            (n, r) => n + (r.kind === "dir" ? (r.dirSizeBytes ?? 0) : r.sizeBytes),
            0,
          ),
          folders: items.filter((r) => r.kind === "dir").length,
          images: 0,
          videos: 0,
        })
      }),
      rebase: vi.fn(async (sel: SelectionDescriptor) => ok(sel)),
    },
    jobs: {
      dirSize: vi.fn(async (sel: SelectionDescriptor) => {
        const dirs = resolve(sel).filter((r) => r.kind === "dir")
        for (const d of dirs) d.dirSizeBytes = 4096
        return ok({
          jobId: ++nextJob,
          kind: "dirSize" as const,
          state: "running" as const,
          total: dirs.length,
          done: 0,
          failed: 0,
          skipped: 0,
          bytesTotal: 0,
          bytesDone: 0,
          current: "",
          destination: "",
          error: "",
          startedMs: 1,
          finishedMs: 0,
          bytesPerSec: 0,
          etaMs: 0,
        })
      }),
      cancel: vi.fn(async () => ok({ cancelled: true })),
    },
    fs: {
      volumes: vi.fn(async () => {
        await options.volumesDelay
        return ok({ volumes: options.volumes ?? [] })
      }),
      // Stage C10.5: one level of subfolders for the folder tree.
      listDirs: vi.fn(async (path: string, showHidden: boolean) => {
        await options.dirsDelay
        const failure = options.fail?.[path]
        if (failure) return err(failure.code, failure.message, failure.details)
        const sep = path.includes("\\") ? "\\" : "/"
        const join = (name: string): string => (path.endsWith(sep) ? path : path + sep) + name
        const below = (p: string): string[] =>
          options.dirs?.[p] ??
          options.folders
            .filter((f) => f.crumbs.at(-2)?.path === p)
            .map((f) => f.crumbs.at(-1)!.name)
        const shown = (names: string[]): string[] =>
          names.filter((name) => showHidden || !name.startsWith("."))
        return ok({
          path,
          dirs: shown(below(path)).map((name) => ({
            name,
            path: join(name),
            hasChildren: shown(below(join(name))).length > 0,
          })),
          truncated: false,
        })
      }),
      // A new folder: added to the parent's listing (as Go's index would be).
      mkdir: vi.fn(async (parentDirId: number, path: string) => {
        const f = byId.get(parentDirId)
        if (!f) return err("NOT_FOUND", "the folder is not in the index")
        const first = path.split(/[\\/]/).filter((x) => x !== "")[0] ?? ""
        if (first === "" || first.includes(":"))
          return err(
            "INVALID_ARGUMENT",
            `${first}: The name contains characters that aren't allowed.`,
            {
              reason: "INVALID_NAME",
            },
          )
        const existing = f.entries.find((e) => e.name === first)
        if (existing) return ok({ entryId: existing.id, created: false })
        const id = ++nextEntry
        f.entries.push(item(id, first, { kind: "dir" }))
        return ok({ entryId: id, created: true })
      }),
      canTrash: vi.fn(async () => ok({ trash: options.trash ?? true })),
    },
    files: {
      start: vi.fn(async (p: CommanderJobParams) => {
        // Stage C08: a sync applies a compare's plan; two files are named by id.
        if (p.kind === "sync") {
          const c = compares.get(p.compareId)
          if (!c) return err("NOT_FOUND", "the comparison is no longer available; compare again")
          if (!c.done) return err("BUSY", "the comparison has not finished")
          if (p.planVersion !== c.planVersion)
            return err("INVALID_ARGUMENT", "the comparison changed since it was confirmed", {
              reason: "stalePlan",
            })
          const plan = planOf(c)
          const snap = job({
            kind: "sync",
            total:
              plan.copyRight.files +
              plan.copyLeft.files +
              plan.deleteRight +
              plan.deleteLeft +
              plan.folders,
            destination: byId.get(c.params.rightDirId)?.crumbs.at(-1)?.name ?? "",
          })
          jobs.push(snap)
          return ok(snap)
        }
        if (p.kind === "compareFiles") {
          // Two files by id, or (Stage C10.5) a selection against a folder.
          const total = "source" in p ? resolve(p.source.selection).length : 1
          if ("source" in p && !byId.has(p.destinationDirId))
            return err("NOT_FOUND", "the folder is not in the index")
          const snap = job({ kind: "compareFiles", total, state: "running" })
          jobs.push(snap)
          return ok(snap)
        }
        // Stage C09: an undo has no selection; a multi-rename renames what
        // its preview calls "rename" and keeps the journal.
        if (p.kind === "undoRename") {
          if (!undo)
            return err("INVALID_ARGUMENT", "jobs: invalid job: there is no multi-rename to undo")
          const steps = undo.steps
          undo = null
          for (const s of steps.toReversed()) setName(s.entry, s.old)
          const snap = job({ kind: "undoRename", total: steps.length, state: "running" })
          jobs.push(snap)
          return ok(snap)
        }
        if (p.kind === "multiRename") {
          let rows: RenamePreviewRow[]
          try {
            rows = renameRows(p.source.selection, p.plan)
          } catch (e) {
            const { field, message } = e as { field: string; message: string }
            return err("INVALID_ARGUMENT", message, { reason: "plan", field })
          }
          const entries = resolve(p.source.selection)
          const steps = rows.flatMap((r, i) =>
            r.status === "rename" ? [{ entry: entries[i]!, old: r.name, next: r.newName }] : [],
          )
          for (const s of steps) setName(s.entry, s.next)
          if (steps.length > 0) undo = { dir: folderOf(steps[0]!.entry)?.path ?? "", steps }
          const snap = job({ kind: "multiRename", total: rows.length, state: "running" })
          jobs.push(snap)
          return ok(snap)
        }
        if (p.kind === "setAttributes") {
          for (const e of resolve(p.source.selection)) {
            e.attrs = ((e.attrs ?? 0) & ~(p.clearAttrs ?? 0)) | (p.setAttrs ?? 0)
            if (p.modifiedMs !== undefined) e.modifiedMs = p.modifiedMs
          }
        }
        // Stage C10.5: between a connection and this computer.
        if (p.kind === "upload") {
          const dir = remoteDirs.get(p.remoteDirId)
          if (!dir || !opens.has(dir.remoteId)) return closedError()
          const snap = job({
            kind: "upload",
            total: resolve(p.source.selection).length,
            destination: dir.path,
          })
          jobs.push(snap)
          return ok(snap)
        }
        if (p.kind === "remoteDelete") {
          const gone = resolve(p.source.selection)
          for (const e of gone) {
            const at = remoteEntry(e.id)
            if (at)
              at.server.folders[at.path] = at.server.folders[at.path]!.filter((x) => x.id !== e.id)
          }
          const snap = job({ kind: "remoteDelete", total: gone.length })
          jobs.push(snap)
          relistRemote()
          return ok(snap)
        }
        const total = resolve(p.source.selection).length
        const snap = job({ kind: p.kind, total })
        if (p.kind === "download") {
          const dest = byId.get(p.destinationDirId)
          if (!dest) return err("NOT_FOUND", "the folder is not in the index")
          snap.destination = dest.crumbs.at(-1)?.name ?? ""
        }
        if (p.kind === "copy" || p.kind === "move" || p.kind === "extract" || p.kind === "pack") {
          const dest = byId.get(p.destinationDirId)
          if (!dest) return err("NOT_FOUND", "the folder is not in the index")
          snap.destination = dest.crumbs.at(-1)?.name ?? ""
        }
        jobs.push(snap)
        return ok(snap)
      }),
      pause: vi.fn(async () => ok({ ok: true })),
      resume: vi.fn(async () => ok({ ok: true })),
      startNow: vi.fn(async () => ok({ ok: true })),
      resolve: vi.fn(async () => ok({ ok: true })),
      errors: vi.fn(async () =>
        ok({
          errors: [
            {
              name: "locked.jpg",
              code: "IN_USE" as const,
              message: "The item is open in another program.",
            },
          ],
          total: 1,
        }),
      ),
      list: vi.fn(async () => ok({ jobs })),
      rename: vi.fn(async (entryId: number, name: string) => {
        if (name.includes("/"))
          return err("INVALID_ARGUMENT", "The name can't contain / or \\.", {
            reason: "INVALID_NAME",
          })
        for (const f of options.folders) {
          const e = f.entries.find((x) => x.id === entryId)
          if (e) {
            if (f.entries.some((x) => x.name === name && x.id !== entryId))
              return err("INVALID_ARGUMENT", `${name} already exists`, { reason: "ALREADY_EXISTS" })
            e.name = name
            const dot = name.lastIndexOf(".")
            e.ext = e.kind === "dir" || dot <= 0 ? "" : name.slice(dot + 1).toLowerCase()
            return ok({ name })
          }
        }
        return err("NOT_FOUND", "the item no longer exists")
      }),
    },
    clip: {
      set: vi.fn(async (sel: SelectionDescriptor, mode: "copy" | "cut") => {
        clip = { mode, count: resolve(sel).length }
        return ok(clip)
      }),
      get: vi.fn(async () => ok(clip)),
      paste: vi.fn(async (destinationDirId: number) => {
        if (clip.count === 0) return err("INVALID_ARGUMENT", "the clipboard is empty")
        if (!byId.get(destinationDirId)) return err("NOT_FOUND", "the folder is not in the index")
        const snap = job({ kind: clip.mode === "cut" ? "move" : "copy", total: clip.count })
        jobs.push(snap)
        return ok(snap)
      }),
    },
    clipboard: {
      copyPaths: vi.fn(async (sel: SelectionDescriptor) =>
        ok({ count: resolve(sel).length, truncated: false }),
      ),
      copyText: vi.fn(async () => ok({ ok: true })),
    },
    places: {
      list: vi.fn(async () =>
        ok({
          places: options.home ? [{ id: "home", label: "Home", path: options.home }] : [],
        }),
      ),
    },
    context: {
      publish: vi.fn(
        async (dirId: number, focusId: number | null, selection: SelectionDescriptor | null) => {
          // As Go: omitted (a folder change) keeps what the last switch carried.
          if (selection !== undefined)
            carried = selection ? resolve(selection).map((r) => r.id) : []
          context = {
            version: context.version + 1,
            app: "commander",
            dirId,
            path: "",
            focusId,
            selectionCount: selection ? carried.length : 0,
            selectionTooLarge: false,
          }
          if (selection !== undefined) carriedVersion = context.version
          return ok({ ok: true })
        },
      ),
      get: vi.fn(async () => ok(context)),
      selection: vi.fn(async (version: number, queryId: number) => {
        if (version !== carriedVersion)
          return err("INVALID_ARGUMENT", "no selection for that version")
        const rows = sessions.get(queryId) ?? []
        const hits = carried
          .map((id) => rows.findIndex((r) => r.id === id))
          .filter((i) => i >= 0)
          .sort((a, b) => a - b)
        return ok({ queryId, version: 1, ranges: rangesOf(hits), include: [], exclude: [] })
      }),
    },
    // Stage C10.5 (ADR-0037): what main and the sidecar do for connections.
    remote: {
      connections: vi.fn(async () => ok({ connections })),
      save: vi.fn(async (connection: SavedConnection, password?: string, forget?: boolean) => {
        if (password !== undefined && options.secureStore === false)
          return err("PERMISSION_DENIED", "no secure store", { reason: "noSecureStore" })
        const name = connection.name.trim()
        if (
          connections.some(
            (c) => c.id !== connection.id && c.name.toLowerCase() === name.toLowerCase(),
          )
        )
          return err("INVALID_ARGUMENT", "duplicate", { reason: "duplicate" })
        const id = connection.id || ++nextConnection
        if (password !== undefined) passwords.set(id, password)
        else if (forget) passwords.delete(id)
        const saved = { ...connection, id, name, hasPassword: passwords.has(id) }
        connections = [...connections.filter((c) => c.id !== id), saved]
        connectionsChanged()
        return ok({ ...saved })
      }),
      remove: vi.fn(async (connectionId: number) => {
        connections = connections.filter((c) => c.id !== connectionId)
        passwords.delete(connectionId)
        connectionsChanged()
        return ok({ ok: true })
      }),
      trust: vi.fn(async (connectionId: number, fingerprint: string) => {
        connections = connections.map((c) => (c.id === connectionId ? { ...c, fingerprint } : c))
        connectionsChanged()
        return ok({ ok: true })
      }),
      connect: vi.fn(async (p: RemoteConnectParams) => {
        const saved = "connectionId" in p ? connections.find((c) => c.id === p.connectionId) : null
        if ("connectionId" in p && !saved) return err("NOT_FOUND", "no such connection")
        const target = saved ?? ("quick" in p ? p.quick : null)!
        const server = (options.servers ?? []).find(
          (s) => s.host === target.host && (s.port ?? 21) === target.port,
        )
        if (!server)
          return err("NOT_FOUND", "The server's name could not be found.", { reason: "host" })
        await server.delay
        if (cancelledAttempts.delete(p.attempt)) return err("CANCELLED", "cancelled")
        if (server.fail) return err("INVALID_PATH", server.fail, { reason: server.fail })
        const encrypted = target.tls !== "none"
        if (encrypted && server.tls === false)
          return err("PERMISSION_DENIED", "The server does not offer encryption (TLS).", {
            reason: "tlsRequired",
          })
        if (encrypted && server.fingerprint) {
          const pinned = saved?.fingerprint ?? ""
          if ((p.accept ?? pinned) !== server.fingerprint)
            return err("PERMISSION_DENIED", "The server's certificate could not be verified.", {
              reason: "certificate",
              fingerprint: server.fingerprint,
              subject: server.subject ?? "",
              changed: pinned !== "" && pinned !== server.fingerprint,
            })
        }
        const password = p.password ?? (saved ? (passwords.get(saved.id) ?? "") : "")
        if (server.password !== undefined && password !== server.password)
          return err("PERMISSION_DENIED", "The server refused the user name or the password.", {
            reason: "auth",
          })
        opens.set(++nextRemote, { server })
        return ok({
          remoteId: nextRemote,
          host: target.host,
          port: target.port,
          user: target.user,
          encrypted,
          features: { mlsd: true, resume: true, utf8: true },
          startPath: saved?.startPath || "/",
          localPath: saved?.localPath ?? "",
        })
      }),
      cancel: vi.fn(async (attempt: number) => {
        const listing = stalled.get(attempt)
        if (listing) {
          stalled.delete(attempt)
          listing()
        } else cancelledAttempts.add(attempt)
        return ok({ ok: true })
      }),
      disconnect: vi.fn(async (remoteId: number) => {
        if (!opens.delete(remoteId)) return closedError()
        // Its sessions go with it.
        for (const [queryId, d] of descriptors)
          if (d.remoteId === remoteId) sessions.delete(queryId)
        return ok({ ok: true })
      }),
      open: vi.fn(async (remoteId: number, folder: string | number, attempt?: number) => {
        const open = opens.get(remoteId)
        if (!open) return closedError()
        // A server that stops answering: until the listing is cancelled.
        if (open.server.stall) {
          await new Promise<void>((resolve) => stalled.set(attempt ?? 0, resolve))
          return err("CANCELLED", "cancelled")
        }
        const path = typeof folder === "string" ? folder : remotePathOf(remoteId, folder)
        if (path === null || !open.server.folders[path])
          return err("NOT_FOUND", "There is no such file or folder on the server.", {
            reason: "notFound",
          })
        const crumbs: Crumb[] = [{ name: "/", path: "/" }]
        let at = ""
        for (const part of path.split("/").filter(Boolean)) {
          at += `/${part}`
          crumbs.push({ name: part, path: at })
        }
        const id = remoteDirId(remoteId, path)
        relistRemote(id)
        return ok({
          remoteDirId: id,
          path,
          name: crumbs.at(-1)!.name,
          crumbs,
          rejected: open.server.rejected?.[path] ?? 0,
        })
      }),
      mkdir: vi.fn(async (dirId: number, name: string) => {
        const dir = remoteDirs.get(dirId)
        const server = dir && opens.get(dir.remoteId)?.server
        if (!dir || !server) return closedError()
        if (name === "" || /[/\\]/.test(name))
          return err("INVALID_ARGUMENT", "This name can't be used on a server.")
        if (server.folders[dir.path]!.some((e) => e.name === name))
          return err("INVALID_ARGUMENT", "550 File exists", { reason: "refused" })
        server.folders[dir.path]!.push(item(++nextRemoteEntry, name, { kind: "dir" }))
        server.folders[joinRemote(dir.path, name)] = []
        relistRemote(dirId)
        return ok({ ok: true })
      }),
      rename: vi.fn(async (entryId: number, name: string) => {
        const at = remoteEntry(entryId)
        if (!at) return closedError()
        if (name === "" || /[/\\]/.test(name))
          return err("INVALID_ARGUMENT", "This name can't be used on a server.")
        // A renamed entry is a new entry of the listing, as in Go.
        const renamed = { ...at.entry, id: ++nextRemoteEntry }
        setName(renamed, name)
        at.server.folders[at.path] = at.server.folders[at.path]!.map((e) =>
          e.id === entryId ? renamed : e,
        )
        relistRemote()
        return ok({ ok: true })
      }),
      secureStore: vi.fn(async () => ok({ available: options.secureStore !== false })),
    },
    onEvent: vi.fn(<C extends EventChannel>(channel: C, listener: (p: EventMap[C]) => void) => {
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      set.add(listener as (p: never) => void)
      return () => set.delete(listener as (p: never) => void)
    }),
  }
  // Stage C05: token URLs serve the contents with Range; reads are recorded.
  const tokens = new Map<string, Uint8Array>()
  const reads: { url: string; start: number; end: number }[] = []
  setRangeFetch(async (url, start, end) => {
    const bytes = tokens.get(url)
    if (!bytes) throw new Error("The file can no longer be read.")
    reads.push({ url, start, end })
    return bytes.slice(start, end + 1)
  })
  const shell: ShellRecord[] = []
  const runs: RunRecord[] = []
  const refuseRun = () =>
    options.runFails
      ? err(
          options.runFails.code,
          options.runFails.message,
          options.runFails.reason ? { reason: options.runFails.reason } : undefined,
        )
      : null
  const entryById = (id: number): ContentItem | undefined => {
    for (const f of options.folders) {
      const found = f.entries.find((e) => e.id === id)
      if (found) return found
    }
    return undefined
  }
  const tokenOf = (id: number): string => `panelyth-media://m/${id.toString(16).padStart(32, "0")}`
  const viewers = {
    media: {
      open: vi.fn(async (id: number) => {
        const e = entryById(id)
        if (!e || (e.kind !== "image" && e.kind !== "video"))
          return err("NOT_FOUND", "not an indexed image or video")
        return ok({
          url: tokenOf(id),
          kind: e.kind,
          mime: e.kind === "image" ? "image/jpeg" : "video/mp4",
          width: 800,
          height: 600,
          durationMs: e.kind === "video" ? 5000 : 0,
          videoCodec: e.kind === "video" ? "h264" : "",
          audioCodec: "",
        })
      }),
    },
    preview: {
      ensure: vi.fn(async (p: { profile?: string; items: { id: number }[] }) =>
        ok({
          items: p.items.map(({ id }) => ({
            id,
            // As the sidecar answers: each item names its profile (the tile stores check it).
            ...(p.profile !== undefined && { profile: p.profile }),
            url: `panelyth-thumb://t/${id.toString(16).padStart(64, "f")}.jpg`,
            width: 800,
            height: 600,
          })),
        }),
      ),
    },
    props: {
      get: vi.fn(async (id: number) => {
        const e = entryById(id)
        if (!e) return err("NOT_FOUND", "not in the index")
        return ok({
          id,
          kind: e.kind,
          name: e.name,
          ext: e.ext,
          path: `C:\\fake\\${e.name}`,
          exists: true,
          sizeBytes: e.sizeBytes,
          modifiedMs: e.modifiedMs,
          createdMs: null,
          accessedMs: null,
          width: null,
          height: null,
          childFolders: e.kind === "dir" ? 3 : null,
          childMedia: null,
          ...(e.attrs ? { attrs: e.attrs } : {}),
          permissions: options.permissions ?? null,
          linkTarget: e.kind === "link" ? "C:\\target\\" + e.name : null,
          favorite: false,
          rating: 0,
          label: 0,
          tags: [],
        })
      }),
    },
    file: {
      open: vi.fn(async (id: number) => {
        const e = entryById(id)
        if (!e) return err("NOT_FOUND", "not in the index")
        if (e.kind === "dir") return err("INVALID_ARGUMENT", "a folder has no contents to view")
        const bytes = options.contents?.[id] ?? new Uint8Array(e.sizeBytes)
        const url = tokenOf(id)
        tokens.set(url, bytes)
        return ok({
          url,
          kind: e.kind,
          mime: "application/octet-stream",
          sizeBytes: bytes.length,
        })
      }),
    },
    document: {
      open: vi.fn(async (id: number, _theme?: string, _lang?: string) => {
        shell.push({ action: "document", entryId: id })
        return ok({ ok: true })
      }),
    },
    shell: {
      open: vi.fn(async (id: number, allowProgram?: boolean) => {
        if (options.programs?.includes(id) && allowProgram !== true)
          return err("PERMISSION_DENIED", "this file is a program; confirm to run it", {
            reason: "program",
          })
        shell.push({ action: "open", entryId: id })
        return ok({ ok: true })
      }),
      edit: vi.fn(async (id: number) => {
        const e = entryById(id)
        if (!e || e.kind === "dir")
          return err("PERMISSION_DENIED", "a folder cannot be edited", { reason: "folder" })
        shell.push({ action: "edit", entryId: id })
        return ok({ ok: true })
      }),
      run: vi.fn(async (p: { command: string; dirId: number; console?: boolean }) => {
        const refused = refuseRun()
        if (refused) return refused
        if (!byId.has(p.dirId)) return err("NOT_FOUND", "not in the index")
        runs.push({
          action: "run",
          command: p.command,
          dirId: p.dirId,
          console: p.console === true,
        })
        return ok({ ok: true })
      }),
      runTool: vi.fn(
        async (p: {
          toolId: string
          dirId: number
          otherDirId?: number
          cursorId?: number
          selection?: SelectionDescriptor
        }) => {
          const refused = refuseRun()
          if (refused) return refused
          runs.push({
            action: "runTool",
            toolId: p.toolId,
            dirId: p.dirId,
            otherDirId: p.otherDirId ?? null,
            cursorId: p.cursorId ?? null,
            selection: p.selection ?? null,
          })
          return ok({ ok: true })
        },
      ),
    },
  }
  const fs = Object.assign(api.fs, {
    // Shift+F4: an empty file added to the parent's listing (as Go indexes it).
    mkfile: vi.fn(async (parentDirId: number, name: string) => {
      const f = byId.get(parentDirId)
      if (!f) return err("NOT_FOUND", "the folder is not in the index")
      if (name === "" || /[\\/:]/.test(name))
        return err(
          "INVALID_ARGUMENT",
          `${name}: The name contains characters that aren't allowed.`,
          {
            reason: "INVALID_NAME",
          },
        )
      const existing = f.entries.find((e) => e.name === name)
      if (existing?.kind === "dir")
        return err("INVALID_ARGUMENT", `${name} exists and is not a file`, { reason: "EXISTS" })
      if (existing) return ok({ entryId: existing.id, created: false })
      const id = ++nextEntry
      f.entries.push(item(id, name))
      return ok({ entryId: id, created: true })
    }),
  })
  const full = Object.assign(api, viewers, { fs })
  window.panelyth = full as unknown as CommanderApi

  return {
    api: full,
    settings,
    /** The viewer published a context (as the sidecar would hold it), carrying these ids. */
    setContext(
      next: Partial<Omit<SharedContext, "version">> & Pick<SharedContext, "app" | "dirId">,
      ids: number[] = [],
    ) {
      carried = ids
      carriedVersion = context.version + 1
      context = {
        path: "",
        focusId: null,
        selectionCount: ids.length,
        selectionTooLarge: false,
        ...next,
        version: context.version + 1,
      }
    },
    emit<C extends EventChannel>(channel: C, payload: EventMap[C]) {
      if (channel === "query.invalidated") {
        const snap = payload as EventMap["query.invalidated"]
        versions.set(snap.queryId, snap.version)
      }
      listeners.get(channel)?.forEach((l) => (l as (p: EventMap[C]) => void)(payload))
    },
    lastDescriptor: (): QueryDescriptor => api.query.open.mock.calls.at(-1)![0],
    /** A job snapshot as Go would send it. */
    job,
    /** A folder of the fake filesystem (tests change its entries, then relist). */
    folder: (dirId: number): FakeFolder | undefined => byId.get(dirId),
    /** A folder's session changed in Go: every session of it gets a new version (and is re-sorted). */
    relist(dirId: number) {
      for (const [queryId, d] of descriptors) {
        if (d.dirId !== dirId) continue
        const v = (versions.get(queryId) ?? 1) + 1
        sessions.set(queryId, rowsOf(d))
        versions.set(queryId, v)
        listeners.get("query.invalidated")?.forEach((l) =>
          (l as (p: EventMap["query.invalidated"]) => void)({
            queryId,
            version: v,
            total: sessions.get(queryId)!.length,
          }),
        )
      }
    },
    /**
     * Stage C06: a search found its results (files below its first root
     * matching its mask, in folder order): every session over it gets a new
     * version, then find.progress reports the final state.
     */
    finishFind(findId: number, state: FindProgress["state"] = "completed") {
      const run = finds.get(findId)!
      const root = byPath.get(run.spec.roots[0]!)!
      run.results = subtree(root).flatMap((g) =>
        g.entries
          .filter((e) => e.kind !== "dir" && maskMatch(run.spec.mask || "*", e.name))
          .map((e) => ({ ...e, dirPath: g.path })),
      )
      for (const [queryId, d] of descriptors) {
        if (d.findId !== findId || !sessions.has(queryId)) continue
        const v = (versions.get(queryId) ?? 1) + 1
        sessions.set(queryId, rowsOf(d))
        versions.set(queryId, v)
        listeners.get("query.invalidated")?.forEach((l) =>
          (l as (p: EventMap["query.invalidated"]) => void)({
            queryId,
            version: v,
            total: sessions.get(queryId)!.length,
          }),
        )
      }
      const progress: FindProgress = {
        findId,
        state,
        dirs: subtree(root).length,
        entries: 0,
        searched: 0,
        bytes: 0,
        errors: 0,
        current: root.path,
        matches: run.results.length,
        truncated: false,
        firstMatchMs: run.results.length > 0 ? 5 : -1,
        elapsedMs: 12,
      }
      listeners.get("find.progress")?.forEach((l) => (l as (p: FindProgress) => void)(progress))
    },
    /**
     * Stage C08: a compare finished with these rows: its session gets a new
     * version, then compare.progress reports the final state.
     */
    finishCompare(compareId: number, rows: ContentItem[], over: Partial<CompareProgress> = {}) {
      const c = compares.get(compareId)!
      c.rows = rows
      c.defaults = new Map(rows.map((r) => [r.id, r.diff!.action]))
      c.done = (over.state ?? "completed") === "completed"
      if (c.done) c.planVersion++
      relistCompare(c, true)
      const progress: CompareProgress = {
        compareId,
        state: "completed",
        phase: "listing",
        dirs: 4,
        entries: rows.length * 2,
        compared: 0,
        bytes: 0,
        errors: 0,
        links: 0,
        rows: rows.length,
        truncated: false,
        elapsedMs: 120,
        ...over,
      }
      listeners
        .get("compare.progress")
        ?.forEach((l) => (l as (p: CompareProgress) => void)(progress))
    },
    /** The parameters the last compare started with. */
    lastCompare: () => [...compares.values()].at(-1),
    /** The compares still open in "Go". */
    openCompares: (): number[] => [...compares.keys()],
    /** The text diffs still open in "Go". */
    openDiffs: (): number[] => [...diffs.keys()],
    /** The search sessions still open (the dialog's and fed panels'). */
    openSessions: (): number[] => [...sessions.keys()],
    bookmarks: (): Bookmark[] => bookmarks,
    /** Stage C10.5: the saved connections, the "secret store" and the open connections. */
    connections: (): SavedConnection[] => connections,
    storedPassword: (connectionId: number): string | undefined => passwords.get(connectionId),
    openConnections: (): number[] => [...opens.keys()],
    /** The server went away: every command on the connection now says it is closed. */
    dropConnection(remoteId: number) {
      opens.delete(remoteId)
      for (const [queryId, d] of descriptors) if (d.remoteId === remoteId) sessions.delete(queryId)
    },
    /** Stage C05: shell actions main would have performed. */
    shell,
    /** Stage C10: commands main would have run. */
    runs,
    /** Stage C05: Range reads of token URLs. */
    reads,
    /** Another app (the viewer) changed the bookmarks. */
    setBookmarks(next: Bookmark[]) {
      bookmarks = next
      bookmarksChanged()
    },
  }
}
