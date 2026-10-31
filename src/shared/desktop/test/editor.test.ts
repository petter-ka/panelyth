import type { IpcMainInvokeEvent } from "electron"
import { describe, expect, it, vi } from "vitest"
import {
  MAX_BATCH_FOLDERS,
  defaultSavePath,
  editorHandlers,
  isFrameFile,
  withFormatExtension,
  type EditorDeps,
} from "../src/main/editor"
import { MediaTokens, parseMediaUrl } from "../src/main/mediaProtocol"
import { RpcError } from "../src/main/sidecar/RpcClient"

vi.mock("electron", () => ({ protocol: { handle: vi.fn() } }))

const SESSION = "0123456789abcdef01234567"
const FRAME = `/cache/Panelyth/v1/tmp/edit/${SESSION}-3.jpg`
const event = {} as IpcMainInvokeEvent
const render = {
  sessionId: SESSION,
  rev: 3,
  editList: [],
  view: { maxEdge: 800 },
  quality: "final" as const,
  histogram: false,
}
const save = {
  sessionId: SESSION,
  editList: [],
  target: "copy" as const,
  format: "jpeg" as const,
  quality: 90,
  metadata: "keep" as const,
  dpi: 0,
}

function setup(answers: Record<string, unknown> = {}) {
  const tokens = new MediaTokens(4)
  const call = vi.fn(async (method: string, _params?: unknown) => {
    const a = answers[method]
    if (a instanceof Error) throw a
    return a
  })
  const saveDialog = vi.fn<EditorDeps["saveDialog"]>(async () => null)
  const openDialog = vi.fn<EditorDeps["openDialog"]>(async () => null)
  const folderDialog = vi.fn<EditorDeps["folderDialog"]>(async () => null)
  const showItemInFolder = vi.fn()
  const thumbTokens = new MediaTokens(8)
  const deps = {
    call,
    tokens,
    thumbTokens,
    saveDialog,
    openDialog,
    folderDialog,
    showItemInFolder,
  } as unknown as EditorDeps
  return {
    handlers: editorHandlers(deps),
    tokens,
    thumbTokens,
    call,
    saveDialog,
    openDialog,
    folderDialog,
    showItemInFolder,
  }
}

describe("edit.render", () => {
  it("turns the frame file into a token URL; the path stays in main", async () => {
    const output = { width: 4000, height: 3000, dpi: { x: 300, y: 300 } }
    const { handlers, tokens } = setup({
      "edit.frame": {
        rev: 3,
        frame: { file: FRAME, mime: "image/jpeg", width: 800, height: 600 },
        output,
      },
    })
    const r = await handlers["edit.render"](event, render, "viewer")
    expect(r).toMatchObject({ rev: 3, frame: { width: 800, height: 600 }, output })
    expect(JSON.stringify(r)).not.toContain("tmp")
    const token = parseMediaUrl(r.frame!.url)
    expect(token && tokens.get(token)).toEqual({ path: FRAME, mime: "image/jpeg" })
  })

  it("passes a superseded revision on without a frame or a token", async () => {
    const { handlers, tokens } = setup({ "edit.frame": { rev: 3, superseded: true } })
    await expect(handlers["edit.render"](event, render, "viewer")).resolves.toEqual({
      rev: 3,
      superseded: true,
    })
    expect(tokens.size).toBe(0)
  })

  it("mints no token for anything but a frame file", async () => {
    for (const file of [
      "C:\\Users\\me\\Documents\\secret.txt",
      "/etc/passwd",
      `/cache/tmp/other/${SESSION}-1.jpg`,
      `tmp/edit/${SESSION}-1.jpg`,
      `/cache/tmp/edit/${SESSION}-1.exe`,
      `/cache/tmp/edit/passwd`,
    ]) {
      expect(isFrameFile(file), file).toBe(false)
      const { handlers, tokens } = setup({
        "edit.frame": {
          rev: 3,
          frame: { file, mime: "image/jpeg", width: 1, height: 1 },
          output: { width: 1, height: 1, dpi: { x: 0, y: 0 } },
        },
      })
      await expect(handlers["edit.render"](event, render, "viewer")).rejects.toBeInstanceOf(
        RpcError,
      )
      expect(tokens.size).toBe(0)
    }
    expect(isFrameFile(FRAME)).toBe(true)
  })

  it("rejects a malformed answer and passes sidecar errors on", async () => {
    const bad = setup({ "edit.frame": { rev: 3, frame: { file: FRAME } } })
    await expect(bad.handlers["edit.render"](event, render, "viewer")).rejects.toBeInstanceOf(
      RpcError,
    )
    const gone = setup({ "edit.frame": new RpcError("EDIT_SESSION_GONE", "closed", false) })
    await expect(gone.handlers["edit.render"](event, render, "viewer")).rejects.toMatchObject({
      code: "EDIT_SESSION_GONE",
    })
  })
})

