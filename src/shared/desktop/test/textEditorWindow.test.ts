import type { TextEditOpenResult } from "@panelyth/contracts"
import type { IpcMainInvokeEvent } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The text editor windows (Stage C10.6, ADR-0046): one per file, bound to a
// sidecar session; closing with unsaved changes asks the page first.

type Handler = (...args: unknown[]) => void

class FakeWindow {
  static all: FakeWindow[] = []
  readonly handlers = new Map<string, Handler[]>()
  readonly sent: { ch: string }[] = []
  readonly webContents = {
    id: 200 + FakeWindow.all.length,
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    isDestroyed: () => false,
    send: (_channel: string, message: { ch: string }) => this.sent.push(message),
    printToPDF: vi.fn(async () => Buffer.from("%PDF-1.7 fake")),
  }
  destroyed = false
  title = ""
  constructor(readonly options: { title: string }) {
    this.title = options.title
    FakeWindow.all.push(this)
  }
  setMenuBarVisibility = vi.fn()
  setDocumentEdited = vi.fn()
  setTitle = vi.fn((t: string) => (this.title = t))
  loadURL = vi.fn(async () => undefined)
  focus = vi.fn()
  restore = vi.fn()
  isMinimized = () => false
  isDestroyed = () => this.destroyed
  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
  }
  once(event: string, handler: Handler) {
    this.on(event, handler)
  }
  /** What the user's close does: "close" handlers may prevent it. */
  close() {
    let prevented = false
    for (const h of this.handlers.get("close") ?? [])
      h({ preventDefault: () => (prevented = true) })
    if (prevented) return
    this.destroyed = true
    for (const h of this.handlers.get("closed") ?? []) h()
  }
}

vi.mock("electron", () => ({ BrowserWindow: FakeWindow }))
vi.mock("../src/main/paths", () => ({ appIconPath: () => "" }))

const { TextEditorWindows } = await import("../src/main/textEditorWindow")

const V1 = "a".repeat(64)
const V2 = "b".repeat(64)

function session(path: string, id: string): TextEditOpenResult {
  return {
    sessionId: id,
    name: path.split(/[\\/]/).at(-1)!,
    path,
    version: V1,
    sizeBytes: 5,
    mtimeNs: 1,
    encoding: "windows-1252",
    bom: 0,
    lineEnding: "crlf",
  }
}

/** What the PDF save dialog answers; set per test. */
let pdfAnswer: (defaultPath: string) => string | null = (p) => p

function setup(platform: NodeJS.Platform = "win32") {
  FakeWindow.all = []
  let next = 0
  const paths: Record<number, string> = {
    1: "C:\\notes\\a.md",
    2: "C:\\NOTES\\A.md",
    3: "C:\\b.txt",
  }
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "textedit.open") return session(paths[params.entryId as number]!, `s${++next}`)
    if (method === "textedit.check") return { disk: { version: V2, sizeBytes: 9, mtimeNs: 2 } }
    if (method === "textedit.assetCommit") return { link: "assets/image.png", reused: false }
    if (method === "textedit.resolveImages") {
      return {
        images: (params.links as string[]).map((link) =>
          link.endsWith(".png")
            ? { link, path: `C:/notes/${link}`, type: "png" }
            : { link, path: null, type: null },
        ),
      }
    }
    if (method === "textedit.commit") {
      return {
        status: "saved",
        encoding: params.asUtf8 ? "utf-8" : "windows-1252",
        version: V2,
        sizeBytes: 9,
        mtimeNs: 2,
      }
    }
    return { ok: true }
  })
  const editors = new TextEditorWindows(
    {
      url: "app://texteditor/index.html",
      origin: "app://texteditor",
      preload: "p.cjs",
      devTools: false,
      platform,
      titleBar: platform === "win32",
    },
    {
      call: call as never,
      mintSrc: (path) => `panelyth-media://m/${path.length.toString(16).padStart(32, "0")}`,
      mintImage: (_path, type) => `panelyth-media://m/${type.padEnd(32, "0")}`,
      assetsFolder: async () => "assets",
      savePdfDialog: vi.fn(async (_win: unknown, defaultPath: string) => pdfAnswer(defaultPath)),
      writeFileAtomic: vi.fn(async () => undefined),
      theme: () => "beige",
      style: () => "terminal",
      lang: () => "de",
      background: () => "#f6f1e7",
      log: vi.fn(),
    },
  )
  const h = editors.handlers()
  const ev = (win: FakeWindow) => ({ sender: win.webContents }) as unknown as IpcMainInvokeEvent
  return {
    editors,
    call,
    h,
    ev,
    deps: editors["deps"] as unknown as Record<string, ReturnType<typeof vi.fn>>,
  }
}

