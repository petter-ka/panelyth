import { DEFAULT_SWITCH_SETTINGS, ENTRY_ATTRS, type Crumb } from "@fastview/contracts"
import { useSwitchSettings } from "@fastview/renderer-core"
import { useInterfaceSizeStore } from "@fastview/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { applyContext, resetCarry, startPanels } from "./features/carry"
import { useUiStore } from "./features/commands"
import { ACTIONS, resetKeymap, setBinding } from "./features/keymap"
import { resetListing, useListingStore } from "./features/listing"
import { PANELS_KEY } from "./features/session"
import { resetMarks, startMarks, useMarksStore } from "./features/marks"
import { usePanelsStore } from "./features/panels"
import { closeQuickSearch, useQuickSearch } from "./features/quicksearch"
import { useSizeJobs } from "./features/sizes"
import { folder, installFakeCommander, item, type FakeOptions } from "./test/fakeApi"
import { mockViewport } from "./test/viewport"
import { markCount } from "@fastview/renderer-core"

// Stage C02: keyboard, marks and quick search
// (docs/commander/stages/C02-keyboard-marks-quick-search.md).

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const HOME: Crumb = { name: "home", path: "C:\\home" }
const PICS: Crumb = { name: "pics", path: "C:\\home\\pics" }
const BIG: Crumb = { name: "big", path: "C:\\big" }

// home: dir000000 (= the pics folder), dir000001, file000000..2.txt, photo.jpg, Photo2.JPG
const home = () =>
  folder(10, HOME.path, [ROOT, HOME], 2, 3, [
    item(10_000_100, "photo.jpg", { kind: "image", sizeBytes: 1000 }),
    item(10_000_101, "Photo2.JPG", { kind: "image", sizeBytes: 3000 }),
    item(10_000_102, "zz.hidden", { attrs: ENTRY_ATTRS.hidden }),
  ])
const pics = () => folder(10_000_000, PICS.path, [ROOT, HOME, PICS], 0, 4)
const big = () => folder(20, BIG.path, [ROOT, BIG], 0, 100_000)

let stops: (() => void)[] = []

async function start(options: Partial<FakeOptions> = {}) {
  const fake = installFakeCommander({
    folders: [home(), pics(), folder(1, ROOT.path, [ROOT], 0, 2)],
    home: HOME.path,
    ...options,
  })
  render(<AppShell />)
  stops.push(startMarks())
  await act(async () => {
    stops.push(await startPanels())
  })
  await waitFor(() => expect(rows("left").length).toBeGreaterThan(2))
  return fake
}

const grid = (side: "left" | "right") => screen.getByTestId(`grid-${side}`)
const rows = (side: "left" | "right") => grid(side).querySelectorAll("[data-row]")
const row = (side: "left" | "right", name: string) =>
  [...grid(side).querySelectorAll<HTMLElement>("[data-id]")].find((r) =>
    r.textContent?.includes(name),
  )!
const cursorRow = (side: "left" | "right") =>
  grid(side).querySelector<HTMLElement>("[data-cursor=true]")
const markedNames = (side: "left" | "right") =>
  [...grid(side).querySelectorAll<HTMLElement>("[data-marked=true]")].map(
    (r) => r.querySelector("[role=gridcell]")?.textContent ?? "",
  )
const key = (
  init: KeyboardEventInit & { key: string; code?: string },
  side: "left" | "right" = "left",
) =>
  act(async () => {
    fireEvent.keyDown(grid(side), init)
  })
const count = (side: "left" | "right") => markCount(useMarksStore.getState()[side])

beforeEach(() => {
  mockViewport(800, 600)
  resetListing()
  resetCarry()
  resetMarks()
  resetKeymap()
  resetBridgeCache()
  closeQuickSearch()
  useSizeJobs.setState({ left: null, right: null })
  useUiStore.setState({ mask: null, lastMask: "*.*" })
  useSwitchSettings.setState(DEFAULT_SWITCH_SETTINGS)
  usePanelsStore.setState({ active: "left", split: 50, layoutToken: 0 })
  useInterfaceSizeStore.setState({ size: "medium" })
})
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
  delete window.fastview
  vi.restoreAllMocks()
})

