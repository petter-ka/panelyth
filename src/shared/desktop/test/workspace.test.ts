import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
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

/** A folder per place (videos missing); home is the temp folder itself. */
function place(dir: string, id: string): string {
  const path = join(dir, id)
  if (id !== "videos") mkdirSync(path, { recursive: true })
  return path
}

function setup(overrides: Partial<WorkspaceDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fv-ws-"))
  const deps: WorkspaceDeps = {
    call: vi.fn(async (method: string) =>
      method === "entry.path"
        ? { path: join(dir, "a.jpg"), kind: "image", program: false }
        : { paths: [join(dir, "a.jpg"), join(dir, "b.jpg")], truncated: true },
    ) as unknown as WorkspaceDeps["call"],
    getPath: vi.fn((id) => (id === "home" ? dir : place(dir, id))),
    openPath: vi.fn(async () => ""),
    showItemInFolder: vi.fn(),
    writeClipboard: vi.fn(),
    writeClipboardImage: vi.fn(async () => undefined),
    launch: vi.fn(async () => undefined),
    openTextEditor: vi.fn(async () => undefined),
    startDrag: vi.fn(async () => undefined),
    platform: "linux",
    ...overrides,
  }
  return { deps, dir, h: workspaceHandlers(deps) }
}

describe("workspace handlers", () => {
  it("lists only places that exist", async () => {
    const { h, dir } = setup()
    const { places } = await h["places.list"](ev, {}, "viewer")
    expect(places.map((p) => p.id)).toEqual([
      "home",
      "desktop",
      "documents",
      "downloads",
      "pictures",
    ])
    expect(places[0]).toEqual({ id: "home", label: "Home", path: dir })
  })

  it("lists home once when user folders resolve to it (XDG disabled folders)", async () => {
    const { h, dir } = setup({ getPath: () => dir })
    const { places } = await h["places.list"](ev, {}, "viewer")
    expect(places).toEqual([{ id: "home", label: "Home", path: dir }])
  })

  it("skips places the platform does not define", async () => {
    const { h } = setup({
      getPath: (id) => {
        if (id === "desktop") throw new Error("unknown")
        return tmpdir()
      },
    })
    const { places } = await h["places.list"](ev, {}, "viewer")
    expect(places.some((p) => p.id === "desktop")).toBe(false)
  })

  it("opens and reveals entries through sidecar-resolved paths", async () => {
    const { h, deps, dir } = setup()
    await expect(h["shell.open"](ev, { entryId: 3 }, "viewer")).resolves.toEqual({ ok: true })
    expect(deps.call).toHaveBeenCalledWith("entry.path", { entryId: 3 })
    expect(deps.openPath).toHaveBeenCalledWith(join(dir, "a.jpg"))
    await h["shell.reveal"](ev, { entryId: 3 }, "viewer")
    expect(deps.showItemInFolder).toHaveBeenCalledWith(join(dir, "a.jpg"))
  })

  it("never opens other files, such as executables (ADR-0026, ADR-0027)", async () => {
    for (const kind of ["file", "link"]) {
      const { h, deps } = setup({
        call: (async () => ({
          path: join(tmpdir(), "tool.exe"),
          kind,
          program: kind === "file",
        })) as unknown as WorkspaceDeps["call"],
      })
      await expect(h["shell.open"](ev, { entryId: 9 }, "viewer")).rejects.toThrow(
        "cannot be opened",
      )
      expect(deps.openPath).not.toHaveBeenCalled()
    }
  })

  it("reports a failed open", async () => {
    const { h } = setup({ openPath: async () => "No application is associated" })
    await expect(h["shell.open"](ev, { entryId: 3 }, "viewer")).rejects.toThrow("No application")
  })

  it("reveals only existing folders by path", async () => {
    const { h, deps, dir } = setup()
    await h["shell.revealPath"](ev, { path: dir }, "viewer")
    expect(deps.showItemInFolder).toHaveBeenCalledWith(dir)
    await expect(h["shell.revealPath"](ev, { path: join(dir, "nope") }, "viewer")).rejects.toThrow()
  })

  it("copies selection paths one per line, reporting truncation", async () => {
    const { h, deps, dir } = setup()
    await expect(h["clipboard.copyPaths"](ev, { selection: sel }, "viewer")).resolves.toEqual({
      count: 2,
      truncated: true,
    })
    expect(deps.call).toHaveBeenCalledWith("selection.paths", { selection: sel, limit: 0 })
    expect(deps.writeClipboard).toHaveBeenCalledWith(
      `${join(dir, "a.jpg")}${EOL}${join(dir, "b.jpg")}`,
    )
  })

  it("drags the selection's files from the calling view, never a part of them", async () => {
    const sender = {} as IpcMainInvokeEvent["sender"]
    const from = { sender } as IpcMainInvokeEvent
    const whole = setup({
      call: (async () => ({
        paths: ["/p/a.jpg", "/p/b"],
        truncated: false,
      })) as unknown as WorkspaceDeps["call"],
    })
    await expect(whole.h["drag.start"](from, { selection: sel }, "commander")).resolves.toEqual({
      count: 2,
      truncated: false,
    })
    expect(whole.deps.startDrag).toHaveBeenCalledWith(sender, ["/p/a.jpg", "/p/b"])
    // More than selection.paths gives: no drag at all.
    const { h, deps } = setup()
    await expect(h["drag.start"](from, { selection: sel }, "viewer")).resolves.toEqual({
      count: 2,
      truncated: true,
    })
    expect(deps.startDrag).not.toHaveBeenCalled()
  })

  it("does not clear the clipboard for an empty selection", async () => {
    const { h, deps } = setup({
      call: (async () => ({ paths: [], truncated: false })) as unknown as WorkspaceDeps["call"],
    })
    await expect(h["clipboard.copyPaths"](ev, { selection: sel }, "viewer")).resolves.toEqual({
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
    expect(await h["clipboard.copyImage"](ev, { entryId: 7 }, "viewer")).toEqual({
      width: 640,
      height: 480,
    })
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
    await expect(failing.h["clipboard.copyImage"](ev, { entryId: 7 }, "viewer")).rejects.toThrow(
      "busy",
    )
    expect(existsSync(file)).toBe(false)
  })

  describe("commander profile (Stage C05, ADR-0027)", () => {
    const entry = (path: string, kind: string, program: boolean, settings = {}) =>
      vi.fn(async (method: string) =>
        method === "library.get" ? { settings } : { path, kind, program },
      ) as unknown as WorkspaceDeps["call"]

    it("opens any kind of file with the default app", async () => {
      for (const kind of ["file", "link", "dir", "image"]) {
        const { h, deps } = setup({ call: entry("/docs/report.pdf", kind, false) })
        await expect(h["shell.open"](ev, { entryId: 4 }, "commander")).resolves.toEqual({
          ok: true,
        })
        expect(deps.openPath).toHaveBeenCalledWith("/docs/report.pdf")
      }
    })

    it("opens a program only with allowProgram, and the viewer never", async () => {
      const { h, deps } = setup({ call: entry("/bin/tool.exe", "file", true) })
      const denied = h["shell.open"](ev, { entryId: 4 }, "commander")
      await expect(denied).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
        details: { reason: "program" },
      })
      await expect(
        h["shell.open"](ev, { entryId: 4, allowProgram: false }, "commander"),
      ).rejects.toThrow("program")
      expect(deps.openPath).not.toHaveBeenCalled()
      await h["shell.open"](ev, { entryId: 4, allowProgram: true }, "commander")
      expect(deps.openPath).toHaveBeenCalledWith("/bin/tool.exe")
      // An app bundle is a folder; the viewer refuses it even when allowed.
      const viewer = setup({ call: entry("/Applications/X.app", "dir", true) })
      await expect(
        viewer.h["shell.open"](ev, { entryId: 4, allowProgram: true }, "viewer"),
      ).rejects.toThrow("cannot be opened")
      expect(viewer.deps.openPath).not.toHaveBeenCalled()
    })

    it("edits with the editor from settings, never through a shell", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fv-ed-"))
      const editor = join(dir, "editor.exe")
      writeFileSync(editor, "")
      const { h, deps } = setup({
        call: entry("/logs/a b; rm -rf.txt", "file", false, {
          "commander.settings": { editor: ` ${editor} ` },
        }),
      })
      await h["shell.edit"](ev, { entryId: 5 }, "commander")
      expect(deps.launch).toHaveBeenCalledWith(editor, ["/logs/a b; rm -rf.txt"])
      expect(deps.openPath).not.toHaveBeenCalled()
    })

    it("refuses a missing or relative editor and folders", async () => {
      for (const editor of ["notepad++.exe", join(tmpdir(), "no-such-editor.exe")]) {
        const { h, deps } = setup({
          call: entry("/a.txt", "file", false, { "commander.settings": { editor } }),
        })
        await expect(h["shell.edit"](ev, { entryId: 5 }, "commander")).rejects.toMatchObject({
          details: { reason: "editor" },
        })
        expect(deps.launch).not.toHaveBeenCalled()
      }
      const folder = setup({ call: entry("/docs", "dir", false) })
      await expect(folder.h["shell.edit"](ev, { entryId: 5 }, "commander")).rejects.toThrow(
        "folder",
      )
    })

    it("opens the built-in editor when Settings names none (ADR-0046), on every platform", async () => {
      for (const platform of ["win32", "darwin", "linux"] as const) {
        // A script too: the editor shows it as text and never runs it.
        const { h, deps } = setup({ call: entry("/a.sh", "file", true), platform })
        await h["shell.edit"](ev, { entryId: 5 }, "commander")
        expect(deps.openTextEditor).toHaveBeenCalledWith(5)
        expect(deps.launch).not.toHaveBeenCalled()
        expect(deps.openPath).not.toHaveBeenCalled()
      }
      // The editor's refusals (a binary, too large) reach the commander as they are.
      const binary = setup({ call: entry("/a.bin", "file", false) })
      vi.mocked(binary.deps.openTextEditor).mockRejectedValueOnce(
        Object.assign(new Error("binary"), { details: { reason: "binary" } }),
      )
      await expect(binary.h["shell.edit"](ev, { entryId: 5 }, "commander")).rejects.toMatchObject({
        details: { reason: "binary" },
      })
    })
  })
})
