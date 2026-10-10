import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  openFolder,
  resetFolderStore,
  startFolderMonitoring,
} from "../../features/folder/folderStore"
import { resetThumbs, startThumbMonitoring } from "../../features/previews/thumbStore"
import { profileFor, rowHeight, tilesPerRow, type TileSize } from "../../features/tiles/layout"
import { resetLayoutStore, useLayoutStore } from "../../features/tiles/layoutStore"
import { useSelectionStore } from "../../features/tiles/selectionStore"
import { startSidecarMonitoring, useSidecarStore } from "../../features/system/sidecarStore"
import { installFakeBridge, makeItems } from "../../test/fakeBridge"
import { mockViewport } from "../../test/viewport"
import { TileView } from "./TileView"

describe("tile layout rules (docs/viewer/stages/03-tile-view.md)", () => {
  it.each<[TileSize, number, number]>([
    ["medium", 1000, 5],
    ["medium", 1600, 8],
    ["medium", 2400, 12],
    ["small", 1000, 7],
    ["large", 1000, 3],
    ["large", 200, 1], // never zero
  ])("%s tiles at %i px → %i per row", (size, width, perRow) => {
    expect(tilesPerRow(width, size)).toBe(perRow)
  })

  it("wider windows fit more tiles, never bigger ones", () => {
    let previous = 0
    for (let w = 400; w <= 3840; w += 40) {
      const n = tilesPerRow(w, "medium")
      expect(n).toBeGreaterThanOrEqual(previous)
      previous = n
    }
  })

  it("row height is fixed per size", () => {
    expect(rowHeight("small")).toBe(120 + 22 + 8)
    expect(rowHeight("medium")).toBe(180 + 24 + 12)
    expect(rowHeight("large")).toBe(260 + 24 + 16)
  })

  it.each<[TileSize, number, string]>([
    ["small", 1, "grid-sm"],
    ["small", 2, "grid-md"],
    ["medium", 1, "grid-sm"],
    ["medium", 2, "grid-md"],
    ["large", 1, "grid-md"],
    ["large", 2, "grid-lg"],
    ["large", 3, "grid-lg"],
  ])("%s at %ix density uses %s", (size, dpr, profile) => {
    expect(profileFor(size, dpr)).toBe(profile)
  })
})

let stop: (() => void)[] = []

async function openWith(items = makeItems(100_000, 3)) {
  const bridge = installFakeBridge()
  bridge.backend.items = items
  stop = [startSidecarMonitoring(), startFolderMonitoring(), startThumbMonitoring()]
  render(<TileView />)
  await act(() => openFolder("/photos"))
  return bridge
}

const tiles = () => screen.queryAllByTestId("tile")
const view = () => screen.getByTestId("tile-view")

beforeEach(() => {
  localStorage.clear()
  resetLayoutStore()
  resetFolderStore()
  resetThumbs()
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
})
afterEach(() => {
  stop.forEach((f) => f())
  vi.restoreAllMocks()
})