describe("marks (Stage C02)", () => {
  it("Insert marks and moves down; Space marks in place; the cursor and marks stay separate", async () => {
    await start()
    await key({ key: "ArrowDown" }) // dir000000
    await key({ key: "Insert" })
    expect(cursorRow("left")).toHaveTextContent("dir000001")
    await key({ key: "ArrowDown" })
    await key({ key: " " }) // file000000: marked, the cursor stays
    expect(cursorRow("left")).toHaveTextContent("file000000")
    expect(markedNames("left")).toEqual(["dir000000", "file000000"])
    expect(row("left", "file000000")).toHaveAttribute("aria-selected", "true")
    expect(grid("left")).toHaveAttribute("aria-multiselectable", "true")
    // ".." is never marked: Insert there only moves down.
    await key({ key: "Home" })
    await key({ key: "Insert" })
    expect(count("left")).toBe(2)
    expect(cursorRow("left")).toHaveTextContent("dir000000")
  })

  it("Shift+arrows and Shift+click extend from the anchor; Ctrl+click toggles", async () => {
    await start()
    await key({ key: "ArrowDown" })
    await key({ key: "ArrowDown", shiftKey: true })
    await key({ key: "ArrowDown", shiftKey: true })
    expect(markedNames("left")).toEqual(["dir000000", "dir000001", "file000000"])
    // Shrinks again when Shift moves back.
    await key({ key: "ArrowUp", shiftKey: true })
    expect(markedNames("left")).toEqual(["dir000000", "dir000001"])
    await act(async () => fireEvent.mouseDown(row("left", "photo"), { ctrlKey: true }))
    expect(markedNames("left")).toContain("photo")
    // Rows: dir0, dir1, file0, file1, file2, photo, Photo2; the range is file2..photo.
    await act(async () => fireEvent.mouseDown(row("left", "file000002"), { shiftKey: true }))
    expect(markedNames("left").sort()).toEqual(["dir000000", "dir000001", "file000002", "photo"])
  })

  it("marks all as one range on 100k entries, inverts, and unmarks all", async () => {
    await start({
      folders: [home(), pics(), big(), folder(1, ROOT.path, [ROOT], 0, 2)],
      settings: { [PANELS_KEY]: { v: 1, active: "left", left: { path: BIG.path } } },
    })
    await waitFor(() => expect(useListingStore.getState().left.query?.total).toBe(100_000))
    await key({ key: "a", ctrlKey: true })
    expect(useMarksStore.getState().left.ranges).toEqual([[0, 100_000]])
    expect(count("left")).toBe(100_000)
    await key({ key: " " }, "left") // ".": nothing; move to the first file and unmark it
    await key({ key: "ArrowDown" })
    await key({ key: "Insert" })
    await key({ key: "*", code: "NumpadMultiply" })
    expect(count("left")).toBe(1)
    await key({ key: "-", code: "NumpadSubtract", ctrlKey: true })
    expect(count("left")).toBe(0)
    await waitFor(() =>
      expect(screen.getByTestId("status-left")).toHaveTextContent("100,000 entries"),
    )
  })

  it("marks and unmarks by mask (files only), and marks the cursor's extension", async () => {
    const fake = await start()
    await key({ key: "+", code: "NumpadAdd" })
    const input = screen.getByRole("textbox", { name: "Mask" })
    expect(input).toHaveValue("*.*")
    fireEvent.change(input, { target: { value: "*.txt;*.jpg|file000001.*" } })
    await act(async () => fireEvent.submit(input.closest("form")!))
    expect(fake.api.query.match).toHaveBeenCalledWith(
      expect.any(Number),
      "*.txt;*.jpg|file000001.*",
    )
    await waitFor(() =>
      expect(markedNames("left").sort()).toEqual(["Photo2", "file000000", "file000002", "photo"]),
    )
    await key({ key: "-", code: "NumpadSubtract" })
    const unmark = screen.getByRole("textbox", { name: "Mask" })
    expect(unmark).toHaveValue("*.txt;*.jpg|file000001.*") // the last mask is offered
    fireEvent.change(unmark, { target: { value: "*.jpg" } })
    await act(async () => fireEvent.submit(unmark.closest("form")!))
    await waitFor(() => expect(markedNames("left").sort()).toEqual(["file000000", "file000002"]))
    // Alt+Num+: the cursor's extension (case-insensitive).
    await act(async () => fireEvent.mouseDown(row("left", "photo")))
    await key({ key: "+", code: "NumpadAdd", altKey: true })
    await waitFor(() => expect(markedNames("left")).toContain("Photo2"))
  })

  it("Space on a folder marks it and calculates its size; the status line shows marked sizes", async () => {
    const fake = await start()
    await key({ key: "ArrowDown" })
    await key({ key: " " })
    expect(fake.api.jobs.dirSize).toHaveBeenCalledWith(
      expect.objectContaining({ ranges: [[0, 1]] }),
    )
    expect(useSizeJobs.getState().left?.kind).toBe("dirSize")
    expect(screen.getByTestId("status-left")).toHaveTextContent("Calculating folder sizes…")
    await act(async () => fireEvent.mouseDown(row("left", "Photo2"), { ctrlKey: true }))
    await waitFor(() =>
      expect(screen.getByTestId("marked-left")).toHaveTextContent(
        "2 of 7 marked · 6.9 KB of 31.1 KB",
      ),
    )
    // Stop cancels the job.
    fireEvent.click(within(screen.getByTestId("status-left")).getByRole("button", { name: "Stop" }))
    expect(fake.api.jobs.cancel).toHaveBeenCalled()
  })

  it("rebases marks in Go when the listing changes", async () => {
    const fake = await start()
    await key({ key: "a", ctrlKey: true })
    const q = useListingStore.getState().left.query!
    await act(async () =>
      fake.emit("query.invalidated", {
        queryId: q.queryId,
        version: q.version + 1,
        total: q.total,
      }),
    )
    await waitFor(() => expect(fake.api.selection.rebase).toHaveBeenCalled())
    await waitFor(() => expect(useMarksStore.getState().left.version).toBe(q.version + 1))
    // A new session (sort) starts unmarked.
    await key({ key: "F6", ctrlKey: true })
    await waitFor(() => expect(count("left")).toBe(0))
  })
})

