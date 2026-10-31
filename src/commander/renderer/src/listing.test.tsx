import { ENTRY_ATTRS, type Crumb } from "@panelyth/contracts"
import { useInterfaceSizeStore } from "@panelyth/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { OVERSCAN, ROW_HEIGHT } from "./components/FullView"
import { applyContext, resetCarry, startPanels } from "./features/carry"
import { setStarting } from "./features/commands"
import { formatAttrs } from "./features/format"
import { DEFAULT_COLUMNS, pageStoreOf, resetListing, useListingStore } from "./features/listing"
import { applyLayoutPreset } from "./features/layoutPresets"
import { usePanelsStore } from "./features/panels"
import { showHiddenEverywhere, useTabsStore } from "./features/tabs"
import { PANELS_KEY, readStoredPanels } from "./features/session"
import { applyStoredSettings, SETTINGS_KEY, useSettingsStore } from "./features/settings"
import { startSettingsRelay } from "./features/settingsRelay"
import { folder, installFakeCommander, item, type FakeOptions } from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// Stage C01: panels and listing (docs/commander/stages/C01-panels-and-listing.md).

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const HOME: Crumb = { name: "home", path: "C:\\home" }
const PICS: Crumb = { name: "pics", path: "C:\\home\\pics" }
const BIG: Crumb = { name: "big", path: "C:\\big" }

const home = () =>
  folder(10, HOME.path, [ROOT, HOME], 2, 3, [
    item(10_000_100, "secret.txt", { attrs: ENTRY_ATTRS.hidden }),
  ])
// dir000000 of home is the pics folder (entry id = dir id).
const pics = () => folder(10_000_000, PICS.path, [ROOT, HOME, PICS], 0, 4)
const big = () => folder(20, BIG.path, [ROOT, BIG], 0, 100_000)

let stop: (() => void) | null = null

async function start(options: Partial<FakeOptions> = {}) {
  const fake = installFakeCommander({
    folders: [home(), pics()],
    home: HOME.path,
    volumes: [
      {
        path: "C:\\",
        label: "",
        kind: "fixed",
        freeBytes: 2 * 1024 ** 3,
        totalBytes: 8 * 1024 ** 3,
      },
    ],
    ...options,
  })
  render(<AppShell />)
  await act(async () => {
    stop = await startPanels()
  })
  return fake
}

/** Hidden entries off: the tests that count rows. */
const HIDDEN_OFF = { settings: { [SETTINGS_KEY]: { v: 3, showHidden: false } } }

const grid = (side: "left" | "right") => screen.getByTestId(`grid-${side}`)
const rows = (side: "left" | "right") => grid(side).querySelectorAll("[data-row]")
const cursorRow = (side: "left" | "right") =>
  grid(side).querySelector<HTMLElement>("[data-cursor=true]")
const key = (side: "left" | "right", init: KeyboardEventInit & { key: string }) =>
  act(async () => {
    fireEvent.keyDown(grid(side), init)
  })

