import type {
  ClipState,
  ContentItem,
  JobSnapshot,
  JobStartParams,
  EventChannel,
  EventMap,
  FastViewApi,
  PreviewItem,
  CoverSlot,
  RpcEnvelope,
  SidecarStatus,
} from "@fastview/contracts"
import { vi } from "vitest"

export const readyStatus: SidecarStatus = {
  state: "ready",
  pid: 42,
  protocol: 1,
  version: "test",
  restarts: 0,
  lastError: null,
  since: 1,
}

const ok = <R>(r: R): RpcEnvelope<R> => ({ ok: true, r })

/** Crumbs for a POSIX-style fake path ("/photos/Trip" -> /, /photos, /photos/Trip). */
export function crumbsOf(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean)
  return [
    { name: "/", path: "/" },
    ...parts.map((name, i) => ({ name, path: "/" + parts.slice(0, i + 1).join("/") })),
  ]
}

export function makeItems(n: number, dirs = 0): ContentItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    kind: i < dirs ? ("dir" as const) : ("image" as const),
    name: i < dirs ? `folder ${i + 1}` : `IMG_${i}.jpg`,
    ext: i < dirs ? "" : "jpg",
    sizeBytes: i * 1000,
    modifiedMs: 1_704_067_200_000 + i * 1000,
    favorite: false,
    rating: 0,
    label: 0,
    thumb: null,
  }))
}

/**
 * Installs a fake window.fastview backed by a tiny in-memory "sidecar".
 * `items` is what query pages return; `push` emits events like main does.
 */