describe("quick search (Stage C02)", () => {
  it("jumps to prefix matches, then substring matches; ↓/↑ cycle; Esc closes", async () => {
    const fake = await start()
    await key({ key: "f" })
    expect(screen.getByTestId("quicksearch-left")).toHaveTextContent("f")
    await waitFor(() => expect(cursorRow("left")).toHaveTextContent("file000000"))
    await key({ key: "ArrowDown" })
    await waitFor(() => expect(cursorRow("left")).toHaveTextContent("file000001"))
    await key({ key: "ArrowUp" })
    await waitFor(() => expect(cursorRow("left")).toHaveTextContent("file000000"))
    // "hoto2": no prefix match, so the substring one.
    await key({ key: "Backspace" })
    for (const c of "hoto2") await key({ key: c })
    await waitFor(() => expect(cursorRow("left")).toHaveTextContent("Photo2"))
    expect(fake.api.query.locate).toHaveBeenLastCalledWith(
      expect.objectContaining({ pattern: "hoto2", direction: "forward" }),
    )
    // Wildcards, and a miss.
    await key({ key: "Escape" })
    expect(screen.queryByTestId("quicksearch-left")).not.toBeInTheDocument()
    for (const c of "d*1") await key({ key: c })
    await waitFor(() => expect(cursorRow("left")).toHaveTextContent("dir000001"))
    await key({ key: "q" })
    await waitFor(() =>
      expect(screen.getByTestId("quicksearch-left")).toHaveAttribute("data-missed", "true"),
    )
    expect(cursorRow("left")).toHaveTextContent("dir000001")
    // Any other key closes the box and acts.
    await key({ key: "Home" })
    expect(useQuickSearch.getState().side).toBeNull()
    expect(cursorRow("left")).toHaveTextContent("..")
  })
})