beforeEach(() => {
  mockViewport(800, 600)
  resetListing()
  resetCarry()
  resetBridgeCache()
  usePanelsStore.setState({ active: "left", split: 50, layoutToken: 0 })
  useInterfaceSizeStore.setState({ size: "medium" })
})
afterEach(() => {
  stop?.()
  stop = null
  delete window.panelyth
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("listing (Stage C01)", () => {
  it("opens the home folder in both panels on first run, with the synthetic .. row", async () => {
    const fake = await start()
    expect(fake.api.dir.open).toHaveBeenCalledWith({
      path: HOME.path,
      recursive: false,
      lane: "left",
    })
    // Hidden and system entries (dot-names too) are listed by default.
    expect(fake.lastDescriptor()).toMatchObject({ scope: "all", showHidden: true })
    await waitFor(() => expect(within(grid("left")).getByText("dir000001")).toBeInTheDocument())
    const first = rows("left")[0] as HTMLElement
    expect(first).toHaveTextContent("..")
    expect(first).toHaveAttribute("data-cursor", "true")
    // Folders first and <DIR>; files split into name and extension.
    expect(rows("left")[1]).toHaveTextContent("dir000000")
    expect(rows("left")[1]).toHaveTextContent("<DIR>")
    expect(within(grid("left")).getByText("file000000")).toBeInTheDocument()
    expect(within(grid("left")).getByText("secret")).toBeInTheDocument()
    expect(screen.getByTestId("path-left")).toHaveTextContent(HOME.path)
  })

  it("shows skeleton rows while the app starts and a folder opens, never an empty panel", async () => {
    const fake = installFakeCommander({ folders: [home(), pics()], home: HOME.path, volumes: [] })
    // The first folders take a moment.
    let open!: () => void
    const opened = new Promise<void>((resolve) => (open = resolve))
    const real = fake.api.dir.open.getMockImplementation()!
    fake.api.dir.open.mockImplementation(async (p: { path: string }) => {
      await opened
      return real(p)
    })
    try {
      // As main.tsx starts the app (APP-SWITCHING.md, "Loading screen").
      setStarting(true)
      render(<AppShell />)
      // Rows of bars and the state in words for screen readers; never "No folder open".
      expect(screen.getByTestId("rows-skeleton-left")).toHaveTextContent("Opening…")
      expect(screen.getByTestId("rows-skeleton-right")).toHaveTextContent("Opening…")
      expect(screen.getByTestId("path-left")).toHaveTextContent("Opening…")
      expect(screen.queryByText("No folder open")).toBeNull()
      // No loading screen over the panels: the rest of the app is usable meanwhile.
      expect(screen.queryByTestId("app-loading")).toBeNull()
      let started: Promise<() => void> = Promise.resolve(() => undefined)
      await act(async () => {
        started = startPanels()
        await Promise.resolve()
      })
      expect(screen.getByTestId("rows-skeleton-left")).toBeInTheDocument()
      await act(async () => {
        open()
        stop = await started
        setStarting(false)
      })
      await waitFor(() => expect(within(grid("left")).getByText("dir000001")).toBeInTheDocument())
      expect(screen.queryByTestId("rows-skeleton-left")).toBeNull()
      expect(screen.queryByTestId("rows-skeleton-right")).toBeNull()
      expect(screen.getByTestId("path-left")).toHaveTextContent(HOME.path)
    } finally {
      setStarting(false)
    }
  })

  it("says a panel has no folder once the app has started", async () => {
    installFakeCommander({ folders: [home(), pics()], home: HOME.path, volumes: [] })
    render(<AppShell />)
    expect(screen.queryByTestId("rows-skeleton-left")).toBeNull()
    expect(screen.getByTestId("path-left")).toHaveTextContent("No folder open")
  })

  it("uses a fixed row height per interface size", async () => {
    await start()
    await waitFor(() => expect(rows("left").length).toBeGreaterThan(2))
    expect((rows("left")[1] as HTMLElement).style.height).toBe(`${ROW_HEIGHT.medium}px`)
    expect((rows("left")[2] as HTMLElement).style.top).toBe(`${2 * ROW_HEIGHT.medium}px`)
    await act(async () => useInterfaceSizeStore.setState({ size: "large" }))
    await waitFor(() =>
      expect((rows("left")[1] as HTMLElement).style.height).toBe(`${ROW_HEIGHT.large}px`),
    )
    expect(ROW_HEIGHT).toEqual({ small: 20, medium: 22, large: 26, xlarge: 30 })
    // The gutter and the header are in px: at L a rem size outgrew the width
    // math and gave every panel a horizontal scrollbar.
    const header = grid("left").querySelector<HTMLElement>("[role=row]:not([data-row])")!
    expect(header.style.height).toBe("24px")
    expect((header.firstElementChild as HTMLElement).style.width).toBe("10px")
    expect(((rows("left")[1] as HTMLElement).firstElementChild as HTMLElement).style.width).toBe(
      "10px",
    )
    expect(grid("left").querySelector('[class~="w-2.5"], [class~="h-6"]')).toBeNull()
  })

  it("mounts and pages only the visible window of a 100k folder", async () => {
    const fake = await start({
      folders: [home(), pics(), big()],
      settings: { [PANELS_KEY]: { v: 1, active: "left", left: { path: BIG.path } } },
    })
    await waitFor(() => expect(within(grid("left")).getByText("file000000")).toBeInTheDocument())
    expect(useListingStore.getState().left.query?.total).toBe(100_000)
    const visible = Math.ceil(600 / ROW_HEIGHT.medium)
    expect(rows("left").length).toBeLessThanOrEqual(visible + 2 * OVERSCAN)
    expect(pageStoreOf("left").stats().cached).toBeLessThanOrEqual(2)
    // End jumps to the last row; only the pages around it are fetched.
    await key("left", { key: "End" })
    expect(useListingStore.getState().left.cursor).toBe(100_000)
    // jsdom has no scrolling: deliver the scroll the virtualizer asked for.
    const body = grid("left").children[0] as HTMLElement
    Object.defineProperty(body, "scrollTop", {
      configurable: true,
      value: 100_001 * ROW_HEIGHT.medium - 600,
    })
    await act(async () => fireEvent.scroll(body))
    await waitFor(() => expect(cursorRow("left")).toHaveTextContent("file099999"))
    expect(rows("left").length).toBeLessThanOrEqual(visible + 2 * OVERSCAN)
    const pages = fake.api.query.page.mock.calls.filter(
      ([p]) => p.queryId === useListingStore.getState().left.query?.queryId,
    )
    expect(pages.length).toBeLessThanOrEqual(5)
  })

  it("keys pressed while a refresh looks up the cursor's entry are not undone", async () => {
    const fake = await start()
    await waitFor(() => expect(rows("left").length).toBeGreaterThan(5))
    await key("left", { key: "ArrowDown" })
    const before = useListingStore.getState().left.cursor
    // Go answers the refresh's lookup only after two more keys.
    let answer: () => void = () => undefined
    const indexOf = fake.api.query.indexOf.getMockImplementation()!
    fake.api.query.indexOf.mockImplementationOnce(
      (queryId: number, entryId: number) =>
        new Promise((resolve) => {
          answer = () => resolve(indexOf(queryId, entryId))
        }),
    )
    await act(async () => fake.relist(10))
    await key("left", { key: "ArrowDown" })
    await key("left", { key: "ArrowDown" })
    expect(useListingStore.getState().left.cursor).toBe(before + 2)
    await act(async () => answer())
    expect(useListingStore.getState().left.cursor).toBe(before + 2)
  })

  it("being shown does not take the focus from a path being typed", async () => {
    const fake = await start()
    await waitFor(() => expect(rows("left").length).toBeGreaterThan(0))
    await act(async () => fireEvent.click(screen.getByTestId("path-right")))
    const input = screen.getByRole("textbox", { name: "Path" })
    input.focus()
    fireEvent.change(input, { target: { value: "C:\\big" } })
    await act(async () => fake.emit("app.visibility", { app: "commander", visible: true }))
    expect(screen.getByRole("textbox", { name: "Path" })).toHaveFocus()
    expect(screen.getByRole("textbox", { name: "Path" })).toHaveValue("C:\\big")
  })

  it("moves one cursor with arrows, PgUp/PgDn and Home/End", async () => {
    await start(HIDDEN_OFF)
    await waitFor(() => expect(rows("left").length).toBeGreaterThan(5))
    await key("left", { key: "ArrowDown" })
    await key("left", { key: "ArrowDown" })
    expect(cursorRow("left")).toHaveTextContent("dir000001")
    await key("left", { key: "End" })
    expect(cursorRow("left")).toHaveTextContent("file000002")
    await key("left", { key: "ArrowDown" })
    expect(cursorRow("left")).toHaveTextContent("file000002")
    await key("left", { key: "Home" })
    expect(cursorRow("left")).toHaveTextContent("..")
    await key("left", { key: "PageDown" })
    expect(useListingStore.getState().left.cursor).toBe(5)
    await key("left", { key: "PageUp" })
    expect(useListingStore.getState().left.cursor).toBe(0)
  })

  it("enters a folder with Enter and goes up with Backspace onto the folder just left", async () => {
    const fake = await start()
    await waitFor(() => expect(rows("left").length).toBeGreaterThan(2))
    await key("left", { key: "ArrowDown" })
    await key("left", { key: "Enter" })
    expect(fake.api.dir.openEntry).toHaveBeenCalledWith({
      entryId: 10_000_000,
      recursive: false,
      lane: "left",
    })
    await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(PICS.path))
    await key("left", { key: "Backspace" })
    await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(HOME.path))
    expect(fake.api.query.indexOf).toHaveBeenLastCalledWith(expect.any(Number), 10_000_000)
    await waitFor(() => expect(cursorRow("left")).toHaveTextContent("dir000000"))
    // Ctrl+PgUp goes up too; Enter on ".." as well.
    await key("left", { key: "Home" })
    await key("left", { key: "Enter" })
    await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent("C:\\"))
  })

  it("the Single preset shows the active panel alone as thumbnails; Tab shows the other", async () => {
    await start()
    await waitFor(() => expect(rows("left").length).toBeGreaterThan(2))
    act(() => applyLayoutPreset("single"))
    expect(usePanelsStore.getState().arrangement).toBe("single")
    expect(useListingStore.getState().left.view).toBe("thumbs")
    expect(useListingStore.getState().right.view).toBe("thumbs")
    expect(screen.queryByTestId("grid-left")).not.toBeNull()
    expect(screen.queryByTestId("grid-right")).toBeNull()
    expect(screen.queryByRole("separator", { name: "Resize panels" })).toBeNull()
    // Tab makes the other panel active, and it takes the place.
    await key("left", { key: "Tab" })
    await waitFor(() => expect(screen.queryByTestId("grid-left")).toBeNull())
    expect(screen.getByTestId("grid-right")).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(grid("right")))
    // Back to two panels with another preset.
    act(() => applyLayoutPreset("details"))
    expect(screen.getByTestId("grid-left")).toBeInTheDocument()
    expect(screen.getByTestId("grid-right")).toBeInTheDocument()
  })

  it("the path bar's eye menu: hidden and system files for both panels, this panel's view", async () => {
    const fake = await start(HIDDEN_OFF)
    // main.tsx loads the stored settings at start; the test does it here.
    act(() => applyStoredSettings({ v: 5, showHidden: false }))
    const user = userEvent.setup()
    await waitFor(() => expect(rows("left").length).toBeGreaterThan(2))
    // From the keyboard: jsdom measures every element at 0,0 (see find.test.tsx).
    const open = async () => {
      act(() => screen.getByTestId("view-options-left").focus())
      await user.keyboard("{Enter}")
      return screen.findByTestId("view-options-menu-left")
    }
    let menu = await open()
    const hidden = within(menu).getByRole("menuitemcheckbox", { name: "Show hidden files" })
    const system = within(menu).getByRole("menuitemcheckbox", { name: "Show system files too" })
    expect(hidden).toHaveAttribute("aria-checked", "false")
    expect(system).toHaveAttribute("data-disabled")
    // A switch keeps the menu open, and reaches Settings and both panels.
    await user.click(hidden)
    expect(screen.getByTestId("view-options-menu-left")).toBe(menu)
    expect(hidden).toHaveAttribute("aria-checked", "true")
    expect(system).not.toHaveAttribute("data-disabled")
    expect(useSettingsStore.getState().settings.showHidden).toBe(true)
    expect(fake.settings[SETTINGS_KEY]).toMatchObject({ showHidden: true })
    expect(useListingStore.getState().left.showHidden).toBe(true)
    expect(useListingStore.getState().right.showHidden).toBe(true)
    await user.keyboard("{Escape}")
    // The views of this panel, the current one checked, each with its shortcut.
    menu = await open()
    const views = within(menu).getAllByRole("menuitemradio")
    expect(views.map((v) => v.textContent)).toEqual([
      "Full viewCtrl+F2",
      "Brief viewCtrl+F1",
      "Thumbnails viewCtrl+Shift+F1",
    ])
    expect(views[0]).toHaveAttribute("aria-checked", "true")
    await user.click(views[1]!)
    expect(useListingStore.getState().left.view).toBe("brief")
    expect(useListingStore.getState().right.view).toBe("full")
  })

  it("keeps folders sorted by name unless Settings lets the sort reach them (owner request)", async () => {
    const fake = await start({
      folders: [
        folder(10, HOME.path, [ROOT, HOME], 0, 0, [
          item(11, "b-dir", { kind: "dir", sizeBytes: 1 }),
          item(12, "a-dir", { kind: "dir", sizeBytes: 3 }),
          item(13, "c-dir", { kind: "dir", sizeBytes: 2 }),
          item(14, "x.txt", { sizeBytes: 5 }),
          item(15, "y.txt", { sizeBytes: 9 }),
        ]),
      ],
    })
    const stopRelay = startSettingsRelay()
    try {
      const names = () =>
        [...rows("left")].map((r) => r.querySelector("[data-name]")?.textContent ?? "")
      await waitFor(() => expect(names()).toContain("y"))
      const header = within(grid("left")).getByRole("button", { name: /^Size/ })
      await act(async () => fireEvent.click(header))
      await act(async () => fireEvent.click(header))
      expect(fake.lastDescriptor()).toMatchObject({
        sort: [{ field: "size", direction: "desc" }],
        dirsByName: true,
      })
      await waitFor(() =>
        expect(names().filter(Boolean)).toEqual(["a-dir", "b-dir", "c-dir", "y", "x"]),
      )
      // The settings window turns it off: the panels list again, folders by size too.
      await act(async () =>
        fake.emit("settings.changed", {
          key: SETTINGS_KEY,
          value: { v: 5, sortFoldersByName: false },
        }),
      )
      await waitFor(() => expect(fake.lastDescriptor().dirsByName).toBeUndefined())
      await waitFor(() =>
        expect(names().filter(Boolean)).toEqual(["a-dir", "c-dir", "b-dir", "y", "x"]),
      )
    } finally {
      stopRelay()
    }
  })

  it("sorts in Go on a header click (again reverses) and with Ctrl+F3…F6, folders first", async () => {
    const fake = await start()
    await waitFor(() => expect(rows("left").length).toBeGreaterThan(2))
    const header = within(grid("left")).getByRole("button", { name: /^Size/ })
    await act(async () => fireEvent.click(header))
    expect(fake.lastDescriptor().sort).toEqual([{ field: "size", direction: "asc" }])
    await act(async () => fireEvent.click(header))
    expect(fake.lastDescriptor().sort).toEqual([{ field: "size", direction: "desc" }])
    expect(header.closest("[role=columnheader]")).toHaveAttribute("aria-sort", "descending")
    await key("left", { key: "F4", ctrlKey: true })
    expect(fake.lastDescriptor().sort).toEqual([{ field: "type", direction: "asc" }])
    await key("left", { key: "F5", ctrlKey: true })
    expect(fake.lastDescriptor().sort).toEqual([{ field: "modified", direction: "asc" }])
    await key("left", { key: "F3", ctrlKey: true })
    expect(fake.lastDescriptor().sort).toEqual([{ field: "name", direction: "asc" }])
    // Re-sorting never re-lists, and folders still come first.
    expect(fake.api.dir.open).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(rows("left")[1]).toHaveTextContent("dir000000"))
  })

  it("Ctrl+H shows hidden and system entries without a rescan", async () => {
    const fake = await start()
    const shown = await within(grid("left")).findByText("secret")
    expect(shown.closest("[role=row]")).toHaveClass("text-muted")
    const opens = fake.api.dir.open.mock.calls.length
    await key("left", { key: "h", ctrlKey: true })
    expect(fake.lastDescriptor()).toMatchObject({ scope: "all", showHidden: false })
    await waitFor(() => expect(within(grid("left")).queryByText("secret")).toBeNull())
    await key("left", { key: "h", ctrlKey: true })
    expect(fake.lastDescriptor()).toMatchObject({ scope: "all", showHidden: true })
    expect(fake.api.dir.open.mock.calls.length).toBe(opens)
    const secret = await within(grid("left")).findByText("secret")
    expect(secret.closest("[role=row]")).toHaveClass("text-muted")
  })

  it("resizes columns and persists the widths and sort per panel", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fake = await start()
    await waitFor(() => expect(rows("left").length).toBeGreaterThan(2))
    const handle = within(grid("left")).getByTestId("resize-ext")
    await act(async () => {
      fireEvent.mouseDown(handle, { clientX: 100 })
      fireEvent.mouseMove(document, { clientX: 140 })
      fireEvent.mouseUp(document, { clientX: 140 })
    })
    expect(useListingStore.getState().left.columns.ext).toBe(DEFAULT_COLUMNS.ext + 40)
    const extHeader = grid("left").querySelector<HTMLElement>("[data-column-header=ext]")!
    expect(extHeader.style.width).toBe(`${DEFAULT_COLUMNS.ext + 40}px`)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    const stored = readStoredPanels(fake.settings[PANELS_KEY])
    expect(stored.left).toMatchObject({
      tabs: [{ path: HOME.path }],
      columns: { ext: DEFAULT_COLUMNS.ext + 40 },
    })
  })

  it("restores the folders, sorts and active panel stored before tabs (v1)", async () => {
    const fake = await start({
      settings: {
        [PANELS_KEY]: {
          v: 1,
          active: "right",
          left: { path: PICS.path, sort: { field: "size", direction: "desc" }, showHidden: false },
          right: { path: HOME.path, showHidden: true, columns: { ext: 90, size: 2 } },
        },
      },
    })
    expect(usePanelsStore.getState().active).toBe("right")
    await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(PICS.path))
    const { left, right } = useListingStore.getState()
    expect(left.sort).toEqual({ field: "size", direction: "desc" })
    expect(right.showHidden).toBe(true)
    // Invalid widths fall back to the defaults.
    expect(right.columns).toEqual({ ...DEFAULT_COLUMNS, ext: 90 })
    // No home lookup: both panels had a folder.
    expect(fake.api.dir.open.mock.calls.map(([p]) => p.path).sort()).toEqual(
      [HOME.path, PICS.path].sort(),
    )
  })

  it("tabs stored while hidden entries were off by default show them after the update", async () => {
    const fake = await start({
      settings: {
        [SETTINGS_KEY]: { v: 2, showHidden: false },
        [PANELS_KEY]: {
          v: 3,
          active: "left",
          left: { tabs: [{ path: HOME.path, showHidden: false }] },
          right: { tabs: [{ path: PICS.path, showHidden: false }] },
        },
      },
    })
    await within(grid("left")).findByText("secret")
    expect(useListingStore.getState().right.showHidden).toBe(true)
    // Once: the settings are stored as v3, where an explicit off stays off.
    await waitFor(() =>
      expect(fake.settings[SETTINGS_KEY]).toMatchObject({ v: 5, showHidden: true }),
    )
  })

  it("the setting switches hidden entries in every panel and tab", async () => {
    const fake = await start()
    await within(grid("left")).findByText("secret")
    const opens = fake.api.dir.open.mock.calls.length
    act(() => showHiddenEverywhere(false))
    await waitFor(() => expect(within(grid("left")).queryByText("secret")).toBeNull())
    const { left, right } = useListingStore.getState()
    expect([left.showHidden, right.showHidden]).toEqual([false, false])
    expect(useTabsStore.getState().left.tabs.every((t) => !t.showHidden)).toBe(true)
    expect(fake.api.dir.open.mock.calls.length).toBe(opens)
    act(() => showHiddenEverywhere(true))
    await within(grid("left")).findByText("secret")
  })

  it('disables ".." and "/" at the drive root, where they have nowhere to go', async () => {
    await start({ folders: [home(), pics(), folder(1, ROOT.path, [ROOT], 1, 0)] })
    await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(HOME.path))
    expect(screen.getByTestId("up-left")).toBeEnabled()
    expect(screen.getByTestId("root-left")).toBeEnabled()
    await act(async () => fireEvent.click(screen.getByTestId("root-left")))
    await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(ROOT.path))
    expect(screen.getByTestId("up-left")).toBeDisabled()
    expect(screen.getByTestId("root-left")).toBeDisabled()
    // The server button is apart from the drives, and named by its text.
    expect(screen.getByTestId("connections-left")).toHaveAccessibleName("FTP")
  })

  it("shows the status line: count, listing progress with Stop, free space", async () => {
    const fake = await start(HIDDEN_OFF)
    await waitFor(() => expect(screen.getByTestId("status-left")).toHaveTextContent("5 entries"))
    await waitFor(() =>
      expect(screen.getByTestId("free-left")).toHaveTextContent("2.0 GB free of 8.0 GB"),
    )
    const { scanId, dirId } = useListingStore.getState().left
    await act(async () =>
      fake.emit("index.progress", {
        scanId,
        dirId: dirId!,
        recursive: false,
        state: "running",
        dirsListed: 0,
        dirsPending: 1,
        entries: 1200,
        skipped: 0,
        errors: 0,
        elapsedMs: 5,
      }),
    )
    expect(screen.getByTestId("status-left")).toHaveTextContent("Listing… 1,200 entries so far")
    fireEvent.click(within(screen.getByTestId("status-left")).getByRole("button", { name: "Stop" }))
    expect(fake.api.dir.cancelScan).toHaveBeenCalledWith(scanId)
  })

  it.each([
    [{ code: "NOT_FOUND" as const, message: "x" }, "notFound", "Folder not found"],
    [{ code: "PERMISSION_DENIED" as const, message: "x" }, "denied", "Permission denied"],
    [
      { code: "INVALID_PATH" as const, message: "x", details: { reason: "notReady" } },
      "notReady",
      "Drive not ready",
    ],
    [
      { code: "INVALID_PATH" as const, message: "x", details: { reason: "network" } },
      "network",
      "Network location unavailable",
    ],
  ])("shows the %s state, and Back returns to the listing", async (failure, kind, title) => {
    const fake = await start({ fail: { "E:\\": failure } })
    await waitFor(() => expect(rows("left").length).toBeGreaterThan(2))
    // Path bar: Alt+D edits; errors stay inline and the listing stays.
    await act(async () => fireEvent.keyDown(grid("left"), { key: "d", altKey: true }))
    const input = screen.getByRole("textbox", { name: "Path" })
    fireEvent.change(input, { target: { value: "E:\\" } })
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }))
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.queryByTestId("error-left")).not.toBeInTheDocument()
    await act(async () => fireEvent.keyDown(input, { key: "Escape" }))
    // Any other navigation shows the panel's error state.
    const { openPath } = await import("./features/listing")
    await act(async () => openPath("left", "E:\\"))
    const state = screen.getByTestId("error-left")
    expect(state).toHaveAttribute("data-kind", kind)
    expect(state).toHaveTextContent(title)
    fireEvent.click(within(state).getByRole("button", { name: "Back" }))
    expect(screen.queryByTestId("error-left")).not.toBeInTheDocument()
    expect(screen.getByTestId("path-left")).toHaveTextContent(HOME.path)
    expect(fake.api.dir.open).toHaveBeenCalledWith({ path: "E:\\", recursive: false, lane: "left" })
  })

  it("shows an empty folder state", async () => {
    await start({
      folders: [folder(10, HOME.path, [ROOT, HOME], 0, 0)],
    })
    expect(await screen.findAllByText("This folder is empty")).toHaveLength(2)
  })

  it("formats attributes as rhsa on Windows and rwx elsewhere", () => {
    const { readOnly, hidden, archive, executable } = ENTRY_ATTRS
    expect(formatAttrs(readOnly | hidden | archive, true)).toBe("rh-a")
    expect(formatAttrs(0, true)).toBe("----")
    expect(formatAttrs(executable, false)).toBe("rwx-")
    expect(formatAttrs(readOnly | hidden, false)).toBe("r--h")
  })
})

