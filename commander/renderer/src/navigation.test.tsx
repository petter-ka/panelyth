import type { Crumb } from "@fastview/contracts"
import { useInterfaceSizeStore } from "@fastview/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { BRIEF_COLUMN, BRIEF_OVERSCAN } from "./components/BriefView"
import { ROW_HEIGHT } from "./components/FullView"
import { resetCarry, startPanels } from "./features/carry"
import { resetDrives, startDrives } from "./features/drives"
import { formatDate, formatSize } from "./features/format"
import { resetHotlist, startHotlist } from "./features/hotlist"
import { resetKeymap } from "./features/keymap"
import { parkedQueryIds, resetListing, TAB_GRACE_MS, useListingStore } from "./features/listing"
import { resetMarks } from "./features/marks"
import { usePanelsStore } from "./features/panels"
import { PANELS_KEY, readStoredPanels } from "./features/session"
import { resetSettings, SETTINGS_KEY, useSettingsStore } from "./features/settings"
import { resetTabs, useTabsStore } from "./features/tabs"
import { folder, installFakeCommander, item, type FakeOptions } from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// Stage C03: drives, tabs, hotlist, history and session
// (docs/commander/stages/C03-drives-tabs-hotlist.md).

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const HOME: Crumb = { name: "home", path: "C:\\home" }
const PICS: Crumb = { name: "pics", path: "C:\\home\\pics" }
const WORK: Crumb = { name: "work", path: "C:\\work" }
const BIG: Crumb = { name: "big", path: "C:\\big" }
const DROOT: Crumb = { name: "D:\\", path: "D:\\" }

// dir000000 of home is the pics folder (entry id = dir id); ids are dirId * 1e6 + n.
const PICS_FILE_2 = 10_000_000 * 1_000_000 + 2
const folders = () => [
  folder(10, HOME.path, [ROOT, HOME], 2, 3),
  folder(10_000_000, PICS.path, [ROOT, HOME, PICS], 0, 4),
  folder(30, WORK.path, [ROOT, WORK], 1, 2),
  folder(20, BIG.path, [ROOT, BIG], 0, 100_000),
  folder(40, ROOT.path, [ROOT], 3, 0),
  folder(50, DROOT.path, [DROOT], 0, 2),
]

const VOLUMES = [
  {
    path: "C:\\",
    label: "System",
    kind: "fixed" as const,
    freeBytes: 2 * 1024 ** 3,
    totalBytes: 8 * 1024 ** 3,
  },
  {
    path: "D:\\",
    label: "STICK",
    kind: "removable" as const,
    freeBytes: 1024 ** 3,
    totalBytes: 4 * 1024 ** 3,
  },
  { path: "E:\\", label: "", kind: "removable" as const, notReady: true },
  { path: "Z:\\", label: "", kind: "network" as const, notReady: true },
]

let stops: (() => void)[] = []

async function start(options: Partial<FakeOptions> = {}) {
  const fake = installFakeCommander({
    folders: folders(),
    home: HOME.path,
    volumes: VOLUMES,
    fail: {
      "E:\\": { code: "INVALID_PATH", message: "not ready", details: { reason: "notReady" } },
    },
    ...options,
  })
  render(<AppShell />)
  await act(async () => {
    stops.push(startDrives(), startHotlist())
    stops.push(await startPanels())
  })
  return fake
}

const grid = (side: "left" | "right") => screen.getByTestId(`grid-${side}`)
const path = (side: "left" | "right") => screen.getByTestId(`path-${side}`)
const key = (side: "left" | "right", init: KeyboardEventInit & { key: string }) =>
  act(async () => {
    fireEvent.keyDown(grid(side), init)
  })
const cursorRow = (side: "left" | "right") =>
  grid(side).querySelector<HTMLElement>("[data-cursor=true]")

