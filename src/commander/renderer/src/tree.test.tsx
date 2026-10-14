import type { Crumb } from "@panelyth/contracts"
import { useInterfaceSizeStore } from "@panelyth/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { ROW_HEIGHT } from "./components/FullView"
import { TREE_OVERSCAN, TREE_SETTLE_MS } from "./components/TreePane"
import { resetCarry, startPanels } from "./features/carry"
import { resetDrives, startDrives } from "./features/drives"
import { resetFiles, useFilesStore } from "./features/files"
import { resetHotlist, startHotlist } from "./features/hotlist"
import { resetKeymap } from "./features/keymap"
import { openPath, resetListing, useListingStore } from "./features/listing"
import { resetMarks } from "./features/marks"
import {
  LAYOUT_KEY,
  loadLayout,
  readLayout,
  setTreeMode,
  TREE_WIDTH,
  usePanelsStore,
  type TreeMode,
} from "./features/panels"
import { PANELS_KEY } from "./features/session"
import { loadSettings, resetSettings, SETTINGS_KEY, useSettingsStore } from "./features/settings"
import { resetTabs, useTabsStore } from "./features/tabs"
import { keyOf, resetTree, startTree, trees, useTreeUiStore } from "./features/tree"
import { folder, installFakeCommander, type FakeOptions } from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// Stage C10.5: the folder tree beside the panels
// (docs/commander/stages/C10.5-tabs-tree-ftp-compare.md).

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const HOME: Crumb = { name: "home", path: "C:\\home" }
const PICS: Crumb = { name: "pics", path: "C:\\home\\pics" }
const TRIP: Crumb = { name: "trip", path: "C:\\home\\pics\\trip" }
const WORK: Crumb = { name: "work", path: "C:\\work" }
const DROOT: Crumb = { name: "D:\\", path: "D:\\" }

const folders = () => [
  folder(40, ROOT.path, [ROOT], 0, 1),
  folder(10, HOME.path, [ROOT, HOME], 0, 3),
  folder(11, PICS.path, [ROOT, HOME, PICS], 0, 4),
  folder(12, TRIP.path, [ROOT, HOME, PICS, TRIP], 0, 2),
  folder(30, WORK.path, [ROOT, WORK], 0, 2),
  folder(50, DROOT.path, [DROOT], 0, 2),
]

const VOLUMES = [
  { path: "C:\\", label: "System", kind: "fixed" as const },
  { path: "D:\\", label: "", kind: "fixed" as const },
]

type Side = "left" | "right"
type Tree = "one" | Side
let stops: (() => void)[] = []

async function start(mode: TreeMode = "one", options: Partial<FakeOptions> = {}) {
  const fake = installFakeCommander({
    folders: folders(),
    home: HOME.path,
    volumes: VOLUMES,
    settings: {
      [LAYOUT_KEY]: { v: 1, split: 50, tree: mode },
      [PANELS_KEY]: {
        v: 3,
        active: "left",
        left: { tabs: [{ path: HOME.path }] },
        right: { tabs: [{ path: WORK.path }] },
      },
      ...options.settings,
    },
    ...Object.fromEntries(Object.entries(options).filter(([k]) => k !== "settings")),
  })
  render(<AppShell />)
  await act(async () => {
    await loadLayout()
    await loadSettings()
    stops.push(startDrives(), startHotlist(), startTree())
    stops.push(await startPanels())
  })
  await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
  await waitFor(() => expect(path("right")).toHaveTextContent(WORK.path))
  return fake
}

const grid = (side: Side) => screen.getByTestId(`grid-${side}`)
const path = (side: Side) => screen.getByTestId(`path-${side}`)
const pane = (id: Tree) => screen.getByTestId(`tree-${id}`)
const treeEl = (id: Tree) => screen.getByTestId(`tree-rows-${id}`)
const nodes = (id: Tree) => [...pane(id).querySelectorAll<HTMLElement>("[role=treeitem]")]
const names = (id: Tree) => nodes(id).map((n) => `${n.getAttribute("aria-level")} ${n.ariaLabel}`)
const node = (id: Tree, name: string) => within(pane(id)).getByRole("treeitem", { name })
const current = (id: Tree) => pane(id).querySelector<HTMLElement>("[aria-current=location]")
const cursor = (id: Tree) => pane(id).querySelector<HTMLElement>("[aria-selected=true]")
const treeKey = (id: Tree, init: KeyboardEventInit & { key: string }) =>
  act(async () => {
    fireEvent.keyDown(treeEl(id), init)
  })