describe("edit.thumbs", () => {
  const params = { sessionId: SESSION, editLists: [[], [], []], edge: 120 }

  it("turns thumbnail files into token URLs of their own store", async () => {
    const { handlers, tokens, thumbTokens } = setup({
      "edit.thumbFrames": {
        thumbs: [
          { file: `/cache/tmp/edit/${SESSION}-7.jpg`, width: 120, height: 90 },
          null,
          { file: `/cache/tmp/edit/${SESSION}-8.jpg`, width: 90, height: 120 },
        ],
      },
    })
    const r = await handlers["edit.thumbs"](event, params, "viewer")
    expect(r.thumbs).toHaveLength(3)
    expect(r.thumbs[1]).toBeNull()
    expect(r.thumbs[0]).toMatchObject({ width: 120, height: 90 })
    expect(JSON.stringify(r)).not.toContain("tmp")
    const token = parseMediaUrl(r.thumbs[2]!.url)
    expect(token && thumbTokens.get(token)).toEqual({
      path: `/cache/tmp/edit/${SESSION}-8.jpg`,
      mime: "image/jpeg",
    })
    // The frame on the canvas keeps its token: thumbnails never use its store.
    expect(tokens.size).toBe(0)
    expect(thumbTokens.size).toBe(2)
  })

  it("gives no token to a file that is not a frame, and rejects a malformed answer", async () => {
    const odd = setup({
      "edit.thumbFrames": { thumbs: [{ file: "/etc/passwd", width: 1, height: 1 }] },
    })
    await expect(odd.handlers["edit.thumbs"](event, params, "viewer")).resolves.toEqual({
      thumbs: [null],
    })
    expect(odd.thumbTokens.size).toBe(0)
    const bad = setup({ "edit.thumbFrames": { thumbs: [{ file: 1 }] } })
    await expect(bad.handlers["edit.thumbs"](event, params, "viewer")).rejects.toBeInstanceOf(
      RpcError,
    )
  })
})

