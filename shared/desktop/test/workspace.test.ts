import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { EOL, tmpdir } from "node:os"
import { join } from "node:path"
import type { IpcMainInvokeEvent } from "electron"
import { describe, expect, it, vi } from "vitest"
import { pngSize, workspaceHandlers, type WorkspaceDeps } from "../src/main/workspace"

vi.mock("electron", () => ({}))

const ev = {} as IpcMainInvokeEvent
const sel = {
  queryId: 1,
  version: 1,
  ranges: [[0, 2]] as [number, number][],
  include: [],
  exclude: [],
}

function setup(overrides: Partial<WorkspaceDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fv-ws-"))
  const deps: WorkspaceDeps = {
    call: vi.fn(async (method: string) =>
      method === "entry.path"
        ? { path: join(dir, "a.jpg"), kind: "image" }
        : { paths: [join(dir, "a.jpg"), join(dir, "b.jpg")], truncated: true },
    ) as unknown as WorkspaceDeps["call"],
    getPath: vi.fn((id) => (id === "videos" ? join(dir, "missing") : dir)),
    openPath: vi.fn(async () => ""),
    showItemInFolder: vi.fn(),
    writeClipboard: vi.fn(),
    writeClipboardImage: vi.fn(async () => undefined),
    ...overrides,
  }
  return { deps, dir, h: workspaceHandlers(deps) }
}

describe("workspace handlers", () => {
  it("lists only places that exist", async () => {
    const { h, dir } = setup()
    const { places } = await h["places.list"](ev, {})
    expect(places.map((p) => p.id)).toEqual([
      "home",
      "desktop",
      "documents",
      "downloads",
      "pictures",
    ])
    expect(places[0]).toEqual({ id: "home", label: "Home", path: dir })
  })

  it("skips places the platform does not define", async () => {
    const { h } = setup({
      getPath: (id) => {
        if (id === "desktop") throw new Error("unknown")
        return tmpdir()
      },
    })
    const { places } = await h["places.list"](ev, {})
    expect(places.some((p) => p.id === "desktop")).toBe(false)
  })

  it("opens and reveals entries through sidecar-resolved paths", async () => {
    const { h, deps, dir } = setup()
    await expect(h["shell.open"](ev, { entryId: 3 })).resolves.toEqual({ ok: true })
    expect(deps.call).toHaveBeenCalledWith("entry.path", { entryId: 3 })
    expect(deps.openPath).toHaveBeenCalledWith(join(dir, "a.jpg"))
    await h["shell.reveal"](ev, { entryId: 3 })
    expect(deps.showItemInFolder).toHaveBeenCalledWith(join(dir, "a.jpg"))
  })

  it("never opens other files, such as executables (ADR-0026, ADR-0027)", async () => {
    for (const kind of ["file", "link"]) {
      const { h, deps } = setup({
        call: (async () => ({ path: join(tmpdir(), "tool.exe"), kind })) as unknown as WorkspaceDeps["call"],
      })
      await expect(h["shell.open"](ev, { entryId: 9 })).rejects.toThrow("cannot be opened")
      expect(deps.openPath).not.toHaveBeenCalled()
    }
  })

  it("reports a failed open", async () => {
    const { h } = setup({ openPath: async () => "No application is associated" })
    await expect(h["shell.open"](ev, { entryId: 3 })).rejects.toThrow("No application")
  })

  it("reveals only existing folders by path", async () => {
    const { h, deps, dir } = setup()
    await h["shell.revealPath"](ev, { path: dir })
    expect(deps.showItemInFolder).toHaveBeenCalledWith(dir)
    await expect(h["shell.revealPath"](ev, { path: join(dir, "nope") })).rejects.toThrow()
  })

  it("copies selection paths one per line, reporting truncation", async () => {
    const { h, deps, dir } = setup()
    await expect(h["clipboard.copyPaths"](ev, { selection: sel })).resolves.toEqual({
      count: 2,
      truncated: true,
    })
    expect(deps.call).toHaveBeenCalledWith("selection.paths", { selection: sel, limit: 0 })
    expect(deps.writeClipboard).toHaveBeenCalledWith(
      `${join(dir, "a.jpg")}${EOL}${join(dir, "b.jpg")}`,
    )
  })

  it("does not clear the clipboard for an empty selection", async () => {
    const { h, deps } = setup({
      call: (async () => ({ paths: [], truncated: false })) as unknown as WorkspaceDeps["call"],
    })
    await expect(h["clipboard.copyPaths"](ev, { selection: sel })).resolves.toEqual({
      count: 0,
      truncated: false,
    })
    expect(deps.writeClipboard).not.toHaveBeenCalled()
  })

  it("puts the Go-made PNG on the clipboard and always deletes the temp file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fv-clip-"))
    const file = join(dir, "clip-1-1.png")
    // Signature + IHDR with width 640, height 480.
    const png = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
    png.writeUInt32BE(13, 8)
    png.write("IHDR", 12, "latin1")
    png.writeUInt32BE(640, 16)
    png.writeUInt32BE(480, 20)
    writeFileSync(file, png)
    const write = vi.fn(async () => undefined)
    const { h } = setup({
      call: vi.fn(async () => ({
        file,
        width: 640,
        height: 480,
      })) as unknown as WorkspaceDeps["call"],
      writeClipboardImage: write,
    })
    expect(await h["clipboard.copyImage"](ev, { entryId: 7 })).toEqual({ width: 640, height: 480 })
    expect(write).toHaveBeenCalledWith(png)
    expect(pngSize(png)).toBe("640x480")
    expect(existsSync(file)).toBe(false)

    writeFileSync(file, png)
    const failing = setup({
      call: vi.fn(async () => ({
        file,
        width: 640,
        height: 480,
      })) as unknown as WorkspaceDeps["call"],
      writeClipboardImage: vi.fn(async () => {
        throw new Error("clipboard busy")
      }),
    })
    await expect(failing.h["clipboard.copyImage"](ev, { entryId: 7 })).rejects.toThrow("busy")
    expect(existsSync(file)).toBe(false)
  })
})
