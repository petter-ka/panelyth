import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  openFolder,
  resetFolderStore,
  startFolderMonitoring,
  useFolderStore,
} from "../features/folder/folderStore"
import { resetLibraryStore, startLibraryMonitoring } from "../features/library/libraryStore"
import { closeProperties } from "../features/properties/propertiesStore"
import { resetThumbs, startThumbMonitoring } from "../features/previews/thumbStore"
import { startSidecarMonitoring, useSidecarStore } from "../features/system/sidecarStore"
import { resetLayoutStore } from "../features/tiles/layoutStore"
import { resetTree, startTreeMonitoring } from "../features/tree/treeStore"
import { installFakeBridge, makeItems } from "../test/fakeBridge"
import { mockViewport } from "../test/viewport"
import { AppShell } from "./AppShell"

let stop: (() => void)[] = []

async function setup(items = makeItems(40, 2)) {
  const bridge = installFakeBridge()
  bridge.backend.items = items
  stop = [
    startSidecarMonitoring(),
    startFolderMonitoring(),
    startThumbMonitoring(),
    startLibraryMonitoring(),
    startTreeMonitoring(),
  ]
  render(<AppShell />)
  await screen.findByText("No folder open")
  return bridge
}

const sidebar = () => within(screen.getByTestId("sidebar-list"))
/** A folder tree node (Recent and Bookmarks rows can share its name). */
const treeNode = async (name: string) =>
  (await sidebar().findAllByRole("treeitem", { name })).find(
    (e) => e.dataset.testid === "tree-node",
  )!
/**
 * Opens a dropdown from the keyboard. With mockViewport every element has the
 * same rectangle, so react-resizable-panels believes each pointerdown is on a
 * divider and prevents it, which also stops Radix triggers (jsdom only).
 */
const openMenu = (trigger: HTMLElement) => fireEvent.keyDown(trigger, { key: "Enter" })
const lastQuery = (bridge: ReturnType<typeof installFakeBridge>) =>
  bridge.api.query.open.mock.lastCall![0]

beforeEach(() => {
  mockViewport(1400, 900)
  resetFolderStore()
  resetLibraryStore()
  resetTree()
  resetThumbs()
  resetLayoutStore()
  closeProperties()
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
})
afterEach(() => {
  stop.forEach((f) => f())
  vi.restoreAllMocks()
})

describe("sidebar", () => {
  it("lists places and volumes, and opens a place", async () => {
    const bridge = await setup()
    await userEvent.click(await sidebar().findByRole("treeitem", { name: "Pictures" }))
    await waitFor(() =>
      expect(bridge.api.dir.open).toHaveBeenCalledWith({ path: "/photos", recursive: false }),
    )
    expect(sidebar().getByRole("treeitem", { name: "/" })).toBeInTheDocument()
  })

  it("lists tree children lazily, one level per expand", async () => {
    const bridge = await setup()
    const root = await sidebar().findByRole("treeitem", { name: "/" })
    expect(bridge.api.fs.listDirs).not.toHaveBeenCalled()
    await userEvent.click(within(root).getByRole("button", { name: "Expand /" }))
    expect(await sidebar().findByRole("treeitem", { name: "photos" })).toBeInTheDocument()
    expect(bridge.api.fs.listDirs.mock.calls.map((c) => c[0])).toEqual(["/"])
    // "videos" has no subfolders (probe): no expander.
    const videos = sidebar().getByRole("treeitem", { name: "videos" })
    expect(within(videos).getByRole("button", { name: "Expand videos" })).toHaveClass("invisible")
  })

  it("reveals the open folder: ancestors expand and the folder is marked", async () => {
    const bridge = await setup()
    await act(() => openFolder("/photos/Trip"))
    await waitFor(async () =>
      expect(await treeNode("Trip")).toHaveAttribute("aria-selected", "true"),
    )
    expect(bridge.api.fs.listDirs.mock.calls.map((c) => c[0])).toEqual(["/", "/photos"])
  })

  it("adds a bookmark from the tree's context menu", async () => {
    const bridge = await setup()
    await act(() => openFolder("/photos/Trip"))
    fireEvent.contextMenu(await treeNode("Trip"))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Add bookmark" }))
    expect(bridge.api.library.addBookmark).toHaveBeenCalledWith("/photos/Trip", "")
    expect(await screen.findByText("Bookmarks")).toBeInTheDocument()
  })

  it("moves with the keyboard: Down, Right expands, Enter opens", async () => {
    const bridge = await setup()
    const tree = screen.getByTestId("sidebar-list")
    await sidebar().findByRole("treeitem", { name: "/" })
    act(() => tree.focus())
    // Quick access "Pictures" is first; "/" follows.
    fireEvent.keyDown(tree, { key: "ArrowDown" })
    fireEvent.keyDown(tree, { key: "ArrowRight" })
    expect(await sidebar().findByRole("treeitem", { name: "photos" })).toBeInTheDocument()
    fireEvent.keyDown(tree, { key: "ArrowDown" })
    fireEvent.keyDown(tree, { key: "Enter" })
    await waitFor(() =>
      expect(bridge.api.dir.open).toHaveBeenLastCalledWith({ path: "/photos", recursive: false }),
    )
  })
})

