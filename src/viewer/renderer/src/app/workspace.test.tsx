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
import { usePrograms } from "@panelyth/renderer-core"
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

  it("shows a loader on the clicked place while its folder is slow to open", async () => {
    const bridge = await setup()
    // A drive that has to wake up: dir.open answers late.
    const open = bridge.api.dir.open.getMockImplementation()!
    let answer: () => void = () => undefined
    bridge.api.dir.open.mockImplementationOnce(
      (params: { path: string; recursive: boolean }) =>
        new Promise((resolve) => {
          answer = () => resolve(open(params))
        }),
    )
    const place = () => sidebar().getByRole("treeitem", { name: "Pictures" })
    await sidebar().findByRole("treeitem", { name: "Pictures" })
    expect(place().querySelector("[data-glyph=folder]")).not.toBeNull()
    await userEvent.click(place())
    expect(place()).toHaveAttribute("aria-busy", "true")
    expect(place().querySelector("[data-spinner]")).not.toBeNull()
    expect(place().querySelector("[data-glyph=folder]")).toBeNull()
    // Only the clicked row shows it.
    expect(screen.getByTestId("sidebar-list").querySelectorAll("[data-spinner]")).toHaveLength(1)
    await act(async () => answer())
    await waitFor(() => expect(place().querySelector("[data-spinner]")).toBeNull())
    expect(place().querySelector("[data-glyph=folder]")).not.toBeNull()
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

  it("a click on a tree folder opens it and shows its subfolders", async () => {
    const bridge = await setup()
    const root = await sidebar().findByRole("treeitem", { name: "/" })
    await userEvent.click(within(root).getByRole("button", { name: "Expand /" }))
    await userEvent.click(await treeNode("photos"))
    await waitFor(() =>
      expect(bridge.api.dir.open).toHaveBeenCalledWith({ path: "/photos", recursive: false }),
    )
    await waitFor(async () =>
      expect(await treeNode("photos")).toHaveAttribute("aria-expanded", "true"),
    )
    expect(await treeNode("Trip")).toBeInTheDocument()
    // A second click keeps it open; only the arrow collapses.
    await userEvent.click(await treeNode("photos"))
    expect(await treeNode("photos")).toHaveAttribute("aria-expanded", "true")
  })

  it("reveals the open folder: ancestors expand and the folder is marked", async () => {
    const bridge = await setup()
    await act(() => openFolder("/photos/Trip"))
    await waitFor(async () =>
      expect(await treeNode("Trip")).toHaveAttribute("aria-selected", "true"),
    )
    expect(bridge.api.fs.listDirs.mock.calls.map((c) => c[0])).toEqual(["/", "/photos"])
  })

  it("centers a revealed folder that is out of sight, and leaves one in sight alone", async () => {
    const bridge = await setup()
    const scrolls: { el: Element; top: number }[] = []
    // jsdom does not scroll: scrollTo moves scrollTop and reports it, as a browser does.
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: function (this: HTMLElement, options: ScrollToOptions) {
        const top = options.top ?? 0
        scrolls.push({ el: this, top })
        Object.defineProperty(this, "scrollTop", { configurable: true, value: top })
        this.dispatchEvent(new Event("scroll"))
      },
    })
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(900)
    // TanStack never scrolls past scrollHeight − clientHeight; jsdom's scrollHeight is 0.
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(100_000)
    const list = screen.getByTestId("sidebar-list")
    const listScrolls = () => scrolls.filter((s) => s.el === list).map((s) => s.top)
    const rowStart = async (name: string) =>
      Number(
        /translateY\(([\d.]+)px\)/.exec(
          (await treeNode(name)).closest<HTMLElement>("[role=presentation]")!.style.transform,
        )![1],
      )
    try {
      // Near the top of the list: in sight, so the list does not move.
      await act(() => openFolder("/photos"))
      await waitFor(async () =>
        expect(await treeNode("photos")).toHaveAttribute("aria-selected", "true"),
      )
      expect(listScrolls()).toEqual([])

      // Below sixty siblings, as when the commander hands a folder over: to the middle.
      const many = Array.from({ length: 60 }, (_, i) => `a${String(i).padStart(2, "0")}`)
      bridge.backend.dirs.set("/", [...many, "photos"])
      bridge.backend.dirs.set("/photos", ["Trip", "Family"])
      resetTree()
      await act(() => openFolder("/photos/Trip"))
      await waitFor(() => expect(listScrolls().length).toBeGreaterThan(0))
      await waitFor(async () =>
        expect(await treeNode("Trip")).toHaveAttribute("aria-selected", "true"),
      )
      const start = await rowStart("Trip")
      // Row middle (rows are 26 px at the medium size) at the middle of the 900 px list,
      // give or take the 32 px path header that sticks over its top.
      const middle = listScrolls().at(-1)! + 450
      expect(Math.abs(middle - (start + 13))).toBeLessThanOrEqual(32)
    } finally {
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
    }
  })

  it("adds a bookmark from the tree's context menu", async () => {
    const bridge = await setup()
    await act(() => openFolder("/photos/Trip"))
    fireEvent.contextMenu(await treeNode("Trip"))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Add bookmark" }))
    expect(bridge.api.library.addBookmark).toHaveBeenCalledWith("/photos/Trip", "")
    expect(await screen.findByText("Bookmarks")).toBeInTheDocument()
  })

  it("opens a tree folder with a folder program, by its path (ADR-0044)", async () => {
    usePrograms.setState({
      programs: [
        { id: "gimp", name: "GIMP", path: "/usr/bin/gimp", target: "files" },
        { id: "tc", name: "Total Commander", path: "/usr/bin/tc", target: "both" },
      ],
    })
    const bridge = await setup()
    await act(() => openFolder("/photos/Trip"))
    fireEvent.contextMenu(await treeNode("Trip"))
    expect(await screen.findByRole("menuitem", { name: "Open with Total Commander" })).toBeVisible()
    expect(screen.queryByRole("menuitem", { name: "Open with GIMP" })).toBeNull()
    await userEvent.click(screen.getByRole("menuitem", { name: "Open with Total Commander" }))
    expect(bridge.api.programs.openFolder).toHaveBeenCalledWith("tc", "/photos/Trip")
    usePrograms.setState({ programs: [] })
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

  it("offers the Open with programs for the tile's kind and starts them through main (ADR-0044)", async () => {
    usePrograms.setState({
      programs: [
        { id: "gimp", name: "GIMP", path: "/usr/bin/gimp", target: "files" },
        { id: "files", name: "Nautilus", path: "/usr/bin/nautilus", target: "folders" },
        { id: "code", name: "Code", path: "/usr/bin/code", target: "both" },
      ],
    })
    const bridge = await openItems()
    fireEvent.mouseDown(tile(4), { button: 2 })
    fireEvent.contextMenu(tile(4))
    const menu = await screen.findByTestId("tile-menu")
    expect(
      within(menu)
        .getAllByTestId("menu-open-with-program")
        .map((e) => e.textContent),
    ).toEqual(["Open with GIMP", "Open with Code"])
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Open with GIMP" }))
    // The program and the entry by id; main reads the path of each.
    expect(bridge.api.programs.open).toHaveBeenCalledWith("gimp", 5)

    // A folder tile: the folder programs; a refusal shows in the status line.
    bridge.api.programs.open.mockResolvedValueOnce({
      ok: false,
      e: {
        code: "PERMISSION_DENIED",
        message: "x",
        retryable: false,
        details: { reason: "missing" },
      },
    } as never)
    fireEvent.mouseDown(tile(0), { button: 2 })
    fireEvent.contextMenu(tile(0))
    const folderMenu = await screen.findByTestId("tile-menu")
    expect(
      within(folderMenu)
        .getAllByTestId("menu-open-with-program")
        .map((e) => e.textContent),
    ).toEqual(["Open with Nautilus", "Open with Code"])
    await userEvent.click(within(folderMenu).getByRole("menuitem", { name: "Open with Nautilus" }))
    expect(bridge.api.programs.open).toHaveBeenLastCalledWith("files", 1)
    expect(
      await screen.findByText("Nautilus was not found. Add it again in Settings → Open with."),
    ).toBeInTheDocument()
    usePrograms.setState({ programs: [] })
  })

  it("empty space offers the folder programs for the folder that is open (ADR-0044)", async () => {
    usePrograms.setState({
      programs: [
        { id: "gimp", name: "GIMP", path: "/usr/bin/gimp", target: "files" },
        { id: "tc", name: "Total Commander", path: "/usr/bin/tc", target: "folders" },
      ],
    })
    const bridge = await openItems()
    fireEvent.contextMenu(screen.getByTestId("tile-view"))
    const menu = await screen.findByTestId("tile-menu")
    expect(
      within(menu)
        .getAllByTestId("menu-open-with-program")
        .map((e) => e.textContent),
    ).toEqual(["Open with Total Commander"])
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Open with Total Commander" }))
    const dirId = useFolderStore.getState().folder!.dirId
    expect(bridge.api.programs.open).toHaveBeenCalledWith("tc", dirId)
    usePrograms.setState({ programs: [] })
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