beforeEach(() => {
  mockViewport(800, 600)
  resetListing()
  resetCarry()
  resetBridgeCache()
  resetTabs()
  resetDrives()
  resetHotlist()
  resetSettings()
  resetKeymap()
  resetMarks()
  usePanelsStore.setState({ active: "left", split: 50, layoutToken: 0 })
  useInterfaceSizeStore.setState({ size: "medium" })
})
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("tabs", () => {
  it("opens, switches and closes tabs; only the visible tab holds a session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fake = await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    const opens = () => fake.api.query.open.mock.calls.length
    // The cursor on pics: the first tab remembers it.
    await key("left", { key: "ArrowDown" })
    await waitFor(() => expect(cursorRow("left")?.dataset.id).toBe(String(10_000_000)))
    const before = opens()
    const homeQuery = useListingStore.getState().left.query!.queryId

    // Ctrl+T: a new tab on the same folder takes over the session.
    await key("left", { key: "t", ctrlKey: true })
    expect(screen.getByTestId("tabs-left").querySelectorAll("[role=tab]")).toHaveLength(2)
    expect(useTabsStore.getState().left.active).toBe(1)
    expect(opens()).toBe(before)

    // The new tab goes elsewhere; the first tab still remembers home.
    await key("left", { key: "Enter" })
    await waitFor(() => expect(path("left")).toHaveTextContent(PICS.path))
    const picsQuery = useListingStore.getState().left.query!.queryId
    expect(fake.api.query.close).toHaveBeenCalledWith(homeQuery)

    // Ctrl+Tab: back to the first tab; the pics session is parked, not closed.
    await key("left", { key: "Tab", ctrlKey: true })
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    expect(parkedQueryIds()).toEqual([picsQuery])
    expect(fake.api.query.close).not.toHaveBeenCalledWith(picsQuery)
    // The first tab's cursor came back to its entry (pics, row 1 after "..").
    await waitFor(() => expect(cursorRow("left")?.dataset.id).toBe(String(10_000_000)))

    // Within the grace period, switching back reuses the parked session.
    const opensBefore = opens()
    const homeQuery2 = useListingStore.getState().left.query!.queryId
    await key("left", { key: "Tab", ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(path("left")).toHaveTextContent(PICS.path))
    expect(useListingStore.getState().left.query!.queryId).toBe(picsQuery)
    expect(opens()).toBe(opensBefore)
    expect(parkedQueryIds()).toEqual([homeQuery2])

    // After the grace period the parked session closes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TAB_GRACE_MS + 100)
    })
    expect(parkedQueryIds()).toEqual([])
    expect(fake.api.query.close).toHaveBeenCalledWith(homeQuery2)

    // Ctrl+W closes the visible tab; its session closes once the other shows.
    await key("left", { key: "w", ctrlKey: true })
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    expect(screen.queryByTestId("tabs-left")).toBeNull()
    expect(fake.api.query.close).toHaveBeenCalledWith(picsQuery)
    // The last tab never closes.
    await key("left", { key: "w", ctrlKey: true })
    expect(useTabsStore.getState().left.tabs).toHaveLength(1)
  })

  it("branches a locked tab's navigation into a new tab and never closes it", async () => {
    await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await key("left", { key: "t", ctrlKey: true })
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId("tab-left-0"))
    })
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("tab-menu-left")).getByText("Lock tab"))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId("tab-left-0"))
    })
    await waitFor(() => expect(useTabsStore.getState().left.active).toBe(0))
    expect(useTabsStore.getState().left.tabs[0]!.locked).toBe(true)
    expect(screen.getByTestId("tab-left-0")).toHaveAttribute("data-locked", "true")

    await key("left", { key: "ArrowDown" })
    await key("left", { key: "Enter" })
    await waitFor(() => expect(path("left")).toHaveTextContent(PICS.path))
    const { tabs, active } = useTabsStore.getState().left
    expect(tabs).toHaveLength(3)
    expect(active).toBe(1)
    expect(tabs[0]!.path).toBe(HOME.path)

    // Ctrl+W on the locked tab does nothing.
    await act(async () => {
      fireEvent.click(screen.getByTestId("tab-left-0"))
    })
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await key("left", { key: "w", ctrlKey: true })
    expect(useTabsStore.getState().left.tabs).toHaveLength(3)
  })

  it("reorders tabs by dragging", async () => {
    await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await key("left", { key: "t", ctrlKey: true })
    await key("left", { key: "t", ctrlKey: true })
    const ids = useTabsStore.getState().left.tabs.map((t) => t.id)
    const dataTransfer = { effectAllowed: "", setData: () => undefined }
    await act(async () => {
      fireEvent.dragStart(screen.getByTestId("tab-left-0"), { dataTransfer })
    })
    await act(async () => {
      fireEvent.dragOver(screen.getByTestId("tab-left-2"), { dataTransfer })
      fireEvent.drop(screen.getByTestId("tab-left-2"), { dataTransfer })
    })
    const { tabs, active } = useTabsStore.getState().left
    expect(tabs.map((t) => t.id)).toEqual([ids[1], ids[2], ids[0]])
    // The visible tab stays visible.
    expect(tabs[active]!.id).toBe(ids[2])
  })
})

