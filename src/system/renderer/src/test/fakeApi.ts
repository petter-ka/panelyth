import type {
  ContentItem,
  EventChannel,
  EventMap,
  SystemApi,
  SystemHardware,
  SystemLoad,
  Volume,
} from "@panelyth/contracts"
import { vi } from "vitest"

// An in-memory System API: the computer, its load, the volumes and a find
// whose results tests hand over the way the sidecar would.

const ok = <R>(r: R) => ({ ok: true as const, r })

export const HARDWARE: SystemHardware = {
  os: { name: "Windows 11", release: "10.0.26300", arch: "x64", platform: "win32" },
  hostname: "STUDIO-PC",
  uptimeMs: 3 * 86_400_000 + 4 * 3_600_000,
  cpu: { model: "Ryzen 9 9950X", threads: 4, speedMhz: 4300 },
  memoryBytes: 64 * 1024 ** 3,
  gpus: [{ name: "GeForce RTX 5080", vendor: "NVIDIA", driver: "32.0.15.7", active: true }],
}

export const VOLUMES: Volume[] = [
  {
    path: "C:\\",
    label: "System",
    kind: "fixed",
    freeBytes: 100 * 1024 ** 3,
    totalBytes: 1000 * 1024 ** 3,
  },
  {
    path: "D:\\",
    label: "Photos",
    kind: "fixed",
    freeBytes: 50 * 1024 ** 3,
    totalBytes: 2000 * 1024 ** 3,
  },
  { path: "E:\\", label: "", kind: "optical", notReady: true },
]

export function item(id: number, name: string, dirPath: string): ContentItem {
  const dot = name.lastIndexOf(".")
  return {
    id,
    kind: "file",
    name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
    sizeBytes: 2048,
    modifiedMs: 1_700_000_000_000,
    favorite: false,
    rating: 0,
    label: 0,
    dirPath,
    thumb: null,
  }
}

type Listener = (payload: never) => void

export function createFakeSystemApi() {
  const listeners = new Map<string, Set<Listener>>()
  /** Busy and total milliseconds per core; each load() adds `step`. */
  const clock = { busy: [0, 0, 0, 0], total: [0, 0, 0, 0], step: [500, 250, 1000, 0] }
  const results: ContentItem[] = []
  const state = { version: 1 }
  const api = {
    app: {
      exit: vi.fn(async () => ok({ ok: true })),
      switch: vi.fn(async () => ok({ ok: true })),
      about: vi.fn(async () =>
        ok({ name: "Panelyth", version: "1.0.0", channel: "stable", platform: "win32" }),
      ),
      openTarget: vi.fn(async () => ok({ ok: true })),
    },
    update: {
      getState: vi.fn(async () => ok({ state: "idle" })),
      check: vi.fn(async () => ok({ ok: true })),
      download: vi.fn(async () => ok({ ok: true })),
      install: vi.fn(async () => ok({ ok: true })),
    },
    sidecar: { getStatus: vi.fn(async () => ok({ state: "ready" })) },
    settings: {
      openWindow: vi.fn(async () => ok({ ok: true })),
      closeWindow: vi.fn(async () => ok({ ok: true })),
    },
    library: {
      get: vi.fn(async () => ok({ settings: {} })),
      setSetting: vi.fn(async () => ok({ ok: true })),
    },
    system: {
      hardware: vi.fn(async () => ok(HARDWARE)),
      load: vi.fn(async (): Promise<ReturnType<typeof ok<SystemLoad>>> => {
        clock.busy = clock.busy.map((b, i) => b + clock.step[i]!)
        clock.total = clock.total.map((t) => t + 1000)
        return ok({
          at: Date.now(),
          cores: clock.busy.map((busyMs, i) => ({ busyMs, totalMs: clock.total[i]! })),
          freeMemoryBytes: 16 * 1024 ** 3,
          totalMemoryBytes: 64 * 1024 ** 3,
        })
      }),
    },
    fs: { volumes: vi.fn(async () => ok({ volumes: VOLUMES })) },
    find: {
      start: vi.fn(async () => ok({ findId: 7, queryId: 70, version: 1, total: 0 })),
      cancel: vi.fn(async () => ok({ ok: true })),
    },
    query: {
      page: vi.fn(
        async ({ queryId, offset, limit }: { queryId: number; offset: number; limit: number }) =>
          ok({
            queryId,
            version: state.version,
            total: results.length,
            offset,
            items: results.slice(offset, offset + limit),
          }),
      ),
      close: vi.fn(async () => ok({ ok: true })),
    },
    dir: {
      openContaining: vi.fn(async () => ok({ dirId: 42, path: "D:\\Photos\\2024", crumbs: [] })),
    },
    context: { publish: vi.fn(async () => ok({ ok: true })) },
    onEvent: vi.fn(<C extends EventChannel>(channel: C, listener: (p: EventMap[C]) => void) => {
      const set = listeners.get(channel) ?? new Set<Listener>()
      set.add(listener as Listener)
      listeners.set(channel, set)
      return () => set.delete(listener as Listener)
    }),
  }
  return {
    api: api as unknown as SystemApi,
    raw: api,
    emit<C extends EventChannel>(channel: C, payload: EventMap[C]): void {
      for (const listener of listeners.get(channel) ?? [])
        (listener as (p: EventMap[C]) => void)(payload)
    },
    /** The sidecar found more: they join the results under a new version. */
    found(items: ContentItem[]): number {
      results.push(...items)
      state.version++
      return state.version
    },
    get total() {
      return results.length
    },
  }
}

export type FakeSystem = ReturnType<typeof createFakeSystemApi>

export function installFakeSystemApi(): FakeSystem {
  const fake = createFakeSystemApi()
  ;(window as unknown as { panelyth?: SystemApi }).panelyth = fake.api
  return fake
}

export function removeFakeSystemApi(): void {
  delete (window as unknown as { panelyth?: SystemApi }).panelyth
}
