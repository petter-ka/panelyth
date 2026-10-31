import { beforeEach, describe, expect, it, vi } from "vitest"

interface FakeWindow {
  options: Record<string, unknown>
  url: string
  handlers: Map<string, () => void>
  closed: boolean
  focus: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  close(): void
}

const created: FakeWindow[] = []

vi.mock("electron", () => ({
  BrowserWindow: class {
    options: Record<string, unknown>
    webContents = { id: 300 + created.length, on: vi.fn(), setWindowOpenHandler: vi.fn() }
    url = ""
    handlers = new Map<string, () => void>()
    closed = false
    focus = vi.fn()
    restore = vi.fn()
    constructor(options: Record<string, unknown>) {
      this.options = options
      created.push(this as unknown as FakeWindow)
    }
    setMenuBarVisibility = vi.fn()
    on = (event: string, handler: () => void) => this.handlers.set(event, handler)
    once = (event: string, handler: () => void) => this.handlers.set(event, handler)
    loadURL = vi.fn(async (url: string) => {
      this.url = url
    })
    isDestroyed = () => this.closed
    isMinimized = () => false
    close() {
      this.closed = true
      this.handlers.get("closed")?.()
    }
  },
}))
vi.mock("../src/main/paths", () => ({ appIconPath: () => "" }))

const { CompareWindows, compareWindowKey, compareWindowUrl } =
  await import("../src/main/compareWindow")

const BASE = "app://commander/compare.html"
const OPTIONS = {
  url: BASE,
  origin: "app://commander",
  preload: "commander.cjs",
  devTools: false,
  titleBar: true,
}
const FILES = {
  view: "files",
  left: { id: 3, name: "a b.txt" },
  right: { id: 4, name: "ä.txt" },
} as const
const SYNC = {
  view: "sync",
  left: { path: "C:\\a", dirId: 1 },
  right: { path: "D:\\b & c", dirId: null },
} as const
const MANY = {
  view: "many",
  jobId: 9,
  side: "left",
  count: 14,
  folder: "D:\\b",
  mineQueryId: 2,
  theirsQueryId: 5,
} as const

const fragment = (url: string): URLSearchParams => new URLSearchParams(url.split("#")[1])

describe("compare windows (ADR-0048)", () => {
  beforeEach(() => {
    created.length = 0
  })

  it("names what to compare in the fragment", () => {
    expect(Object.fromEntries(fragment(compareWindowUrl(BASE, FILES)))).toEqual({
      view: "files",
      l: "3",
      ln: "a b.txt",
      r: "4",
      rn: "ä.txt",
    })
    expect(Object.fromEntries(fragment(compareWindowUrl(BASE, MANY)))).toEqual({
      view: "many",
      job: "9",
      side: "left",
      count: "14",
      folder: "D:\\b",
      mq: "2",
      tq: "5",
    })
    // A typed folder has no id yet: the page resolves it when it compares.
    expect(Object.fromEntries(fragment(compareWindowUrl(BASE, SYNC)))).toEqual({
      view: "sync",
      lp: "C:\\a",
      ld: "1",
      rp: "D:\\b & c",
    })
    expect(compareWindowUrl(BASE, FILES).startsWith(`${BASE}#`)).toBe(true)
  })

  it("is a child of the shell that does not block it, on the commander's preload", () => {
    const parent = { isDestroyed: () => false }
    new CompareWindows(OPTIONS, () => parent as never).open(FILES)
    const win = created[0]!
    expect(win.options).toMatchObject({ parent, titleBarStyle: "hidden" })
    expect(win.options).not.toHaveProperty("modal")
    expect(win.options.webPreferences).toMatchObject({
      preload: "commander.cjs",
      sandbox: true,
      contextIsolation: true,
      additionalArguments: ["--panelyth-title-bar"],
    })
    expect(win.url).toBe(compareWindowUrl(BASE, FILES))
  })

  it("brings forward the window of the same two files or folders; a result list gets its own", () => {
    const windows = new CompareWindows({ ...OPTIONS, titleBar: false }, () => null)
    windows.open(FILES)
    windows.open({ ...FILES })
    expect(created).toHaveLength(1)
    expect(created[0]!.focus).toHaveBeenCalled()
    // The other way round is another comparison: left and right swap.
    windows.open({ ...FILES, left: FILES.right, right: FILES.left })
    windows.open(SYNC)
    windows.open(SYNC)
    windows.open(MANY)
    windows.open(MANY)
    expect(created).toHaveLength(5)
    expect(windows.count).toBe(5)
    expect(created[0]!.options).not.toHaveProperty("titleBarStyle")
  })

  it("opens a new window once the old one closed", () => {
    const windows = new CompareWindows(OPTIONS, () => null)
    windows.open(FILES)
    created[0]!.close()
    expect(windows.count).toBe(0)
    windows.open(FILES)
    expect(created).toHaveLength(2)
  })

  it("knows its pages, for the settings they share with the commander", () => {
    const windows = new CompareWindows(OPTIONS, () => null)
    const a = windows.open(FILES)
    const b = windows.open(SYNC)
    expect(windows.webContents()).toEqual([a.webContents, b.webContents])
    expect(windows.owns(b.webContents)).toBe(true)
    expect(windows.owns({ id: 1 } as never)).toBe(false)
    b.close()
    expect(windows.webContents()).toEqual([a.webContents])
    expect(windows.owns(b.webContents)).toBe(false)
  })

  it("keys files by their ids and folders by their paths", () => {
    expect(compareWindowKey(FILES)).toBe("files:3:4")
    expect(compareWindowKey(SYNC)).toBe("sync:C:\\a\0D:\\b & c")
    expect(compareWindowKey(MANY)).toBeNull()
  })
})
