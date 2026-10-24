import type { CommanderApi } from "@panelyth/contracts"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppShell } from "./components/AppShell"
import { resetBridgeCache } from "./bridge"
import { LAYOUT_KEY, loadLayout, setSplit, usePanelsStore } from "./features/panels"

const ok = <R,>(r: R) => ({ ok: true as const, r })

function installApi(settings: Record<string, unknown> = {}) {
  const api = {
    app: { exit: vi.fn(async () => ok({ ok: true })), switch: vi.fn(async () => ok({ ok: true })) },
    system: { ping: vi.fn(), info: vi.fn() },
    sidecar: { getStatus: vi.fn() },
    library: {
      get: vi.fn(async () => ok({ settings, bookmarks: [], recent: [] })),
      setSetting: vi.fn(async () => ok({ ok: true })),
    },
    onEvent: vi.fn(() => () => undefined),
  }
  window.panelyth = api as unknown as CommanderApi
  return api
}

beforeEach(() => {
  usePanelsStore.setState({ active: "left", split: 50, layoutToken: 0 })
  resetBridgeCache()
})
afterEach(() => {
  delete window.panelyth
  vi.useRealTimers()
})

describe("commander shell (Stage C00)", () => {
  it("shows two panels, the function-key bar and the switch to the viewer", () => {
    installApi()
    render(<AppShell />)
    expect(screen.getByTestId("panel-left")).toHaveAttribute("data-active", "true")
    expect(screen.getByTestId("panel-right")).toHaveAttribute("data-active", "false")
    expect(screen.getByRole("button", { name: "Switch to Viewer" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /F5 Copy/ })).toBeEnabled()
    expect(screen.getByRole("button", { name: /F3 View/ })).toBeEnabled()
    expect(screen.getByRole("button", { name: /F4 Edit/ })).toBeEnabled()
  })

  it("Tab moves the active panel and its focus", () => {
    installApi()
    render(<AppShell />)
    fireEvent.keyDown(window, { key: "Tab" })
    expect(screen.getByTestId("panel-right")).toHaveAttribute("data-active", "true")
    expect(document.activeElement).toBe(screen.getByRole("grid", { name: "Right panel contents" }))
    fireEvent.keyDown(window, { key: "Tab" })
    expect(screen.getByTestId("panel-left")).toHaveAttribute("data-active", "true")
  })

  it("switches to the viewer by click and by Ctrl+Shift+M", async () => {
    const api = installApi()
    render(<AppShell />)
    fireEvent.click(screen.getByRole("button", { name: "Switch to Viewer" }))
    await waitFor(() => expect(api.app.switch).toHaveBeenCalledWith("viewer"))
    fireEvent.keyDown(window, { key: "M", ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(api.app.switch).toHaveBeenCalledTimes(2))
  })

  it("persists the panel split once, after the drag settles", async () => {
    vi.useFakeTimers()
    const api = installApi()
    setSplit(30)
    setSplit(35.04)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(api.library.setSetting).toHaveBeenCalledTimes(1)
    // The folder tree's mode and width are part of the layout since Stage C10.5,
    // the panels' arrangement since the title strip's presets (ADR-0045).
    expect(api.library.setSetting).toHaveBeenCalledWith(LAYOUT_KEY, {
      v: 1,
      split: 35,
      arrangement: "side",
      tree: "off",
      treeWidth: 220,
    })
  })

  it("applies a stored arrangement and ignores an unknown one", async () => {
    installApi({ [LAYOUT_KEY]: { v: 1, arrangement: "stacked" } })
    await loadLayout()
    expect(usePanelsStore.getState().arrangement).toBe("stacked")
    usePanelsStore.setState({ arrangement: "side" })
    // library.db is read once per start: a new start for the second value.
    resetBridgeCache()
    installApi({ [LAYOUT_KEY]: { v: 1, arrangement: "diagonal" } })
    await loadLayout()
    expect(usePanelsStore.getState().arrangement).toBe("side")
  })

  it("applies a stored split and ignores invalid ones", async () => {
    installApi({ [LAYOUT_KEY]: { v: 1, split: 30 } })
    await loadLayout()
    expect(usePanelsStore.getState().split).toBe(30)
  })
})
