import { ENTRY_ATTRS, type Crumb } from "@fastview/contracts"
import { useInterfaceSizeStore } from "@fastview/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { resetCarry, startPanels } from "./features/carry"
import { buildSpec, DEFAULT_FORM, HISTORY_KEY, resetFind, startFind } from "./features/find"
import { folderPrefix } from "./features/format"
import { resetListing, useListingStore } from "./features/listing"
import { usePanelsStore } from "./features/panels"
import { folder, installFakeCommander, item } from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// Stage C06: find files, branch view and quick filter
// (docs/commander/stages/C06-find-and-branch-view.md).

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const HOME: Crumb = { name: "home", path: "C:\\home" }
const PICS: Crumb = { name: "pics", path: "C:\\home\\pics" }

// home: dir000000 (= pics), dir000001, file000000..2.txt and a hidden secret.txt;
// pics: file000000..3.txt.
const home = () =>
  folder(10, HOME.path, [ROOT, HOME], 2, 3, [
    item(10_000_100, "secret.txt", { attrs: ENTRY_ATTRS.hidden }),
  ])
const pics = () => folder(10_000_000, PICS.path, [ROOT, HOME, PICS], 0, 4)

let stops: (() => void)[] = []

async function start() {
  const fake = installFakeCommander({ folders: [home(), pics()], home: HOME.path, volumes: [] })
  render(<AppShell />)
  await act(async () => {
    stops = [await startPanels(), startFind()]
  })
  await waitFor(() => expect(rows("left").length).toBeGreaterThan(2))
  return fake
}

const grid = (side: "left" | "right") => screen.getByTestId(`grid-${side}`)
const rows = (side: "left" | "right") => grid(side).querySelectorAll("[data-row]")
const key = (side: "left" | "right", init: KeyboardEventInit & { key: string }) =>
  act(async () => {
    fireEvent.keyDown(grid(side), init)
  })
const dialog = () => screen.getByTestId("find-dialog")

/** Alt+F7, a mask, Start search. */
async function search(mask: string) {
  await key("left", { key: "F7", altKey: true })
  const d = dialog()
  fireEvent.change(within(d).getByLabelText("Search for"), { target: { value: mask } })
  await act(async () => {
    fireEvent.click(within(d).getByRole("button", { name: "Start search" }))
  })
}

beforeEach(() => {
  mockViewport(800, 600)
  resetListing()
  resetCarry()
  resetFind()
  resetBridgeCache()
  usePanelsStore.setState({ active: "left", split: 50, layoutToken: 0 })
  useInterfaceSizeStore.setState({ size: "medium" })
})
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
  delete window.fastview
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("find files (Alt+F7)", () => {
  it("searches the panel's folder and streams the results into the Results tab", async () => {
    const fake = await start()
    await key("left", { key: "F7", altKey: true })
    expect(within(dialog()).getByLabelText("Search in")).toHaveValue(HOME.path)
    await search("*.txt")
    expect(fake.api.find.start).toHaveBeenCalledWith(
      expect.objectContaining({
        roots: [HOME.path],
        mask: "*.txt",
        depth: -1,
        hidden: false,
        text: "",
        encodings: [],
        minSize: null,
        attrsSet: 0,
      }),
    )
    expect(screen.getByRole("tab", { name: "Results" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByTestId("find-status")).toHaveTextContent("Searching")
    await act(async () => fake.finishFind(1))
    // home's four .txt files (the search session shows hidden ones) and pics' four.
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(8))
    expect(screen.getByTestId("find-status")).toHaveTextContent("Done: 8 found in 2 folders")
    expect(screen.getAllByRole("option")[4]).toHaveTextContent(`${PICS.path}\\file000000.txt`)
    expect(fake.settings[HISTORY_KEY]).toMatchObject({ masks: ["*.txt"] })
    // Stop is only for running searches.
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled()
  })

  it("Stop cancels the search; closing the dialog cancels and forgets it", async () => {
    const fake = await start()
    await search("*")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    })
    expect(fake.api.find.cancel).toHaveBeenCalledWith(1)
    const queryId = (await fake.api.find.start.mock.results[0]!.value).r.queryId as number
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    })
    expect(screen.queryByTestId("find-dialog")).toBeNull()
    expect(fake.api.query.close).toHaveBeenCalledWith(queryId)
    await waitFor(() => expect(grid("left")).toHaveFocus())
  })

  it("Feed to panel shows the results sorted in the panel; .. goes back to the folder", async () => {
    const fake = await start()
    await search("*.txt")
    await act(async () => fake.finishFind(1))
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(8))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Feed to panel" }))
    })
    expect(screen.queryByTestId("find-dialog")).toBeNull()
    expect(fake.lastDescriptor()).toMatchObject({ findId: 1, recursive: false, scope: "all" })
    expect(fake.api.find.cancel).not.toHaveBeenCalled()
    // The panel hides hidden files as usual: ".." and seven results.
    await waitFor(() => expect(rows("left")).toHaveLength(8))
    expect(screen.getByTestId("location-left")).toHaveTextContent(
      `Search results: *.txt in ${HOME.path}`,
    )
    expect(useListingStore.getState().left.find).toEqual({
      findId: 1,
      label: `*.txt in ${HOME.path}`,
    })
    await key("left", { key: "Backspace" })
    await waitFor(() => expect(screen.queryByTestId("location-left")).toBeNull())
    expect(useListingStore.getState().left.find).toBeNull()
    expect(screen.getByTestId("path-left")).toHaveTextContent(HOME.path)
  })

  it("Go to file opens the result's folder with the cursor on it", async () => {
    const fake = await start()
    await search("*.txt")
    await act(async () => fake.finishFind(1))
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(8))
    const list = screen.getByRole("listbox", { name: "Search results" })
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        fireEvent.keyDown(list, { key: "ArrowDown" })
      })
    }
    await act(async () => {
      fireEvent.keyDown(list, { key: "Enter" })
    })
    // Result 5 is pics' file000001.txt.
    expect(fake.api.dir.openContaining).toHaveBeenCalledWith(10_000_000 * 1_000_000 + 1, "left")
    await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(PICS.path))
    await waitFor(() =>
      expect(grid("left").querySelector("[data-cursor=true]")).toHaveTextContent("file000001"),
    )
  })

  it("rejects an empty start folder and an empty size range", async () => {
    const fake = await start()
    await key("left", { key: "F7", altKey: true })
    fireEvent.change(within(dialog()).getByLabelText("Search in"), { target: { value: " ; " } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start search" }))
    })
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a folder to search in.")
    expect(fake.api.find.start).not.toHaveBeenCalled()
  })
})

