import type { WebContents } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"

interface FakeWindow {
  options: Record<string, unknown>
  webContents: { id: number }
  url: string
  handlers: Map<string, () => void>
  closed: boolean
  focus: ReturnType<typeof vi.fn>
  close(): void
}

const created: FakeWindow[] = []

vi.mock("electron", () => ({
  BrowserWindow: class {
    options: Record<string, unknown>
    webContents = { id: 200 + created.length, on: vi.fn(), setWindowOpenHandler: vi.fn() }
    url = ""
    handlers = new Map<string, () => void>()
    closed = false
    focus = vi.fn()
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
    isVisible = () => true
    isMinimized = () => false
    restore = vi.fn()
    close() {
      this.closed = true
      this.handlers.get("closed")?.()
    }
  },
}))
vi.mock("../src/main/paths", () => ({ appIconPath: () => "" }))

const { SettingsWindow, settingsWindowUrl } = await import("../src/main/settingsWindow")

const PAGE = {
  url: "app://panelyth/settings.html",
  origin: "app://panelyth",
  preload: "viewer.cjs",
  args: ["--panelyth-commander"],
}

function shell() {
  const listeners = new Map<string, () => void>()
  return {
    listeners,
    isDestroyed: () => false,
    setEnabled: vi.fn(),
    focus: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => listeners.set(event, handler)),
    removeListener: vi.fn((event: string) => listeners.delete(event)),
  }
}

const opener = { id: 1, isDestroyed: () => false } as unknown as WebContents

describe("the settings window (ADR-0039)", () => {
  beforeEach(() => {
    created.length = 0
  })

  it("names the first tab in the fragment only", () => {
    expect(settingsWindowUrl("app://panelyth/settings.html", "about")).toBe(
      "app://panelyth/settings.html#tab=about",
    )
    expect(settingsWindowUrl("app://panelyth/settings.html")).toBe("app://panelyth/settings.html")
    expect(settingsWindowUrl("app://commander/settings.html", "commander", "toolbar")).toBe(
      "app://commander/settings.html#tab=commander&section=toolbar",
    )
  })

  it("is a modal child of the shell on Windows and Linux, with the opener's page and preload", () => {
    const parent = shell()
    const windows = new SettingsWindow(
      { devTools: false, platform: "win32" },
      () => parent as never,
    )
    windows.open(opener, PAGE, "appearance")
    const win = created[0]!
    expect(win.options).toMatchObject({ parent, modal: true, minimizable: false })
    expect(win.options.webPreferences).toMatchObject({
      preload: "viewer.cjs",
      sandbox: true,
      contextIsolation: true,
      additionalArguments: ["--panelyth-commander"],
    })
    expect(win.url).toBe("app://panelyth/settings.html#tab=appearance")
    expect(parent.setEnabled).not.toHaveBeenCalled()
  })

  it("on macOS is a movable child window that keeps the focus, without dimming the shell", () => {
    const parent = shell()
    const windows = new SettingsWindow(
      { devTools: false, platform: "darwin" },
      () => parent as never,
    )
    windows.open(opener, PAGE)
    expect(created[0]!.options).toMatchObject({ parent, modal: false })
    // Electron disables a macOS window with a half-transparent sheet: never here.
    expect(parent.setEnabled).not.toHaveBeenCalled()
    // The shell window activated (a click on it): the settings window takes the focus back.
    const settings = created[0]!
    settings.focus.mockClear()
    parent.listeners.get("focus")?.()
    expect(settings.focus).toHaveBeenCalled()
    settings.close()
    expect(parent.listeners.has("focus")).toBe(false)
    expect(parent.focus).toHaveBeenCalled()
  })

  it("is one window: asking again focuses it", () => {
    const windows = new SettingsWindow(
      { devTools: false, platform: "linux" },
      () => shell() as never,
    )
    windows.open(opener, PAGE)
    windows.open(opener, PAGE, "about")
    expect(created).toHaveLength(1)
    expect(created[0]!.focus).toHaveBeenCalled()
  })

  it("knows its opener, and only the window itself may close it", () => {
    const windows = new SettingsWindow(
      { devTools: false, platform: "linux" },
      () => shell() as never,
    )
    windows.open(opener, PAGE)
    const self = created[0]!.webContents as unknown as WebContents
    const stranger = { id: 99 } as unknown as WebContents
    expect(windows.openerOf(self)).toBe(opener)
    expect(windows.openerOf(stranger)).toBeNull()
    expect(windows.closeFrom(stranger)).toBe(false)
    expect(windows.isOpen).toBe(true)
    expect(windows.closeFrom(self)).toBe(true)
    expect(windows.isOpen).toBe(false)
    expect(windows.openerOf(self)).toBeNull()
  })
})