const panelKey = (side: Side, init: KeyboardEventInit & { key: string }) =>
  act(async () => {
    fireEvent.keyDown(grid(side), init)
  })
/** The tree has followed its panel to this folder. */
const followed = (id: Tree, name: string) =>
  waitFor(() => expect(current(id)).toHaveAttribute("aria-label", name))

beforeEach(() => {
  mockViewport(1000, 600)
  resetListing()
  resetCarry()
  resetBridgeCache()
  resetTabs()
  resetDrives()
  resetHotlist()
  resetSettings()
  resetKeymap()
  resetMarks()
  resetFiles()
  resetTree()
  usePanelsStore.setState({
    active: "left",
    split: 50,
    layoutToken: 0,
    tree: "off",
    treeWidth: TREE_WIDTH.initial,
  })
  useInterfaceSizeStore.setState({ size: "medium" })
})
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("the folder tree", () => {
  it("is off until asked for; Ctrl+Shift+F8 cycles one tree, a tree per panel, none", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fake = await start("off")
    expect(screen.queryByTestId("tree-one")).toBeNull()
    // Nothing is listed for a tree that is not shown.
    expect(fake.api.fs.listDirs).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.keyDown(window, { key: "F8", ctrlKey: true, shiftKey: true })
    })
    expect(pane("one")).toBeInTheDocument()
    await followed("one", "home")
    await act(async () => {
      fireEvent.keyDown(window, { key: "F8", ctrlKey: true, shiftKey: true })
    })
    expect(screen.queryByTestId("tree-one")).toBeNull()
    expect(pane("left")).toBeInTheDocument()
    expect(pane("right")).toBeInTheDocument()
    await followed("right", "work")
    // The choice is part of the stored layout.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(fake.settings[LAYOUT_KEY]).toMatchObject({ v: 1, split: 50, tree: "two" })
    await act(async () => {
      fireEvent.keyDown(window, { key: "F8", ctrlKey: true, shiftKey: true })
    })
    expect(screen.queryByTestId("tree-left")).toBeNull()
  })

  it("lists drives, and only the folders that lead to the panel's folder", async () => {
    const fake = await start("one")
    await followed("one", "home")
    expect(names("one")).toEqual(["1 System (C:)", "2 home", "2 work", "1 D:\\"])
    // One listing per ancestor; home itself and the other drive were not listed.
    expect(fake.api.fs.listDirs.mock.calls.map((c) => c[0])).toEqual(["C:\\"])
    expect(node("one", "home")).toHaveAttribute("aria-expanded", "false")
    expect(node("one", "work")).not.toHaveAttribute("aria-expanded")
  })

  it("follows the active panel: into a folder, and to the other panel's folder", async () => {
    await start("one")
    await followed("one", "home")
    // Into pics in the left panel.
    await act(async () => {
      await openPath("left", PICS.path)
    })
    await followed("one", "pics")
    expect(node("one", "home")).toHaveAttribute("aria-expanded", "true")
    // Tab: the right panel is active; the one tree shows its folder.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Tab" })
    })
    expect(usePanelsStore.getState().active).toBe("right")
    await followed("one", "work")
  })

  it("a folder opens in its panel however long the tree takes to list", async () => {
    let release!: () => void
    const dirsDelay = new Promise<void>((r) => (release = r))
    const fake = await start("one", { dirsDelay })
    // The panels are up (start waited for both paths) while no listing has answered.
    await waitFor(() => expect(fake.api.fs.listDirs).toHaveBeenCalled())
    expect(names("one")).toEqual(["1 System (C:)", "1 D:\\"])
    await panelKey("left", { key: "Backspace" })
    await waitFor(() => expect(path("left")).toHaveTextContent(/^C:\\$/))
    release()
    await followed("one", "System (C:)")
  })

  it("moves with the keys: arrows, expand and collapse, the parent, type-ahead", async () => {
    const fake = await start("one")
    await followed("one", "home")
    // Shift+Tab from the panel: the keys go to the tree, on the panel's folder.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Tab", shiftKey: true })
    })
    await waitFor(() => expect(document.activeElement).toBe(treeEl("one")))
    expect(cursor("one")).toHaveAttribute("aria-label", "home")

    // →: expands (one listing), then goes to the first child.
    const listed = fake.api.fs.listDirs.mock.calls.length
    await treeKey("one", { key: "ArrowRight" })
    await waitFor(() => expect(node("one", "pics")).toBeInTheDocument())
    expect(fake.api.fs.listDirs.mock.calls.length).toBe(listed + 1)
    await treeKey("one", { key: "ArrowRight" })
    expect(cursor("one")).toHaveAttribute("aria-label", "pics")
    // ←: to the parent, then collapses it.
    await treeKey("one", { key: "ArrowLeft" })
    expect(cursor("one")).toHaveAttribute("aria-label", "home")
    await treeKey("one", { key: "ArrowLeft" })
    expect(within(pane("one")).queryByRole("treeitem", { name: "pics" })).toBeNull()
    // ↓ ↑ Home End.
    await treeKey("one", { key: "ArrowDown" })
    expect(cursor("one")).toHaveAttribute("aria-label", "work")
    await treeKey("one", { key: "End" })
    expect(cursor("one")).toHaveAttribute("aria-label", "D:\\")
    await treeKey("one", { key: "Home" })
    expect(cursor("one")).toHaveAttribute("aria-label", "System (C:)")
    await treeKey("one", { key: "ArrowUp" })
    expect(cursor("one")).toHaveAttribute("aria-label", "System (C:)")
    // Letters: the next node of that name; a second letter refines.
    await treeKey("one", { key: "w" })
    expect(cursor("one")).toHaveAttribute("aria-label", "work")
    await treeKey("one", { key: "h" }) // "wh": nothing; the cursor stays
    expect(cursor("one")).toHaveAttribute("aria-label", "work")
    // A cursor key ends the typed text: the next letter starts a new one.
    await treeKey("one", { key: "ArrowUp" })
    expect(cursor("one")).toHaveAttribute("aria-label", "home")
    await treeKey("one", { key: "d" })
    expect(cursor("one")).toHaveAttribute("aria-label", "D:\\")
    // The panel did not move: the tree's cursor is its own.
    expect(path("left")).toHaveTextContent(HOME.path)
  })

  it("Enter opens the folder in the panel and gives the keys back; Esc and Tab only give them back", async () => {
    await start("one")
    await followed("one", "home")
    await act(async () => {
      fireEvent.keyDown(window, { key: "Tab", shiftKey: true })
    })
    await waitFor(() => expect(document.activeElement).toBe(treeEl("one")))
    await treeKey("one", { key: "ArrowDown" })
    await treeKey("one", { key: "Enter" })
    await waitFor(() => expect(path("left")).toHaveTextContent(WORK.path))
    await waitFor(() => expect(document.activeElement).toBe(grid("left")))
    await followed("one", "work")

    // Tab in the tree goes back to the panel; it does not switch panels.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Tab", shiftKey: true })
    })
    await waitFor(() => expect(document.activeElement).toBe(treeEl("one")))
    await treeKey("one", { key: "Tab" })
    await waitFor(() => expect(document.activeElement).toBe(grid("left")))
    expect(usePanelsStore.getState().active).toBe("left")
    await act(async () => {
      treeEl("one").focus()
    })
    await treeKey("one", { key: "Escape" })
    await waitFor(() => expect(document.activeElement).toBe(grid("left")))
  })

  it("a click opens the folder and shows its subfolders; the arrow only expands", async () => {
    await start("one")
    await followed("one", "home")
    await act(async () => {
      fireEvent.click(within(node("one", "D:\\")).getByRole("button", { name: "Expand D:\\" }))
    })
    await waitFor(() => expect(node("one", "D:\\")).not.toHaveAttribute("aria-expanded"))
    expect(path("left")).toHaveTextContent(HOME.path)

    await act(async () => {
      fireEvent.mouseDown(node("one", "home"))
      fireEvent.click(node("one", "home"))
    })
    await waitFor(() => expect(node("one", "pics")).toBeInTheDocument())
    expect(node("one", "home")).toHaveAttribute("aria-expanded", "true")
    await act(async () => {
      fireEvent.mouseDown(node("one", "pics"))
      fireEvent.click(node("one", "pics"))
    })
    await waitFor(() => expect(path("left")).toHaveTextContent(PICS.path))
    await followed("one", "pics")
  })

  it("shows a tree per panel, each following its own; a click in one makes its panel active", async () => {
    await start("two")
    await followed("left", "home")
    await followed("right", "work")
    expect(usePanelsStore.getState().active).toBe("left")
    await act(async () => {
      fireEvent.mouseDown(node("right", "home"))
      fireEvent.click(node("right", "home"))
    })
    expect(usePanelsStore.getState().active).toBe("right")
    await waitFor(() => expect(path("right")).toHaveTextContent(HOME.path))
    expect(path("left")).toHaveTextContent(HOME.path)
    await followed("right", "home")
    // Shift+Tab goes to the active panel's own tree.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Tab", shiftKey: true })
    })
    await waitFor(() => expect(document.activeElement).toBe(treeEl("right")))
    // Each tree holds its own nodes.
    expect(trees.left.getNode(keyOf(PICS.path))).toBeUndefined()
  })

  it("lists hidden folders when its panel shows hidden files (the default)", async () => {
    const fake = await start("one", { dirs: { "C:\\": ["home", "work", ".secret"] } })
    await followed("one", "home")
    await waitFor(() => expect(node("one", ".secret")).toBeInTheDocument())
    expect(fake.api.fs.listDirs).toHaveBeenLastCalledWith("C:\\", true, true)
    await panelKey("left", { key: "h", ctrlKey: true })
    await waitFor(() =>
      expect(within(pane("one")).queryByRole("treeitem", { name: ".secret" })).toBeNull(),
    )
    expect(fake.api.fs.listDirs).toHaveBeenLastCalledWith("C:\\", false, true)
  })

  it("mounts a bounded number of rows for a folder with a thousand subfolders", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => `sub${String(i).padStart(4, "0")}`)
    const fake = await start("one", { dirs: { "D:\\": many } })
    await followed("one", "home")
    const before = fake.api.fs.listDirs.mock.calls.length
    await act(async () => {
      fireEvent.click(within(node("one", "D:\\")).getByRole("button", { name: "Expand D:\\" }))
    })
    await waitFor(() => expect(node("one", "sub0000")).toBeInTheDocument())
    // One request for the thousand, never one per row.
    expect(fake.api.fs.listDirs.mock.calls.length).toBe(before + 1)
    const visible = Math.ceil(600 / ROW_HEIGHT.medium)
    expect(nodes("one").length).toBeLessThanOrEqual(visible + 2 * TREE_OVERSCAN)
    expect(nodes("one").length).toBeGreaterThan(5)
    expect(within(pane("one")).queryByRole("treeitem", { name: "sub0999" })).toBeNull()
    // End reaches the last one.
    await act(async () => {
      treeEl("one").focus()
    })
    await treeKey("one", { key: "End" })
    expect(useTreeUiStore.getState().cursor.one).toBe(keyOf("D:\\sub0999"))
  })

  it("says why a folder could not be listed, under its node", async () => {
    await start("one", {
      fail: { "D:\\": { code: "PERMISSION_DENIED", message: "denied" } },
    })
    await followed("one", "home")
    await act(async () => {
      fireEvent.click(within(node("one", "D:\\")).getByRole("button", { name: "Expand D:\\" }))
    })
    await waitFor(() =>
      expect(pane("one")).toHaveTextContent("You don't have permission to open this folder."),
    )
  })

  it("offers a node's commands: the other panel, a new tab, the hotlist, refresh", async () => {
    const fake = await start("one")
    await followed("one", "home")
    const menu = async (name: string, entry: string) => {
      await act(async () => {
        fireEvent.contextMenu(node("one", name))
      })
      await act(async () => {
        fireEvent.click(within(screen.getByTestId("tree-menu-one")).getByText(entry))
      })
    }
    await menu("work", "Open in the right panel")
    await waitFor(() => expect(path("right")).toHaveTextContent(WORK.path))
    expect(usePanelsStore.getState().active).toBe("right")

    await menu("home", "Open in a new tab")
    await waitFor(() => expect(path("right")).toHaveTextContent(HOME.path))
    expect(useTabsStore.getState().right.tabs).toHaveLength(2)

    await menu("work", "Add to the directory hotlist")
    expect(fake.api.library.addBookmark).toHaveBeenCalledWith(WORK.path, "", "")
    await waitFor(() =>
      expect(screen.getByTestId("files-notice")).toHaveTextContent(
        "Added to the directory hotlist.",
      ),
    )

    const listed = fake.api.fs.listDirs.mock.calls.length
    await menu("System (C:)", "Refresh")
    await waitFor(() => expect(fake.api.fs.listDirs.mock.calls.length).toBe(listed + 1))
    expect(fake.api.fs.listDirs).toHaveBeenLastCalledWith("C:\\", true, true)
  })

  it("takes dropped panel items on a node: the copy dialog for that folder", async () => {
    await start("one")
    await followed("one", "home")
    const data = new Map<string, string>()
    const dataTransfer = {
      setData: (t: string, v: string) => data.set(t, v),
      getData: (t: string) => data.get(t) ?? "",
      get types() {
        return [...data.keys()]
      },
      effectAllowed: "",
      dropEffect: "",
    }
    await panelKey("left", { key: "ArrowDown" })
    const row = grid("left").querySelector('[data-row="1"]')!
    await act(async () => {
      fireEvent.dragStart(row, { dataTransfer })
    })
    await act(async () => {
      fireEvent.dragOver(node("one", "work"), { dataTransfer })
      fireEvent.drop(node("one", "work"), { dataTransfer })
    })
    expect(useFilesStore.getState().copy).toMatchObject({ kind: "copy", destination: WORK.path })
  })

  it("opens folders as the cursor rests on them when the setting says so", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await start("one", { settings: { [SETTINGS_KEY]: { v: 2, treeFollowCursor: true } } })
    await followed("one", "home")
    await act(async () => {
      treeEl("one").focus()
    })
    // Passing over work on the way to D: opens neither until the cursor rests.
    await treeKey("one", { key: "ArrowDown" })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TREE_SETTLE_MS - 50)
    })
    await treeKey("one", { key: "ArrowDown" })
    expect(path("left")).toHaveTextContent(HOME.path)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TREE_SETTLE_MS + 50)
    })
    await waitFor(() => expect(path("left")).toHaveTextContent(/^D:\\$/))
    // The keys stay in the tree.
    expect(document.activeElement).toBe(treeEl("one"))
  })

  it("dims while its panel is inside an archive or on search results", async () => {
    await start("one")
    await followed("one", "home")
    expect(pane("one")).not.toHaveAttribute("data-dimmed")
    await act(async () => {
      useListingStore.setState((s) => ({
        left: { ...s.left, find: { findId: 1, label: "*.txt" } },
      }))
    })
    expect(pane("one")).toHaveAttribute("data-dimmed", "true")
    expect(current("one")).toHaveAttribute("aria-label", "home")
  })

  it("resizes with its divider, by key and by drag, within limits", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fake = await start("one")
    const divider = screen.getByRole("separator", { name: "Resize Folder tree" })
    expect(pane("one").style.width).toBe(`${TREE_WIDTH.initial}px`)
    await act(async () => {
      fireEvent.keyDown(divider, { key: "ArrowRight" })
    })
    expect(pane("one").style.width).toBe(`${TREE_WIDTH.initial + 16}px`)
    await act(async () => {
      fireEvent.pointerDown(divider, { clientX: 300, pointerId: 1 })
      fireEvent.pointerMove(divider, { clientX: 2000, pointerId: 1 })
      fireEvent.pointerUp(divider, { pointerId: 1 })
    })
    expect(usePanelsStore.getState().treeWidth).toBe(TREE_WIDTH.max)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(fake.settings[LAYOUT_KEY]).toMatchObject({ tree: "one", treeWidth: TREE_WIDTH.max })
    await act(async () => {
      fireEvent.doubleClick(divider)
    })
    expect(usePanelsStore.getState().treeWidth).toBe(TREE_WIDTH.initial)
  })

  it("can be chosen in Settings", async () => {
    await start("off")
    await act(async () => setTreeMode("off"))
    await act(async () => {
      fireEvent.keyDown(window, { key: ",", ctrlKey: true })
    })
    await act(async () => {
      fireEvent.click(await screen.findByRole("radio", { name: "One beside each panel" }))
    })
    expect(usePanelsStore.getState().tree).toBe("two")
    await act(async () => {
      fireEvent.click(
        screen.getByRole("checkbox", { name: "The tree opens folders as the cursor moves" }),
      )
    })
    expect(useSettingsStore.getState().settings.treeFollowCursor).toBe(true)
  })
})

describe("the stored layout", () => {
  it("keeps what is valid and ignores the rest", () => {
    expect(readLayout({ v: 1, split: 30, tree: "two", treeWidth: 300 })).toEqual({
      split: 30,
      tree: "two",
      treeWidth: 300,
    })
    // A layout from before the tree (C00): the split alone.
    expect(readLayout({ v: 1, split: 40 })).toEqual({ split: 40 })
    expect(readLayout({ v: 1, split: 5, tree: "three", treeWidth: 9000 })).toEqual({})
    expect(readLayout({ v: 2, split: 30 })).toEqual({})
    expect(readLayout(null)).toEqual({})
  })
})