describe("session restore", () => {
  it("restores both panels with their tabs, views, sorts, histories and cursor entries", async () => {
    await start({
      settings: {
        [PANELS_KEY]: {
          v: 2,
          active: "right",
          left: {
            active: 1,
            columns: { ext: 80 },
            tabs: [
              { path: HOME.path, name: "home", sort: { field: "name", direction: "asc" } },
              {
                path: WORK.path,
                name: "work",
                sort: { field: "size", direction: "desc" },
                view: "brief",
                locked: true,
                history: [HOME.path, WORK.path],
                historyIndex: 1,
                cursorId: 30_000_001,
              },
            ],
          },
          right: {
            active: 0,
            tabs: [{ path: PICS.path, showHidden: true, cursorId: PICS_FILE_2 }],
          },
        },
      },
    })
    expect(usePanelsStore.getState().active).toBe("right")
    await waitFor(() => expect(path("left")).toHaveTextContent(WORK.path))
    await waitFor(() => expect(path("right")).toHaveTextContent(PICS.path))
    const { left, right } = useListingStore.getState()
    expect(left.view).toBe("brief")
    expect(grid("left")).toHaveAttribute("role", "listbox")
    expect(left.sort).toEqual({ field: "size", direction: "desc" })
    expect(left.history).toEqual([HOME.path, WORK.path])
    expect(left.columns.ext).toBe(80)
    expect(right.showHidden).toBe(true)
    expect(useTabsStore.getState().left.tabs.map((t) => t.locked)).toEqual([false, true])
    await waitFor(() => expect(cursorRow("left")?.dataset.id).toBe("30000001"))
    await waitFor(() => expect(cursorRow("right")?.dataset.id).toBe(String(PICS_FILE_2)))
  })

  it("writes tabs, views and cursor entries to commander.panels", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fake = await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await key("left", { key: "ArrowDown" })
    await key("left", { key: "t", ctrlKey: true })
    await key("left", { key: "F1", ctrlKey: true })
    expect(grid("left")).toHaveAttribute("role", "listbox")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    const stored = readStoredPanels(fake.settings[PANELS_KEY])
    expect(stored.left?.active).toBe(1)
    expect(stored.left?.tabs.map((t) => [t.path, t.view, t.cursorId])).toEqual([
      [HOME.path, "full", 10_000_000],
      [HOME.path, "brief", 10_000_000],
    ])
  })

  it("starts panels with hidden files shown when Settings → Panels says so", async () => {
    await start({ settings: { [SETTINGS_KEY]: { v: 1, showHidden: true } } })
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    expect(useListingStore.getState().left.showHidden).toBe(true)
  })
})

