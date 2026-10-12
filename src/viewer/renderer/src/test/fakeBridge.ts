import type {
  BatchFolder,
  BatchParams,
  BatchPlanResult,
  RecipeSaveParams,
  StoredRecipe,
  EditAsset,
  EditColorsParams,
  EditColorsResult,
  EditOpenResult,
  EditProbeParams,
  EditRenderParams,
  EditRenderResult,
  EditSaveParams,
  EditThumbsParams,
  ClipState,
  ContentItem,
  JobSnapshot,
  JobStartParams,
  EventChannel,
  EventMap,
  PanelythApi,
  PreviewItem,
  CoverSlot,
  RpcEnvelope,
  SidecarStatus,
} from "@panelyth/contracts"
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
 * Installs a fake window.panelyth backed by a tiny in-memory "sidecar".
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
    bookmarks: [] as { id: number; path: string; label: string; group: string }[],
    recent: [] as { path: string; lastOpenedAt: number }[],
    clip: { mode: "", count: 0 } as ClipState,
    nextJob: 1,
    jobs: [] as JobStartParams[],
    tags: [{ id: 1, name: "Holiday", count: 3 }],
    /** The image editor (Stage 12): what edit.open answers and what was asked. */
    edit: {
      session: {
        sessionId: "0123456789abcdef01234567",
        name: "IMG_2.jpg",
        width: 4000,
        height: 3000,
        format: "jpeg",
        hasAlpha: false,
        dpi: { x: 300, y: 300 },
        saveFormat: "jpeg",
        canReplace: true,
      } as EditOpenResult,
      renders: [] as EditRenderParams[],
      saves: [] as EditSaveParams[],
      /** Stage 13: what the eyedropper reads, and what was asked. */
      probes: [] as EditProbeParams[],
      color: [200, 100, 50, 255] as [number, number, number, number],
      thumbs: [] as EditThumbsParams[],
      counts: [] as EditColorsParams[],
      /** Stage 14: what main's file dialog answers (null = cancelled), and the fonts. */
      asset: {
        assetId: "0123456789abcdef0123456789abcdef",
        name: "logo.png",
        width: 400,
        height: 200,
        thumbUrl: `panelyth-media://m/${"7".repeat(32)}`,
      } as EditAsset | null,
      fonts: ["Go", "Go Mono", "Arial", "Noto Sans CJK"],
      /** Stage 15: the pupils edit.eyes finds. */
      eyes: [
        { x: 0.3, y: 0.4, w: 0.04, h: 0.05 },
        { x: 0.6, y: 0.41, w: 0.04, h: 0.05 },
      ],
      colors: {
        distinct: 4096,
        palette: [
          { hex: "#336699", share: 0.5 },
          { hex: "#ffcc00", share: 0.25 },
        ],
        hasAlpha: false,
        width: 4000,
        height: 3000,
      } as EditColorsResult,
      /** Set to make the next save dialog cancel. */
      cancelDialog: false,
      closed: [] as string[],
    },
    /** Batch mode (Stage 16): what the plan answers, and what was asked. */
    batch: {
      plans: [] as BatchParams[],
      starts: [] as BatchParams[],
      undone: [] as number[],
      /** What main's folder dialog answers (null = cancelled). */
      folder: { folderId: "0123456789abcdef", name: "Web export" } as BatchFolder | null,
      /** Merged into every plan. */
      plan: {} as Partial<BatchPlanResult>,
      /** Set to make batch.start fail. */
      startError: "",
      recipes: [
        {
          id: 0,
          builtin: "web1600",
          name: "Web, 1600 px",
          recipe: {
            version: 1,
            ops: [
              { op: "resize", p: { mode: "fit", w: 1600, h: 1600, noEnlarge: true } },
              { op: "sharpen", p: { amount: 60, radius: 0.8 } },
            ],
            output: {
              format: "jpeg",
              quality: 85,
              metadata: "keep",
              destination: "beside",
              template: "{name}-web",
              conflict: "keepBoth",
            },
          },
        },
      ] as StoredRecipe[],
      nextRecipe: 1,
    },
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
    bytesPerSec: 0,
    etaMs: 0,
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
          url: `panelyth-media://m/${String(entryId).padStart(32, "0")}`,
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
      indexOf: vi.fn(async (_queryId: number, entryId: number) =>
        ok({ index: backend.items.findIndex((i) => i.id === entryId), version: backend.version }),
      ),
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
          permissions: null,
          linkTarget: null,
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
          group: "",
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
    edit: {
      open: vi.fn(async (_entryId: number) => ok(backend.edit.session)),
      // The frame is the output at the working scale: the size follows the
      // operations the way Go's does for the ones the tests use.
      render: vi.fn(async (params: EditRenderParams) => {
        backend.edit.renders.push(params)
        let { width, height } = backend.edit.session
        for (const op of params.editList) {
          if (op.off) continue
          if (op.op === "rotate" && Math.abs(op.p.angle) % 180 === 90)
            [width, height] = [height, width]
          if (op.op === "crop") {
            width = Math.max(1, Math.round(width * op.p.rect.w))
            height = Math.max(1, Math.round(height * op.p.rect.h))
          }
          if (op.op === "resize" && op.p.mode === "percent") {
            width = Math.round((width * op.p.w) / 100)
            height = Math.round((height * (op.p.h || op.p.w)) / 100)
          }
          if (op.op === "canvas") {
            width = op.p.w || width
            height = op.p.h || height
          }
          // A frame outside the picture grows it (percent of the shorter edge).
          if (op.op === "border" && !op.p.inside && op.p.unit !== "px") {
            const side = Math.round((op.p.width / 100) * Math.min(width, height))
            width += 2 * side
            height += 2 * side
          }
        }
        const scale = Math.min(1, params.view.maxEdge / Math.max(width, height))
        const bins = Array.from({ length: 256 }, () => 0)
        // The picture a tool is given: everything between 40 and 215.
        const narrow = bins.map((_, i) => (i >= 40 && i <= 215 ? 6 : 0))
        const mid = bins.map((_, i) => (i >= 20 && i <= 235 ? 5 : 0))
        const result: EditRenderResult = {
          rev: params.rev,
          frame: {
            url: `panelyth-media://m/${String(params.rev).padStart(32, "0")}`,
            width: Math.round(width * scale),
            height: Math.round(height * scale),
          },
          output: { width, height, dpi: backend.edit.session.dpi },
          ...(params.histogram && {
            histogram: {
              lum: bins.map((_, i) => (i === 0 ? 10 : i === 255 ? 30 : 4)),
              r: mid,
              g: mid,
              b: mid,
              pixels: 1056,
              clipLow: 10,
              clipHigh: 30,
              mean: 128,
            },
          }),
          ...(params.histogramAt !== undefined && {
            before: {
              lum: narrow,
              r: narrow,
              g: narrow,
              b: narrow,
              pixels: 1056,
              clipLow: 0,
              clipHigh: 0,
              mean: 127,
            },
          }),
        }
        return ok(result)
      }),
      info: vi.fn(async (_sessionId: string) =>
        ok({
          groups: [
            {
              name: "camera" as const,
              items: [
                { id: "Make", value: "Panelyth" },
                { id: "Model", value: "Model X" },
              ],
            },
            {
              name: "exposure" as const,
              items: [
                { id: "ExposureTime", value: "1/250 s" },
                { id: "ExposureProgram", value: "aperturePriority", code: "aperturePriority" },
              ],
            },
          ],
        }),
      ),
      estimate: vi.fn(async () => ok({ bytes: 2_400_000 })),
      save: vi.fn(async (params: EditSaveParams) => {
        backend.edit.saves.push(params)
        if (params.target === "as" && backend.edit.cancelDialog) {
          return ok({ jobId: null, name: "" })
        }
        const stem = backend.edit.session.name.replace(/\.[^.]+$/, "")
        const ext =
          params.format === "jpeg" ? "jpg" : params.format === "tiff" ? "tif" : params.format
        const name =
          params.target === "replace" ? backend.edit.session.name : `${stem} (edited).${ext}`
        return ok({ jobId: snapshot("editSave", 5).jobId, name })
      }),
      close: vi.fn(async (sessionId: string) => {
        backend.edit.closed.push(sessionId)
        return ok({ ok: true })
      }),
      saved: vi.fn(async (_jobId: number) => ok({ entryId: 5, name: "IMG_2 (edited).jpg" })),
      reveal: vi.fn(async (_jobId: number) => ok({ ok: true })),
      probe: vi.fn(async (params: EditProbeParams) => {
        backend.edit.probes.push(params)
        const rgba = backend.edit.color
        const hex =
          "#" +
          rgba
            .slice(0, 3)
            .map((v) => v.toString(16).padStart(2, "0"))
            .join("")
        return ok({ rgba, hex })
      }),
      thumbs: vi.fn(async (params: EditThumbsParams) => {
        backend.edit.thumbs.push(params)
        return ok({
          thumbs: params.editLists.map((_, i) => ({
            url: `panelyth-media://m/${String(9000 + i).padStart(32, "0")}`,
            width: params.edge,
            height: Math.round((params.edge * 3) / 4),
          })),
        })
      }),
      colors: vi.fn(async (params: EditColorsParams) => {
        backend.edit.counts.push(params)
        return ok(backend.edit.colors)
      }),
      fonts: vi.fn(async (_sessionId: string) => ok({ families: backend.edit.fonts })),
      eyes: vi.fn(async (_params: { sessionId: string; editList: unknown[] }) =>
        ok({ eyes: backend.edit.eyes }),
      ),
      pickAsset: vi.fn(async (_sessionId: string) => ok({ asset: backend.edit.asset })),
      releaseAsset: vi.fn(async (_sessionId: string, _assetId: string) => ok({ ok: true })),
    },
    batch: {
      pickFolder: vi.fn(async () => ok({ folder: backend.batch.folder })),
      // The pictures of the selection are the fake's image items, in order.
      plan: vi.fn(async (params: BatchParams) => {
        backend.batch.plans.push(params)
        const total = count(params.source.selection)
        const chosen = backend.items.slice(0, total)
        const pictures = chosen.filter((i) => i.kind === "image")
        const folders = chosen.filter((i) => i.kind === "dir").length
        const videos = chosen.filter((i) => i.kind === "video").length
        const o = params.recipe.output
        const template = o.template || (o.destination === "folder" ? "{name}" : "{name}-edited")
        const names = pictures.slice(0, 5).map((p, i) => {
          const stem = p.name.replace(/\.[^.]+$/, "")
          const ext = o.format === "keep" ? p.ext : o.format === "jpeg" ? "jpg" : o.format
          const name = template
            .replace("{name}", stem)
            .replace(/\{n(?::(\d))?\}/, (_m, w: string | undefined) =>
              String(i + 1).padStart(Number(w ?? 1), "0"),
            )
          return o.destination === "replace" ? p.name : `${name}.${ext}`
        })
        const step = Math.max(1, Math.ceil(pictures.length / 12))
        const plan: BatchPlanResult = {
          count: pictures.length,
          skipped: [
            ...(folders > 0 ? [{ reason: "folder" as const, count: folders }] : []),
            ...(videos > 0 ? [{ reason: "video" as const, count: videos }] : []),
          ],
          names,
          bytes: pictures.reduce((n, p) => n + p.sizeBytes, 0),
          estimateBytes: 1_500_000,
          warnings: [],
          problems: params.recipe.ops
            .filter((op) => ["draw", "clone", "heal", "redeye"].includes(op.op))
            .map((op) => ({ code: "notBatchable" as const, op: op.op, detail: "" })),
          samples: pictures
            .filter((_p, i) => i % step === 0)
            .slice(0, 12)
            .map((p) => ({ id: p.id, name: p.name })),
          ...backend.batch.plan,
        }
        return ok(plan)
      }),
      start: vi.fn(async (params: BatchParams) => {
        if (backend.batch.startError) {
          return {
            ok: false as const,
            e: {
              code: "INVALID_ARGUMENT" as const,
              message: backend.batch.startError,
              retryable: false,
            },
          }
        }
        backend.batch.starts.push(params)
        return ok(snapshot("edit", count(params.source.selection)))
      }),
      undo: vi.fn(async (jobId: number) => {
        if (backend.batch.undone.includes(jobId)) {
          return {
            ok: false as const,
            e: {
              code: "NOT_FOUND" as const,
              message: "this batch can no longer be undone",
              retryable: false,
            },
          }
        }
        backend.batch.undone.push(jobId)
        return ok(snapshot("undoEdit", 3))
      }),
    },
    recipes: {
      list: vi.fn(async () => ok({ recipes: [...backend.batch.recipes] })),
      save: vi.fn(async (params: RecipeSaveParams) => {
        const same = backend.batch.recipes.find(
          (r) => !r.builtin && r.name.toLowerCase() === params.name.toLowerCase(),
        )
        const id = same?.id ?? backend.batch.nextRecipe++
        backend.batch.recipes = [
          ...backend.batch.recipes.filter((r) => r.id !== id || r.builtin !== ""),
          { id, builtin: "", name: params.name, recipe: params.recipe },
        ]
        return ok({ id, name: params.name })
      }),
      remove: vi.fn(async (id: number) => {
        backend.batch.recipes = backend.batch.recipes.filter((r) => r.builtin !== "" || r.id !== id)
        return ok({ ok: true })
      }),
    },
    onEvent: vi.fn((channel: EventChannel, listener: (p: never) => void) => {
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      set.add(listener)
      return () => set.delete(listener)
    }),
  }
  window.panelyth = api as unknown as PanelythApi

  return {
    api,
    backend,
    push<C extends EventChannel>(channel: C, payload: EventMap[C]) {
      listeners.get(channel)?.forEach((l) => l(payload as never))
    },
    /** A job.progress event for a job the fake started. */
    job(jobId: number, state: JobSnapshot["state"], patch: Partial<JobSnapshot> = {}) {
      const snap = { ...snapshot("editSave", 5), jobId, state, ...patch }
      backend.nextJob--
      listeners.get("job.progress")?.forEach((l) => l(snap as never))
    },
  }
}
