import type { BrowserWindow } from "electron"
import { describe, expect, it, vi } from "vitest"
import { AppShell } from "../src/main/shell"

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
    contentView: { addChildView: vi.fn() },
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
    const shell = new AppShell(window, commanderView, onShown)
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
    const shell = new AppShell(window, commanderView)
    shell.switchTo("commander")
    expect(shell.activeApp).toBe("commander")
  })
})
