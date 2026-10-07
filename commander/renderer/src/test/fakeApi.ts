import {
  ENTRY_ATTRS,
  type Bookmark,
  type CommanderApi,
  type CommanderJobParams,
  type JobSnapshot,
  type ContentItem,
  type Crumb,
  type ErrorCode,
  type EventChannel,
  type EventMap,
  type FindProgress,
  type FindStartParams,
  type QueryDescriptor,
  type RecentFolder,
  type SelectionDescriptor,
  type SharedContext,
  type Volume,
} from "@fastview/contracts"
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

export interface FakeOptions {
  folders: FakeFolder[]
  settings?: Record<string, unknown>
  context?: SharedContext
  home?: string
  volumes?: Volume[]
  /** dir.open of these paths fails with the given error. */
  fail?: Record<string, { code: ErrorCode; message: string; details?: unknown }>
  /** Ids carried by the initial context. */
  carried?: number[]
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
}

/** What main would have done for shell.open / shell.edit (FASTVIEW_TEST_SHELL=record). */
export interface ShellRecord {
  action: "open" | "edit"
  entryId: number
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
    if (d.findId !== undefined) {
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
    query: {
      open: vi.fn(async (d: QueryDescriptor) => {
        if (d.findId !== undefined && !finds.has(d.findId))
          return err("NOT_FOUND", "the search results are no longer available")
        if (!byId.get(d.dirId)) return err("NOT_FOUND", "folder is not indexed")
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
        return ok({ version: 1, ranges: rangesOf(hits), count: hits.length })
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
        const total = resolve(p.source.selection).length
        const snap = job({ kind: p.kind, total })
        if (p.kind === "copy" || p.kind === "move") {
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
  const entryById = (id: number): ContentItem | undefined => {
    for (const f of options.folders) {
      const found = f.entries.find((e) => e.id === id)
      if (found) return found
    }
    return undefined
  }
  const tokenOf = (id: number): string => `fastview-media://m/${id.toString(16).padStart(32, "0")}`
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
      ensure: vi.fn(async (p: { items: { id: number }[] }) =>
        ok({
          items: p.items.map(({ id }) => ({
            id,
            url: `fastview-thumb://t/${id.toString(16).padStart(64, "f")}.jpg`,
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
  window.fastview = full as unknown as CommanderApi

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
    /** The search sessions still open (the dialog's and fed panels'). */
    openSessions: (): number[] => [...sessions.keys()],
    bookmarks: (): Bookmark[] => bookmarks,
    /** Stage C05: shell actions main would have performed. */
    shell,
    /** Stage C05: Range reads of token URLs. */
    reads,
    /** Another app (the viewer) changed the bookmarks. */
    setBookmarks(next: Bookmark[]) {
      bookmarks = next
      bookmarksChanged()
    },
  }
}