describe("navigation keys (Stage C02)", () => {
  it("goes to the root, back and forward, and opens folders in either panel", async () => {
    await start()
    await key({ key: "ArrowDown" })
    await key({ key: "Enter" })
    await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(PICS.path))
    await key({ key: "\\", ctrlKey: true })
    await waitFor(() => expect(screen.getByTestId("path-left").textContent).toBe(ROOT.path))
    expect(useListingStore.getState().left.history).toEqual([HOME.path, PICS.path, "C:\\"])
    await key({ key: "ArrowLeft", altKey: true })
    await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(PICS.path))
    await key({ key: "ArrowLeft", altKey: true })
    await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(HOME.path))
    await key({ key: "ArrowRight", altKey: true })
    await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(PICS.path))
    // Ctrl+→ opens the cursor folder (here ".." = the parent) in the right panel.
    await key({ key: "Home" })
    await key({ key: "ArrowRight", ctrlKey: true })
    await waitFor(() => expect(screen.getByTestId("path-right")).toHaveTextContent(HOME.path))
  })

  it("Ctrl+U swaps the panels with their marks", async () => {
    await start({
      settings: {
        [PANELS_KEY]: {
          v: 1,
          active: "left",
          left: { path: HOME.path },
          right: { path: PICS.path },
        },
      },
    })
    await waitFor(() => expect(screen.getByTestId("path-right")).toHaveTextContent(PICS.path))
    await key({ key: "ArrowDown" })
    await key({ key: "Insert" })
    await key({ key: "u", ctrlKey: true })
    expect(screen.getByTestId("path-left")).toHaveTextContent(PICS.path)
    expect(screen.getByTestId("path-right")).toHaveTextContent(HOME.path)
    await waitFor(() => expect(markedNames("right")).toEqual(["dir000000"]))
    expect(within(grid("left")).getByText("file000003")).toBeInTheDocument()
  })
})

describe("keymap (Stage C02)", () => {
  it("dispatches per scope, can be remapped, and lists every action in F1", async () => {
    await start()
    setBinding("mark.invert", ["Mod+i"])
    await key({ key: "i", ctrlKey: true })
    expect(count("left")).toBe(7) // all entries but ".." and the hidden one
    await key({ key: "*", code: "NumpadMultiply" }) // no longer bound
    expect(count("left")).toBe(7)
    await act(async () => fireEvent.keyDown(window, { key: "F1" }))
    const dialog = await screen.findByTestId("shortcuts")
    for (const a of ACTIONS) expect(dialog.querySelector(`[data-action="${a.id}"]`)).not.toBeNull()
    expect(dialog.querySelector('[data-action="mark.invert"]')).toHaveTextContent("Ctrl+I")
  })
})

describe("the shared context, part 2 (Stage C02)", () => {
  it("publishes the marks with the switch", async () => {
    const fake = await start()
    await key({ key: "ArrowDown" })
    await key({ key: "Insert" })
    await key({ key: "Insert" })
    fireEvent.click(screen.getByRole("button", { name: "Switch to Viewer" }))
    await waitFor(() => expect(fake.api.app.switch).toHaveBeenCalled())
    expect(fake.api.context.publish).toHaveBeenLastCalledWith(
      10,
      expect.any(Number),
      // Marked one by one: explicit ids, not a range.
      expect.objectContaining({ ranges: [], include: [10_000_000, 10_000_001] }),
    )
  })

  it("turns the viewer's selection into marks, in the same folder too", async () => {
    const fake = await start()
    fake.setContext({ app: "viewer", dirId: 10, focusId: null }, [10_000_100, 10_000_101, 999])
    await act(async () => applyContext())
    await waitFor(() => expect(markedNames("left").sort()).toEqual(["Photo2", "photo"]))
    // Settings off: no marks carried.
    useSwitchSettings.setState({
      carry: { folder: true, focus: true, selection: false },
      startWith: "last",
      v: 1,
    })
    await key({ key: "-", code: "NumpadSubtract", ctrlKey: true })
    fake.setContext({ app: "viewer", dirId: 10, focusId: null }, [10_000_100])
    await act(async () => applyContext())
    expect(count("left")).toBe(0)
  })

  it("shows a notice when the selection was too large", async () => {
    const fake = await start()
    fake.setContext({ app: "viewer", dirId: 10, selectionTooLarge: true })
    await act(async () => applyContext())
    expect(screen.getByTestId("carry-notice")).toHaveTextContent(
      "The selection is too large to carry over",
    )
    expect(fake.api.context.selection).not.toHaveBeenCalled()
  })

  it("keeps the folder when carrying the folder is off", async () => {
    const fake = await start()
    useSwitchSettings.setState({
      carry: { folder: false, focus: true, selection: true },
      startWith: "last",
      v: 1,
    })
    fake.setContext({ app: "viewer", dirId: 10_000_000, focusId: null })
    await act(async () => applyContext())
    expect(screen.getByTestId("path-left")).toHaveTextContent(HOME.path)
    expect(fake.api.dir.openEntry).not.toHaveBeenCalled()
  })
})
