import { ENTRY_ATTRS, type Crumb } from "@fastview/contracts"
import { useInterfaceSizeStore } from "@fastview/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { OVERSCAN, ROW_HEIGHT } from "./components/FullView"
import { applyContext, resetCarry, startPanels } from "./features/carry"
import { formatAttrs } from "./features/format"
import { DEFAULT_COLUMNS, pageStoreOf, resetListing, useListingStore } from "./features/listing"
import { usePanelsStore } from "./features/panels"
import { PANELS_KEY, readStoredPanels } from "./features/session"
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
  delete window.fastview
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
    expect(fake.lastDescriptor()).toMatchObject({ scope: "all", showHidden: false })
    await waitFor(() => expect(within(grid("left")).getByText("dir000001")).toBeInTheDocument())
    const first = rows("left")[0] as HTMLElement
    expect(first).toHaveTextContent("..")
    expect(first).toHaveAttribute("data-cursor", "true")
    // Folders first and <DIR>; files split into name and extension; the hidden file is not listed.
    expect(rows("left")[1]).toHaveTextContent("dir000000")
    expect(rows("left")[1]).toHaveTextContent("<DIR>")
    expect(within(grid("left")).getByText("file000000")).toBeInTheDocument()
    expect(within(grid("left")).queryByText("secret")).not.toBeInTheDocument()
    expect(screen.getByTestId("path-left")).toHaveTextContent(HOME.path)
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
    expect(ROW_HEIGHT).toEqual({ small: 20, medium: 22, large: 26 })
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

  it("moves one cursor with arrows, PgUp/PgDn and Home/End", async () => {
    await start()
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
    await waitFor(() => expect(rows("left").length).toBeGreaterThan(2))
    const opens = fake.api.dir.open.mock.calls.length
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

  it("shows the status line: count, listing progress with Stop, free space", async () => {
    const fake = await start()
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
