import type { SharedContext } from "@fastview/contracts"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useGlobalShortcuts } from "../../app/shortcuts"
import { ContentPane } from "../../components/ContentPane"
import { installFakeBridge, makeItems } from "../../test/fakeBridge"
import { mockViewport } from "../../test/viewport"
import { openFolder, resetFolderStore, useFolderStore } from "../folder/folderStore"
import { startSidecarMonitoring, useSidecarStore } from "../system/sidecarStore"
import { focusAndSelect, useSelectionStore } from "../tiles/selectionStore"
import { resetContextSync, startContextSync } from "./appSwitch"

// The connection point to the commander (ADR-0031, docs/shared/APP-SWITCHING.md).

let stop: (() => void)[] = []

function Harness() {
  useGlobalShortcuts()
  return <ContentPane />
}

function setup(commanderEnabled: boolean) {
  const bridge = installFakeBridge()
  const switchApp = vi.fn(async () => ({ ok: true as const, r: { ok: true as const } }))
  if (commanderEnabled) {
    ;(window.fastview!.app as unknown as { switch?: typeof switchApp }).switch = switchApp
  }
  stop = [startSidecarMonitoring()]
  render(<Harness />)
  return { bridge, switchApp }
}

beforeEach(() => {
  mockViewport(1000, 800)
  resetFolderStore()
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
})
afterEach(() => {
  stop.forEach((f) => f())
  vi.restoreAllMocks()
})

describe("switch to the commander", () => {
  it("is hidden while the commander is disabled", () => {
    setup(false)
    expect(screen.queryByTestId("app-switch")).not.toBeInTheDocument()
  })

  it("is the first toolbar control and switches by click", async () => {
    const { switchApp } = setup(true)
    const toolbar = screen.getByRole("toolbar", { name: "Navigation" })
    const button = screen.getByRole("button", { name: "Switch to Commander" })
    expect(toolbar.querySelector("button")).toBe(button)
    expect(button).toHaveAttribute("title", "Switch to Commander (Ctrl+Shift+M)")
    fireEvent.click(button)
    await waitFor(() => expect(switchApp).toHaveBeenCalledWith("commander"))
  })

  it("switches with Ctrl+Shift+M, also while typing", async () => {
    const { switchApp } = setup(true)
    await act(async () => {
      fireEvent.keyDown(window, { key: "M", ctrlKey: true, shiftKey: true })
    })
    await waitFor(() => expect(switchApp).toHaveBeenCalledTimes(1))
    const input = document.createElement("input")
    document.body.append(input)
    input.focus()
    await act(async () => {
      fireEvent.keyDown(input, { key: "M", ctrlKey: true, shiftKey: true })
    })
    await waitFor(() => expect(switchApp).toHaveBeenCalledTimes(2))
    input.remove()
  })
})

describe("the shared context (Stage C01)", () => {
  function withContext(initial: SharedContext) {
    const fake = setup(true)
    let current = initial
    const context = {
      publish: vi.fn(async () => ({ ok: true as const, r: { ok: true } })),
      get: vi.fn(async () => ({ ok: true as const, r: current })),
    }
    ;(window.fastview as unknown as { context: typeof context }).context = context
    stop.push(startContextSync())
    return {
      ...fake,
      context,
      set: (next: SharedContext) => {
        current = next
      },
    }
  }
  const none: SharedContext = { version: 0, app: "", dirId: 0, path: "", focusId: null }

  beforeEach(() => resetContextSync())

  it("publishes the folder and the focused tile, then switches", async () => {
    const { bridge, context, switchApp } = withContext(none)
    bridge.backend.items = makeItems(10)
    await act(async () => openFolder("/photos"))
    await waitFor(() => expect(context.publish).toHaveBeenCalledWith(1, null))
    await act(async () => focusAndSelect(3, bridge.backend.items[3]!.id))
    fireEvent.click(screen.getByRole("button", { name: "Switch to Commander" }))
    await waitFor(() => expect(switchApp).toHaveBeenCalledWith("commander"))
    expect(context.publish).toHaveBeenLastCalledWith(1, bridge.backend.items[3]!.id)
    expect(context.publish.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      switchApp.mock.invocationCallOrder[0]!,
    )
  })

  it("opens the commander's folder and selects its cursor entry when it is media", async () => {
    const { bridge, set } = withContext(none)
    bridge.backend.items = makeItems(10, 2)
    const target = bridge.backend.items[4]!
    set({ version: 2, app: "commander", dirId: 7, path: "/x", focusId: target.id })
    await act(async () => bridge.push("app.visibility", { app: "viewer", visible: true }))
    await waitFor(() =>
      expect(bridge.api.dir.openEntry).toHaveBeenCalledWith({ entryId: 7, recursive: false }),
    )
    await waitFor(() => expect(useSelectionStore.getState().selectedId).toBe(target.id))
    expect(useSelectionStore.getState().focusIndex).toBe(4)
  })

  it("selects nothing for a cursor entry the viewer can't show", async () => {
    const { bridge, set } = withContext(none)
    bridge.backend.items = makeItems(10)
    set({ version: 1, app: "commander", dirId: 7, path: "/x", focusId: 424242 })
    await act(async () => bridge.push("app.visibility", { app: "viewer", visible: true }))
    await waitFor(() => expect(bridge.api.query.indexOf).toHaveBeenCalled())
    expect(useFolderStore.getState().folder?.dirId).toBe(7)
    expect(useSelectionStore.getState().selectedId).toBeNull()
  })

  it("moves nothing when it already shows the folder, and ignores old or own contexts", async () => {
    const { bridge, context, set } = withContext(none)
    bridge.backend.items = makeItems(10)
    await act(async () => openFolder("/photos"))
    await act(async () => focusAndSelect(2, bridge.backend.items[2]!.id))
    set({
      version: 3,
      app: "commander",
      dirId: 1,
      path: "/photos",
      focusId: bridge.backend.items[5]!.id,
    })
    await act(async () => bridge.push("app.visibility", { app: "viewer", visible: true }))
    await waitFor(() => expect(context.get).toHaveBeenCalled())
    expect(bridge.api.dir.openEntry).not.toHaveBeenCalled()
    expect(useSelectionStore.getState().focusIndex).toBe(2)
    set({ version: 4, app: "viewer", dirId: 9, path: "/y", focusId: null })
    await act(async () => bridge.push("app.visibility", { app: "viewer", visible: true }))
    expect(bridge.api.dir.openEntry).not.toHaveBeenCalled()
  })

  it("does not publish while hidden", async () => {
    const { bridge, context } = withContext(none)
    await act(async () => bridge.push("app.visibility", { app: "viewer", visible: false }))
    context.publish.mockClear()
    await act(async () => openFolder("/photos"))
    expect(context.publish).not.toHaveBeenCalled()
  })
})