describe("TileView", () => {
  it("mounts only the rows in view for a 100,000-item folder", async () => {
    mockViewport(1000, 800)
    const bridge = await openWith()
    expect(view()).toHaveAttribute("data-per-row", "5")
    const n = tiles().length
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThanOrEqual(5 * 8) // 4 visible rows + overscan, never the folder
    // Pages covering the view (plus one ahead), not the whole folder.
    const offsets = bridge.api.query.page.mock.calls.map((c) => (c[0] as { offset: number }).offset)
    expect(new Set(offsets)).toEqual(new Set([0, 256]))
    expect(await screen.findByText("folder 1")).toBeInTheDocument()
  })

  it("fits more tiles per row on a wider window and keeps tile size fixed", async () => {
    mockViewport(2400, 800)
    await openWith(makeItems(500))
    expect(view()).toHaveAttribute("data-per-row", "12")
    const box = tiles()[0]!.querySelector<HTMLElement>("[data-thumb-box]")!
    expect(box.style.width).toBe("180px")
    act(() => useLayoutStore.getState().setTileSize("small"))
    expect(view()).toHaveAttribute("data-per-row", "18")
    expect(tiles()[0]!.querySelector<HTMLElement>("[data-thumb-box]")!.style.width).toBe("120px")
    expect(useLayoutStore.getState().tileSize).toBe("small")
  })

  it("requests thumbnails once for the settled range, visible tiles first", async () => {
    mockViewport(1000, 800)
    const bridge = await openWith(makeItems(2000))
    await waitFor(() => expect(bridge.api.preview.ensure).toHaveBeenCalledTimes(1))
    const req = bridge.api.preview.ensure.mock.calls[0]![0] as {
      lane: string
      profile: string
      items: { id: number; priority: number }[]
    }
    expect(req.lane).toBe("tiles")
    expect(req.profile).toBe("grid-sm")
    expect(req.items[0]).toEqual({ id: 1, priority: 0 })
    expect(req.items.length).toBeLessThanOrEqual(500)
    const priorities = new Set(req.items.map((i) => i.priority))
    expect(priorities.has(0)).toBe(true)
  })

  it("never requests folders as thumbnails and shows folder tiles", async () => {
    mockViewport(1000, 800)
    const bridge = await openWith(makeItems(20, 5))
    await waitFor(() => expect(bridge.api.preview.ensure).toHaveBeenCalled())
    const ids = (
      bridge.api.preview.ensure.mock.calls[0]![0] as { items: { id: number }[] }
    ).items.map((i) => i.id)
    expect(ids.some((id) => id <= 5)).toBe(false)
    expect(tiles()[0]).toHaveAttribute("data-kind", "dir")
  })

  it("moves by tile with ←/→ and by row with ↑/↓", async () => {
    mockViewport(1000, 800)
    await openWith(makeItems(100))
    view().focus()
    const key = (k: string) => fireEvent.keyDown(view(), { key: k })
    key("ArrowRight")
    expect(useSelectionStore.getState()).toMatchObject({ focusIndex: 1, selectedId: 2 })
    key("ArrowDown")
    expect(useSelectionStore.getState().focusIndex).toBe(6) // 5 per row
    key("ArrowLeft")
    key("ArrowUp")
    expect(useSelectionStore.getState().focusIndex).toBe(0)
    key("ArrowUp") // clamped
    expect(useSelectionStore.getState().focusIndex).toBe(0)
    key("End")
    expect(useSelectionStore.getState().focusIndex).toBe(99)
    expect(view()).toHaveAttribute("aria-activedescendant", "tile-99")
  })

  it("Ctrl+Shift+arrows add a range without dropping Ctrl+click picks", async () => {
    const user = userEvent.setup()
    mockViewport(1000, 800)
    await openWith(makeItems(100))
    const picked = (i: number) => screen.getByText(`IMG_${i}.jpg`)
    await user.pointer({ keys: "[MouseLeft]", target: await screen.findByText("IMG_1.jpg") })
    await user.keyboard("{Control>}")
    await user.pointer({ keys: "[MouseLeft]", target: picked(4) })
    await user.pointer({ keys: "[MouseLeft]", target: picked(8) })
    await user.keyboard("{/Control}")
    view().focus()
    fireEvent.keyDown(view(), { key: "ArrowRight", ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(view(), { key: "ArrowRight", ctrlKey: true, shiftKey: true })
    const selected = tiles()
      .filter((t) => t.getAttribute("aria-selected") === "true")
      .map((t) => Number(t.getAttribute("data-index")))
    expect(selected).toEqual([1, 4, 8, 9, 10])
    // Plain Shift+arrow keeps the Ctrl picks too.
    fireEvent.keyDown(view(), { key: "ArrowRight", shiftKey: true })
    const after = tiles()
      .filter((t) => t.getAttribute("aria-selected") === "true")
      .map((t) => Number(t.getAttribute("data-index")))
    expect(after).toEqual([1, 4, 8, 9, 10, 11])
  })

  it("Shift+click after Ctrl+click picks adds a range and keeps the picks", async () => {
    const user = userEvent.setup()
    mockViewport(1000, 800)
    await openWith(makeItems(100))
    const selected = () =>
      tiles()
        .filter((t) => t.getAttribute("aria-selected") === "true")
        .map((t) => Number(t.getAttribute("data-index")))
    await user.click(await screen.findByText("IMG_2.jpg"))
    await user.keyboard("{Control>}")
    await user.click(screen.getByText("IMG_6.jpg"))
    await user.click(screen.getByText("IMG_11.jpg"))
    await user.keyboard("{/Control}{Shift>}")
    await user.click(screen.getByText("IMG_14.jpg"))
    expect(selected()).toEqual([2, 6, 11, 12, 13, 14])
    await user.click(screen.getByText("IMG_12.jpg")) // move the Shift end back
    await user.keyboard("{/Shift}")
    expect(selected()).toEqual([2, 6, 11, 12])
  })

  it("Ctrl+Shift+click adds a range to Ctrl+click picks", async () => {
    const user = userEvent.setup()
    mockViewport(1000, 800)
    await openWith(makeItems(100))
    await user.pointer({ keys: "[MouseLeft]", target: await screen.findByText("IMG_2.jpg") })
    await user.keyboard("{Control>}")
    await user.pointer({ keys: "[MouseLeft]", target: screen.getByText("IMG_6.jpg") })
    await user.keyboard("{Shift>}")
    await user.pointer({ keys: "[MouseLeft]", target: screen.getByText("IMG_9.jpg") })
    await user.keyboard("{/Shift}{/Control}")
    const selected = tiles()
      .filter((t) => t.getAttribute("aria-selected") === "true")
      .map((t) => Number(t.getAttribute("data-index")))
    expect(selected).toEqual([2, 6, 7, 8, 9])
  })

  it("opens a folder tile with Enter or double-click", async () => {
    mockViewport(1000, 800)
    const bridge = await openWith(makeItems(10, 2))
    view().focus()
    await act(async () => fireEvent.keyDown(view(), { key: "Enter" }))
    expect(bridge.api.dir.openEntry).toHaveBeenCalledWith({ entryId: 1, recursive: false })
    const second = await screen.findByText("folder 2")
    await act(async () => fireEvent.doubleClick(second))
    await waitFor(() => expect(bridge.api.dir.openEntry).toHaveBeenCalledTimes(2))
  })

  it("a plain click inside a multi-selection keeps it on press, then selects only that tile", async () => {
    const user = userEvent.setup()
    mockViewport(1000, 800)
    await openWith(makeItems(30))
    await user.click(await screen.findByText("IMG_2.jpg"))
    await user.keyboard("{Shift>}")
    await user.click(screen.getByText("IMG_6.jpg"))
    await user.keyboard("{/Shift}")
    const selected = () =>
      tiles()
        .filter((t) => t.getAttribute("aria-selected") === "true")
        .map((t) => Number(t.getAttribute("data-index")))
    expect(selected()).toEqual([2, 3, 4, 5, 6])
    await user.pointer({ keys: "[MouseLeft>]", target: screen.getByText("IMG_4.jpg") })
    expect(selected()).toEqual([2, 3, 4, 5, 6]) // still draggable as a group
    await user.pointer({ keys: "[/MouseLeft]", target: screen.getByText("IMG_4.jpg") })
    expect(selected()).toEqual([4])
  })

  it("selects with a click and marks exactly one tile selected", async () => {
    mockViewport(1000, 800)
    await openWith(makeItems(30))
    const target = await screen.findByText("IMG_3.jpg")
    await userEvent.pointer({ keys: "[MouseLeft]", target })
    const selected = tiles().filter((t) => t.getAttribute("aria-selected") === "true")
    expect(selected).toHaveLength(1)
    expect(selected[0]).toHaveAttribute("data-index", "3")
  })

  it("steps the tile size with Ctrl + wheel", async () => {
    mockViewport(1000, 800)
    await openWith(makeItems(30))
    act(() => {
      view().dispatchEvent(
        new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true }),
      )
    })
    expect(useLayoutStore.getState().tileSize).toBe("large")
    act(() => {
      view().dispatchEvent(
        new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, cancelable: true }),
      )
      view().dispatchEvent(
        new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, cancelable: true }),
      )
    })
    expect(useLayoutStore.getState().tileSize).toBe("small")
  })

  it("refetches only the pages in view when the session is invalidated", async () => {
    mockViewport(1000, 800)
    const bridge = await openWith(makeItems(5000))
    await waitFor(() => expect(bridge.api.query.page).toHaveBeenCalledTimes(2))
    bridge.backend.version = 2
    await act(async () => bridge.push("query.invalidated", { queryId: 1, version: 2, total: 5000 }))
    await waitFor(() => expect(bridge.api.query.page).toHaveBeenCalledTimes(4))
    const offsets = bridge.api.query.page.mock.calls
      .slice(2)
      .map((c) => (c[0] as { offset: number }).offset)
    expect(new Set(offsets)).toEqual(new Set([0, 256]))
  })
})
