import type { SidecarStatus } from "@fastview/contracts"
import type { IpcMainInvokeEvent } from "electron"
import { describe, expect, it, vi } from "vitest"
import {
  createInvokeHandler,
  forwardableEvent,
  profileParams,
  type MainHandlers,
  type SidecarPort,
} from "../src/main/ipc/router"
import { RpcError } from "../src/main/sidecar/RpcClient"

vi.mock("electron", () => ({}))

const ORIGIN = "app://fastview"
const COMMANDER = "app://commander"
const status: SidecarStatus = {
  state: "ready",
  pid: 1,
  protocol: 1,
  version: "v",
  restarts: 0,
  lastError: null,
  since: 0,
}

function eventFrom(url: string, parent: object | null = null): IpcMainInvokeEvent {
  return { senderFrame: { url, parent } } as unknown as IpcMainInvokeEvent
}

const mainHandlers = (): MainHandlers => ({
  "app.exit": vi.fn(async () => ({ ok: true })),
  "app.switch": vi.fn(() => ({ ok: true })),
  "sidecar.getStatus": vi.fn(() => status),
  "dialog.openFolder": vi.fn(async () => ({ path: "/picked" })),
  "file.open": vi.fn(async (_e, p: { entryId: number }) => ({
    url: `fastview-media://m/${String(p.entryId).padStart(32, "1")}`,
    kind: "file" as const,
    mime: "application/octet-stream",
    sizeBytes: 10,
  })),
  "shell.edit": vi.fn(async () => ({ ok: true })),
  "media.open": vi.fn(async (_e, p: { entryId: number }) => ({
    url: `fastview-media://m/${String(p.entryId).padStart(32, "0")}`,
    kind: "image" as const,
    mime: "image/jpeg",
    width: 10,
    height: 10,
    durationMs: 0,
    videoCodec: "",
    audioCodec: "",
  })),
  "places.list": vi.fn(async () => ({ places: [] })),
  "shell.open": vi.fn(async () => ({ ok: true })),
  "shell.reveal": vi.fn(async () => ({ ok: true })),
  "shell.revealPath": vi.fn(async () => ({ ok: true })),
  "clipboard.copyPaths": vi.fn(async () => ({ count: 1, truncated: false })),
  "clipboard.copyText": vi.fn(async () => ({ ok: true })),
  "clipboard.copyImage": vi.fn(async () => ({ width: 1, height: 1 })),
})

function setup(devMethods = false, activeApp?: () => "viewer" | "commander") {
  const sidecar: SidecarPort = {
    call: vi.fn(async (method: string) => ({ echoed: method })),
    getStatus: vi.fn(() => status),
  }
  const main = mainHandlers()
  const onSharedSetting = vi.fn()
  const handler = createInvokeHandler({
    sidecar,
    main,
    origins: { viewer: ORIGIN, commander: COMMANDER },
    devMethods,
    onSharedSetting,
    ...(activeApp && { activeApp }),
  })
  return {
    sidecar,
    main,
    handler,
    onSharedSetting,
    ok: eventFrom(`${ORIGIN}/index.html`),
    commander: eventFrom(`${COMMANDER}/index.html`),
  }
}