describe("Brief view", () => {
  it("flows names top to bottom in fixed columns, mounting only the visible columns", async () => {
    await start({
      settings: { [PANELS_KEY]: { v: 2, active: "left", left: { tabs: [{ path: BIG.path }] } } },
    })
    await waitFor(() => expect(path("left")).toHaveTextContent(BIG.path))
    await key("left", { key: "F1", ctrlKey: true })
    const rows = Math.floor(600 / ROW_HEIGHT.medium)
    const visibleColumns = Math.ceil(800 / BRIEF_COLUMN.medium)
    await waitFor(() =>
      expect(grid("left").querySelectorAll("[role=option]").length).toBeGreaterThan(0),
    )
    const mounted = grid("left").querySelectorAll("[role=option]").length
    expect(mounted).toBeLessThanOrEqual((visibleColumns + BRIEF_OVERSCAN) * rows)

    // Row `rows` starts the second column.
    const second = grid("left").querySelector<HTMLElement>(`[data-row="${rows}"]`)!
    const first = grid("left").querySelector<HTMLElement>(`[data-row="0"]`)!
    expect(second.style.left).toBe(`${BRIEF_COLUMN.medium}px`)
    expect(second.style.top).toBe("0px")
    expect(first.style.left).toBe("0px")

    // → moves a column, ← back; ↓ one row.
    await key("left", { key: "ArrowRight" })
    expect(useListingStore.getState().left.cursor).toBe(rows)
    await key("left", { key: "ArrowDown" })
    expect(useListingStore.getState().left.cursor).toBe(rows + 1)
    await key("left", { key: "ArrowLeft" })
    expect(useListingStore.getState().left.cursor).toBe(1)
    // Ctrl+F2 is the Full view again.
    await key("left", { key: "F2", ctrlKey: true })
    expect(grid("left")).toHaveAttribute("role", "grid")
  })

  it("marks and quick-searches like the Full view", async () => {
    await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await key("left", { key: "F1", ctrlKey: true })
    await waitFor(() => expect(grid("left").querySelectorAll("[role=option]").length).toBe(6))
    await key("left", { key: "End" })
    await key("left", { key: "Insert" })
    await waitFor(() =>
      expect(grid("left").querySelector("[aria-selected=true]")).toHaveTextContent(
        "file000002.txt",
      ),
    )
    await key("left", { key: "d" })
    await waitFor(() => expect(cursorRow("left")).toHaveTextContent("dir000000"))
  })
})

describe("drives", () => {
  it("shows drives with labels, space and markers; Alt+F1 opens the menu", async () => {
    await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    const bar = screen.getByTestId("drives-left")
    await waitFor(() => expect(within(bar).getByRole("button", { name: "C" })).toBeInTheDocument())
    expect(within(bar).getByRole("button", { name: "C" })).toHaveAttribute("aria-pressed", "true")
    expect(within(bar).getByRole("button", { name: "Z" })).toHaveAttribute("data-not-ready", "true")
    expect(bar).toHaveTextContent("2.0 GB free of 8.0 GB")

    await key("left", { key: "F1", altKey: true })
    const menu = screen.getByTestId("drive-menu-left")
    expect(menu).toHaveTextContent("STICK")
    expect(menu).toHaveTextContent("removable")
    expect(menu).toHaveTextContent("network")
    expect(menu).toHaveTextContent("not ready")
    expect(menu).toHaveTextContent("Home")
    // A drive letter selects its drive.
    await act(async () => {
      fireEvent.keyDown(menu, { key: "d" })
    })
    await waitFor(() => expect(path("left")).toHaveTextContent(DROOT.path))
    expect(screen.queryByTestId("drive-menu-left")).toBeNull()
  })

  it("Alt+F2 opens the right panel's menu; a drive that isn't ready shows its state there", async () => {
    await start()
    await waitFor(() => expect(path("right")).toHaveTextContent(HOME.path))
    await key("left", { key: "F2", altKey: true })
    expect(usePanelsStore.getState().active).toBe("right")
    const menu = screen.getByTestId("drive-menu-right")
    await act(async () => {
      fireEvent.click(within(menu).getByText("E"))
    })
    await waitFor(() =>
      expect(screen.getByTestId("error-right")).toHaveAttribute("data-kind", "notReady"),
    )
    // The left panel is untouched.
    expect(path("left")).toHaveTextContent(HOME.path)
  })

  it("opens the menu at once while a slow network drive keeps Go busy", async () => {
    let release!: () => void
    const volumesDelay = new Promise<void>((r) => (release = r))
    await start({ volumesDelay })
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await key("left", { key: "F1", altKey: true })
    const menu = screen.getByTestId("drive-menu-left")
    expect(menu).toHaveTextContent("Updating drives…")
    // The panels keep working meanwhile.
    await key("right", { key: "ArrowDown" })
    expect(useListingStore.getState().right.cursor).toBe(1)
    await act(async () => {
      release()
      await volumesDelay
    })
    await waitFor(() => expect(screen.getByTestId("drive-menu-left")).toHaveTextContent("STICK"))
  })

  it("follows volumes.changed", async () => {
    const fake = await start()
    await waitFor(() => expect(screen.getByTestId("drives-left")).toHaveTextContent("D"))
    await act(async () => fake.emit("volumes.changed", { volumes: [VOLUMES[0]!] }))
    expect(
      within(screen.getByTestId("drives-left")).queryByRole("button", { name: "D" }),
    ).toBeNull()
  })
})

