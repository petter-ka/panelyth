import type { SidecarStatus } from "@panelyth/contracts"
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

const ORIGIN = "app://panelyth"
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
  // sender.id is the window an edit session belongs to (Stage 12).
  return {
    senderFrame: { url, parent },
    sender: { id: url.startsWith(COMMANDER) ? 2 : 1 },
  } as unknown as IpcMainInvokeEvent
}

const mainHandlers = (): MainHandlers => ({
  "app.exit": vi.fn(async () => ({ ok: true })),
  "app.switch": vi.fn(() => ({ ok: true })),
  "sidecar.getStatus": vi.fn(() => status),
  "dialog.openFolder": vi.fn(async () => ({ path: "/picked" })),
  "file.open": vi.fn(async (_e, p: { entryId: number }) => ({
    url: `panelyth-media://m/${String(p.entryId).padStart(32, "1")}`,
    kind: "file" as const,
    mime: "application/octet-stream",
    sizeBytes: 10,
  })),
  "shell.edit": vi.fn(async () => ({ ok: true })),
  "shell.run": vi.fn(async () => ({ ok: true })),
  "shell.runTool": vi.fn(async () => ({ ok: true })),
  "document.open": vi.fn(async () => ({ ok: true })),
  "media.openWindow": vi.fn(async () => ({ ok: true })),
  "media.windowStep": vi.fn(async () => ({ item: null })),
  "media.windowAnswer": vi.fn(async () => ({ ok: true })),
  "media.open": vi.fn(async (_e, p: { entryId: number }) => ({
    url: `panelyth-media://m/${String(p.entryId).padStart(32, "0")}`,
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
  "edit.render": vi.fn(async (_e, p: { rev: number }) => ({
    rev: p.rev,
    frame: { url: `panelyth-media://m/${"e".repeat(32)}`, width: 4, height: 3 },
    output: { width: 40, height: 30, dpi: { x: 0, y: 0 } },
  })),
  "edit.save": vi.fn(async () => ({ jobId: 5, name: "a (edited).jpg" })),
  "edit.reveal": vi.fn(async () => ({ ok: true })),
  "edit.thumbs": vi.fn(async () => ({ thumbs: [] })),
  "asset.pick": vi.fn(async () => ({ asset: null })),
  "asset.release": vi.fn(async () => ({ ok: true })),
  "batch.pickFolder": vi.fn(async () => ({ folder: null })),
  "batch.plan": vi.fn(async () => ({
    count: 2,
    skipped: [],
    names: ["a-edited.jpg"],
    bytes: 10,
    estimateBytes: 5,
    warnings: [],
    problems: [],
    samples: [{ id: 3, name: "a.jpg" }],
  })),
  "batch.start": vi.fn(async () => ({ jobId: 9 }) as never),
  "remote.saveConnection": vi.fn(async (_e, p) => ({ ...p.connection, id: 1 })),
  "remote.connect": vi.fn(async () => ({ remoteId: 1 }) as never),
  "remote.secureStore": vi.fn(() => ({ available: true })),
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
      ["document.open", { entryId: 3 }],
      ["document.open", { entryId: 3, theme: "light" }],
      ["media.open", { entryId: 3 }],
      ["media.openWindow", { entryId: 3, key: 1, theme: "dark", lang: "de" }],
      ["media.windowStep", { direction: -1 }],
      ["media.windowStep", { direction: 0 }],
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
    for (const m of ["file.open", "document.open", "shell.edit", "fs.mkfile"]) {
      const res = await handler(ok, m, { entryId: 3 })
      expect(res, m).toMatchObject({ ok: false, e: { code: "METHOD_NOT_FOUND" } })
    }
    // The viewer can answer a media window's question but not ask one.
    const asked = await handler(ok, "media.windowStep", { direction: 1 })
    expect(asked).toMatchObject({ ok: false, e: { code: "METHOD_NOT_FOUND" } })
    await expect(
      handler(ok, "media.windowAnswer", { requestId: 1, item: null }),
    ).resolves.toMatchObject({ ok: true })
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
      ["document.open", { entryId: 3, theme: "Pink Panther!" }],
      ["document.open", { entryId: 3, path: "/etc/passwd" }],
      ["document.open", { entryId: 0 }],
      ["media.openWindow", { entryId: 3, key: 1, path: "/etc/passwd" }],
      ["media.openWindow", { entryId: 3 }],
      ["media.openWindow", { entryId: 0, key: 1 }],
      ["media.windowStep", { direction: 2 }],
      ["media.windowAnswer", { requestId: 1, item: { id: 1 } }],
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

  it("gives the commander the command line and user commands; the viewer neither (Stage C10)", async () => {
    const { handler, main, sidecar, commander, ok } = setup()
    const sel = { queryId: 1, version: 1, ranges: [[0, 2]], include: [], exclude: [] }
    for (const [m, p] of [
      ["shell.run", { command: "git status", dirId: 7 }],
      // An empty line with the console flag: a console in the folder.
      ["shell.run", { command: "", dirId: 7, console: true }],
      ["shell.run", { command: 'echo "a & b" > %TEMP%\\x', dirId: 7, console: true }],
      ["shell.runTool", { toolId: "ab12cd34", dirId: 7 }],
      [
        "shell.runTool",
        { toolId: "ab12cd34", dirId: 7, otherDirId: 8, cursorId: 9, selection: sel },
      ],
    ] as const) {
      await expect(handler(commander, m, p), m).resolves.toMatchObject({ ok: true })
      expect(main[m]).toHaveBeenLastCalledWith(commander, p, "commander")
    }
    // Main runs them itself: nothing is forwarded to the sidecar by the router.
    expect(sidecar.call).not.toHaveBeenCalled()
    // The viewer's profile has neither.
    for (const [m, p] of [
      ["shell.run", { command: "calc", dirId: 7 }],
      ["shell.runTool", { toolId: "ab12cd34", dirId: 7 }],
    ] as const) {
      await expect(handler(ok, m, p), m).resolves.toMatchObject({
        ok: false,
        e: { code: "METHOD_NOT_FOUND" },
      })
    }
    // The viewer cannot plant a user command for the commander to run.
    await expect(
      handler(ok, "library.setSetting", {
        key: "commander.tools",
        value: { v: 1, commands: [{ id: "x", title: "x", command: "calc" }] },
      }),
    ).resolves.toMatchObject({ ok: false, e: { code: "PERMISSION_DENIED" } })
    expect(main["shell.run"]).toHaveBeenCalledTimes(3)
    // Validation: one line of text, folder and entry ids, a tool id; never a path or a program.
    for (const [m, p] of [
      ["shell.run", { command: "", dirId: 7 }],
      ["shell.run", { command: "   ", dirId: 7 }],
      ["shell.run", { command: "", dirId: 7, console: false }],
      ["shell.run", { command: "a\nb", dirId: 7 }],
      ["shell.run", { command: "a\u0000b", dirId: 7 }],
      ["shell.run", { command: "x".repeat(2049), dirId: 7 }],
      ["shell.run", { command: 5, dirId: 7 }],
      ["shell.run", { command: "dir", dirId: 0 }],
      ["shell.run", { command: "dir" }],
      ["shell.run", { command: "dir", dirId: 7, cwd: "C:\\Windows" }],
      ["shell.run", { command: "dir", dirId: 7, console: "yes" }],
      ["shell.run", { command: "dir", dirId: 7, env: { PATH: "x" } }],
      ["shell.runTool", { toolId: "../x", dirId: 7 }],
      ["shell.runTool", { toolId: "", dirId: 7 }],
      ["shell.runTool", { toolId: "ab12cd34" }],
      ["shell.runTool", { toolId: "ab12cd34", dirId: 7, command: "calc" }],
      ["shell.runTool", { toolId: "ab12cd34", dirId: 7, params: "%P" }],
      ["shell.runTool", { toolId: "ab12cd34", dirId: 7, cursorId: -1 }],
      ["shell.runTool", { toolId: "ab12cd34", dirId: 7, otherDirId: "C:\\" }],
      ["shell.runTool", { toolId: "ab12cd34", dirId: 7, selection: { paths: ["C:\\x"] } }],
    ] as const) {
      const res = await handler(commander, m, p)
      expect(res, `${m} ${JSON.stringify(p)}`).toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
    expect(main["shell.run"]).toHaveBeenCalledTimes(3)
    expect(main["shell.runTool"]).toHaveBeenCalledTimes(2)
  })

  it("gives the commander find files, branch scans and Go to file; the viewer none of them (Stage C06)", async () => {
    const { handler, sidecar, commander, ok } = setup()
    const abs = process.platform === "win32" ? "C:\\data" : "/data"
    const spec = {
      roots: [abs],
      mask: "*.txt|bak\\",
      depth: -1,
      hidden: false,
      text: "needle",
      caseSensitive: false,
      wholeWords: true,
      encodings: ["utf-8", "utf-16le"],
      skipBinary: true,
      minSize: 0,
      maxSize: null,
      modifiedAfter: null,
      modifiedBefore: 1_700_000_000_000,
      attrsSet: 0,
      attrsClear: 1,
    }
    const descriptor = {
      dirId: 1,
      recursive: false,
      sort: [{ field: "size", direction: "desc" }],
      kinds: [],
      search: "",
      exts: [],
      favorite: false,
      minRating: 0,
      tags: [],
      scope: "all",
      showHidden: false,
      nameMask: "*.log",
      findId: 4,
    }
    for (const [m, p] of [
      ["find.start", spec],
      ["find.cancel", { findId: 4 }],
      ["dir.openContaining", { entryId: 9 }],
      ["query.open", descriptor],
      ["dir.open", { path: abs, recursive: true, lane: "left" }],
      ["dir.openEntry", { entryId: 9, recursive: true, lane: "right" }],
    ] as const) {
      const res = await handler(commander, m, p)
      expect(res, `${m} ${JSON.stringify(res)}`).toMatchObject({ ok: true })
      expect(sidecar.call).toHaveBeenLastCalledWith(m, p)
    }
    for (const [m, p] of [
      ["find.start", { ...spec, roots: [] }],
      ["find.start", { ...spec, roots: ["relative"] }],
      ["find.start", { ...spec, encodings: ["utf-32"] }],
      ["find.start", { ...spec, attrsSet: 32 }],
      ["find.start", { ...spec, depth: -2 }],
      ["find.start", { ...spec, minSize: -1 }],
      ["find.start", { ...spec, extra: true }],
      ["find.cancel", { findId: 0 }],
      ["dir.openContaining", { path: abs }],
      ["query.open", { ...descriptor, recursive: true }],
      ["query.open", { ...descriptor, findId: -1 }],
      ["dir.open", { path: abs, recursive: false, lane: "Left Panel" }],
    ] as const) {
      const res = await handler(commander, m, p)
      expect(res, `${m} ${JSON.stringify(p)}`).toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
    for (const m of ["find.start", "find.cancel", "dir.openContaining"]) {
      const res = await handler(ok, m, { findId: 1 })
      expect(res, m).toMatchObject({ ok: false, e: { code: "METHOD_NOT_FOUND" } })
    }
    // Search results are in the all scope: never the viewer's.
    expect(await handler(ok, "query.open", { ...descriptor, scope: undefined })).toMatchObject({
      ok: false,
    })
  })

  it("checks archive methods and jobs (Stage C07)", async () => {
    const { handler, sidecar, commander, ok } = setup()
    const sel = { queryId: 2, version: 1, ranges: [[0, 2]], include: [], exclude: [] }
    const descriptor = {
      dirId: 1,
      recursive: false,
      sort: [],
      kinds: [],
      search: "",
      exts: [],
      favorite: false,
      minRating: 0,
      tags: [],
      scope: "all",
      archiveId: 3,
      archiveDirId: 0,
    }
    for (const [m, p] of [
      ["archive.open", { entryId: 9 }],
      ["archive.close", { archiveId: 3 }],
      ["archive.check", { selection: sel, destinationDirId: 4 }],
      ["archive.tools", {}],
      ["query.open", descriptor],
      [
        "jobs.start",
        {
          kind: "extract",
          source: { selection: sel },
          destinationDirId: 4,
          conflict: "ask",
          subfolders: true,
        },
      ],
      [
        "jobs.start",
        {
          kind: "pack",
          source: { selection: sel },
          destinationDirId: 4,
          conflict: "ask",
          name: "out.zip",
          format: "zip",
          level: 6,
          deleteOriginals: false,
        },
      ],
      ["jobs.start", { kind: "testArchive", source: { selection: sel } }],
    ] as const) {
      const res = await handler(commander, m, p)
      expect(res, `${m} ${JSON.stringify(res)}`).toMatchObject({ ok: true })
      expect(sidecar.call).toHaveBeenLastCalledWith(m, p)
    }
    const pack = {
      kind: "pack",
      source: { selection: sel },
      destinationDirId: 4,
      conflict: "ask",
      name: "out.zip",
      format: "zip",
      level: 6,
    }
    for (const [m, p] of [
      ["archive.open", { entryId: 0 }],
      ["archive.close", {}],
      ["archive.check", { selection: sel }],
      ["query.open", { ...descriptor, recursive: true }],
      ["query.open", { ...descriptor, archiveId: undefined }],
      ["query.open", { ...descriptor, findId: 2 }],
      ["jobs.start", { ...pack, format: "rar" }],
      ["jobs.start", { ...pack, level: 10 }],
      ["jobs.start", { ...pack, name: "" }],
      ["jobs.start", { ...pack, destination: "/tmp" }],
      [
        "jobs.start",
        { kind: "extract", source: { selection: sel }, destinationDirId: 4, conflict: "nope" },
      ],
      [
        "jobs.start",
        {
          kind: "extract",
          source: { selection: sel },
          destinationDirId: 4,
          conflict: "ask",
          links: 1,
        },
      ],
    ] as const) {
      const res = await handler(commander, m, p)
      expect(res, `${m} ${JSON.stringify(p)}`).toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
    // The viewer has no archives.
    for (const m of ["archive.open", "archive.close", "archive.check", "archive.tools"]) {
      const res = await handler(ok, m, { entryId: 1 })
      expect(res, m).toMatchObject({ ok: false, e: { code: "METHOD_NOT_FOUND" } })
    }
    expect(
      await handler(ok, "jobs.start", { kind: "testArchive", source: { selection: sel } }),
    ).toMatchObject({ ok: false, e: { code: "PERMISSION_DENIED" } })
    expect(
      await handler(ok, "query.open", { ...descriptor, scope: undefined, archiveDirId: undefined }),
    ).toMatchObject({ ok: false })
  })

  it("checks compare methods and jobs (Stage C08)", async () => {
    const { handler, sidecar, commander, ok } = setup()
    const sel = { queryId: 2, version: 1, ranges: [[0, 2]], include: [], exclude: [] }
    const options = { toleranceMs: 2000, dst: false, ignoreDates: false }
    const dirs = { leftDirId: 3, rightDirId: 4, ...options, content: false, asymmetric: true }
    const marks = { leftQueryId: 5, rightQueryId: 6, ...options }
    const list = {
      kind: "hashCreate",
      source: { selection: sel },
      algorithm: "sha256",
      perFile: false,
      destinationDirId: 4,
      name: "sums.sha256",
    }
    for (const [m, p] of [
      ["compare.dirs", dirs],
      ["compare.cancel", { compareId: 1 }],
      ["compare.close", { compareId: 1 }],
      ["compare.plan", { compareId: 1 }],
      ["compare.show", { compareId: 1, show: ["copyRight", "delete"] }],
      ["compare.show", { compareId: 1, show: [] }],
      ["compare.setAction", { compareId: 1, selection: sel, action: "copyLeft" }],
      ["compare.setAction", { compareId: 1, selection: sel, action: "default" }],
      ["compare.marks", marks],
      ["diff.open", { leftId: 7, rightId: 8 }],
      ["diff.page", { diffId: 1, offset: 0, limit: 500 }],
      ["diff.close", { diffId: 1 }],
      ["jobs.start", { kind: "sync", compareId: 1, planVersion: 3 }],
      ["jobs.start", { kind: "sync", compareId: 1, planVersion: 3, deletePermanently: true }],
      ["jobs.start", list],
      [
        "jobs.start",
        { kind: "hashCreate", source: { selection: sel }, algorithm: "crc32", perFile: true },
      ],
      ["jobs.start", { kind: "hashVerify", source: { selection: sel } }],
      ["jobs.start", { kind: "compareFiles", leftId: 7, rightId: 8 }],
      // Stage C10.5: several files against a folder.
      ["jobs.start", { kind: "compareFiles", source: { selection: sel }, destinationDirId: 9 }],
    ] as const) {
      const res = await handler(commander, m, p)
      expect(res, `${m} ${JSON.stringify(res)}`).toMatchObject({ ok: true })
      // Nothing is added for these: no copyLinks, no paths.
      expect(sidecar.call).toHaveBeenLastCalledWith(m, p)
    }
    for (const [m, p] of [
      ["compare.dirs", { ...dirs, leftDirId: 0 }],
      // The roots are folder ids, never paths: a sync writes to them.
      ["compare.dirs", { ...dirs, leftDirId: "/home/me", left: "/home/me" }],
      ["compare.dirs", { ...dirs, toleranceMs: 60_001 }],
      ["compare.dirs", { ...dirs, toleranceMs: -1 }],
      ["compare.dirs", { ...dirs, asymmetric: "yes" }],
      ["compare.dirs", { ...dirs, mask: "*.txt" }],
      ["compare.cancel", {}],
      ["compare.show", { compareId: 1, show: ["everything"] }],
      ["compare.show", { compareId: 1, show: "equal" }],
      ["compare.setAction", { compareId: 1, selection: sel, action: "shred" }],
      [
        "compare.setAction",
        { compareId: 1, selection: { ...sel, ranges: [[3, 1]] }, action: "none" },
      ],
      ["compare.marks", { ...marks, rightQueryId: 5 }],
      ["compare.marks", { ...marks, dst: 1 }],
      ["diff.open", { leftId: 7 }],
      ["diff.open", { leftId: 7, rightId: 8, path: "/etc/passwd" }],
      ["diff.page", { diffId: 1, offset: 0, limit: 501 }],
      ["diff.page", { diffId: 1, offset: -1, limit: 10 }],
      ["jobs.start", { kind: "sync", compareId: 1 }],
      ["jobs.start", { kind: "sync", compareId: 1, planVersion: 0 }],
      // A sync takes no selection and no paths: only the confirmed plan.
      ["jobs.start", { kind: "sync", compareId: 1, planVersion: 3, source: { selection: sel } }],
      ["jobs.start", { kind: "sync", compareId: 1, planVersion: 3, right: "/tmp" }],
      ["jobs.start", { ...list, algorithm: "sha512" }],
      ["jobs.start", { ...list, name: "" }],
      ["jobs.start", { ...list, destinationDirId: undefined }],
      ["jobs.start", { ...list, perFile: true }],
      ["jobs.start", { ...list, destination: "/tmp" }],
      ["jobs.start", { kind: "hashVerify" }],
      ["jobs.start", { kind: "compareFiles", leftId: 7 }],
      ["jobs.start", { kind: "compareFiles", leftId: 7, rightId: 8, source: { selection: sel } }],
      ["jobs.start", { kind: "compareFiles", source: { selection: sel } }],
      ["jobs.start", { kind: "compareFiles", source: { selection: sel }, destinationDirId: 0 }],
      ["jobs.start", { kind: "compareFiles", source: { selection: sel }, destination: "/tmp" }],
      ["jobs.start", { kind: "compareFiles", source: {}, destinationDirId: 9 }],
    ] as const) {
      const res = await handler(commander, m, p)
      expect(res, `${m} ${JSON.stringify(p)}`).toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
    // The viewer compares nothing.
    for (const m of [
      "compare.dirs",
      "compare.cancel",
      "compare.close",
      "compare.show",
      "compare.setAction",
      "compare.plan",
      "compare.marks",
      "diff.open",
      "diff.page",
      "diff.close",
    ]) {
      const res = await handler(ok, m, { compareId: 1 })
      expect(res, m).toMatchObject({ ok: false, e: { code: "METHOD_NOT_FOUND" } })
    }
    for (const p of [
      { kind: "sync", compareId: 1, planVersion: 3 },
      { kind: "hashVerify", source: { selection: sel } },
      { kind: "compareFiles", leftId: 7, rightId: 8 },
      { kind: "hashCreate", source: { selection: sel }, algorithm: "md5", perFile: true },
    ]) {
      expect(await handler(ok, "jobs.start", p), p.kind).toMatchObject({
        ok: false,
        e: { code: "PERMISSION_DENIED" },
      })
    }
    // The compare's progress is forwarded like the other sidecar events.
    const progress = {
      compareId: 1,
      state: "running",
      phase: "listing",
      dirs: 2,
      entries: 10,
      compared: 0,
      bytes: 0,
      errors: 0,
      links: 0,
      rows: 4,
      truncated: false,
      elapsedMs: 12,
    }
    expect(
      forwardableEvent({ t: "evt", ch: "compare.progress", seq: 1, p: progress }),
    ).toMatchObject({ ch: "compare.progress" })
    expect(
      forwardableEvent({
        t: "evt",
        ch: "compare.progress",
        seq: 2,
        p: { ...progress, phase: "?" },
      }),
    ).toBeNull()
  })

  it("checks the multi-rename preview and the rename and attribute jobs (Stage C09)", async () => {
    const { handler, sidecar, commander, ok } = setup()
    const sel = { queryId: 2, version: 1, ranges: [[0, 2]], include: [], exclude: [] }
    const plan = {
      nameMask: "[N]-[C]",
      extMask: "[E]",
      search: "",
      replace: "",
      regex: false,
      matchCase: false,
      case: "",
      start: 1,
      step: 1,
      digits: 2,
    }
    const preview = { selection: sel, plan, offset: 0, limit: 200 }
    const attrs = { kind: "setAttributes", source: { selection: sel } }
    for (const [m, p] of [
      ["rename.preview", preview],
      ["rename.preview", { ...preview, plan: { ...plan, case: "words", start: -5, step: -1 } }],
      ["rename.undoInfo", {}],
      ["jobs.start", { kind: "multiRename", source: { selection: sel }, plan }],
      ["jobs.start", { kind: "undoRename" }],
      ["jobs.start", { ...attrs, setAttrs: 4, clearAttrs: 1 | 8 }],
      ["jobs.start", { ...attrs, setMode: 0o400, clearMode: 0o022, recursive: true }],
      [
        "jobs.start",
        { ...attrs, modifiedMs: Date.UTC(2024, 0, 2), accessedMs: Date.UTC(2024, 0, 3) },
      ],
    ] as const) {
      const res = await handler(commander, m, p)
      expect(res, `${m} ${JSON.stringify(res)}`).toMatchObject({ ok: true })
      // Nothing is added for these: no copyLinks, no paths.
      expect(sidecar.call).toHaveBeenLastCalledWith(m, p)
    }
    for (const [m, p] of [
      ["rename.preview", { ...preview, limit: 0 }],
      ["rename.preview", { ...preview, limit: 501 }],
      ["rename.preview", { ...preview, offset: -1 }],
      ["rename.preview", { ...preview, plan: { ...plan, case: "title" } }],
      ["rename.preview", { ...preview, plan: { ...plan, digits: 0 } }],
      ["rename.preview", { ...preview, plan: { ...plan, digits: 11 } }],
      ["rename.preview", { ...preview, plan: { ...plan, step: 1_000_001 } }],
      ["rename.preview", { ...preview, plan: { ...plan, nameMask: "x".repeat(256) } }],
      ["rename.preview", { ...preview, plan: { ...plan, search: "a\0b" } }],
      ["rename.preview", { ...preview, plan: { ...plan, regex: "yes" } }],
      // A plan is exactly its fields: no folder, no list of names.
      ["rename.preview", { ...preview, plan: { ...plan, folder: "/tmp" } }],
      ["rename.preview", { ...preview, names: ["a", "b"] }],
      ["rename.preview", { ...preview, selection: { ...sel, ranges: [[3, 1]] } }],
      ["rename.undoInfo", { jobId: 1 }],
      ["jobs.start", { kind: "multiRename", source: { selection: sel } }],
      ["jobs.start", { kind: "multiRename", plan }],
      [
        "jobs.start",
        { kind: "multiRename", source: { selection: sel }, plan, destination: "/tmp" },
      ],
      [
        "jobs.start",
        { kind: "multiRename", source: { selection: sel }, plan: { ...plan, start: 1.5 } },
      ],
      // An undo takes nothing: it undoes what Go recorded, not what a renderer says.
      ["jobs.start", { kind: "undoRename", source: { selection: sel } }],
      ["jobs.start", { kind: "undoRename", names: [["b", "a"]] }],
      ["jobs.start", attrs],
      ["jobs.start", { ...attrs, recursive: true }],
      ["jobs.start", { ...attrs, setAttrs: 4, clearAttrs: 4 }],
      ["jobs.start", { ...attrs, setAttrs: 16 }],
      ["jobs.start", { ...attrs, clearAttrs: 32 }],
      ["jobs.start", { ...attrs, setMode: 0o1000 }],
      ["jobs.start", { ...attrs, setMode: 0o600, clearMode: 0o200 }],
      ["jobs.start", { ...attrs, modifiedMs: Date.UTC(1979, 11, 31) }],
      ["jobs.start", { ...attrs, accessedMs: Date.UTC(10_000, 0, 1) }],
      ["jobs.start", { ...attrs, modifiedMs: "now" }],
      ["jobs.start", { ...attrs, setAttrs: 1, recursive: 1 }],
      ["jobs.start", { ...attrs, setAttrs: 1, path: "C:\\Windows" }],
      ["jobs.start", { kind: "setAttributes", setAttrs: 1 }],
    ] as const) {
      const res = await handler(commander, m, p)
      expect(res, `${m} ${JSON.stringify(p)}`).toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
    // The viewer keeps its own batch rename and has none of this.
    for (const m of ["rename.preview", "rename.undoInfo"]) {
      const res = await handler(ok, m, {})
      expect(res, m).toMatchObject({ ok: false, e: { code: "METHOD_NOT_FOUND" } })
    }
    for (const p of [
      { kind: "multiRename", source: { selection: sel }, plan },
      { kind: "undoRename" },
      { ...attrs, setAttrs: 1 },
    ]) {
      expect(await handler(ok, "jobs.start", p), p.kind).toMatchObject({
        ok: false,
        e: { code: "PERMISSION_DENIED" },
      })
    }
    // The viewer's pattern rename is not the commander's.
    expect(
      await handler(commander, "jobs.start", {
        kind: "rename",
        source: { selection: sel },
        pattern: "{name} {n}",
        start: 1,
      }),
    ).toMatchObject({ ok: false, e: { code: "PERMISSION_DENIED" } })
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

  it("lets the commander's tree list a folder's subfolders, hidden ones too; the viewer's never", async () => {
    const { handler, sidecar, commander, ok: viewer } = setup()
    const path = process.platform === "win32" ? "C:\\data" : "/data"
    for (const params of [{ path }, { path, showHidden: true }, { path, showHidden: false }]) {
      await expect(handler(commander, "fs.listDirs", params)).resolves.toMatchObject({ ok: true })
      expect(sidecar.call).toHaveBeenLastCalledWith("fs.listDirs", params)
    }
    for (const params of [
      { path, showHidden: "yes" },
      { path, showHidden: true, depth: 2 },
      { path: "relative", showHidden: true },
      { showHidden: true },
    ]) {
      await expect(handler(commander, "fs.listDirs", params)).resolves.toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
    // The viewer lists visible folders only (ADR-0026).
    await expect(handler(viewer, "fs.listDirs", { path })).resolves.toMatchObject({ ok: true })
    vi.mocked(sidecar.call).mockClear()
    await expect(handler(viewer, "fs.listDirs", { path, showHidden: true })).resolves.toMatchObject(
      { ok: false },
    )
    expect(sidecar.call).not.toHaveBeenCalled()
  })

  it("gives connections to the commander only, with every typed value checked (Stage C10.5)", async () => {
    const { handler, sidecar, main, commander, ok: viewer } = setup()
    const sel = { queryId: 1, version: 2, ranges: [[0, 3]], include: [], exclude: [] }
    const connection = {
      id: 0,
      name: "Work",
      group: "",
      host: "ftp.example.org",
      port: 21,
      tls: "explicit",
      user: "alice",
      startPath: "/pub",
      localPath: "",
      active: false,
      encoding: "",
      transfers: 2,
      fingerprint: "",
      hasPassword: false,
    }
    const quick = {
      host: "10.0.0.7",
      port: 2121,
      tls: "none",
      user: "",
      active: false,
      encoding: "",
      transfers: 1,
    }
    const descriptor = {
      dirId: 1,
      recursive: false,
      sort: [{ field: "name", direction: "asc" }],
      kinds: [],
      search: "",
      exts: [],
      favorite: false,
      minRating: 0,
      tags: [],
      scope: "all",
    }
    const print = "ab".repeat(32)
    const good: [string, unknown][] = [
      ["remote.connections", {}],
      ["remote.secureStore", {}],
      ["remote.saveConnection", { connection }],
      ["remote.saveConnection", { connection, password: "s3cret" }],
      ["remote.saveConnection", { connection: { ...connection, id: 4 }, forget: true }],
      ["remote.removeConnection", { connectionId: 4 }],
      ["remote.trust", { connectionId: 4, fingerprint: print }],
      ["remote.trust", { connectionId: 4, fingerprint: "" }],
      ["remote.connect", { connectionId: 4, attempt: 1 }],
      ["remote.connect", { connectionId: 4, attempt: 1, password: "", accept: print }],
      ["remote.connect", { quick, attempt: 2, password: "typed" }],
      ["remote.cancel", { attempt: 2 }],
      ["remote.disconnect", { remoteId: 1 }],
      ["remote.open", { remoteId: 1, path: "/pub/my photos" }],
      ["remote.open", { remoteId: 1, dirId: 7881299348946945 }],
      ["remote.open", { remoteId: 1, path: "/pub", attempt: 9 }],
      ["remote.mkdir", { remoteDirId: 7881299348946945, name: "new folder" }],
      ["remote.rename", { entryId: 7881299348946946, name: "read me.txt" }],
      ["query.open", { ...descriptor, remoteId: 1, remoteDirId: 7881299348946945 }],
      [
        "jobs.start",
        { kind: "download", source: { selection: sel }, destinationDirId: 9, conflict: "ask" },
      ],
      [
        "jobs.start",
        {
          kind: "upload",
          source: { selection: sel },
          remoteDirId: 9,
          conflict: "skip",
          move: true,
        },
      ],
      ["jobs.start", { kind: "remoteDelete", source: { selection: sel } }],
    ]
    for (const [m, p] of good) {
      const res = await handler(commander, m, p)
      expect(res, `${m} ${JSON.stringify(res)}`).toMatchObject({ ok: true })
      // The viewer has none of it.
      const refused = await handler(viewer, m, p)
      expect(refused, `viewer ${m}`).toMatchObject({ ok: false })
    }
    // The three that pass a password are answered by main, never forwarded as they came.
    expect(main["remote.saveConnection"]).toHaveBeenCalledTimes(3)
    expect(main["remote.connect"]).toHaveBeenCalledTimes(3)
    for (const [method] of vi.mocked(sidecar.call).mock.calls) {
      expect(["remote.saveConnection", "remote.connect", "remote.secureStore"]).not.toContain(
        method,
      )
    }
    // A renderer can name neither of main's own three.
    for (const m of ["remote.storeConnection", "remote.dial", "remote.secret"]) {
      await expect(handler(commander, m, { connectionId: 1 })).resolves.toMatchObject({
        ok: false,
        e: { code: "METHOD_NOT_FOUND" },
      })
    }

    const bad: [string, unknown][] = [
      ["remote.connections", { all: true }],
      ["remote.saveConnection", { connection: { ...connection, host: "" } }],
      ["remote.saveConnection", { connection: { ...connection, host: "bob@example.org" } }],
      ["remote.saveConnection", { connection: { ...connection, host: "example.org/x" } }],
      ["remote.saveConnection", { connection: { ...connection, host: "a\r\nUSER root" } }],
      ["remote.saveConnection", { connection: { ...connection, port: 0 } }],
      ["remote.saveConnection", { connection: { ...connection, port: 65536 } }],
      ["remote.saveConnection", { connection: { ...connection, tls: "maybe" } }],
      ["remote.saveConnection", { connection: { ...connection, name: "  " } }],
      ["remote.saveConnection", { connection: { ...connection, user: "a\nb" } }],
      ["remote.saveConnection", { connection: { ...connection, startPath: "pub" } }],
      ["remote.saveConnection", { connection: { ...connection, transfers: 5 } }],
      ["remote.saveConnection", { connection: { ...connection, fingerprint: "abc" } }],
      ["remote.saveConnection", { connection: { ...connection, secret: "AAAA" } }],
      ["remote.saveConnection", { connection, password: "" }],
      ["remote.saveConnection", { connection, password: "two\nlines" }],
      ["remote.saveConnection", { connection, password: "x".repeat(1025) }],
      ["remote.saveConnection", { connection, password: "x", forget: true }],
      ["remote.saveConnection", { connection, secret: "AAAA" }],
      ["remote.removeConnection", { connectionId: 0 }],
      ["remote.trust", { connectionId: 4, fingerprint: "zz".repeat(32) }],
      ["remote.connect", { attempt: 1 }],
      ["remote.connect", { connectionId: 4 }],
      ["remote.connect", { connectionId: 4, quick, attempt: 1 }],
      ["remote.connect", { connectionId: 4, attempt: 1, password: "a\r\nDELE x" }],
      ["remote.connect", { connectionId: 4, attempt: 1, accept: "" }],
      ["remote.connect", { quick: { ...quick, host: "a b" }, attempt: 1 }],
      ["remote.connect", { quick: { ...quick, password: "x" }, attempt: 1 }],
      ["remote.cancel", {}],
      ["remote.disconnect", { remoteId: -1 }],
      ["remote.open", { remoteId: 1 }],
      ["remote.open", { remoteId: 1, path: "pub" }],
      ["remote.open", { remoteId: 1, path: "/a\nb" }],
      ["remote.open", { remoteId: 1, path: "/a", dirId: 2 }],
      ["remote.open", { remoteId: 1, path: "/a", attempt: "x" }],
      ["remote.open", { remoteId: 1, path: "/a", extra: 1 }],
      ["remote.mkdir", { remoteDirId: 9, name: "a/b" }],
      ["remote.mkdir", { remoteDirId: 9, name: ".." }],
      ["remote.mkdir", { remoteDirId: 9, name: "a\\b" }],
      ["remote.rename", { entryId: 9, name: "" }],
      ["remote.rename", { entryId: 9, name: "x\ny" }],
      ["query.open", { ...descriptor, remoteId: 1 }],
      ["query.open", { ...descriptor, remoteId: 1, remoteDirId: 2, scope: "media" }],
      ["query.open", { ...descriptor, remoteId: 1, remoteDirId: 2, archiveId: 3 }],
      ["query.open", { ...descriptor, remoteId: 1, remoteDirId: 2, recursive: true }],
      [
        "jobs.start",
        { kind: "download", source: { selection: sel }, destination: "/tmp", conflict: "ask" },
      ],
      ["jobs.start", { kind: "download", source: { selection: sel }, destinationDirId: 9 }],
      ["jobs.start", { kind: "upload", source: { selection: sel }, conflict: "ask" }],
      [
        "jobs.start",
        { kind: "upload", source: { selection: sel }, remoteDirId: 9, conflict: "ask", move: 1 },
      ],
      ["jobs.start", { kind: "remoteDelete", source: { selection: sel }, permanent: true }],
    ]
    vi.mocked(sidecar.call).mockClear()
    for (const [m, p] of bad) {
      const res = await handler(commander, m, p)
      expect(res, `${m} ${JSON.stringify(p)}`).toMatchObject({ ok: false })
    }
    expect(sidecar.call).not.toHaveBeenCalled()
    // A refusal never repeats a password.
    const echo = await handler(commander, "remote.saveConnection", {
      connection,
      password: "hunter2\nx",
    })
    expect(JSON.stringify(echo)).not.toContain("hunter2")
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
    ["lookalike host", eventFrom("app://panelyth.evil/index.html")],
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

describe("the image editor's methods (Stage 12, ADR-0035)", () => {
  const SESSION = "0123456789abcdef01234567"
  const list = [{ op: "rotate", p: { angle: 90 } }]
  const render = {
    sessionId: SESSION,
    rev: 1,
    editList: list,
    view: { maxEdge: 1200 },
    quality: "draft",
    histogram: true,
  }
  const save = {
    sessionId: SESSION,
    editList: list,
    target: "copy",
    format: "jpeg",
    quality: 92,
    metadata: "keep",
    dpi: 0,
  }
  const estimate = {
    sessionId: SESSION,
    editList: list,
    format: "png",
    quality: 0,
    metadata: "strip",
  }

  it("serves the viewer and adds the calling window to edit.open", async () => {
    const { handler, sidecar, main, ok } = setup()
    await expect(handler(ok, "edit.open", { entryId: 9 })).resolves.toMatchObject({ ok: true })
    expect(sidecar.call).toHaveBeenLastCalledWith("edit.open", { entryId: 9, owner: 1 })
    await expect(handler(ok, "edit.render", render)).resolves.toMatchObject({
      ok: true,
      r: { rev: 1, frame: { width: 4 } },
    })
    expect(main["edit.render"]).toHaveBeenCalledWith(ok, render, "viewer")
    await expect(handler(ok, "edit.save", save)).resolves.toEqual({
      ok: true,
      r: { jobId: 5, name: "a (edited).jpg" },
    })
    for (const [m, p] of [
      ["edit.info", { sessionId: SESSION }],
      ["edit.close", { sessionId: SESSION }],
      ["edit.estimate", estimate],
      ["edit.saved", { jobId: 5 }],
      ["edit.reveal", { jobId: 5 }],
    ] as const) {
      await expect(handler(ok, m, p), m).resolves.toMatchObject({ ok: true })
    }
  })

  it("refuses every edit method from the commander's view, and the sidecar-side ones from anyone", async () => {
    const { handler, sidecar, main, commander, ok } = setup()
    for (const [m, p] of [
      ["edit.open", { entryId: 9 }],
      ["edit.render", render],
      ["edit.info", { sessionId: SESSION }],
      ["edit.estimate", estimate],
      ["edit.save", save],
      ["edit.close", { sessionId: SESSION }],
      ["edit.saved", { jobId: 5 }],
      ["edit.reveal", { jobId: 5 }],
    ] as const) {
      await expect(handler(commander, m, p), m).resolves.toMatchObject({
        ok: false,
        e: { code: "METHOD_NOT_FOUND" },
      })
    }
    // What main calls in the sidecar (a frame file, a save path) is not a renderer method.
    for (const m of ["edit.frame", "edit.write", "edit.source", "edit.savedPath"]) {
      for (const from of [ok, commander]) {
        await expect(handler(from, m, {}), m).resolves.toMatchObject({
          ok: false,
          e: { code: "METHOD_NOT_FOUND" },
        })
      }
    }
    expect(sidecar.call).not.toHaveBeenCalled()
    expect(main["edit.render"]).not.toHaveBeenCalled()
    expect(main["edit.save"]).not.toHaveBeenCalled()
  })

  it("lets a renderer name neither the owner nor a path", async () => {
    const { handler, sidecar, ok } = setup()
    for (const p of [
      { entryId: 9, owner: 77 },
      { entryId: 0 },
      { entryId: "9" },
      { path: "C:\\x.jpg" },
      {},
    ]) {
      await expect(handler(ok, "edit.open", p)).resolves.toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
    for (const extra of [{ path: "C:\\out.jpg" }, { destination: "/tmp/x.jpg" }, { owner: 1 }]) {
      await expect(handler(ok, "edit.save", { ...save, ...extra })).resolves.toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
    expect(sidecar.call).not.toHaveBeenCalled()
  })

  it.each([
    ["a session id that is not one", { ...render, sessionId: "../../etc" }],
    ["a session id of the wrong length", { ...render, sessionId: "abc" }],
    ["revision zero", { ...render, rev: 0 }],
    ["a fractional revision", { ...render, rev: 1.5 }],
    ["no view", { ...render, view: {} }],
    ["a huge view", { ...render, view: { maxEdge: 1e9 } }],
    ["a view with extras", { ...render, view: { maxEdge: 100, rect: [0, 0, 1, 1] } }],
    ["an unknown quality", { ...render, quality: "best" }],
    ["a histogram flag that is not a boolean", { ...render, histogram: "yes" }],
    ["an edit list that is not a list", { ...render, editList: "[]" }],
    ["an unknown operation", { ...render, editList: [{ op: "shell", p: { cmd: "calc" } }] }],
    ["NaN in an operation", { ...render, editList: [{ op: "rotate", p: { angle: Number.NaN } }] }],
    ["extra keys on an operation", { ...render, editList: [{ op: "flip", p: {}, run: 1 }] }],
    ["too many operations", { ...render, editList: Array.from({ length: 513 }, () => list[0]) }],
    ["an extra parameter", { ...render, file: "x" }],
  ])("refuses a render with %s", async (_name, params) => {
    const { handler, main, ok } = setup()
    await expect(handler(ok, "edit.render", params)).resolves.toMatchObject({
      ok: false,
      e: { code: "INVALID_ARGUMENT" },
    })
    expect(main["edit.render"]).not.toHaveBeenCalled()
  })

  it.each([
    ["an unknown target", { ...save, target: "overwrite" }],
    ["an unknown format", { ...save, format: "webp" }],
    ["a quality out of range", { ...save, quality: 101 }],
    ["a fractional quality", { ...save, quality: 80.5 }],
    ["an unknown metadata policy", { ...save, metadata: "all" }],
    ["a negative resolution", { ...save, dpi: -1 }],
    ["a huge resolution", { ...save, dpi: 1e6 }],
    ["a resolution that is not a number", { ...save, dpi: "300" }],
    ["a hostile edit list", { ...save, editList: [{ op: "crop", p: { rect: null } }] }],
  ])("refuses a save with %s", async (_name, params) => {
    const { handler, main, ok } = setup()
    await expect(handler(ok, "edit.save", params)).resolves.toMatchObject({
      ok: false,
      e: { code: "INVALID_ARGUMENT" },
    })
    expect(main["edit.save"]).not.toHaveBeenCalled()
  })

  it("lets only the commander hand a picture to the viewer's editor", async () => {
    const { handler, main, commander, ok } = setup()
    await expect(handler(commander, "app.switch", { to: "viewer", edit: 12 })).resolves.toEqual({
      ok: true,
      r: { ok: true },
    })
    expect(main["app.switch"]).toHaveBeenLastCalledWith(
      commander,
      { to: "viewer", edit: 12 },
      "commander",
    )
    for (const [from, p] of [
      [ok, { to: "commander", edit: 12 }],
      [ok, { to: "viewer", edit: 12 }],
      [commander, { to: "commander", edit: 12 }],
    ] as const) {
      await expect(handler(from, "app.switch", p)).resolves.toMatchObject({
        ok: false,
        e: { code: "PERMISSION_DENIED" },
      })
    }
    for (const edit of [0, -1, 1.5, "12", null]) {
      await expect(handler(commander, "app.switch", { to: "viewer", edit })).resolves.toMatchObject(
        {
          ok: false,
          e: { code: "INVALID_ARGUMENT" },
        },
      )
    }
    expect(main["app.switch"]).toHaveBeenCalledTimes(1)
  })

  it("serves the Stage 13 methods to the viewer only, with every parameter checked", async () => {
    const { handler, sidecar, main, commander, ok } = setup()
    const tone = [
      {
        op: "levels",
        p: { l: { inBlack: 10, inWhite: 240, gamma: 1.1, outBlack: 0, outWhite: 255 } },
      },
      {
        op: "curves",
        p: {
          l: [
            [0, 0],
            [128, 140],
            [255, 255],
          ],
        },
      },
    ]
    const probe = {
      sessionId: SESSION,
      editList: tone,
      view: { maxEdge: 900 },
      x: 0.5,
      y: 0.25,
      radius: 2,
    }
    const thumbs = { sessionId: SESSION, editLists: [[], tone], edge: 120 }
    const colors = { sessionId: SESSION, editList: tone, scope: "edited", maxColors: 16 }
    await expect(handler(ok, "edit.probe", probe)).resolves.toMatchObject({ ok: true })
    expect(sidecar.call).toHaveBeenLastCalledWith("edit.probe", probe)
    await expect(handler(ok, "edit.colors", colors)).resolves.toMatchObject({ ok: true })
    await expect(handler(ok, "edit.thumbs", thumbs)).resolves.toEqual({
      ok: true,
      r: { thumbs: [] },
    })
    expect(main["edit.thumbs"]).toHaveBeenCalledWith(ok, thumbs, "viewer")
    await expect(
      handler(ok, "edit.render", { ...render, editList: tone, histogramAt: 1 }),
    ).resolves.toMatchObject({ ok: true })
    for (const [m, p] of [
      ["edit.probe", probe],
      ["edit.thumbs", thumbs],
      ["edit.colors", colors],
      ["edit.thumbFrames", thumbs],
    ] as const) {
      await expect(handler(commander, m, p), m).resolves.toMatchObject({
        ok: false,
        e: { code: "METHOD_NOT_FOUND" },
      })
    }
    await expect(handler(ok, "edit.thumbFrames", thumbs)).resolves.toMatchObject({
      ok: false,
      e: { code: "METHOD_NOT_FOUND" },
    })
    for (const [m, p] of [
      ["edit.probe", { ...probe, x: 1.5 }],
      ["edit.probe", { ...probe, y: Number.NaN }],
      ["edit.probe", { ...probe, radius: 99 }],
      ["edit.probe", { ...probe, view: { maxEdge: 0 } }],
      ["edit.probe", { ...probe, editList: [{ op: "exec", p: {} }] }],
      ["edit.thumbs", { ...thumbs, edge: 4000 }],
      ["edit.thumbs", { ...thumbs, editLists: Array.from({ length: 17 }, () => []) }],
      ["edit.thumbs", { ...thumbs, editLists: [[{ op: "flip", p: { axis: null } }]] }],
      ["edit.thumbs", { ...thumbs, editLists: "all" }],
      ["edit.colors", { ...colors, scope: "everything" }],
      ["edit.colors", { ...colors, maxColors: 0 }],
      ["edit.colors", { ...colors, maxColors: 1000 }],
      ["edit.colors", { ...colors, path: "C:\\x" }],
      ["edit.render", { ...render, histogramAt: -1 }],
      ["edit.render", { ...render, histogramAt: 1.5 }],
      ["edit.render", { ...render, histogramAt: 100000 }],
    ] as const) {
      await expect(handler(ok, m, p), JSON.stringify(p).slice(0, 80)).resolves.toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
  })

  it("gives the viewer effects, fonts and picked assets; the commander none of them (Stage 14)", async () => {
    const { handler, sidecar, main, commander, ok } = setup()
    const ASSET = "0123456789abcdef0123456789abcdef"
    const effects = [
      { op: "border", p: { style: "polaroid", width: 5, color: "#ffffff" } },
      { op: "frameMask", p: { shape: "custom", assetId: ASSET, feather: 2 } },
      { op: "watermark", p: { text: "© {year} {name}", size: 6, font: "Go", anchor: "se" } },
      { op: "bump", p: { height: 40, source: "texture", assetId: ASSET, tile: true } },
      { op: "sketch", p: { style: "pencil", detail: 60 } },
      { op: "oil", p: { radius: 4 } },
      { op: "lens", p: { mode: "bulge", amount: 50, cx: 0.4, cy: 0.6 } },
      {
        op: "obscure",
        p: {
          method: "mosaic",
          strength: 60,
          shape: "polygon",
          points: [
            [0.1, 0.1],
            [0.5, 0.2],
            [0.3, 0.7],
          ],
        },
      },
    ]
    // The operations are known to the structural check; Go checks what they mean.
    await expect(
      handler(ok, "edit.render", { ...render, editList: effects }),
    ).resolves.toMatchObject({
      ok: true,
    })
    await expect(handler(ok, "edit.fonts", { sessionId: SESSION })).resolves.toMatchObject({
      ok: true,
    })
    expect(sidecar.call).toHaveBeenLastCalledWith("edit.fonts", { sessionId: SESSION })
    // The dialog and the path are main's: the renderer sends a session id and nothing else.
    await expect(handler(ok, "asset.pick", { sessionId: SESSION })).resolves.toEqual({
      ok: true,
      r: { asset: null },
    })
    expect(main["asset.pick"]).toHaveBeenCalledWith(ok, { sessionId: SESSION }, "viewer")
    await expect(
      handler(ok, "asset.release", { sessionId: SESSION, assetId: ASSET }),
    ).resolves.toMatchObject({ ok: true })
    for (const [m, p] of [
      ["asset.pick", { sessionId: SESSION, path: "C:\\logo.png" }],
      ["asset.pick", { sessionId: "nope" }],
      ["asset.pick", {}],
      ["asset.release", { sessionId: SESSION, assetId: "../../etc/passwd" }],
      ["asset.release", { sessionId: SESSION, assetId: ASSET.toUpperCase() }],
      ["asset.release", { sessionId: SESSION }],
      ["edit.fonts", { sessionId: SESSION, family: "Arial" }],
      ["edit.render", { ...render, editList: [{ op: "border", p: { width: Number.NaN } }] }],
      [
        "edit.render",
        { ...render, editList: [{ op: "watermark", p: { text: "x".repeat(5000) } }] },
      ],
    ] as const) {
      await expect(handler(ok, m, p), JSON.stringify(p).slice(0, 80)).resolves.toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
    // No renderer names a file for an asset: the sidecar methods that take a path are main's.
    for (const view of [ok, commander]) {
      for (const [m, p] of [
        ["edit.assetAdd", { sessionId: SESSION, path: "C:\\logo.png" }],
        ["edit.assetDrop", { sessionId: SESSION, assetId: ASSET }],
      ] as const) {
        await expect(handler(view, m, p), m).resolves.toMatchObject({
          ok: false,
          e: { code: "METHOD_NOT_FOUND" },
        })
      }
    }
    for (const [m, p] of [
      ["asset.pick", { sessionId: SESSION }],
      ["asset.release", { sessionId: SESSION, assetId: ASSET }],
      ["edit.fonts", { sessionId: SESSION }],
    ] as const) {
      await expect(handler(commander, m, p), m).resolves.toMatchObject({
        ok: false,
        e: { code: "METHOD_NOT_FOUND" },
      })
    }
    expect(main["asset.pick"]).toHaveBeenCalledTimes(1)
  })

  it("lets the viewer draw and retouch and find red eyes; the commander not (Stage 15)", async () => {
    const { handler, sidecar, commander, ok } = setup()
    const strokes = [
      {
        op: "draw",
        p: {
          strokes: [
            {
              tool: "brush",
              color: "#ff0000",
              size: 4,
              points: [
                [0.1, 0.1],
                [0.5, 0.5, 0.8],
              ],
            },
            { tool: "text", size: 6, text: "{name}", points: [[0.2, 0.2]] },
          ],
        },
      },
      { op: "clone", p: { size: 5, source: [0.2, 0.2], points: [[0.6, 0.6]] } },
      { op: "heal", p: { size: 4, points: [[0.5, 0.5]] } },
      { op: "redeye", p: { rect: { x: 0.4, y: 0.4, w: 0.05, h: 0.05 } } },
    ]
    await expect(
      handler(ok, "edit.render", { ...render, editList: strokes }),
    ).resolves.toMatchObject({
      ok: true,
    })
    const eyes = { sessionId: SESSION, editList: strokes }
    await expect(handler(ok, "edit.eyes", eyes)).resolves.toMatchObject({ ok: true })
    expect(sidecar.call).toHaveBeenLastCalledWith("edit.eyes", eyes)
    await expect(handler(commander, "edit.eyes", eyes)).resolves.toMatchObject({
      ok: false,
      e: { code: "METHOD_NOT_FOUND" },
    })
    for (const p of [
      { sessionId: SESSION },
      { sessionId: "nope", editList: [] },
      { sessionId: SESSION, editList: [{ op: "spray", p: {} }] },
      { sessionId: SESSION, editList: [], rect: { x: 0, y: 0, w: 1, h: 1 } },
      {
        sessionId: SESSION,
        editList: [
          { op: "draw", p: { strokes: [{ tool: "brush", size: 1, points: [[0.5, Number.NaN]] }] } },
        ],
      },
    ]) {
      await expect(
        handler(ok, "edit.eyes", p),
        JSON.stringify(p).slice(0, 80),
      ).resolves.toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
  })

  it("runs a batch for the viewer only, with the recipe checked and no path from a renderer (Stage 16)", async () => {
    const { handler, sidecar, main, commander, ok } = setup()
    const source = {
      selection: { queryId: 1, version: 1, ranges: [[0, 200]], include: [], exclude: [] },
    }
    const output = {
      format: "jpeg",
      quality: 85,
      metadata: "keep",
      destination: "folder",
      template: "{n:3}-{name}",
      conflict: "keepBoth",
    }
    const recipe = {
      version: 1,
      ops: [
        { op: "resize", p: { mode: "fit", w: 1600, h: 1600, noEnlarge: true } },
        { op: "watermark", p: { text: "© {year}", size: 4, anchor: "se" } },
      ],
      output,
    }
    const FOLDER = "0123456789abcdef"
    const batch = { source, recipe, folderId: FOLDER }
    await expect(handler(ok, "batch.pickFolder", {})).resolves.toEqual({
      ok: true,
      r: { folder: null },
    })
    await expect(handler(ok, "batch.plan", batch)).resolves.toMatchObject({
      ok: true,
      r: { count: 2 },
    })
    expect(main["batch.plan"]).toHaveBeenCalledWith(ok, batch, "viewer")
    await expect(handler(ok, "batch.start", { source, recipe })).resolves.toMatchObject({
      ok: true,
    })
    await expect(handler(ok, "batch.undo", { jobId: 9 })).resolves.toMatchObject({ ok: true })
    expect(sidecar.call).toHaveBeenLastCalledWith("batch.undo", { jobId: 9 })
    await expect(handler(ok, "recipe.list", {})).resolves.toMatchObject({ ok: true })
    await expect(handler(ok, "recipe.save", { id: 0, name: "Web", recipe })).resolves.toMatchObject(
      { ok: true },
    )
    await expect(handler(ok, "recipe.delete", { id: 4 })).resolves.toMatchObject({ ok: true })

    const bad = (change: object): object => ({ ...recipe, ...change })
    const out = (change: object): object => ({ ...recipe, output: { ...output, ...change } })
    for (const [m, p] of [
      // A folder is a handle of main's, never a path.
      ["batch.start", { source, recipe, folder: "C:\\out" }],
      ["batch.start", { source, recipe, folderId: "C:\\out" }],
      ["batch.plan", { source, recipe, folderId: "../../x" }],
      ["batch.pickFolder", { defaultPath: "C:\\" }],
      ["batch.start", { recipe }],
      ["batch.start", { source: { ids: [1, 2] }, recipe }],
      // Free-hand tools, unknown operations and too many of them.
      ["batch.start", { source, recipe: bad({ ops: [{ op: "draw", p: { strokes: [] } }] }) }],
      ["batch.start", { source, recipe: bad({ ops: [{ op: "heal", p: {} }] }) }],
      ["batch.plan", { source, recipe: bad({ ops: [{ op: "shell", p: { cmd: "calc" } }] }) }],
      [
        "batch.start",
        { source, recipe: bad({ ops: Array.from({ length: 65 }, () => recipe.ops[0]) }) },
      ],
      ["batch.start", { source, recipe: bad({ version: 2 }) }],
      ["batch.start", { source, recipe: bad({ run: "calc.exe" }) }],
      // The output: nothing that names a place, and only known rules.
      ["batch.start", { source, recipe: out({ folder: "C:\\out" }) }],
      ["batch.start", { source, recipe: out({ template: "..\\{name}" }) }],
      ["batch.start", { source, recipe: out({ template: "sub/{name}" }) }],
      ["batch.start", { source, recipe: out({ template: "{name}-{who}" }) }],
      ["batch.start", { source, recipe: out({ template: "x".repeat(121) }) }],
      ["batch.start", { source, recipe: out({ format: "exe" }) }],
      ["batch.start", { source, recipe: out({ quality: 500 }) }],
      ["batch.start", { source, recipe: out({ metadata: "everything" }) }],
      ["batch.start", { source, recipe: out({ destination: "C:\\out" }) }],
      ["batch.start", { source, recipe: out({ destination: "replace" }) }],
      ["batch.start", { source, recipe: out({ conflict: "ask" }) }],
      ["batch.start", { source, recipe: out({ dpi: -1 }) }],
      ["batch.undo", { jobId: "9" }],
      ["batch.undo", { jobId: 9, path: "C:\\x" }],
      ["recipe.save", { id: 0, name: "", recipe }],
      ["recipe.save", { id: 0, name: "n".repeat(81), recipe }],
      ["recipe.save", { id: -1, name: "x", recipe }],
      ["recipe.save", { id: 0, name: "x", recipe: bad({ ops: [{ op: "clone", p: {} }] }) }],
      ["recipe.save", { id: 0, name: "x", recipe, path: "C:\\recipes\\x.json" }],
      ["recipe.delete", { id: 0 }],
      ["recipe.list", { all: true }],
    ] as const) {
      await expect(handler(ok, m, p), JSON.stringify(p).slice(0, 90)).resolves.toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
    }
    // Replacing the originals is allowed when they keep their format.
    await expect(
      handler(ok, "batch.start", {
        source,
        recipe: out({ destination: "replace", format: "keep", template: undefined }),
      }),
    ).resolves.toMatchObject({ ok: true })
    // The sidecar's own methods take a path: no renderer reaches them.
    for (const view of [ok, commander]) {
      for (const m of ["edit.plan", "edit.batch"] as const) {
        await expect(
          handler(view, m, { source, recipe, folder: "C:\\out" }),
          m,
        ).resolves.toMatchObject({ ok: false, e: { code: "METHOD_NOT_FOUND" } })
      }
    }
    // The commander has no batch editing (ADR-0027).
    for (const [m, p] of [
      ["batch.pickFolder", {}],
      ["batch.plan", batch],
      ["batch.start", batch],
      ["batch.undo", { jobId: 9 }],
      ["recipe.list", {}],
      ["recipe.save", { id: 0, name: "Web", recipe }],
      ["recipe.delete", { id: 4 }],
    ] as const) {
      await expect(handler(commander, m, p), m).resolves.toMatchObject({
        ok: false,
        e: { code: "METHOD_NOT_FOUND" },
      })
    }
    expect(main["batch.start"]).toHaveBeenCalledTimes(2)
    expect(main["batch.pickFolder"]).toHaveBeenCalledTimes(1)
  })

  it("does not let a renderer start the save job directly", async () => {
    const { handler, sidecar, ok, commander } = setup()
    const sel = { queryId: 1, version: 1, ranges: [[0, 1]], include: [], exclude: [] }
    for (const from of [ok, commander]) {
      // Nor a batch edit or its undo (Stage 16): those go through batch.start and batch.undo.
      for (const kind of ["editSave", "edit", "undoEdit"]) {
        const res = await handler(from, "jobs.start", { kind, source: { selection: sel } })
        expect(res, kind).toMatchObject({ ok: false })
      }
    }
    expect(sidecar.call).not.toHaveBeenCalled()
  })
})
