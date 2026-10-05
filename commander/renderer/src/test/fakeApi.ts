import {
  ENTRY_ATTRS,
  type CommanderApi,
  type ContentItem,
  type Crumb,
  type ErrorCode,
  type EventChannel,
  type EventMap,
  type QueryDescriptor,
  type SharedContext,
  type Volume,
} from "@fastview/contracts"
import { vi } from "vitest"

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
  const settings: Record<string, unknown> = { ...options.settings }
  let context: SharedContext = options.context ?? {
    version: 0,
    app: "",
    dirId: 0,
    path: "",
    focusId: null,
  }
  let nextQuery = 0
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
      get: vi.fn(async () => ok({ settings, bookmarks: [], recent: [] })),
      setSetting: vi.fn(async (key: string, value: unknown) => {
        settings[key] = value
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
    },
    query: {
      open: vi.fn(async (d: QueryDescriptor) => {
        const f = byId.get(d.dirId)
        if (!f) return err("NOT_FOUND", "folder is not indexed")
        const key = d.sort[0] ?? { field: "name", direction: "asc" }
        const hidden = ENTRY_ATTRS.hidden | ENTRY_ATTRS.system
        const rows = f.entries
          .filter((e) => d.showHidden || ((e.attrs ?? 0) & hidden) === 0)
          .sort((a, b) => {
            const dirs = Number(b.kind === "dir") - Number(a.kind === "dir")
            if (dirs !== 0) return dirs
            const c = compare(key.field, a, b)
            return (key.direction === "desc" ? -c : c) || a.name.localeCompare(b.name)
          })
        sessions.set(++nextQuery, rows)
        return ok({ queryId: nextQuery, version: 1, total: rows.length })
      }),
      page: vi.fn(
        async ({ queryId, offset, limit }: { queryId: number; offset: number; limit: number }) => {
          const rows = sessions.get(queryId)
          if (!rows) return err("NOT_FOUND", "query session expired; reopen it")
          return ok({
            queryId,
            version: 1,
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
    },
    fs: {
      volumes: vi.fn(async () => ok({ volumes: options.volumes ?? [] })),
    },
    places: {
      list: vi.fn(async () =>
        ok({
          places: options.home ? [{ id: "home", label: "Home", path: options.home }] : [],
        }),
      ),
    },
    context: {
      publish: vi.fn(async (dirId: number, focusId: number | null) => {
        context = { version: context.version + 1, app: "commander", dirId, path: "", focusId }
        return ok({ ok: true })
      }),
      get: vi.fn(async () => ok(context)),
    },
    onEvent: vi.fn(<C extends EventChannel>(channel: C, listener: (p: EventMap[C]) => void) => {
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      set.add(listener as (p: never) => void)
      return () => set.delete(listener as (p: never) => void)
    }),
  }
  window.fastview = api as unknown as CommanderApi

  return {
    api,
    settings,
    /** The viewer published a context (as the sidecar would hold it). */
    setContext(next: Omit<SharedContext, "version">) {
      context = { ...next, version: context.version + 1 }
    },
    emit<C extends EventChannel>(channel: C, payload: EventMap[C]) {
      listeners.get(channel)?.forEach((l) => (l as (p: EventMap[C]) => void)(payload))
    },
    lastDescriptor: (): QueryDescriptor => api.query.open.mock.calls.at(-1)![0],
  }
}