describe("the search spec", () => {
  it("converts sizes, whole days and attribute rules", () => {
    const built = buildSpec({
      ...DEFAULT_FORM,
      roots: "C:\\a; D:\\b ;",
      mask: "",
      minSize: "1.5",
      maxSize: "2",
      sizeUnit: "MB",
      after: "2026-10-01",
      before: "2026-10-01",
      attrs: { ...DEFAULT_FORM.attrs, hidden: "set", readOnly: "clear" },
      encoding: "utf-16le",
    })
    expect(built).toEqual({
      spec: expect.objectContaining({
        roots: ["C:\\a", "D:\\b"],
        mask: "*.*",
        minSize: 1.5 * 1024 ** 2,
        maxSize: 2 * 1024 ** 2,
        modifiedAfter: new Date(2026, 9, 1).getTime(),
        modifiedBefore: new Date(2026, 9, 2).getTime(),
        attrsSet: ENTRY_ATTRS.hidden,
        attrsClear: ENTRY_ATTRS.readOnly,
        // Asking for hidden files searches them.
        hidden: true,
        encodings: ["utf-16le"],
      }),
    })
    expect(buildSpec({ ...DEFAULT_FORM, roots: "C:\\", minSize: "5", maxSize: "1" })).toEqual({
      error: "The minimum size is larger than the maximum.",
    })
    expect(buildSpec({ ...DEFAULT_FORM, roots: "C:\\", minSize: "x" })).toEqual({
      error: "Enter sizes as numbers.",
    })
  })
})

describe("folder prefixes", () => {
  it("are relative to the panel's folder", () => {
    expect(folderPrefix(undefined, "C:\\home")).toBe("")
    expect(folderPrefix("C:\\home", "C:\\home")).toBe("")
    expect(folderPrefix("C:\\home\\a\\b", "C:\\home")).toBe("a\\b\\")
    expect(folderPrefix("D:\\other", "C:\\home")).toBe("D:\\other\\")
    expect(folderPrefix("/srv/x", "/")).toBe("srv/x/")
  })
})

describe("branch view (Ctrl+B)", () => {
  it("lists every file below the folder in its lane, and Ctrl+B returns", async () => {
    const fake = await start()
    await key("left", { key: "b", ctrlKey: true })
    expect(fake.api.dir.open).toHaveBeenLastCalledWith({
      path: HOME.path,
      recursive: true,
      lane: "left",
    })
    expect(fake.lastDescriptor()).toMatchObject({ recursive: true })
    // "..", home's three visible files and pics' four.
    await waitFor(() => expect(rows("left")).toHaveLength(8))
    expect(screen.getByTestId("location-left")).toHaveTextContent("Branch view")
    // Files from subfolders show their folder relative to the panel's.
    const prefixes = within(grid("left")).getAllByText("pics\\")
    expect(prefixes).toHaveLength(4)
    expect(prefixes[0]).toHaveClass("text-muted")
    await key("left", { key: "b", ctrlKey: true })
    await waitFor(() => expect(screen.queryByTestId("location-left")).toBeNull())
    expect(fake.lastDescriptor()).toMatchObject({ recursive: false })
  })
})

describe("quick filter (Ctrl+S)", () => {
  it("filters live without a rescan, shows the mask, and Esc clears it", async () => {
    const fake = await start()
    const opens = fake.api.dir.open.mock.calls.length
    await key("left", { key: "s", ctrlKey: true })
    const input = await screen.findByRole("textbox", { name: "Quick filter" })
    await waitFor(() => expect(input).toHaveFocus())
    fireEvent.change(input, { target: { value: "file000001*" } })
    await waitFor(() => expect(fake.lastDescriptor()).toMatchObject({ nameMask: "file000001*" }))
    // Folders always pass: "..", two folders and one file.
    await waitFor(() => expect(rows("left")).toHaveLength(4))
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(screen.getByTestId("filter-left")).toHaveTextContent("file000001*")
    expect(fake.api.dir.open.mock.calls.length).toBe(opens)
    await key("left", { key: "s", ctrlKey: true })
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Quick filter" }), { key: "Escape" })
    })
    await waitFor(() => expect(fake.lastDescriptor().nameMask).toBeUndefined())
    expect(screen.queryByTestId("filter-left")).toBeNull()
  })
})