describe("the shared context, part 1 (Stage C01)", () => {
  it("opens the viewer's folder in the active panel with the cursor on its focused tile", async () => {
    const fake = await start({
      context: {
        version: 3,
        app: "viewer",
        dirId: 10,
        path: HOME.path,
        focusId: 10_000_003,
        selectionCount: 0,
        selectionTooLarge: false,
      },
      settings: {
        [PANELS_KEY]: {
          v: 1,
          active: "left",
          left: { path: PICS.path },
          right: { path: PICS.path },
        },
      },
    })
    expect(fake.api.dir.openEntry).toHaveBeenCalledWith({
      entryId: 10,
      recursive: false,
      lane: "left",
    })
    await waitFor(() => expect(cursorRow("left")).toHaveTextContent("file000001"))
    // The inactive panel keeps its own folder.
    expect(screen.getByTestId("path-right")).toHaveTextContent(PICS.path)
  })

  it("applies a newer context when shown; the same folder moves nothing", async () => {
    const fake = await start()
    await waitFor(() => expect(rows("left").length).toBeGreaterThan(2))
    await key("left", { key: "ArrowDown" })
    // The viewer is on the same folder: cursor and listing stay.
    fake.setContext({ app: "viewer", dirId: 10, path: HOME.path, focusId: 10_000_004 })
    const opens = fake.api.dir.openEntry.mock.calls.length
    await act(async () => fake.emit("app.visibility", { app: "commander", visible: true }))
    expect(fake.api.dir.openEntry.mock.calls.length).toBe(opens)
    expect(useListingStore.getState().left.cursor).toBe(1)
    // A different folder opens in the active panel.
    fake.setContext({ app: "viewer", dirId: 10_000_000, path: PICS.path, focusId: null })
    await act(async () => applyContext())
    await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(PICS.path))
    // A deleted folder shows the usual "not found" state.
    fake.setContext({ app: "viewer", dirId: 999, path: "C:\\gone", focusId: null })
    await act(async () => applyContext())
    expect(screen.getByTestId("error-left")).toHaveAttribute("data-kind", "notFound")
  })

  it("publishes the active panel's folder and cursor entry, then switches", async () => {
    const fake = await start()
    await waitFor(() => expect(rows("left").length).toBeGreaterThan(2))
    await key("left", { key: "ArrowDown" })
    await key("left", { key: "ArrowDown" })
    fake.api.context.publish.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Switch to Viewer" }))
    await waitFor(() => expect(fake.api.app.switch).toHaveBeenCalledWith("viewer"))
    expect(fake.api.context.publish).toHaveBeenCalledWith(10, 10_000_001, null)
    expect(fake.api.context.publish.mock.invocationCallOrder[0]!).toBeLessThan(
      fake.api.app.switch.mock.invocationCallOrder[0]!,
    )
  })

  it("names this app in the context when its active folder changes while visible", async () => {
    const fake = await start()
    await waitFor(() => expect(fake.api.context.publish).toHaveBeenCalledWith(10, null, undefined))
    await act(async () => fake.emit("app.visibility", { app: "commander", visible: false }))
    fake.api.context.publish.mockClear()
    const { openPath } = await import("./features/listing")
    await act(async () => openPath("left", PICS.path))
    expect(fake.api.context.publish).not.toHaveBeenCalled()
  })
})