export function installFakeBridge(initial: SidecarStatus = readyStatus) {
  const listeners = new Map<EventChannel, Set<(p: never) => void>>()
  const backend = {
    items: [] as ContentItem[],
    version: 1,
    nextScan: 1,
    nextQuery: 1,
    /** Fake filesystem for the folder tree: path -> subfolder names. */
    dirs: new Map<string, string[]>([
      ["/", ["photos", "videos"]],
      ["/photos", ["Trip", "Family"]],
    ]),
    settings: {} as Record<string, unknown>,
    bookmarks: [] as { id: number; path: string; label: string }[],
    recent: [] as { path: string; lastOpenedAt: number }[],
    clip: { mode: "", count: 0 } as ClipState,
    nextJob: 1,
    jobs: [] as JobStartParams[],
    tags: [{ id: 1, name: "Holiday", count: 3 }],
  }
  const snapshot = (kind: JobSnapshot["kind"], total: number): JobSnapshot => ({
    jobId: backend.nextJob++,
    kind,
    state: "queued",
    total,
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
  })
  const count = (sel: { ranges: [number, number][]; include: number[]; exclude: number[] }) =>
    sel.ranges.reduce((n, [a, b]) => n + b - a, 0) + sel.include.length - sel.exclude.length
  const child = (parent: string, name: string) =>
    parent === "/" ? `/${name}` : `${parent}/${name}`

  const api = {
    app: { exit: vi.fn(async () => ok({ ok: true })) },
    system: {
      ping: vi.fn(async () => ok({ pong: true as const, serverTimeNs: 1 })),
      info: vi.fn(async () =>
        ok({
          version: "test",
          goVersion: "go1.27.0",
          pid: 42,
          protocol: 1,
          uptimeMs: 1,
          goroutines: 3,
          heapBytes: 1,
          runtimeMemBytes: 1,
          numCpu: 8,
        }),
      ),
    },
    sidecar: { getStatus: vi.fn(async () => ok(initial)) },
    dialog: {
      openFolder: vi.fn(async (): Promise<RpcEnvelope<{ path: string | null }>> =>
        ok({ path: "/photos/Trip" }),
      ),
    },
    dir: {
      open: vi.fn(async (p: { path: string; recursive: boolean }) =>
        ok({
          dirId: 1,
          path: p.path,
          name: p.path.split("/").pop() || p.path,
          scanId: backend.nextScan++,
          recursive: p.recursive,
          listedBefore: false,
          lastListedAt: null,
          crumbs: crumbsOf(p.path),
        }),
      ),
      openEntry: vi.fn(async (p: { entryId: number; recursive: boolean }) =>
        ok({
          dirId: p.entryId,
          path: `/entry/${p.entryId}`,
          name: `entry ${p.entryId}`,
          scanId: backend.nextScan++,
          recursive: p.recursive,
          listedBefore: true,
          lastListedAt: 1,
          crumbs: crumbsOf(`/entry/${p.entryId}`),
        }),
      ),
      cancelScan: vi.fn(async () => ok({ cancelled: true })),
    },
    media: {
      open: vi.fn(async (entryId: number) =>
        ok({
          url: `fastview-media://m/${String(entryId).padStart(32, "0")}`,
          kind: "image" as const,
          mime: "image/jpeg",
          width: 4000,
          height: 3000,
          durationMs: 0,
          videoCodec: "",
          audioCodec: "",
        }),
      ),
    },
    preview: {
      ensure: vi.fn(async (p: { items: { id: number }[] }) =>
        ok({
          items: [] as PreviewItem[],
          queued: p.items.length,
          deferred: 0,
        }),
      ),
    },
    folder: {
      covers: vi.fn(async (p: { items: { id: number }[] }) =>
        ok({ items: p.items.map(({ id }) => ({ dirId: id, slots: [] as CoverSlot[] })) }),
      ),
    },
    query: {
      open: vi.fn(async (_descriptor: Record<string, unknown>) =>
        ok({
          queryId: backend.nextQuery++,
          version: backend.version,
          total: backend.items.length,
        }),
      ),
      page: vi.fn(async (p: { queryId: number; offset: number; limit: number }) =>
        ok({
          queryId: p.queryId,
          version: backend.version,
          total: backend.items.length,
          offset: p.offset,
          items: backend.items.slice(p.offset, p.offset + p.limit),
        }),
      ),
      close: vi.fn(async () => ok({ closed: true })),
      facets: vi.fn(async () =>
        ok({
          folders: backend.items.filter((i) => i.kind === "dir").length,
          images: backend.items.filter((i) => i.kind === "image").length,
          videos: backend.items.filter((i) => i.kind === "video").length,
          exts: [{ ext: "jpg", count: backend.items.filter((i) => i.ext === "jpg").length }],
        }),
      ),
    },
    selection: {
      info: vi.fn(async (sel: { ranges: [number, number][]; include: number[] }) =>
        ok({
          count: sel.ranges.reduce((n, [a, b]) => n + b - a, 0) + sel.include.length,
          bytes: 1234,
          folders: 0,
          images: 1,
          videos: 0,
        }),
      ),
      rebase: vi.fn(async (sel: { queryId: number; ranges: [number, number][] }) =>
        ok({ ...sel, version: backend.version, include: [], exclude: [] }),
      ),
    },
    props: {
      get: vi.fn(async (entryId: number) => {
        const item = backend.items.find((i) => i.id === entryId)
        return ok({
          id: entryId,
          kind: item?.kind ?? "image",
          name: item?.name ?? "x",
          ext: item?.ext ?? "",
          path: `/photos/Trip/${item?.name ?? "x"}`,
          exists: true,
          sizeBytes: item?.sizeBytes ?? 0,
          modifiedMs: item?.modifiedMs ?? 0,
          createdMs: 1_700_000_000_000,
          accessedMs: null,
          width: 4000,
          height: 3000,
          childFolders: null,
          childMedia: null,
          favorite: item?.favorite ?? false,
          rating: item?.rating ?? 0,
          tags: [] as string[],
        })
      }),
    },
    fs: {
      volumes: vi.fn(async () =>
        ok({ volumes: [{ path: "/", label: "", kind: "fixed" as const }] }),
      ),
      listDirs: vi.fn(async (path: string) =>
        ok({
          path,
          dirs: (backend.dirs.get(path) ?? []).map((name) => ({
            name,
            path: child(path, name),
            hasChildren: backend.dirs.has(child(path, name)),
          })),
          truncated: false,
        }),
      ),
    },
    places: {
      list: vi.fn(async () =>
        ok({ places: [{ id: "pictures" as const, label: "Pictures", path: "/photos" }] }),
      ),
    },
    library: {
      get: vi.fn(async () =>
        ok({
          settings: { ...backend.settings },
          bookmarks: [...backend.bookmarks],
          recent: [...backend.recent],
        }),
      ),
      setSetting: vi.fn(async (key: string, value: unknown) => {
        backend.settings[key] = value
        return ok({ ok: true })
      }),
      addBookmark: vi.fn(async (path: string, label: string) => {
        const b = {
          id: backend.bookmarks.length + 1,
          path,
          label: label || path.split("/").pop() || path,
        }
        backend.bookmarks.push(b)
        return ok(b)
      }),
      removeBookmark: vi.fn(async (id: number) => {
        backend.bookmarks = backend.bookmarks.filter((b) => b.id !== id)
        return ok({ ok: true })
      }),
      tags: vi.fn(async () => ok({ tags: [...backend.tags] })),
      deleteTag: vi.fn(async () => ok({ ok: true })),
    },
    jobs: {
      start: vi.fn(async (p: JobStartParams) => {
        backend.jobs.push(p)
        return ok(snapshot(p.kind, count(p.source.selection)))
      }),
      cancel: vi.fn(async () => ok({ cancelled: true })),
      errors: vi.fn(async () =>
        ok({
          errors: [{ name: "IMG_1.jpg", code: "IN_USE" as const, message: "The item is open." }],
          total: 1,
        }),
      ),
      list: vi.fn(async () => ok({ jobs: [] as JobSnapshot[] })),
    },
    clip: {
      set: vi.fn(
        async (
          sel: { ranges: [number, number][]; include: number[]; exclude: number[] },
          mode: "copy" | "cut",
        ) => {
          backend.clip = { mode, count: count(sel) }
          return ok(backend.clip)
        },
      ),
      get: vi.fn(async () => ok(backend.clip)),
      paste: vi.fn(async () =>
        ok(snapshot(backend.clip.mode === "cut" ? "move" : "copy", backend.clip.count)),
      ),
    },
    entry: {
      rename: vi.fn(async (_id: number, name: string): Promise<RpcEnvelope<{ name: string }>> =>
        name.includes("/")
          ? {
              ok: false,
              e: {
                code: "INVALID_ARGUMENT",
                message: "The name can't contain a slash.",
                retryable: false,
              },
            }
          : ok({ name }),
      ),
    },
    shell: {
      open: vi.fn(async () => ok({ ok: true })),
      reveal: vi.fn(async () => ok({ ok: true })),
      revealPath: vi.fn(async () => ok({ ok: true })),
    },
    clipboard: {
      copyPaths: vi.fn(async (sel: { ranges: [number, number][] }) =>
        ok({ count: sel.ranges.reduce((n, [a, b]) => n + b - a, 0), truncated: false }),
      ),
      copyText: vi.fn(async () => ok({ ok: true })),
      copyImage: vi.fn(async () => ok({ width: 4000, height: 3000 })),
    },
    onEvent: vi.fn((channel: EventChannel, listener: (p: never) => void) => {
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      set.add(listener)
      return () => set.delete(listener)
    }),
  }
  window.fastview = api as unknown as FastViewApi

  return {
    api,
    backend,
    push<C extends EventChannel>(channel: C, payload: EventMap[C]) {
      listeners.get(channel)?.forEach((l) => l(payload as never))
    },
  }
}