describe("invoke router", () => {
  it("checks each call against the calling app view's profile (ADR-0027)", async () => {
    const { handler, sidecar, main, commander } = setup()
    await expect(handler(commander, "system.ping", {})).resolves.toMatchObject({ ok: true })
    await expect(handler(commander, "app.switch", { to: "viewer" })).resolves.toEqual({
      ok: true,
      r: { ok: true },
    })
    expect(main["app.switch"]).toHaveBeenCalledWith(commander, { to: "viewer" }, "commander")
    for (const m of [
      "shell.reveal",
      "shell.revealPath",
      "dialog.openFolder",
      "clipboard.copyImage",
      "folder.covers",
      "library.tags",
    ]) {
      const res = await handler(commander, m, {})
      expect(res, m).toMatchObject({ ok: false, e: { code: "METHOD_NOT_FOUND" } })
    }
    expect(sidecar.call).toHaveBeenCalledTimes(1)
  })

  it("gives the commander quick view, lister, open and edit; the viewer none of the new methods (Stage C05)", async () => {
    const { handler, sidecar, main, commander, ok } = setup()
    for (const [m, p] of [
      ["file.open", { entryId: 3 }],
      ["shell.open", { entryId: 3 }],
      ["shell.open", { entryId: 3, allowProgram: true }],
      ["shell.edit", { entryId: 3 }],
      ["media.open", { entryId: 3 }],
    ] as const) {
      await expect(handler(commander, m, p), m).resolves.toMatchObject({ ok: true })
      expect(main[m]).toHaveBeenLastCalledWith(commander, p, "commander")
    }
    await expect(
      handler(commander, "fs.mkfile", { parentDirId: 2, name: "new.txt" }),
    ).resolves.toMatchObject({ ok: true })
    await expect(handler(commander, "props.get", { entryId: 3 })).resolves.toMatchObject({
      ok: true,
    })
    expect(sidecar.call).toHaveBeenCalledWith("fs.mkfile", { parentDirId: 2, name: "new.txt" })
    // The viewer cannot plant the commander's settings (the F4 editor is started by main).
    await expect(
      handler(ok, "library.setSetting", {
        key: "commander.settings",
        value: { editor: "C:\\x.exe" },
      }),
    ).resolves.toMatchObject({ ok: false, e: { code: "PERMISSION_DENIED" } })
    await expect(
      handler(commander, "library.setSetting", {
        key: "commander.settings",
        value: { editor: "" },
      }),
    ).resolves.toMatchObject({ ok: true })
    // The viewer's profile has none of the commander-only methods.
    for (const m of ["file.open", "shell.edit", "fs.mkfile"]) {
      const res = await handler(ok, m, { entryId: 3 })
      expect(res, m).toMatchObject({ ok: false, e: { code: "METHOD_NOT_FOUND" } })
    }
    // The viewer's shell.open still goes to main, which applies its profile.
    await handler(ok, "shell.open", { entryId: 3 })
    expect(main["shell.open"]).toHaveBeenLastCalledWith(ok, { entryId: 3 }, "viewer")
    // Validation: ids, the flag, names; never a path.
    for (const [m, p] of [
      ["shell.open", { entryId: 3, allowProgram: "yes" }],
      ["shell.open", { entryId: 3, path: "/bin/sh" }],
      ["shell.edit", { entryId: 0 }],
      ["shell.edit", { entryId: 3, editor: "/bin/sh" }],
      ["file.open", { entryId: -1 }],
      ["fs.mkfile", { parentDirId: 2, name: "" }],
      ["fs.mkfile", { parentDirId: 2, name: "a\u0000b" }],
      ["fs.mkfile", { parentDirId: 2 }],
    ] as const) {
      const res = await handler(commander, m, p)
      expect(res, `${m} ${JSON.stringify(p)}`).toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
  })

  it("lets the commander list folders in the all scope (Stage C01)", async () => {
    const { handler, sidecar, commander } = setup()
    const descriptor = {
      dirId: 1,
      recursive: false,
      sort: [{ field: "attrs", direction: "desc" }],
      kinds: [],
      search: "",
      exts: [],
      favorite: false,
      minRating: 0,
      tags: [],
      scope: "all",
      showHidden: true,
    }
    await expect(handler(commander, "query.open", descriptor)).resolves.toMatchObject({ ok: true })
    await expect(
      handler(commander, "query.indexOf", { queryId: 1, entryId: 7 }),
    ).resolves.toMatchObject({ ok: true })
    await expect(handler(commander, "fs.volumes", {})).resolves.toMatchObject({ ok: true })
    expect(sidecar.call).toHaveBeenCalledWith("query.open", descriptor)
  })

  it("lets the commander run file operations with folder ids as destinations (Stage C04)", async () => {
    const { handler, sidecar, commander, ok } = setup()
    const sel = { queryId: 1, version: 1, ranges: [[0, 2]], include: [], exclude: [] }
    const source = { selection: sel }
    const abs = process.platform === "win32" ? "C:\\dst" : "/dst"
    const good: [string, unknown][] = [
      ["jobs.start", { kind: "dirSize", source }],
      ["jobs.start", { kind: "trash", source }],
      ["jobs.start", { kind: "delete", source }],
      [
        "jobs.start",
        { kind: "copy", source, destinationDirId: 7, conflict: "ask", verify: true, mask: "*.jpg" },
      ],
      [
        "jobs.start",
        { kind: "move", source, destinationDirId: 7, conflict: "skip", name: "b.jpg" },
      ],
      ["clip.paste", { destinationDirId: 7, conflict: "keepBoth" }],
      ["fs.mkdir", { parentDirId: 7, path: "a/b/c" }],
      ["fs.canTrash", { dirId: 7 }],
      ["entry.rename", { entryId: 3, name: "x.jpg" }],
    ]
    for (const [m, p] of good) {
      expect(await handler(commander, m, p), m).toMatchObject({ ok: true })
    }
    // copyLinks is added for the commander's copies and pastes.
    expect(sidecar.call).toHaveBeenCalledWith("clip.paste", {
      destinationDirId: 7,
      conflict: "keepBoth",
      copyLinks: true,
    })
    const denied: [string, unknown][] = [
      ["jobs.start", { kind: "copy", source, destination: abs, conflict: "ask" }],
      ["clip.paste", { destination: abs, conflict: "ask" }],
      ["jobs.start", { kind: "favorite", source, favorite: true }],
    ]
    for (const [m, p] of denied) {
      expect(await handler(commander, m, p), m).toMatchObject({
        ok: false,
        e: { code: "PERMISSION_DENIED" },
      })
    }
    const invalid: [string, unknown][] = [
      ["jobs.start", { kind: "copy", source, conflict: "ask" }],
      [
        "jobs.start",
        { kind: "copy", source, destination: abs, destinationDirId: 7, conflict: "ask" },
      ],
      ["jobs.start", { kind: "copy", source, destinationDirId: 0, conflict: "ask" }],
      [
        "jobs.start",
        { kind: "copy", source, destinationDirId: 7, conflict: "ask", mask: "x".repeat(300) },
      ],
      ["fs.mkdir", { parentDirId: 7, path: "  " }],
      ["fs.canTrash", { dirId: -1 }],
    ]
    for (const [m, p] of invalid) {
      expect(await handler(commander, m, p), m).toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
    // The viewer keeps its path destinations.
    expect(
      await handler(ok, "jobs.start", {
        kind: "copy",
        source,
        destination: abs,
        conflict: "keepBoth",
      }),
    ).toMatchObject({ ok: true })
  })

  it("validates quick search, mask marking and the carried selection (Stage C02)", async () => {
    const { handler, sidecar, commander, ok } = setup()
    const sel = { queryId: 1, version: 1, ranges: [[0, 2]], include: [], exclude: [] }
    const good: [string, unknown][] = [
      ["query.locate", { queryId: 1, pattern: "ab*", from: 0, direction: "forward" }],
      ["query.match", { queryId: 1, mask: "*.jpg|*.tmp" }],
      ["selection.fromContext", { version: 2, queryId: 1 }],
      ["context.publish", { app: "commander", dirId: 3, focusId: null, selection: sel }],
      ["context.publish", { app: "commander", dirId: 3, focusId: 4, selection: null }],
    ]
    for (const [m, p] of good) {
      expect(await handler(commander, m, p), m).toMatchObject({ ok: true })
    }
    const bad: [string, unknown][] = [
      ["query.locate", { queryId: 1, pattern: "ab", from: 0, direction: "up" }],
      ["query.locate", { queryId: 1, pattern: "x".repeat(300), from: 0, direction: "forward" }],
      ["query.match", { queryId: 1, mask: "" }],
      ["selection.fromContext", { version: 0, queryId: 1 }],
      ["context.publish", { app: "commander", dirId: 3, focusId: null, selection: { queryId: 1 } }],
    ]
    for (const [m, p] of bad) {
      expect(await handler(commander, m, p), m).toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
    // The viewer reads the carried selection too.
    expect(await handler(ok, "selection.fromContext", { version: 1, queryId: 1 })).toMatchObject({
      ok: true,
    })
    expect(sidecar.call).toHaveBeenCalledTimes(good.length + 1)
  })

  it("lets both apps edit the shared bookmarks, validated (Stage C03)", async () => {
    const { handler, sidecar, commander, ok } = setup()
    const path = process.platform === "win32" ? "C:\\photos" : "/photos"
    const good: [string, unknown][] = [
      ["library.addBookmark", { path, label: "" }],
      ["library.addBookmark", { path, label: "Photos", group: "Work" }],
      ["library.updateBookmark", { id: 1, path, label: "P", group: "" }],
      ["library.reorderBookmarks", { ids: [3, 1, 2] }],
      ["library.removeBookmark", { id: 1 }],
    ]
    for (const [m, p] of good) {
      expect(await handler(commander, m, p), m).toMatchObject({ ok: true })
    }
    const bad: [string, unknown][] = [
      ["library.addBookmark", { path, label: "", group: 5 }],
      ["library.addBookmark", { path, label: "", group: "g".repeat(129) }],
      ["library.addBookmark", { path: "relative", label: "" }],
      ["library.updateBookmark", { id: 0, path, label: "", group: "" }],
      ["library.updateBookmark", { id: 1, path, label: "" }],
      ["library.reorderBookmarks", { ids: [1, -2] }],
      ["library.reorderBookmarks", { ids: Array.from({ length: 501 }, (_, i) => i + 1) }],
    ]
    for (const [m, p] of bad) {
      expect(await handler(commander, m, p), m).toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
    expect(await handler(ok, "library.reorderBookmarks", { ids: [1] })).toMatchObject({ ok: true })
    expect(sidecar.call).toHaveBeenCalledTimes(good.length + 1)
  })

  it("validates the engine v2 job calls and adds copyLinks for the commander only (Stage P03)", async () => {
    const { handler, sidecar, ok } = setup()
    const sel = { queryId: 1, version: 1, ranges: [[0, 2]], include: [], exclude: [] }
    const abs = process.platform === "win32" ? "C:\\dst" : "/dst"
    const copy = { kind: "copy", source: { selection: sel }, destination: abs, conflict: "ask" }
    const good: [string, unknown][] = [
      ["jobs.start", copy],
      ["jobs.start", { ...copy, conflict: "replaceOlder", verify: true, now: false }],
      ["jobs.pause", { jobId: 3 }],
      ["jobs.resume", { jobId: 3 }],
      ["jobs.startNow", { jobId: 3 }],
      ["jobs.resolve", { jobId: 3, decision: "renameExisting", applyToAll: true }],
    ]
    for (const [m, p] of good) {
      expect(await handler(ok, m, p), m).toMatchObject({ ok: true })
    }
    const bad: [string, unknown][] = [
      ["jobs.start", { ...copy, copyLinks: true }],
      ["jobs.start", { ...copy, verify: "yes" }],
      ["jobs.pause", { jobId: 0 }],
      ["jobs.resolve", { jobId: 3, decision: "ask", applyToAll: false }],
      ["jobs.resolve", { jobId: 3, decision: "skip" }],
    ]
    for (const [m, p] of bad) {
      expect(await handler(ok, m, p), m).toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
    // The viewer's copy goes to Go as sent: links stay skipped.
    expect(sidecar.call).toHaveBeenCalledWith("jobs.start", copy)
    expect(profileParams("commander", "jobs.start", copy)).toEqual({ ...copy, copyLinks: true })
    expect(profileParams("commander", "clip.paste", { destination: abs, conflict: "ask" })).toEqual(
      {
        destination: abs,
        conflict: "ask",
        copyLinks: true,
      },
    )
    expect(profileParams("commander", "jobs.start", { kind: "dirSize", source: {} })).toEqual({
      kind: "dirSize",
      source: {},
    })
    expect(profileParams("viewer", "clip.paste", { destination: abs, conflict: "ask" })).toEqual({
      destination: abs,
      conflict: "ask",
    })
  })

  it("keeps the viewer on the media scope", async () => {
    const { handler, sidecar, ok } = setup()
    const base = {
      dirId: 1,
      recursive: false,
      sort: [],
      kinds: [],
      search: "",
      exts: [],
      favorite: false,
      minRating: 0,
      tags: [],
    }
    await expect(handler(ok, "query.open", { ...base, scope: "all" })).resolves.toMatchObject({
      ok: false,
      e: { code: "PERMISSION_DENIED" },
    })
    await expect(handler(ok, "query.open", base)).resolves.toMatchObject({ ok: true })
    expect(sidecar.call).toHaveBeenCalledTimes(1)
  })

  it("accepts context.publish only from the visible app, as itself", async () => {
    let active: "viewer" | "commander" = "viewer"
    const { handler, sidecar, ok, commander } = setup(false, () => active)
    const params = (app: string) => ({ app, dirId: 3, focusId: null })
    await expect(handler(ok, "context.publish", params("commander"))).resolves.toMatchObject({
      ok: false,
      e: { code: "PERMISSION_DENIED" },
    })
    await expect(handler(commander, "context.publish", params("commander"))).resolves.toEqual({
      ok: true,
      r: { ok: false },
    })
    expect(sidecar.call).not.toHaveBeenCalled()
    await expect(handler(ok, "context.publish", params("viewer"))).resolves.toMatchObject({
      ok: true,
    })
    active = "commander"
    await handler(commander, "context.publish", { app: "commander", dirId: 3, focusId: 9 })
    expect(sidecar.call).toHaveBeenCalledTimes(2)
    await expect(handler(commander, "context.get", {})).resolves.toMatchObject({ ok: true })
    await expect(
      handler(commander, "context.publish", { app: "commander", dirId: 0, focusId: null }),
    ).resolves.toMatchObject({ ok: false, e: { code: "INVALID_ARGUMENT" } })
  })

  it("validates app.switch", async () => {
    const { handler, ok } = setup()
    await expect(handler(ok, "app.switch", { to: "elsewhere" })).resolves.toMatchObject({
      ok: false,
      e: { code: "INVALID_ARGUMENT" },
    })
  })

  it("announces shared.* settings so the other app can apply them", async () => {
    const { handler, ok, onSharedSetting } = setup()
    await handler(ok, "library.setSetting", { key: "workspace", value: { a: 1 } })
    expect(onSharedSetting).not.toHaveBeenCalled()
    await handler(ok, "library.setSetting", { key: "shared.appearance", value: { theme: "light" } })
    expect(onSharedSetting).toHaveBeenCalledWith("shared.appearance", { theme: "light" })
  })

  it("forwards allowed sidecar methods", async () => {
    const { handler, sidecar, ok } = setup()
    await expect(handler(ok, "system.ping", {})).resolves.toEqual({
      ok: true,
      r: { echoed: "system.ping" },
    })
    expect(sidecar.call).toHaveBeenCalledWith("system.ping", {})
  })

  it("answers main-local methods without the sidecar", async () => {
    const { handler, sidecar, main, ok } = setup()
    await expect(handler(ok, "sidecar.getStatus", {})).resolves.toEqual({ ok: true, r: status })
    await expect(handler(ok, "dialog.openFolder", {})).resolves.toEqual({
      ok: true,
      r: { path: "/picked" },
    })
    expect(main["dialog.openFolder"]).toHaveBeenCalledWith(ok, {}, "viewer")
    await expect(handler(ok, "media.open", { entryId: 7 })).resolves.toMatchObject({
      ok: true,
      r: { kind: "image" },
    })
    expect(main["media.open"]).toHaveBeenCalledWith(ok, { entryId: 7 }, "viewer")
    const sel = { queryId: 1, version: 1, ranges: [], include: [], exclude: [] }
    for (const [m, p] of [
      ["places.list", {}],
      ["shell.open", { entryId: 3 }],
      ["shell.reveal", { entryId: 3 }],
      ["shell.revealPath", { path: process.platform === "win32" ? "C:\\x" : "/x" }],
      ["clipboard.copyPaths", { selection: sel }],
      ["clipboard.copyImage", { entryId: 7 }],
      ["clipboard.copyText", { text: "C:\\x" }],
    ] as const) {
      expect(await handler(ok, m, p), m).toMatchObject({ ok: true })
      expect(main[m]).toHaveBeenCalledWith(ok, p, "viewer")
    }
    expect(sidecar.call).not.toHaveBeenCalled()
  })

  it("forwards valid index calls to the sidecar", async () => {
    const { handler, sidecar, ok } = setup()
    const sel = { queryId: 1, version: 2, ranges: [[0, 10]], include: [12], exclude: [3] }
    const abs = process.platform === "win32" ? "C:\\Photos" : "/photos"
    const calls: [string, unknown][] = [
      ["dir.open", { path: abs, recursive: false }],
      ["dir.openEntry", { entryId: 2, recursive: false }],
      ["dir.cancelScan", { scanId: 3 }],
      [
        "query.open",
        {
          dirId: 1,
          recursive: true,
          sort: [
            { field: "created", direction: "desc" },
            { field: "dimensions", direction: "asc" },
          ],
          kinds: ["image"],
          search: "beach 2024",
          exts: ["jpg", "mp4"],
          favorite: true,
          minRating: 3,
          tags: ["Holiday", "family"],
        },
      ],
      [
        "query.open",
        {
          dirId: 1,
          recursive: false,
          sort: [{ field: "attrs", direction: "asc" }],
          kinds: [],
          search: "",
          exts: [],
          favorite: false,
          minRating: 0,
          tags: [],
          // The all scope is the commander's (tested above); masks work in both.
          scope: "media",
          nameMask: "*.txt;*.md|*.bak",
        },
      ],
      ["query.facets", { queryId: 1 }],
      ["selection.info", { selection: sel }],
      ["selection.rebase", { selection: sel }],
      ["props.get", { entryId: 4 }],
      ["fs.volumes", {}],
      ["fs.listDirs", { path: abs }],
      ["library.get", {}],
      ["library.setSetting", { key: "workspace", value: { panes: [20, 60, 20], tileSize: "md" } }],
      ["library.addBookmark", { path: abs, label: "" }],
      ["library.removeBookmark", { id: 3 }],
      ["query.page", { queryId: 1, offset: 0, limit: 1000, thumbProfile: "grid-md" }],
      ["query.page", { queryId: 2, offset: 5, limit: 10, thumbProfile: null }],
      [
        "preview.ensure",
        { lane: "grid", epoch: 3, profile: "grid-sm", items: [{ id: 1, priority: 0 }], force: [1] },
      ],
      [
        "folder.covers",
        { lane: "covers", epoch: 2, profile: "grid-md", items: [{ id: 7, priority: 1 }] },
      ],
      ["query.close", { queryId: 1 }],
      [
        "jobs.start",
        { kind: "copy", source: { selection: sel }, destination: abs, conflict: "keepBoth" },
      ],
      [
        "jobs.start",
        { kind: "move", source: { selection: sel }, destination: abs, conflict: "skip" },
      ],
      ["jobs.start", { kind: "trash", source: { selection: sel } }],
      ["jobs.start", { kind: "delete", source: { selection: sel } }],
      [
        "jobs.start",
        { kind: "rename", source: { selection: sel }, pattern: "{name} {n:000}", start: 1 },
      ],
      ["jobs.start", { kind: "favorite", source: { selection: sel }, favorite: true }],
      ["jobs.start", { kind: "rating", source: { selection: sel }, rating: 0 }],
      ["jobs.start", { kind: "tag", source: { selection: sel }, tag: "Holiday", add: false }],
      ["jobs.cancel", { jobId: 1 }],
      ["jobs.errors", { jobId: 1, offset: 0, limit: 500 }],
      ["jobs.list", {}],
      ["clip.set", { selection: sel, mode: "cut" }],
      ["clip.get", {}],
      ["clip.paste", { destination: abs, conflict: "replace" }],
      ["entry.rename", { entryId: 4, name: "Beach day.jpg" }],
      ["library.tags", {}],
      ["library.deleteTag", { id: 2 }],
    ]
    for (const [m, p] of calls) {
      expect(await handler(ok, m, p), m).toMatchObject({ ok: true })
    }
    expect(sidecar.call).toHaveBeenCalledTimes(calls.length)
  })

  it("accepts the dev server origin when configured", async () => {
    const sidecar: SidecarPort = { call: vi.fn(async () => ({})), getStatus: () => status }
    const handler = createInvokeHandler({
      sidecar,
      main: mainHandlers(),
      origins: { viewer: "http://localhost:5173", commander: "http://localhost:5175" },
      devMethods: false,
    })
    expect(await handler(eventFrom("http://localhost:5173/"), "system.ping", {})).toMatchObject({
      ok: true,
    })
    expect(await handler(eventFrom("http://localhost:5174/"), "system.ping", {})).toMatchObject({
      ok: false,
    })
  })

  it.each([
    ["foreign origin", eventFrom("https://evil.example/")],
    ["lookalike host", eventFrom("app://fastview.evil/index.html")],
    ["file origin", eventFrom("file:///C:/x.html")],
    ["subframe", eventFrom(`${ORIGIN}/index.html`, {})],
  ])("rejects untrusted sender: %s", async (_name, event) => {
    const { handler, sidecar } = setup()
    const res = await handler(event, "system.ping", {})
    expect(res).toMatchObject({ ok: false, e: { code: "PERMISSION_DENIED" } })
    expect(sidecar.call).not.toHaveBeenCalled()
  })

  it.each([
    "system.shutdown",
    "media.resolve",
    "entry.path",
    "selection.paths",
    "nope",
    42,
    undefined,
  ])("rejects non-allowlisted method %s", async (m) => {
    const { handler, sidecar, ok } = setup()
    expect(await handler(ok, m, {})).toMatchObject({ ok: false, e: { code: "METHOD_NOT_FOUND" } })
    expect(sidecar.call).not.toHaveBeenCalled()
  })

  it("gates dev methods", async () => {
    const off = setup(false)
    expect(await off.handler(off.ok, "system.echo", { payload: "x" })).toMatchObject({
      e: { code: "METHOD_NOT_FOUND" },
    })
    const on = setup(true)
    expect(await on.handler(on.ok, "system.echo", { payload: "x" })).toMatchObject({ ok: true })
  })

  it("validates params", async () => {
    const { handler, ok } = setup(true)
    const q = {
      dirId: 1,
      recursive: false,
      sort: [],
      kinds: [],
      search: "",
      exts: [],
      favorite: false,
      minRating: 0,
      tags: [],
    }
    const sel = { queryId: 1, version: 1, ranges: [], include: [], exclude: [] }
    for (const [m, p] of [
      ["system.ping", { extra: 1 }],
      ["system.ping", []],
      ["system.echo", { payload: 1 }],
      ["system.echo", { payload: "x", more: 1 }],
      ["system.echo", { payload: "x".repeat(1024 * 1024 + 1) }],
      ["dir.open", { path: "relative/dir", recursive: false }],
      ["dir.open", { path: "", recursive: false }],
      ["dir.open", { path: "/x\u0000y", recursive: false }],
      ["dir.open", { path: "/x", recursive: "yes" }],
      ["dir.open", { path: "/x", recursive: false, extra: 1 }],
      ["dir.openEntry", { entryId: 0, recursive: false }],
      ["dir.openEntry", { entryId: 2 }],
      ["dir.cancelScan", { scanId: 0 }],
      ["dir.cancelScan", { scanId: 1.5 }],
      [
        "query.open",
        {
          dirId: 1,
          recursive: false,
          sort: [{ field: "name; DROP TABLE", direction: "asc" }],
          kinds: [],
          search: "",
          exts: [],
          favorite: false,
          minRating: 0,
          tags: [],
        },
      ],
      [
        "query.open",
        {
          dirId: 1,
          recursive: false,
          sort: [{ field: "name", direction: "up" }],
          kinds: [],
          search: "",
          exts: [],
          favorite: false,
          minRating: 0,
          tags: [],
        },
      ],
      ["query.open", { ...q, kinds: ["document"] }],
      ["query.open", { ...q, scope: "everything" }],
      ["query.open", { ...q, showHidden: true }],
      ["query.open", { ...q, scope: "media", showHidden: true }],
      ["query.open", { ...q, scope: "all", nameMask: "x".repeat(257) }],
      ["query.open", { ...q, scope: "all", nameMask: 3 }],
      ["query.open", { ...q, hidden: true }],
      ["query.open", { dirId: 1, recursive: false, sort: [], kinds: [] }],
      ["query.open", { ...q, search: "x".repeat(257) }],
      ["query.open", { ...q, search: 5 }],
      ["query.open", { ...q, exts: [".jpg"] }],
      ["query.open", { ...q, exts: ["JPG"] }],
      ["query.open", { ...q, exts: Array(33).fill("jpg") }],
      [
        "query.open",
        {
          dirId: 1,
          recursive: false,
          sort: Array(5).fill({ field: "name", direction: "asc" }),
          kinds: [],
          search: "",
          exts: [],
          favorite: false,
          minRating: 0,
          tags: [],
        },
      ],
      ["query.open", { ...q, dirId: -1 }],
      ["query.open", { dirId: 1, recursive: false, sort: [], kinds: [], search: "", exts: [] }],
      ["query.open", { ...q, favorite: 1 }],
      ["query.open", { ...q, minRating: 6 }],
      ["query.open", { ...q, minRating: -1 }],
      ["query.open", { ...q, tags: [""] }],
      ["query.open", { ...q, tags: ["t".repeat(65)] }],
      ["query.open", { ...q, tags: Array(17).fill("t") }],
      ["query.page", { queryId: 1, offset: -1, limit: 10, thumbProfile: null }],
      ["query.page", { queryId: 1, offset: 0, limit: 0, thumbProfile: null }],
      ["query.page", { queryId: 1, offset: 0, limit: 1001, thumbProfile: null }],
      ["query.page", { queryId: 1, offset: 0, limit: 10 }],
      ["query.page", { queryId: 1, offset: 0, limit: 10, thumbProfile: "huge" }],
      ["preview.ensure", { lane: "", epoch: 1, profile: "grid-sm", items: [], force: [] }],
      ["preview.ensure", { lane: "grid", epoch: -1, profile: "grid-sm", items: [], force: [] }],
      ["preview.ensure", { lane: "grid", epoch: 1, profile: "poster", items: [], force: [] }],
      [
        "preview.ensure",
        { lane: "grid", epoch: 1, profile: "grid-sm", items: [{ id: 1, priority: 9 }], force: [] },
      ],
      [
        "preview.ensure",
        { lane: "grid", epoch: 1, profile: "grid-sm", items: [{ id: 1 }], force: [] },
      ],
      [
        "preview.ensure",
        {
          lane: "grid",
          epoch: 1,
          profile: "grid-sm",
          items: Array(501).fill({ id: 1, priority: 0 }),
          force: [],
        },
      ],
      ["preview.ensure", { lane: "grid", epoch: 1, profile: "grid-sm", items: [], force: ["1"] }],
      ["folder.covers", { lane: "covers", epoch: 1, profile: "grid-sm", items: [], force: [] }],
      ["folder.covers", { lane: "covers", epoch: 1, profile: "poster", items: [] }],
      [
        "folder.covers",
        {
          lane: "covers",
          epoch: 1,
          profile: "grid-sm",
          items: Array(201).fill({ id: 1, priority: 0 }),
        },
      ],
      ["query.close", {}],
      ["media.open", { entryId: 0 }],
      ["media.open", { entryId: 1, path: "/etc/passwd" }],
      ["query.facets", { queryId: 0 }],
      ["selection.info", { selection: { ...sel, ranges: [[5, 2]] } }],
      ["selection.info", { selection: { ...sel, ranges: [[-1, 2]] } }],
      ["selection.info", { selection: { ...sel, ranges: [[0, 1, 2]] } }],
      ["selection.info", { selection: { ...sel, include: ["7"] } }],
      ["selection.info", { selection: { ...sel, exclude: Array(50_001).fill(1) } }],
      ["selection.info", { selection: { ...sel, ids: [1, 2, 3] } }],
      ["selection.info", { ...sel }],
      ["selection.rebase", { selection: { ...sel, version: 0 } }],
      ["props.get", { entryId: "1" }],
      ["fs.volumes", { all: true }],
      ["fs.listDirs", { path: "relative" }],
      ["fs.listDirs", { path: "/x", depth: 5 }],
      ["library.setSetting", { key: "", value: 1 }],
      ["library.setSetting", { key: "k".repeat(129), value: 1 }],
      ["library.setSetting", { key: "k", value: undefined }],
      ["library.setSetting", { key: "k", value: "x".repeat(64 * 1024 + 1) }],
      ["library.addBookmark", { path: "relative", label: "" }],
      ["library.addBookmark", { path: "/x", label: "l".repeat(257) }],
      ["library.removeBookmark", { id: 0 }],
      ["shell.open", { path: "/usr/bin/evil" }],
      ["shell.reveal", { entryId: -1 }],
      ["shell.revealPath", { path: "relative" }],
      ["clipboard.copyPaths", { selection: { ...sel, queryId: 0 } }],
      ["clipboard.copyText", { text: "x".repeat(64 * 1024 + 1) }],
      ["clipboard.copyImage", { entryId: 0 }],
      ["clipboard.copyImage", { entryId: 1.5 }],
      ["jobs.start", { kind: "explode", source: { selection: sel } }],
      ["jobs.start", { kind: "trash", ids: [1, 2, 3] }],
      ["jobs.start", { kind: "trash", source: { selection: sel }, destination: "/x" }],
      ["jobs.start", { kind: "trash", source: { selection: { ...sel, queryId: 0 } } }],
      [
        "jobs.start",
        { kind: "copy", source: { selection: sel }, destination: "relative", conflict: "skip" },
      ],
      [
        "jobs.start",
        { kind: "copy", source: { selection: sel }, destination: "/x", conflict: "maybe" },
      ],
      ["jobs.start", { kind: "move", source: { selection: sel }, destination: "/x" }],
      ["jobs.start", { kind: "rename", source: { selection: sel }, pattern: "", start: 1 }],
      [
        "jobs.start",
        { kind: "rename", source: { selection: sel }, pattern: "x".repeat(256), start: 1 },
      ],
      ["jobs.start", { kind: "rename", source: { selection: sel }, pattern: "{n}", start: -1 }],
      ["jobs.start", { kind: "favorite", source: { selection: sel }, favorite: "yes" }],
      ["jobs.start", { kind: "rating", source: { selection: sel }, rating: 6 }],
      ["jobs.start", { kind: "rating", source: { selection: sel }, rating: 2.5 }],
      ["jobs.start", { kind: "tag", source: { selection: sel }, tag: "  ", add: true }],
      ["jobs.start", { kind: "tag", source: { selection: sel }, tag: "t".repeat(65), add: true }],
      ["jobs.cancel", { jobId: 0 }],
      ["jobs.errors", { jobId: 1, offset: 0, limit: 501 }],
      ["jobs.errors", { jobId: 1, offset: -1, limit: 10 }],
      ["jobs.list", { all: true }],
      ["clip.set", { selection: sel, mode: "move" }],
      ["clip.set", { selection: { ...sel, ranges: [[3, 1]] }, mode: "copy" }],
      ["clip.paste", { destination: "relative", conflict: "keepBoth" }],
      ["clip.paste", { destination: "/x", conflict: "maybe" }],
      ["entry.rename", { entryId: 1, name: "" }],
      ["entry.rename", { entryId: 1, name: "n".repeat(256) }],
      ["entry.rename", { entryId: 1, name: "a\u0000b.jpg" }],
      ["entry.rename", { entryId: 1, path: "/etc/x" }],
      ["library.deleteTag", { id: -1 }],
    ] as const) {
      expect(await handler(ok, m, p), `${m} ${JSON.stringify(p).slice(0, 40)}`).toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
  })

  it("converts sidecar errors to envelopes", async () => {
    const { handler, sidecar, ok } = setup()
    vi.mocked(sidecar.call).mockRejectedValueOnce(new RpcError("SIDECAR_UNAVAILABLE", "gone", true))
    expect(await handler(ok, "system.info", {})).toEqual({
      ok: false,
      e: { code: "SIDECAR_UNAVAILABLE", message: "gone", retryable: true },
    })
  })
})

describe("sidecar event forwarding", () => {
  const progress = {
    scanId: 1,
    dirId: 1,
    recursive: false,
    state: "running",
    dirsListed: 0,
    dirsPending: 1,
    entries: 10,
    skipped: 0,
    errors: 0,
    elapsedMs: 5,
  }

  it("forwards known channels with valid payloads", () => {
    expect(forwardableEvent({ t: "evt", ch: "index.progress", seq: 1, p: progress })).toEqual({
      ch: "index.progress",
      p: progress,
    })
    expect(
      forwardableEvent({
        t: "evt",
        ch: "query.invalidated",
        seq: 2,
        p: { queryId: 1, version: 2, total: 5 },
      }),
    ).not.toBeNull()
  })

  it("forwards drive and bookmark changes (Stage C03)", () => {
    const volumes = [{ path: "E:\\", label: "", kind: "removable", notReady: true }]
    expect(
      forwardableEvent({ t: "evt", ch: "volumes.changed", seq: 1, p: { volumes } }),
    ).not.toBeNull()
    const bookmarks = [{ id: 1, path: "/a", label: "a", group: "" }]
    expect(
      forwardableEvent({ t: "evt", ch: "bookmarks.changed", seq: 1, p: { bookmarks } }),
    ).not.toBeNull()
    expect(
      forwardableEvent({
        t: "evt",
        ch: "bookmarks.changed",
        seq: 1,
        p: { bookmarks: [{ id: 1, path: "/a", label: "a" }] },
      }),
    ).toBeNull()
  })

  it("drops unknown channels, main-owned channels and malformed payloads", () => {
    expect(forwardableEvent({ t: "evt", ch: "nope", seq: 1, p: {} })).toBeNull()
    expect(forwardableEvent({ t: "evt", ch: "sidecar.status", seq: 1, p: status })).toBeNull()
    expect(
      forwardableEvent({ t: "evt", ch: "index.progress", seq: 1, p: { ...progress, state: "?" } }),
    ).toBeNull()
  })
})
