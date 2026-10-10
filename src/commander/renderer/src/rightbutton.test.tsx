import { DEFAULT_SWITCH_SETTINGS, type Crumb } from "@panelyth/contracts"
import { markCount, useSwitchSettings } from "@panelyth/renderer-core"
import { useInterfaceSizeStore } from "@panelyth/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { RIGHT_HOLD_MS } from "./components/useRightButton"
import { resetCarry, startPanels } from "./features/carry"
import { useUiStore } from "./features/commands"
import { resetFiles, useFilesStore } from "./features/files"
import { resetKeymap } from "./features/keymap"
import { resetListing } from "./features/listing"
import { resetMarks, startMarks, useMarksStore } from "./features/marks"
import { usePanelsStore } from "./features/panels"
import { closeQuickSearch } from "./features/quicksearch"
import { resetSettings, useSettingsStore, DEFAULT_SETTINGS } from "./features/settings"
import { folder, installFakeCommander } from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// The right mouse button (CFR-06): marking, and the context menu on hold.

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const HOME: Crumb = { name: "home", path: "C:\\home" }

let stops: (() => void)[] = []

async function start() {
  const fake = installFakeCommander({
    // home: dir000000, dir000001, file000000..3.txt
    folders: [folder(10, HOME.path, [ROOT, HOME], 2, 4), folder(1, ROOT.path, [ROOT], 0, 2)],
    home: HOME.path,
  })
  render(<AppShell />)
  stops.push(startMarks())
  await act(async () => {
    stops.push(await startPanels())
  })
  await waitFor(() => expect(rows().length).toBeGreaterThan(2))
  return fake
}

const grid = () => screen.getByTestId("grid-left")
const rows = () => grid().querySelectorAll("[data-row]")
const row = (name: string) =>
  [...grid().querySelectorAll<HTMLElement>("[data-row]")].find((r) =>
    r.textContent?.includes(name),
  )!
const cursorRow = () => grid().querySelector<HTMLElement>("[data-cursor=true]")
const markedNames = () =>
  [...grid().querySelectorAll<HTMLElement>("[data-marked=true]")].map(
    (r) => r.querySelector("[role=gridcell]")?.textContent ?? "",
  )
const count = () => markCount(useMarksStore.getState().left)
const RIGHT = { button: 2 }
const down = (name: string) => act(async () => fireEvent.mouseDown(row(name), RIGHT))
const over = (name: string) => act(async () => fireEvent.mouseMove(row(name), RIGHT))
// The release, and the contextmenu event that follows it on Windows.
const up = (name: string) =>
  act(async () => {
    fireEvent.mouseUp(row(name), RIGHT)
    fireEvent.contextMenu(row(name), RIGHT)
  })
const hold = () => act(async () => new Promise((done) => setTimeout(done, RIGHT_HOLD_MS + 50)))
const menu = () => screen.queryByTestId("row-menu-left")

beforeEach(() => {
  mockViewport(800, 600)
  resetListing()
  resetCarry()
  resetMarks()
  resetKeymap()
  resetSettings()
  resetFiles()
  resetBridgeCache()
  closeQuickSearch()
  useUiStore.setState({ mask: null, rowMenu: null, hold: null })
  useSwitchSettings.setState(DEFAULT_SWITCH_SETTINGS)
  usePanelsStore.setState({ active: "left", split: 50, layoutToken: 0 })
  useInterfaceSizeStore.setState({ size: "medium" })
})
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
  delete window.panelyth
  vi.restoreAllMocks()
})

