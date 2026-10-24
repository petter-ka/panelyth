import type { BrowserWindow } from "electron"
import { describe, expect, it, vi } from "vitest"
import { AppShell, chromeColorOf } from "../src/main/shell"
import { themeColorsOf } from "../src/main/themeColors"

// The app switch in main (ADR-0031): which app is on screen, and telling the
// sidecar so its watches follow (Stage P02, ADR-0026).

const fakeContents = () => ({
  focus: vi.fn(),
  isDestroyed: () => false,
  send: vi.fn(),
  on: vi.fn(),
  loadURL: vi.fn(async () => undefined),
  close: vi.fn(),
})

vi.mock("electron", () => ({
  nativeTheme: { shouldUseDarkColors: false },
  WebContentsView: class {
    webContents = fakeContents()
    setVisible = vi.fn()
    setBackgroundColor = vi.fn()
    setBounds = vi.fn()
  },
}))
vi.mock("../src/main/security", () => ({ hardenWebContents: vi.fn() }))
vi.mock("../src/main/window", () => ({ securePreferences: vi.fn(() => ({})) }))
vi.mock("../src/main/perf", () => ({ perfMark: vi.fn() }))

function fakeWindow() {
  const webContents = fakeContents()
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    setTitle: vi.fn(),
    on: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    getContentSize: () => [1280, 800],
    contentView: { addChildView: vi.fn(), on: vi.fn() },
    webContents,
  }
  return { window: window as unknown as BrowserWindow, webContents, setTitle: window.setTitle }
}

const commanderView = {
  url: "app://commander/index.html",
  origin: "app://commander",
  preload: "commander.cjs",
  devTools: false,
}

describe("AppShell", () => {
  it("names the app on screen once per switch, and both apps hear of it", () => {
    const { window, webContents, setTitle } = fakeWindow()
    const onShown = vi.fn()
    const shell = new AppShell(window, { commander: commanderView }, onShown)
    expect(shell.activeApp).toBe("viewer")
    expect(onShown).not.toHaveBeenCalled()

    shell.switchTo("commander")
    expect(shell.activeApp).toBe("commander")
    expect(onShown).toHaveBeenCalledExactlyOnceWith("commander")
    expect(setTitle).toHaveBeenLastCalledWith("Panelyth Commander")
    expect(webContents.send).toHaveBeenLastCalledWith(expect.any(String), {
      ch: "app.visibility",
      p: { app: "viewer", visible: false },
    })
    const commander = shell.webContentsOf("commander")!
    expect(commander.send).toHaveBeenLastCalledWith(expect.any(String), {
      ch: "app.visibility",
      p: { app: "commander", visible: true },
    })

    // Shown again without a switch (a click on the current app): nothing new.
    shell.switchTo("commander")
    expect(onShown).toHaveBeenCalledOnce()

    shell.requestSwitch("viewer")
    expect(onShown).toHaveBeenLastCalledWith("viewer")
    expect(onShown).toHaveBeenCalledTimes(2)
    expect(shell.switched).toBe(true)
    expect(setTitle).toHaveBeenLastCalledWith("Panelyth")
  })

  it("stays on the viewer while the commander is disabled", () => {
    const { window } = fakeWindow()
    const onShown = vi.fn()
    const shell = new AppShell(window, null, onShown)
    expect(shell.enabled).toBe(false)
    shell.switchTo("commander")
    expect(shell.activeApp).toBe("viewer")
    expect(onShown).not.toHaveBeenCalled()
  })

  it("works without a listener", () => {
    const { window } = fakeWindow()
    const shell = new AppShell(window, { commander: commanderView })
    shell.switchTo("commander")
    expect(shell.activeApp).toBe("commander")
  })
})