describe("asset.pick", () => {
  const ASSET = "0123456789abcdef0123456789abcdef"
  const file = {
    assetId: ASSET,
    name: "logo.png",
    width: 400,
    height: 200,
    thumb: { file: `/cache/tmp/edit/${ASSET.slice(0, 24)}-0.png`, width: 128, height: 64 },
  }

  it("asks the native dialog, registers the picture and answers with an id and a token", async () => {
    const { handlers, call, openDialog, thumbTokens, tokens } = setup({
      "edit.source": { path: "/photos/trip/a.jpg" },
      "edit.assetAdd": file,
    })
    openDialog.mockResolvedValueOnce("/logos/logo.png")
    const r = await handlers["asset.pick"](event, { sessionId: SESSION }, "viewer")
    // The dialog opens in the edited picture's folder.
    expect(openDialog).toHaveBeenCalledWith(event, { defaultPath: "/photos/trip" })
    expect(call).toHaveBeenCalledWith("edit.assetAdd", {
      sessionId: SESSION,
      path: "/logos/logo.png",
    })
    expect(r.asset).toMatchObject({ assetId: ASSET, name: "logo.png", width: 400, height: 200 })
    // Neither the picture's path nor the thumbnail's reaches the renderer.
    expect(JSON.stringify(r)).not.toMatch(/logos|cache|tmp/)
    const token = parseMediaUrl(r.asset!.thumbUrl)
    expect(token && thumbTokens.get(token)).toEqual({ path: file.thumb.file, mime: "image/png" })
    expect(tokens.size).toBe(0)
  })

  it("does nothing when the dialog is cancelled", async () => {
    const { handlers, call } = setup({ "edit.source": { path: "/photos/a.jpg" } })
    await expect(handlers["asset.pick"](event, { sessionId: SESSION }, "viewer")).resolves.toEqual({
      asset: null,
    })
    expect(call).not.toHaveBeenCalledWith("edit.assetAdd", expect.anything())
  })

  it("refuses a path that is not absolute, and an answer it does not expect", async () => {
    const relative = setup({ "edit.source": { path: "/photos/a.jpg" } })
    relative.openDialog.mockResolvedValueOnce("logo.png")
    await expect(
      relative.handlers["asset.pick"](event, { sessionId: SESSION }, "viewer"),
    ).rejects.toMatchObject({ code: "INVALID_PATH" })
    expect(relative.call).not.toHaveBeenCalledWith("edit.assetAdd", expect.anything())
    // A thumbnail that is not a frame file gets no token.
    for (const thumb of [
      { file: "/etc/passwd", width: 1, height: 1 },
      { file: "/photos/trip/logo.png", width: 1, height: 1 },
    ]) {
      const odd = setup({
        "edit.source": { path: "/photos/a.jpg" },
        "edit.assetAdd": { ...file, thumb },
      })
      odd.openDialog.mockResolvedValueOnce("/logos/logo.png")
      await expect(
        odd.handlers["asset.pick"](event, { sessionId: SESSION }, "viewer"),
      ).rejects.toMatchObject({ code: "INTERNAL" })
      expect(odd.thumbTokens.size).toBe(0)
    }
    const bad = setup({
      "edit.source": { path: "/photos/a.jpg" },
      "edit.assetAdd": { ...file, assetId: "../x" },
    })
    bad.openDialog.mockResolvedValueOnce("/logos/logo.png")
    await expect(
      bad.handlers["asset.pick"](event, { sessionId: SESSION }, "viewer"),
    ).rejects.toMatchObject({ code: "INTERNAL" })
  })

  it("passes on why a file cannot be used, and a closed session", async () => {
    const invalid = setup({
      "edit.source": { path: "/photos/a.jpg" },
      "edit.assetAdd": new RpcError("EDIT_ASSET_INVALID", "not a picture", false),
    })
    invalid.openDialog.mockResolvedValueOnce("/logos/notes.txt")
    await expect(
      invalid.handlers["asset.pick"](event, { sessionId: SESSION }, "viewer"),
    ).rejects.toMatchObject({ code: "EDIT_ASSET_INVALID" })
    const gone = setup({ "edit.source": new RpcError("EDIT_SESSION_GONE", "closed", false) })
    await expect(
      gone.handlers["asset.pick"](event, { sessionId: SESSION }, "viewer"),
    ).rejects.toMatchObject({ code: "EDIT_SESSION_GONE" })
    // No session, no dialog.
    expect(gone.openDialog).not.toHaveBeenCalled()
  })

  it("releases an asset by id", async () => {
    const { handlers, call } = setup({ "edit.assetDrop": { ok: true } })
    await expect(
      handlers["asset.release"](event, { sessionId: SESSION, assetId: ASSET }, "viewer"),
    ).resolves.toEqual({ ok: true })
    expect(call).toHaveBeenCalledWith("edit.assetDrop", { sessionId: SESSION, assetId: ASSET })
  })
})