describe("navigation", () => {
  it("breadcrumb, back, forward and up", async () => {
    const bridge = await setup()
    await act(() => openFolder("/photos/Trip"))
    const crumbs = within(screen.getByTestId("breadcrumb"))
    expect(crumbs.getByRole("button", { name: "Trip" })).toHaveAttribute("aria-current", "page")
    await userEvent.click(crumbs.getByRole("button", { name: "photos" }))
    await waitFor(() => expect(useFolderStore.getState().folder?.path).toBe("/photos"))

    await userEvent.click(screen.getByRole("button", { name: "Back" }))
    await waitFor(() => expect(useFolderStore.getState().folder?.path).toBe("/photos/Trip"))
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true })
    await waitFor(() => expect(useFolderStore.getState().folder?.path).toBe("/photos"))
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled()

    fireEvent.keyDown(window, { key: "ArrowUp", altKey: true })
    await waitFor(() => expect(useFolderStore.getState().folder?.path).toBe("/"))
    expect(screen.getByRole("button", { name: "Up" })).toBeDisabled()
    expect(bridge.api.dir.open).toHaveBeenCalledTimes(5)
  })

  it("F5 re-lists the folder and keeps the session", async () => {
    const bridge = await setup()
    await act(() => openFolder("/photos"))
    const queryId = useFolderStore.getState().query?.queryId
    fireEvent.keyDown(window, { key: "F5" })
    await waitFor(() => expect(bridge.api.dir.open).toHaveBeenCalledTimes(2))
    expect(useFolderStore.getState().query?.queryId).toBe(queryId)
    expect(bridge.api.query.open).toHaveBeenCalledTimes(1)
  })
})

describe("search and filters", () => {
  it("debounces search, shows the result count, and Esc clears it", async () => {
    const bridge = await setup()
    await act(() => openFolder("/photos"))
    fireEvent.keyDown(window, { key: "f", ctrlKey: true })
    const input = screen.getByRole("searchbox", { name: "Search file names" })
    expect(input).toHaveFocus()
    await userEvent.type(input, "img 1", { skipClick: true }) // focused by Ctrl+F
    await waitFor(() => expect(lastQuery(bridge)).toMatchObject({ search: "img 1" }))
    expect(bridge.api.query.open).toHaveBeenCalledTimes(2) // one per settled search, not per key
    expect(screen.getByTestId("folder-summary")).toHaveTextContent("results for “img 1”")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(lastQuery(bridge)).toMatchObject({ search: "" }))
    expect(input).toHaveValue("")
  })

  it("kind chips and the file-type menu filter through the index", async () => {
    const bridge = await setup()
    await act(() => openFolder("/photos"))
    const filters = within(screen.getByRole("group", { name: "Filters" }))
    expect(await filters.findByRole("button", { name: /Images\s*38/ })).toBeInTheDocument()
    await userEvent.click(filters.getByRole("button", { name: /Images/ }))
    await waitFor(() => expect(lastQuery(bridge)).toMatchObject({ kinds: ["image"], exts: [] }))
    openMenu(filters.getByRole("button", { name: /File types/ }))
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /JPG/ }))
    await waitFor(() =>
      expect(lastQuery(bridge)).toMatchObject({ kinds: ["image"], exts: ["jpg"] }),
    )
    await userEvent.keyboard("{Escape}")
    await userEvent.click(filters.getByRole("button", { name: "Clear" }))
    await waitFor(() =>
      expect(lastQuery(bridge)).toMatchObject({ kinds: [], exts: [], search: "" }),
    )
  })

  it("sorts by two keys", async () => {
    const bridge = await setup()
    await act(() => openFolder("/photos"))
    openMenu(screen.getByRole("button", { name: "Sort" }))
    await userEvent.click(
      within(await screen.findByRole("group", { name: "Then by" })).getByRole("menuitemradio", {
        name: "Date created",
      }),
    )
    await waitFor(() =>
      expect(lastQuery(bridge)).toMatchObject({
        sort: [
          { field: "name", direction: "asc" },
          { field: "created", direction: "asc" },
        ],
      }),
    )
  })
})