describe("the commander view's first color", () => {
  it("is the theme's chrome, the system's when the theme follows it", () => {
    expect(chromeColorOf({ theme: "dark" })).toBe("#242424")
    expect(chromeColorOf({ theme: "beige" })).toBe("#f6f1e7")
    // The mocked system is light.
    expect(chromeColorOf({ theme: "system" })).toBe("#f7f7f7")
    expect(chromeColorOf({ theme: "aqua" })).toBe("#242424")
    expect(chromeColorOf(null)).toBe("#242424")
  })

  it("is known for a stored theme before the sidecar answers (the window's first color)", () => {
    expect(themeColorsOf("light-brown")).toEqual({ chrome: "#f2e4d0" })
    expect(themeColorsOf("system")).toEqual({ chrome: "#f7f7f7" })
    expect(themeColorsOf(null)).toEqual({ chrome: "#242424" })
    expect(themeColorsOf("aqua")).toEqual(themeColorsOf("dark"))
  })

  it("is the terminal console's chrome in the terminal style (ADR-0047)", () => {
    expect(chromeColorOf({ theme: "dark", style: "terminal" })).toBe("#07100b")
    expect(chromeColorOf({ theme: "beige", style: "terminal" })).toBe("#efe4cb")
    expect(chromeColorOf({ theme: "dark", style: "glass" })).toBe("#242424")
    expect(themeColorsOf("system", "terminal")).toEqual({ chrome: "#f3f2ee" })
    expect(themeColorsOf("aqua", "terminal")).toEqual(themeColorsOf("dark", "terminal"))
  })

  it("is set when the view is made, and follows a later theme change", () => {
    const { window } = fakeWindow()
    const shell = new AppShell(window, { commander: commanderView })
    shell.setBackground("#f7f7f7")
    shell.switchTo("commander")
    const added = (window.contentView.addChildView as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      setBackgroundColor: ReturnType<typeof vi.fn>
    }
    expect(added.setBackgroundColor).toHaveBeenLastCalledWith("#f7f7f7")
    shell.setBackground("#2a2233")
    expect(added.setBackgroundColor).toHaveBeenLastCalledWith("#2a2233")
  })
})

describe("the commander view's size", () => {
  it("follows the content area when it changes without a resize (the menu bar appearing)", () => {
    const { window } = fakeWindow()
    let size = [1280, 800]
    ;(window as unknown as { getContentSize: () => number[] }).getContentSize = () => size
    const shell = new AppShell(window, { commander: commanderView })
    shell.switchTo("commander")
    const view = (window.contentView.addChildView as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      setBounds: ReturnType<typeof vi.fn>
    }
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1280, height: 800 })
    // The menu bar takes 26 px: no "resize" on the window, only the content view's bounds change.
    size = [1280, 774]
    const onBounds = (window.contentView.on as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]) => event === "bounds-changed",
    )![1] as () => void
    onBounds()
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1280, height: 774 })
  })
})

describe("Panelyth System's view (ADR-0042)", () => {
  it("is a view of its own: made on its first switch, one app view on top at a time", () => {
    const { window, webContents } = fakeWindow()
    const onShown = vi.fn()
    const shell = new AppShell(
      window,
      { commander: commanderView, system: { ...commanderView, url: "app://system/index.html" } },
      onShown,
    )
    shell.switchTo("commander")
    shell.switchTo("system")
    const added = (window.contentView.addChildView as ReturnType<typeof vi.fn>).mock.calls.map(
      ([view]) =>
        view as {
          setVisible: ReturnType<typeof vi.fn>
          webContents: { send: ReturnType<typeof vi.fn> }
        },
    )
    expect(added).toHaveLength(2)
    const [commander, system] = added
    expect(commander!.setVisible).toHaveBeenLastCalledWith(false)
    expect(system!.setVisible).toHaveBeenLastCalledWith(true)
    expect(shell.activeApp).toBe("system")
    expect(onShown).toHaveBeenLastCalledWith("system")
    expect(shell.webContentsOf("system")).toBe(system!.webContents)
    // Every app hears whether it is the one on screen.
    for (const [wc, app] of [
      [webContents, "viewer"],
      [commander!.webContents, "commander"],
      [system!.webContents, "system"],
    ] as const) {
      expect(wc.send).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ ch: "app.visibility", p: { app, visible: app === "system" } }),
      )
    }
    // Back to the viewer: no app view stays on top.
    shell.switchTo("viewer")
    expect(system!.setVisible).toHaveBeenLastCalledWith(false)
    expect(added).toHaveLength(2)
  })
})