describe("edit.save", () => {
  it("starts a copy or a replace without a dialog and without a path", async () => {
    for (const target of ["copy", "replace"] as const) {
      const { handlers, call, saveDialog } = setup({
        "edit.write": { jobId: 4, name: "a (edited).jpg" },
      })
      await expect(handlers["edit.save"](event, { ...save, target }, "viewer")).resolves.toEqual({
        jobId: 4,
        name: "a (edited).jpg",
      })
      expect(saveDialog).not.toHaveBeenCalled()
      // The job is listed in the app that saves (ADR-0031 amended).
      expect(call).toHaveBeenCalledWith("edit.write", { ...save, target, app: "viewer" })
    }
  })

  it("asks the native dialog for a destination, beside the original", async () => {
    const { handlers, call, saveDialog } = setup({
      "edit.source": { path: "/photos/trip/a.webp" },
      "edit.write": { jobId: 6, name: "b.png" },
    })
    saveDialog.mockResolvedValueOnce("/photos/out/b")
    const params = { ...save, target: "as" as const, format: "png" as const }
    await expect(handlers["edit.save"](event, params, "viewer")).resolves.toEqual({
      jobId: 6,
      name: "b.png",
    })
    expect(saveDialog.mock.calls[0]![1].format).toBe("png")
    expect(saveDialog.mock.calls[0]![1].defaultPath.replaceAll("\\", "/")).toBe(
      "/photos/trip/a (edited).png",
    )
    // The extension follows the format, so Go never writes a PNG named without it.
    const sent = call.mock.calls.find(([m]) => m === "edit.write")!
    expect(sent[1]).toMatchObject({ target: "as", path: "/photos/out/b.png" })
  })

  it("does nothing when the dialog is cancelled", async () => {
    const { handlers, call } = setup({ "edit.source": { path: "/photos/a.jpg" } })
    await expect(
      handlers["edit.save"](event, { ...save, target: "as" }, "viewer"),
    ).resolves.toEqual({ jobId: null, name: "" })
    expect(call).not.toHaveBeenCalledWith("edit.write", expect.anything())
  })

  it("refuses a destination that is not an absolute path", async () => {
    const { handlers, call, saveDialog } = setup({ "edit.source": { path: "/photos/a.jpg" } })
    saveDialog.mockResolvedValueOnce("relative/out.jpg")
    await expect(
      handlers["edit.save"](event, { ...save, target: "as" }, "viewer"),
    ).rejects.toMatchObject({ code: "INVALID_PATH" })
    expect(call).not.toHaveBeenCalledWith("edit.write", expect.anything())
  })

  it("names saves by the format's extension", () => {
    expect(withFormatExtension("/x/a.jpg", "jpeg")).toBe("/x/a.jpg")
    expect(withFormatExtension("/x/a.JPEG", "jpeg")).toBe("/x/a.JPEG")
    expect(withFormatExtension("/x/a", "tiff")).toBe("/x/a.tif")
    expect(withFormatExtension("/x/a.jpg", "png")).toBe("/x/a.jpg.png")
    expect(defaultSavePath("/p/photo.final.JPG", "jpeg").replaceAll("\\", "/")).toBe(
      "/p/photo.final (edited).jpg",
    )
  })
})