describe("hotlist and history", () => {
  it("adds the current folder, opens entries, and follows changes from the viewer", async () => {
    const fake = await start({
      bookmarks: [{ id: 1, path: WORK.path, label: "Work", group: "Jobs" }],
    })
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await key("left", { key: "d", ctrlKey: true })
    let menu = screen.getByTestId("hotlist-left")
    expect(menu).toHaveTextContent("Jobs")
    await act(async () => {
      fireEvent.click(within(menu).getByText("Add the current folder"))
    })
    expect(fake.api.library.addBookmark).toHaveBeenCalledWith(HOME.path, "", "")
    expect(fake.bookmarks().map((b) => b.path)).toEqual([WORK.path, HOME.path])

    // A bookmark added in the viewer shows up here (bookmarks.changed).
    await act(async () =>
      fake.setBookmarks([
        ...fake.bookmarks(),
        { id: 9, path: PICS.path, label: "pics", group: "" },
      ]),
    )
    await key("left", { key: "d", ctrlKey: true })
    menu = screen.getByTestId("hotlist-left")
    expect(menu).toHaveTextContent("pics")
    await act(async () => {
      fireEvent.click(within(menu).getByText("Work"))
    })
    await waitFor(() => expect(path("left")).toHaveTextContent(WORK.path))
  })

  it("edits, groups, reorders and removes entries in the hotlist dialog", async () => {
    const fake = await start({
      bookmarks: [
        { id: 1, path: WORK.path, label: "Work", group: "" },
        { id: 2, path: PICS.path, label: "Pics", group: "" },
      ],
    })
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await key("left", { key: "d", ctrlKey: true })
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("hotlist-left")).getByText("Configure…"))
    })
    const dialog = screen.getByRole("dialog")
    await act(async () => {
      fireEvent.click(within(dialog).getByText("Pics"))
    })
    fireEvent.change(within(dialog).getByLabelText("Group"), { target: { value: "Media" } })
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Pictures" } })
    await act(async () => {
      fireEvent.click(within(dialog).getByText("Save"))
    })
    expect(fake.bookmarks()[1]).toEqual({
      id: 2,
      path: PICS.path,
      label: "Pictures",
      group: "Media",
    })

    await act(async () => {
      fireEvent.click(within(dialog).getByLabelText("Move up"))
    })
    expect(fake.api.library.reorderBookmarks).toHaveBeenCalledWith([2, 1])
    expect(fake.bookmarks().map((b) => b.id)).toEqual([2, 1])

    // A duplicate folder is refused with a message.
    fireEvent.change(within(dialog).getByLabelText("Folder"), { target: { value: WORK.path } })
    await act(async () => {
      fireEvent.click(within(dialog).getByText("Save"))
    })
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Another hotlist entry")

    await act(async () => {
      fireEvent.click(within(dialog).getByText("Remove"))
    })
    expect(fake.bookmarks().map((b) => b.id)).toEqual([1])
  })

  it("Alt+↓ lists the tab's history and the recent locations of both apps", async () => {
    await start({
      recent: [
        { path: HOME.path, lastOpenedAt: 3 },
        { path: DROOT.path, lastOpenedAt: 2 },
      ],
    })
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await key("left", { key: "ArrowDown" })
    await key("left", { key: "Enter" })
    await waitFor(() => expect(path("left")).toHaveTextContent(PICS.path))
    await key("left", { key: "ArrowDown", altKey: true })
    const menu = await screen.findByTestId("history-left")
    await waitFor(() => expect(menu).toHaveTextContent("Recent (both apps)"))
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((el) => el.textContent)
    expect(items[0]).toContain(PICS.path)
    expect(items[1]).toContain(HOME.path)
    expect(items.at(-1)).toContain(DROOT.path)
    await act(async () => {
      fireEvent.click(within(menu).getByText(DROOT.path))
    })
    await waitFor(() => expect(path("left")).toHaveTextContent(DROOT.path))
  })
})