describe("multi-selection, context menu and properties", () => {
  const tile = (i: number) =>
    screen.getAllByTestId("tile").find((t) => t.dataset.index === String(i))!

  async function openItems() {
    const bridge = await setup()
    await act(() => openFolder("/photos"))
    await screen.findByText("IMG_3.jpg")
    return bridge
  }

  it("shift and ctrl click select several tiles; the status bar counts them", async () => {
    const bridge = await openItems()
    fireEvent.mouseDown(tile(2), { button: 0 })
    fireEvent.mouseDown(tile(5), { button: 0, shiftKey: true })
    fireEvent.mouseDown(tile(8), { button: 0, ctrlKey: true })
    expect(screen.getAllByRole("gridcell", { selected: true })).toHaveLength(5)
    expect(await screen.findByTestId("selection-summary")).toHaveTextContent("5 selected")
    await waitFor(() => expect(screen.getByTestId("selection-summary")).toHaveTextContent("1.2 KB"))
    expect(bridge.api.selection.info).toHaveBeenLastCalledWith(
      expect.objectContaining({ ranges: [[2, 6]], include: [9], exclude: [] }),
    )
  })

  it("Ctrl+A selects everything as one range; Esc clears", async () => {
    await openItems()
    const grid = screen.getByTestId("tile-view")
    fireEvent.keyDown(grid, { key: "a", ctrlKey: true })
    expect(await screen.findByTestId("selection-summary")).toHaveTextContent("40 selected")
    fireEvent.keyDown(grid, { key: "Escape" })
    expect(screen.queryByTestId("selection-summary")).not.toBeInTheDocument()
  })

  it("copies the selection's paths through main without sending ids", async () => {
    const bridge = await openItems()
    fireEvent.keyDown(screen.getByTestId("tile-view"), { key: "a", ctrlKey: true })
    fireEvent.contextMenu(tile(3))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Copy paths" }))
    expect(bridge.api.clipboard.copyPaths).toHaveBeenCalledWith({
      queryId: 1,
      version: 1,
      ranges: [[0, 40]],
      include: [],
      exclude: [],
    })
  })

  it("right-click on an unselected tile selects it and offers single-item actions", async () => {
    const bridge = await openItems()
    fireEvent.mouseDown(tile(4), { button: 2 })
    fireEvent.contextMenu(tile(4))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Show in file manager" }))
    expect(bridge.api.shell.reveal).toHaveBeenCalledWith(5)
  })

  it("empty space offers view actions", async () => {
    await openItems()
    fireEvent.contextMenu(screen.getByTestId("tile-view"))
    const menu = await screen.findByTestId("tile-menu")
    expect(within(menu).getByRole("menuitem", { name: /Sort by/ })).toBeInTheDocument()
    expect(within(menu).getByRole("menuitem", { name: /Refresh/ })).toBeInTheDocument()
    expect(within(menu).queryByRole("menuitem", { name: /Delete/ })).not.toBeInTheDocument()
  })

  it("Alt+Enter shows properties for one entry or a selection", async () => {
    const bridge = await openItems()
    fireEvent.mouseDown(tile(3), { button: 0 })
    fireEvent.keyDown(screen.getByTestId("tile-view"), { key: "Enter", altKey: true })
    const dialog = await screen.findByRole("dialog", { name: "IMG_3.jpg" })
    expect(within(dialog).getByTestId("props-path")).toHaveTextContent("/photos/Trip/IMG_3.jpg")
    expect(within(dialog).getByText("4,000 × 3,000")).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    fireEvent.mouseDown(tile(6), { button: 0, shiftKey: true })
    fireEvent.keyDown(screen.getByTestId("tile-view"), { key: "Enter", altKey: true })
    const multi = await screen.findByRole("dialog", { name: "4 items selected" })
    expect(await within(multi).findByText(/1\.2 KB/)).toBeInTheDocument()
    expect(bridge.api.selection.info).toHaveBeenCalled()
  })
})