describe("text editor windows", () => {
  beforeEach(() => {
    FakeWindow.all = []
  })

  it("opens a window per file and brings it forward when the file is opened again", async () => {
    const { editors, call } = setup("win32")
    await editors.open(1)
    // The same file under another case (Windows): its window comes forward, the new session ends.
    await editors.open(2)
    expect(FakeWindow.all).toHaveLength(1)
    expect(FakeWindow.all[0]!.focus).toHaveBeenCalled()
    expect(call).toHaveBeenCalledWith("textedit.close", { sessionId: "s2" })
    await editors.open(3)
    expect(editors.count).toBe(2)
    expect(FakeWindow.all[0]!.title).toBe("a.md")
  })

  it("gives the page its file through a token, never a path, at the version on disk now", async () => {
    const { editors, h, ev } = setup()
    await editors.open(1)
    const s = await h["texteditor.session"](ev(FakeWindow.all[0]!), {})
    expect(s).toMatchObject({
      name: "a.md",
      version: V2,
      encoding: "windows-1252",
      theme: "beige",
      style: "terminal",
      lang: "de",
    })
    expect(s.src).toMatch(/^panelyth-media:\/\/m\/[0-9a-f]{32}$/)
    expect(JSON.stringify(s)).not.toContain("notes")
  })

  it("sends the window's own session with every call", async () => {
    const { editors, h, ev, call } = setup()
    await editors.open(1)
    await editors.open(3)
    const [a, b] = FakeWindow.all
    await h["texteditor.write"](ev(b!), { seq: 0, text: "x" })
    expect(call).toHaveBeenLastCalledWith("textedit.write", { sessionId: "s2", seq: 0, text: "x" })
    await h["texteditor.commit"](ev(a!), { baseVersion: V1, force: false, asUtf8: true })
    expect(call).toHaveBeenLastCalledWith("textedit.commit", {
      sessionId: "s1",
      baseVersion: V1,
      force: false,
      asUtf8: true,
    })
  })

  it("asks the page before closing with unsaved changes, and closes the session after", async () => {
    const { editors, h, ev, call } = setup("darwin")
    await editors.open(1)
    const win = FakeWindow.all[0]!
    await h["texteditor.setDirty"](ev(win), { dirty: true })
    expect(win.title).toBe("● a.md")
    expect(win.setDocumentEdited).toHaveBeenCalledWith(true)

    win.close()
    expect(win.destroyed).toBe(false)
    expect(win.sent.map((m) => m.ch)).toEqual(["texteditor.closeRequest"])
    // "Cancel" leaves it open; closing without discarding is refused while dirty.
    expect(() => h["texteditor.close"](ev(win), { discard: false })).toThrow("unsaved")
    // "Don't save".
    h["texteditor.close"](ev(win), { discard: true })
    expect(win.destroyed).toBe(true)
    expect(call).toHaveBeenLastCalledWith("textedit.close", { sessionId: "s1" })
    expect(editors.count).toBe(0)
    // A closed window's calls find no file.
    await expect(h["texteditor.check"](ev(win), {})).rejects.toMatchObject({
      code: "TEXTEDIT_SESSION_GONE",
    })
  })

  it("sends a picture's bytes as base64 and answers links with tokens, never paths (C10.7)", async () => {
    const { editors, h, ev, call } = setup()
    await editors.open(1)
    const win = FakeWindow.all[0]!
    await h["texteditor.assetChunk"](ev(win), { seq: 0, data: new Uint8Array([137, 80, 78, 71]) })
    expect(call).toHaveBeenLastCalledWith("textedit.assetChunk", {
      sessionId: "s1",
      seq: 0,
      data: "iVBORw==",
    })
    await expect(h["texteditor.assetCommit"](ev(win), { name: "shot" })).resolves.toEqual({
      link: "assets/image.png",
      reused: false,
    })
    expect(call).toHaveBeenLastCalledWith("textedit.assetCommit", {
      sessionId: "s1",
      name: "shot",
      folder: "assets",
    })
    const { images } = await h["texteditor.resolveImages"](ev(win), {
      links: ["assets/a.png", "../outside.txt"],
    })
    expect(images).toEqual([
      { link: "assets/a.png", src: `panelyth-media://m/${"png".padEnd(32, "0")}` },
      { link: "../outside.txt", src: null },
    ])
    expect(JSON.stringify(images)).not.toContain("notes")
  })

  it("quitting asks only the windows with unsaved changes, and stops while they ask", async () => {
    const { editors, h, ev } = setup()
    await editors.open(1)
    await editors.open(3)
    const [clean, dirty] = FakeWindow.all
    expect(editors.askUnsaved()).toBe(false)
    await h["texteditor.setDirty"](ev(dirty!), { dirty: true })
    expect(editors.askUnsaved()).toBe(true)
    expect(dirty!.sent.map((m) => m.ch)).toEqual(["texteditor.closeRequest"])
    expect(dirty!.focus).toHaveBeenCalled()
    expect(clean!.sent).toEqual([])
    // "Don't save": nothing is left to ask about, so the next quit goes on.
    h["texteditor.close"](ev(dirty!), { discard: true })
    expect(editors.askUnsaved()).toBe(false)
  })

  it("F3 opens a file to read; F4 on it turns that window to editing (owner request)", async () => {
    const { editors, h, ev } = setup()
    await editors.open(1, { readOnly: true })
    const win = FakeWindow.all[0]!
    expect(await h["texteditor.session"](ev(win), {})).toMatchObject({ readOnly: true })
    // F3 again: the same window, still to read.
    await editors.open(1, { readOnly: true })
    expect(win.sent).toEqual([])
    // F4: no second window; editing starts in this one.
    await editors.open(2)
    expect(FakeWindow.all).toHaveLength(1)
    expect(win.sent.map((m) => m.ch)).toEqual(["texteditor.editable"])
    expect(await h["texteditor.session"](ev(win), {})).toMatchObject({ readOnly: false })
    // F3 on a file being edited never takes editing away.
    await editors.open(1, { readOnly: true })
    expect(win.sent).toHaveLength(1)
    expect(await h["texteditor.session"](ev(win), {})).toMatchObject({ readOnly: false })
  })

  it("F4 opens to edit", async () => {
    const { editors, h, ev } = setup()
    await editors.open(3)
    expect(await h["texteditor.session"](ev(FakeWindow.all[0]!), {})).toMatchObject({
      readOnly: false,
    })
  })

  it("exports a PDF of the page where the user chooses, and tells the page only the name (C10.8)", async () => {
    const { editors, h, ev, deps } = setup()
    await editors.open(1)
    const win = FakeWindow.all[0]!
    pdfAnswer = (defaultPath) => {
      // The dialog starts beside the document, under its name.
      expect(defaultPath.replace(/\\/g, "/")).toBe("C:/notes/a.pdf")
      return "D:/out/notes.pdf"
    }
    const result = await h["texteditor.exportPdf"](ev(win), { pageSize: "A4", margins: "normal" })
    expect(result).toEqual({ saved: true, name: "notes.pdf" })
    const options = (win.webContents.printToPDF.mock.calls[0] as unknown[])[0] as {
      pageSize: string
      margins: { top: number }
      displayHeaderFooter: boolean
      footerTemplate: string
    }
    expect(options.pageSize).toBe("A4")
    expect(options.margins.top).toBeCloseTo(18 / 25.4)
    expect(options.displayHeaderFooter).toBe(true)
    expect(options.footerTemplate).toContain("pageNumber")
    expect(deps.writeFileAtomic).toHaveBeenCalledWith("D:/out/notes.pdf", expect.any(Buffer))

    // Cancelled: nothing printed, nothing written.
    pdfAnswer = () => null
    await expect(
      h["texteditor.exportPdf"](ev(win), { pageSize: "Letter", margins: "narrow" }),
    ).resolves.toEqual({ saved: false, name: null })
    expect(win.webContents.printToPDF).toHaveBeenCalledTimes(1)
    expect(deps.writeFileAtomic).toHaveBeenCalledTimes(1)
    pdfAnswer = (p) => p
  })

  it("a clean window closes at once", async () => {
    const { editors } = setup()
    await editors.open(3)
    FakeWindow.all[0]!.close()
    expect(FakeWindow.all[0]!.destroyed).toBe(true)
    expect(editors.count).toBe(0)
  })

  it("passes the sidecar's refusals on to the commander", async () => {
    const { editors, call } = setup()
    call.mockRejectedValueOnce(
      Object.assign(new Error("binary"), { details: { reason: "binary" } }),
    )
    await expect(editors.open(1)).rejects.toMatchObject({ details: { reason: "binary" } })
    expect(FakeWindow.all).toHaveLength(0)
  })
})

describe("textEditorCsp (ADR-0046)", () => {
  it("fetches its token and shows token pictures; no inline styles or scripts, workers, objects or frames", async () => {
    const { textEditorCsp } = await import("../src/main/security")
    const csp = textEditorCsp()
    expect(csp).toContain("connect-src 'self' panelyth-media:")
    expect(csp).toContain("img-src 'self' data: panelyth-media:")
    expect(csp).toContain("style-src 'self';")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain("unsafe-inline")
    expect(csp).not.toContain("worker-src")
    // Development: Vite's inline preamble and its websocket.
    const dev = textEditorCsp(["http://localhost:5177"])
    expect(dev).toContain("'unsafe-inline'")
    expect(dev).toContain("ws://localhost:5177")
  })
})