describe("focus", () => {
  it("keeps the keys in the panel across a view switch and after a menu closes", async () => {
    await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    grid("left").focus()
    await key("left", { key: "F1", ctrlKey: true })
    expect(grid("left")).toHaveAttribute("role", "listbox")
    expect(grid("left")).toHaveFocus()
    await key("left", { key: "d", ctrlKey: true })
    const menu = screen.getByTestId("hotlist-left")
    expect(menu).toHaveFocus()
    await act(async () => {
      fireEvent.keyDown(menu, { key: "Escape" })
    })
    // At once, not after a timer: the next key reaches the panel.
    expect(grid("left")).toHaveFocus()
  })

  it("Alt+F2 gives the drive menu the keys although the active panel changes", async () => {
    await start()
    await waitFor(() => expect(path("right")).toHaveTextContent(HOME.path))
    grid("left").focus()
    await key("left", { key: "F2", altKey: true })
    expect(usePanelsStore.getState().active).toBe("right")
    expect(screen.getByTestId("drive-menu-right")).toHaveFocus()
  })
})

describe("Settings → Panels", () => {
  it("switches size and date formats and stores them", async () => {
    const fake = await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await act(async () => {
      fireEvent.keyDown(window, { key: ",", ctrlKey: true })
    })
    const dialog = screen.getByRole("dialog")
    await act(async () => {
      fireEvent.click(within(dialog).getByLabelText("Units (1.2 MB)"))
      fireEvent.click(within(dialog).getByLabelText("ISO (2026-10-06 14:05)"))
    })
    expect(useSettingsStore.getState().settings).toMatchObject({
      sizeFormat: "units",
      dateFormat: "iso",
    })
    expect(fake.settings[SETTINGS_KEY]).toMatchObject({ sizeFormat: "units", dateFormat: "iso" })
    expect(formatSize(item(1, "a.bin", { sizeBytes: 1536 }), "units")).toBe("1.5 KB")
    expect(formatSize(item(1, "a.bin", { sizeBytes: 1536 }), "bytes")).toMatch(/^1.536$/)
    expect(formatDate(new Date(2026, 9, 6, 14, 5).getTime(), "iso")).toBe("2026-10-06 14:05")
  })

  it("with Alt+letters, plain letters no longer start quick search", async () => {
    await start({ settings: { [SETTINGS_KEY]: { v: 1, letters: "altLetters" } } })
    await act(async () => {
      useSettingsStore.setState({
        settings: { ...useSettingsStore.getState().settings, letters: "altLetters" },
      })
    })
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await key("left", { key: "f" })
    expect(screen.queryByTestId("quicksearch-left")).toBeNull()
    await key("left", { key: "f", altKey: true })
    await waitFor(() => expect(cursorRow("left")).toHaveTextContent("file000000"))
  })
})