describe("edit.reveal", () => {
  it("shows the saved file by job id", async () => {
    const { handlers, showItemInFolder } = setup({
      "edit.savedPath": { path: "/photos/a (edited).jpg" },
    })
    await expect(handlers["edit.reveal"](event, { jobId: 4 }, "viewer")).resolves.toEqual({
      ok: true,
    })
    expect(showItemInFolder).toHaveBeenCalledWith("/photos/a (edited).jpg")
  })

  it("shows nothing for a job it does not know", async () => {
    const { handlers, showItemInFolder } = setup({
      "edit.savedPath": new RpcError("NOT_FOUND", "not a recent save", false),
    })
    await expect(handlers["edit.reveal"](event, { jobId: 99 }, "viewer")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect(showItemInFolder).not.toHaveBeenCalled()
  })
})

describe("batch (Stage 16)", () => {
  const source = {
    selection: {
      queryId: 1,
      version: 1,
      ranges: [[0, 3]] as [number, number][],
      include: [],
      exclude: [],
    },
  }
  const recipe = {
    version: 1,
    ops: [],
    output: {
      format: "jpeg" as const,
      metadata: "keep" as const,
      destination: "folder" as const,
      conflict: "keepBoth" as const,
    },
  }
  const plan = {
    count: 3,
    skipped: [{ reason: "video", count: 1 }],
    names: ["a.jpg", "b.jpg"],
    bytes: 3000,
    estimateBytes: 900,
    warnings: ["alphaLoss"],
    problems: [],
    samples: [{ id: 7, name: "a.jpg" }],
  }

  it("names a picked folder by a handle; the path stays in main", async () => {
    const { handlers, folderDialog, call } = setup({
      "edit.plan": plan,
      "edit.batch": { jobId: 4 },
    })
    folderDialog.mockResolvedValueOnce("/photos/out/Web export")
    const picked = await handlers["batch.pickFolder"](event, {}, "viewer")
    expect(picked.folder).toMatchObject({ name: "Web export" })
    const folderId = picked.folder!.folderId
    expect(folderId).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(picked)).not.toContain("photos")

    await expect(
      handlers["batch.plan"](event, { source, recipe, folderId }, "viewer"),
    ).resolves.toEqual(plan)
    expect(call).toHaveBeenLastCalledWith("edit.plan", {
      source,
      recipe,
      folder: "/photos/out/Web export",
    })
    await handlers["batch.start"](event, { source, recipe, folderId }, "viewer")
    expect(call).toHaveBeenLastCalledWith("edit.batch", {
      source,
      recipe,
      folder: "/photos/out/Web export",
      app: "viewer",
    })
    // Without a folder the sidecar decides (a plan counts; a start is refused there).
    await handlers["batch.plan"](event, { source, recipe }, "viewer")
    expect(call).toHaveBeenLastCalledWith("edit.plan", { source, recipe })
  })

  it("does nothing when the dialog is cancelled, and refuses a path that is not absolute", async () => {
    const { handlers, folderDialog } = setup()
    await expect(handlers["batch.pickFolder"](event, {}, "viewer")).resolves.toEqual({
      folder: null,
    })
    folderDialog.mockResolvedValueOnce("relative/out")
    await expect(handlers["batch.pickFolder"](event, {}, "viewer")).rejects.toMatchObject({
      code: "INVALID_PATH",
    })
  })

  it("refuses a handle it did not give out, and forgets the oldest ones", async () => {
    const { handlers, folderDialog, call } = setup({ "edit.plan": plan })
    await expect(
      handlers["batch.start"](event, { source, recipe, folderId: "f".repeat(16) }, "viewer"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
    expect(call).not.toHaveBeenCalled()
    const ids: string[] = []
    for (let i = 0; i <= MAX_BATCH_FOLDERS; i++) {
      folderDialog.mockResolvedValueOnce(`/out/${i}`)
      ids.push((await handlers["batch.pickFolder"](event, {}, "viewer")).folder!.folderId)
    }
    expect(new Set(ids).size).toBe(ids.length)
    await expect(
      handlers["batch.plan"](event, { source, recipe, folderId: ids[0]! }, "viewer"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
    await expect(
      handlers["batch.plan"](event, { source, recipe, folderId: ids.at(-1)! }, "viewer"),
    ).resolves.toEqual(plan)
  })

  it("rejects a plan it does not expect, and passes sidecar errors on", async () => {
    const withPath = setup({ "edit.plan": { ...plan, names: ["/photos/out/a.jpg"] } })
    await expect(
      withPath.handlers["batch.plan"](event, { source, recipe }, "viewer"),
    ).rejects.toMatchObject({ code: "INTERNAL" })
    const refused = setup({
      "edit.batch": new RpcError("INVALID_PATH", "choose a folder for the results", false),
    })
    await expect(
      refused.handlers["batch.start"](event, { source, recipe }, "viewer"),
    ).rejects.toMatchObject({ code: "INVALID_PATH" })
  })
})