describe("the right mouse button", () => {
  it("a right-click moves the cursor and flips the mark, without a menu", async () => {
    await start()
    await down("file000001")
    await up("file000001")
    expect(cursorRow()).toHaveTextContent("file000001")
    expect(markedNames()).toEqual(["file000001"])
    expect(menu()).toBeNull()
    await down("file000001")
    await up("file000001")
    expect(count()).toBe(0)
    // ".." is never marked.
    await down("..")
    await up("..")
    expect(count()).toBe(0)
    expect(cursorRow()).toHaveTextContent("..")
  })

  it("dragging marks the rows passed over, or unmarks them from a marked row", async () => {
    await start()
    await down("dir000001")
    await over("file000001")
    expect(screen.queryByTestId("hold-ring-left")).toBeNull() // a drag is not a hold
    expect(markedNames()).toEqual(["dir000001", "file000000", "file000001"])
    // Moving back shrinks the stroke; the hold timer no longer opens the menu.
    await over("file000000")
    await hold()
    await up("file000000")
    expect(markedNames()).toEqual(["dir000001", "file000000"])
    expect(menu()).toBeNull()
    expect(cursorRow()).toHaveTextContent("file000000")
    await down("file000000")
    await over("dir000001")
    await up("dir000001")
    expect(count()).toBe(0)
  })

  it("holding opens the menu for the entry and leaves the marks alone", async () => {
    await start()
    await down("file000002")
    expect(screen.getByTestId("hold-ring-left")).toBeInTheDocument()
    await hold()
    expect(screen.queryByTestId("hold-ring-left")).toBeNull()
    expect(count()).toBe(0)
    const open = menu()!
    expect(open).toHaveTextContent("file000002.txt")
    expect(within(open).getByText("Copy to the other panel…")).toBeInTheDocument()
    expect(within(open).getByText("F5")).toBeInTheDocument()
    await up("file000002")
    expect(count()).toBe(0)
    expect(menu()).not.toBeNull()
    await act(async () => fireEvent.click(within(open).getByText("New folder")))
    expect(menu()).toBeNull()
    expect(useFilesStore.getState().mkdir).not.toBeNull()
  })

  it("the menu names the marks when there are any, and Esc closes it", async () => {
    await start()
    await down("file000000")
    await up("file000000")
    await down("file000001")
    await up("file000001")
    await down("file000003")
    await hold()
    expect(menu()).toHaveTextContent("2 marked")
    await act(async () => fireEvent.keyDown(menu()!, { key: "Escape" }))
    expect(menu()).toBeNull()
    expect(count()).toBe(2)
    // Modal: the backdrop covers the window, and a press on it only closes the menu.
    await down("file000003")
    await hold()
    const backdrop = screen.getByTestId("row-menu-backdrop")
    expect(backdrop).toContainElement(menu())
    expect(backdrop.parentElement).toBe(document.body)
    // The wheel does nothing behind the menu, in the list or on the backdrop.
    expect(fireEvent.wheel(row("file000001"), { deltaY: 100 })).toBe(false)
    expect(fireEvent.wheel(backdrop, { deltaY: 100 })).toBe(false)
    expect(fireEvent.wheel(menu()!, { deltaY: 100 })).toBe(true)
    await act(async () => fireEvent.mouseDown(backdrop))
    expect(menu()).toBeNull()
    expect(screen.queryByTestId("row-menu-backdrop")).toBeNull()
    expect(fireEvent.wheel(row("file000001"), { deltaY: 100 })).toBe(true)
    expect(cursorRow()).toHaveTextContent("file000003")
  })

  it("the empty area and the Menu key open a menu in both modes", async () => {
    await start()
    const header = grid().querySelector("[role=columnheader]")!
    await act(async () => fireEvent.contextMenu(header, RIGHT))
    expect(menu()).toBeNull() // the header has its own menu
    expect(screen.getByTestId("column-menu-left")).toBeInTheDocument()
    const body = grid().firstElementChild!
    await act(async () => fireEvent.mouseDown(body, RIGHT))
    await act(async () => fireEvent.contextMenu(body, RIGHT))
    expect(menu()).toHaveTextContent("New text file")
    expect(menu()).not.toHaveTextContent("Rename")
    expect(screen.queryByTestId("column-menu-left")).toBeNull()
    await act(async () => fireEvent.keyDown(menu()!, { key: "Escape" }))
    await act(async () => fireEvent.keyDown(grid(), { key: "ArrowDown" }))
    await act(async () => fireEvent.contextMenu(body)) // the Menu key: no button
    expect(menu()).toHaveTextContent("dir000000")
  })

  it('"Opens the menu" in Settings: a right-click opens the menu at once', async () => {
    await start()
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, rightButton: "menu" } })
    await down("file000001")
    await up("file000001")
    expect(count()).toBe(0)
    expect(cursorRow()).toHaveTextContent("file000001")
    expect(menu()).toHaveTextContent("file000001.txt")
  })
})
