import { DEFAULT_SWITCH_SETTINGS, type SharedContext } from "@fastview/contracts"
import { useSwitchSettings } from "@fastview/renderer-core"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppShell } from "../../app/AppShell"
import { installFakeBridge, makeItems } from "../../test/fakeBridge"
import { mockViewport } from "../../test/viewport"
import { openFolder, resetFolderStore, useFolderStore } from "../folder/folderStore"
import { startSidecarMonitoring, useSidecarStore } from "../system/sidecarStore"
import { useNoticeStore } from "../clipboard/clipboard"
import {
  focusAndSelect,
  selectionCount,
  selectRangeTo,
  useSelectionStore,
} from "../tiles/selectionStore"
import { resetContextSync, startContextSync } from "./appSwitch"

// The connection point to the commander (ADR-0031, docs/shared/APP-SWITCHING.md).

let stop: (() => void)[] = []

// The switch lives in the app rail of the shell (ADR-0031).
const Harness = () => <AppShell />

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

  it("sits in the app rail and switches by click", async () => {
    const { switchApp } = setup(true)
    const rail = screen.getByRole("navigation", { name: "Applications" })
    const button = screen.getByRole("button", { name: "Switch to Commander" })
    expect(rail).toContainElement(button)
    expect(button).toHaveAttribute("data-tooltip-content", "Switch to Commander (Ctrl+Shift+M)")
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
      // The carried selection: entries 2..5 of whatever session asks.
      selection: vi.fn(async (_version: number, queryId: number) => ({
        ok: true as const,
        r: {
          queryId,
          version: 1,
          ranges: [[2, 5]] as [number, number][],
          include: [],
          exclude: [],
        },
      })),
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
  const none: SharedContext = {
    version: 0,
    app: "",
    dirId: 0,
    path: "",
    focusId: null,
    selectionCount: 0,
    selectionTooLarge: false,
  }

  beforeEach(() => {
    resetContextSync()
    useSwitchSettings.setState(DEFAULT_SWITCH_SETTINGS)
  })

  it("publishes the folder and the focused tile, then switches", async () => {
    const { bridge, context, switchApp } = withContext(none)
    bridge.backend.items = makeItems(10)
    await act(async () => openFolder("/photos"))
    await waitFor(() => expect(context.publish).toHaveBeenCalledWith(1, null, undefined))
    await act(async () => focusAndSelect(3, bridge.backend.items[3]!.id))
    fireEvent.click(screen.getByRole("button", { name: "Switch to Commander" }))
    await waitFor(() => expect(switchApp).toHaveBeenCalledWith("commander"))
    expect(context.publish).toHaveBeenLastCalledWith(1, bridge.backend.items[3]!.id, null)
    expect(context.publish.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      switchApp.mock.invocationCallOrder[0]!,
    )
  })

  it("opens the commander's folder and selects its cursor entry when it is media", async () => {
    const { bridge, set } = withContext(none)
    bridge.backend.items = makeItems(10, 2)
    const target = bridge.backend.items[4]!
    set({
      version: 2,
      app: "commander",
      dirId: 7,
      path: "/x",
      focusId: target.id,
      selectionCount: 0,
      selectionTooLarge: false,
    })
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
    set({
      version: 1,
      app: "commander",
      dirId: 7,
      path: "/x",
      focusId: 424242,
      selectionCount: 0,
      selectionTooLarge: false,
    })
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
      ...none,
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
    set({
      version: 4,
      app: "viewer",
      dirId: 9,
      path: "/y",
      focusId: null,
      selectionCount: 0,
      selectionTooLarge: false,
    })
    await act(async () => bridge.push("app.visibility", { app: "viewer", visible: true }))
    expect(bridge.api.dir.openEntry).not.toHaveBeenCalled()
  })

  it("publishes a multi-selection with the switch", async () => {
    const { bridge, context, switchApp } = withContext(none)
    bridge.backend.items = makeItems(10)
    await act(async () => openFolder("/photos"))
    await act(async () => focusAndSelect(1, bridge.backend.items[1]!.id))
    await act(async () => selectRangeTo(4, bridge.backend.items[4]!.id))
    fireEvent.click(screen.getByRole("button", { name: "Switch to Commander" }))
    await waitFor(() => expect(switchApp).toHaveBeenCalled())
    expect(context.publish).toHaveBeenLastCalledWith(
      1,
      bridge.backend.items[4]!.id,
      expect.objectContaining({ ranges: [[1, 5]], include: [], exclude: [] }),
    )
  })

  it("turns the commander's marks into the selection", async () => {
    const { bridge, context, set } = withContext(none)
    bridge.backend.items = makeItems(10)
    set({ ...none, version: 2, app: "commander", dirId: 7, path: "/x", selectionCount: 3 })
    await act(async () => bridge.push("app.visibility", { app: "viewer", visible: true }))
    await waitFor(() => expect(context.selection).toHaveBeenCalledWith(2, expect.any(Number)))
    await waitFor(() => expect(selectionCount(useSelectionStore.getState())).toBe(3))
    expect(useSelectionStore.getState().ranges).toEqual([[2, 5]])
  })

  it("says so when the selection was too large, and honours the carry-over settings", async () => {
    const { bridge, context, set } = withContext(none)
    bridge.backend.items = makeItems(10)
    set({ ...none, version: 2, app: "commander", dirId: 7, path: "/x", selectionTooLarge: true })
    await act(async () => bridge.push("app.visibility", { app: "viewer", visible: true }))
    await waitFor(() =>
      expect(useNoticeStore.getState().notice?.text).toBe(
        "The selection is too large to carry over",
      ),
    )
    expect(context.selection).not.toHaveBeenCalled()
    // Folder off: the viewer stays where it is.
    useSwitchSettings.setState({ carry: { folder: false, focus: true, selection: true } })
    const opens = bridge.api.dir.openEntry.mock.calls.length
    set({ ...none, version: 3, app: "commander", dirId: 8, path: "/y", selectionCount: 2 })
    await act(async () => bridge.push("app.visibility", { app: "viewer", visible: true }))
    await waitFor(() => expect(context.get).toHaveBeenCalledTimes(2))
    expect(bridge.api.dir.openEntry.mock.calls.length).toBe(opens)
  })

  it("does not publish while hidden", async () => {
    const { bridge, context } = withContext(none)
    await act(async () => bridge.push("app.visibility", { app: "viewer", visible: false }))
    context.publish.mockClear()
    await act(async () => openFolder("/photos"))
    expect(context.publish).not.toHaveBeenCalled()
  })
})
