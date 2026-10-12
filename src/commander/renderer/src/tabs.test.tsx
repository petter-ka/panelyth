import type { Crumb } from "@panelyth/contracts"
import { useInterfaceSizeStore } from "@panelyth/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { resetCarry, startPanels } from "./features/carry"
import { resetDrives, startDrives } from "./features/drives"
import { resetHotlist, startHotlist } from "./features/hotlist"
import { resetKeymap } from "./features/keymap"
import { resetListing, useListingStore } from "./features/listing"
import { resetMarks } from "./features/marks"
import { usePanelsStore } from "./features/panels"
import { PANELS_KEY, readStoredPanels } from "./features/session"
import { loadSettings, resetSettings, SETTINGS_KEY } from "./features/settings"
import { captureActive, MAX_CLOSED_TABS, resetTabs, useTabsStore } from "./features/tabs"
import {
  loadTabSets,
  MAX_TAB_SETS,
  readTabSets,
  resetTabSets,
  TAB_SETS_KEY,
  useTabSetsStore,
} from "./features/tabsets"
import { folder, installFakeCommander, type FakeOptions } from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// Stage C10.5: the tab bar with "+", rename, duplicate, reopen, and saved
// tab sets (docs/commander/stages/C10.5-tabs-tree-ftp-compare.md).

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const HOME: Crumb = { name: "home", path: "C:\\home" }
const PICS: Crumb = { name: "pics", path: "C:\\home\\pics" }
const WORK: Crumb = { name: "work", path: "C:\\work" }

const folders = () => [
  folder(10, HOME.path, [ROOT, HOME], 2, 3),
  folder(10_000_000, PICS.path, [ROOT, HOME, PICS], 0, 4),
  folder(30, WORK.path, [ROOT, WORK], 1, 2),
  folder(40, ROOT.path, [ROOT], 3, 0),
]

let stops: (() => void)[] = []

async function start(options: Partial<FakeOptions> = {}) {
  const fake = installFakeCommander({ folders: folders(), home: HOME.path, ...options })
  render(<AppShell />)
  await act(async () => {
    stops.push(startDrives(), startHotlist())
    stops.push(await startPanels())
    await loadSettings()
    await loadTabSets()
  })
  return fake
}

type Side = "left" | "right"
const grid = (side: Side) => screen.getByTestId(`grid-${side}`)
const path = (side: Side) => screen.getByTestId(`path-${side}`)
const key = (side: Side, init: KeyboardEventInit & { key: string }) =>
  act(async () => {
    fireEvent.keyDown(grid(side), init)
  })
const tabsOf = (side: Side) => useTabsStore.getState()[side]
const tabEls = (side: Side) => [
  ...screen.getByTestId(`tabs-${side}`).querySelectorAll<HTMLElement>("[role=tab]"),
]
const click = (el: HTMLElement) =>
  act(async () => {
    fireEvent.click(el)
  })
const tabMenu = async (side: Side, index: number, entry: string) => {
  await act(async () => {
    fireEvent.contextMenu(screen.getByTestId(`tab-${side}-${index}`))
  })
  await click(within(screen.getByTestId(`tab-menu-${side}`)).getByText(entry))
}
/** Two tabs in the left panel: home, then pics (shown). */
async function twoTabs() {
  await key("left", { key: "t", ctrlKey: true })
  await key("left", { key: "ArrowDown" })
  await key("left", { key: "Enter" })
  await waitFor(() => expect(path("left")).toHaveTextContent(PICS.path))
}

beforeEach(() => {
  mockViewport(800, 600)
  resetListing()
  resetCarry()
  resetBridgeCache()
  resetTabs()
  resetTabSets()
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

describe("the tab bar", () => {
  it("is there with one tab and adds a tab with its + button, by mouse alone", async () => {
    const fake = await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    expect(tabEls("left")).toHaveLength(1)
    // One tab cannot be closed: no close button.
    expect(within(tabEls("left")[0]!).queryByRole("button")).toBeNull()

    const opens = fake.api.query.open.mock.calls.length
    await click(screen.getByTestId("tab-new-right"))
    // The button belongs to its panel, which becomes the active one.
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId("tab-new-right"))
    })
    expect(usePanelsStore.getState().active).toBe("right")
    expect(tabEls("right")).toHaveLength(2)
    expect(tabsOf("right").active).toBe(1)
    // The new tab takes over the visible session: nothing is opened.
    expect(fake.api.query.open.mock.calls.length).toBe(opens)

    // × on the visible tab closes it.
    await click(within(tabEls("right")[1]!).getByRole("button", { name: "Close home" }))
    await waitFor(() => expect(tabEls("right")).toHaveLength(1))
  })

  it("hides with one tab when the setting says so", async () => {
    await start({ settings: { [SETTINGS_KEY]: { v: 2, tabBar: "multiple" } } })
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await waitFor(() => expect(screen.queryByTestId("tabs-left")).toBeNull())
    await key("left", { key: "t", ctrlKey: true })
    expect(tabEls("left")).toHaveLength(2)
  })

  it("renames a tab in place; an empty name or the folder's name shows the folder again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fake = await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await act(async () => {
      fireEvent.doubleClick(tabEls("left")[0]!)
    })
    const field = screen.getByRole("textbox", { name: "Tab name" })
    expect(field).toHaveValue("home")
    fireEvent.change(field, { target: { value: "  Holiday  " } })
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" })
    })
    expect(tabsOf("left").tabs[0]!.title).toBe("Holiday")
    expect(tabEls("left")[0]).toHaveTextContent("Holiday")
    // The keys are back in the panel.
    await waitFor(() => expect(document.activeElement).toBe(grid("left")))

    // The title is part of the stored session (v3) and survives a folder change.
    await key("left", { key: "ArrowDown" })
    await key("left", { key: "Enter" })
    await waitFor(() => expect(path("left")).toHaveTextContent(PICS.path))
    expect(tabEls("left")[0]).toHaveTextContent("Holiday")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    const stored = fake.settings[PANELS_KEY] as { v: number }
    expect(stored.v).toBe(3)
    expect(readStoredPanels(stored).left?.tabs[0]?.title).toBe("Holiday")

    // Esc leaves the name alone.
    await tabMenu("left", 0, "Rename tab…")
    const again = screen.getByRole("textbox", { name: "Tab name" })
    fireEvent.change(again, { target: { value: "Other" } })
    await act(async () => {
      fireEvent.keyDown(again, { key: "Escape" })
    })
    expect(tabsOf("left").tabs[0]!.title).toBe("Holiday")

    // The folder's own name means no title.
    await tabMenu("left", 0, "Rename tab…")
    fireEvent.change(screen.getByRole("textbox", { name: "Tab name" }), {
      target: { value: "pics" },
    })
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Tab name" }), { key: "Enter" })
    })
    expect(tabsOf("left").tabs[0]!.title).toBe("")
  })

  it("reads a v2 session: tabs without titles", () => {
    const stored = readStoredPanels({
      v: 2,
      active: "left",
      left: { tabs: [{ path: HOME.path, locked: true }], active: 0 },
    })
    expect(stored.v).toBe(3)
    expect(stored.left?.tabs[0]).toMatchObject({ path: HOME.path, title: "", locked: true })
  })

  it("duplicates a tab that is not shown without opening a session", async () => {
    const fake = await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await twoTabs()
    const opens = fake.api.query.open.mock.calls.length
    await tabMenu("left", 0, "Duplicate tab")
    // The shown tab's record is brought up to date when it is read for saving or leaving.
    captureActive("left")
    expect(tabsOf("left").tabs.map((t) => t.path)).toEqual([HOME.path, HOME.path, PICS.path])
    expect(tabsOf("left").active).toBe(2)
    expect(new Set(tabsOf("left").tabs.map((t) => t.id)).size).toBe(3)
    expect(fake.api.query.open.mock.calls.length).toBe(opens)
    // A copy of the shown tab is a new tab on the same folder, with its title.
    useTabsStore.setState((s) => ({
      left: {
        ...s.left,
        tabs: s.left.tabs.map((t, i) => (i === 2 ? { ...t, title: "Mine" } : t)),
      },
    }))
    await tabMenu("left", 2, "Duplicate tab")
    expect(tabsOf("left").active).toBe(3)
    expect(tabsOf("left").tabs[3]).toMatchObject({ path: PICS.path, title: "Mine" })
  })

  it("closes the tabs to the right, except locked ones", async () => {
    await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await twoTabs()
    await key("left", { key: "t", ctrlKey: true })
    await key("left", { key: "t", ctrlKey: true })
    expect(tabsOf("left").tabs).toHaveLength(4)
    await tabMenu("left", 2, "Lock tab")
    // The shown tab (3) is among those that close: tab 0 shows first.
    await tabMenu("left", 0, "Close tabs to the right")
    await waitFor(() => expect(tabsOf("left").tabs).toHaveLength(2))
    expect(tabsOf("left").tabs.map((t) => t.locked)).toEqual([false, true])
    expect(tabsOf("left").active).toBe(0)
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
  })

  it("reopens closed tabs where they were, newest first, by key", async () => {
    await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await twoTabs()
    // Close pics (shown), then nothing is left to close but home.
    await key("left", { key: "w", ctrlKey: true })
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    expect(tabsOf("left").tabs).toHaveLength(1)

    await key("left", { key: "T", ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(path("left")).toHaveTextContent(PICS.path))
    expect(tabsOf("left").tabs.map((t) => t.path)).toEqual([HOME.path, PICS.path])
    expect(tabsOf("left").active).toBe(1)
    // Nothing more to bring back.
    await key("left", { key: "T", ctrlKey: true, shiftKey: true })
    expect(tabsOf("left").tabs).toHaveLength(2)
  })

  it("remembers at most ten closed tabs", async () => {
    await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    for (let i = 0; i < MAX_CLOSED_TABS + 3; i++) {
      await key("left", { key: "t", ctrlKey: true })
      await key("left", { key: "w", ctrlKey: true })
      await waitFor(() => expect(tabsOf("left").tabs).toHaveLength(1))
    }
    for (let i = 0; i < MAX_CLOSED_TABS + 3; i++) {
      await key("left", { key: "T", ctrlKey: true, shiftKey: true })
    }
    await waitFor(() => expect(tabsOf("left").tabs).toHaveLength(1 + MAX_CLOSED_TABS))
  })
})

describe("tab sets", () => {
  const save = async (name: string, both = false) => {
    await tabMenu("left", 0, "Save tabs…")
    const dialog = screen.getByRole("dialog", { name: "Save tabs" })
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: name },
    })
    if (both) await click(within(dialog).getByRole("radio", { name: /Both panels/ }))
    await click(within(dialog).getByRole("button", { name: "Save" }))
  }

  it("saves a panel's tabs under a name and opens them again in place of the tabs", async () => {
    const fake = await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await twoTabs()
    await tabMenu("left", 0, "Lock tab")
    await save("Trip")
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.getByTestId("files-notice")).toHaveTextContent("Tab set “Trip” saved.")
    const stored = readTabSets(fake.settings[TAB_SETS_KEY])
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ name: "Trip", panels: [{ active: 1 }] })
    expect(stored[0]!.panels[0]!.tabs.map((t) => [t.path, t.locked])).toEqual([
      [HOME.path, true],
      [PICS.path, false],
    ])

    // The right panel (one tab on home) opens the set: one session, for the shown tab.
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId("panel-right"))
    })
    const opens = fake.api.query.open.mock.calls.length
    await key("right", { key: "ArrowDown" })
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId("tab-right-0"))
    })
    await click(within(screen.getByTestId("tab-menu-right")).getByText("Tab sets…"))
    const dialog = screen.getByRole("dialog", { name: "Tab sets" })
    expect(within(dialog).getByRole("option", { name: /Trip/ })).toHaveTextContent("2 tabs")
    await click(within(dialog).getByRole("button", { name: "Open" }))
    await waitFor(() => expect(path("right")).toHaveTextContent(PICS.path))
    expect(tabsOf("right").tabs.map((t) => [t.path, t.locked])).toEqual([
      [HOME.path, true],
      [PICS.path, false],
    ])
    expect(tabsOf("right").active).toBe(1)
    expect(fake.api.query.open.mock.calls.length).toBe(opens + 1)
    // The tab it replaced can be brought back.
    await key("right", { key: "T", ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(tabsOf("right").tabs).toHaveLength(3))
  })

  it("adds a set after the current tabs, and asks before closing locked tabs", async () => {
    await start({
      settings: {
        [TAB_SETS_KEY]: {
          v: 1,
          sets: [{ id: 4, name: "Work", panels: [{ tabs: [{ path: WORK.path, name: "work" }] }] }],
        },
      },
    })
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    expect(useTabSetsStore.getState().sets).toHaveLength(1)

    await tabMenu("left", 0, "Tab sets…")
    await click(screen.getByRole("button", { name: "Add to the tabs" }))
    await waitFor(() => expect(path("left")).toHaveTextContent(WORK.path))
    expect(tabsOf("left").tabs.map((t) => t.path)).toEqual([HOME.path, WORK.path])
    expect(tabsOf("left").active).toBe(1)

    // A locked tab would close: the first "Open" only says so.
    await tabMenu("left", 0, "Lock tab")
    await tabMenu("left", 0, "Tab sets…")
    await click(screen.getByRole("button", { name: "Open" }))
    expect(screen.getByRole("alert")).toHaveTextContent("This closes 1 locked tab.")
    expect(tabsOf("left").tabs).toHaveLength(2)
    await click(screen.getByRole("button", { name: "Open" }))
    await waitFor(() => expect(tabsOf("left").tabs.map((t) => t.path)).toEqual([WORK.path]))
  })

  it("saves and opens both panels' tabs, replaces a set of the same name, renames and removes", async () => {
    const fake = await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await waitFor(() => expect(path("right")).toHaveTextContent(HOME.path))
    await twoTabs()
    await save("Both", true)
    expect(readTabSets(fake.settings[TAB_SETS_KEY])[0]!.panels).toHaveLength(2)

    // The same name again: said in the dialog, and the set is replaced.
    await key("left", { key: "w", ctrlKey: true })
    await waitFor(() => expect(tabsOf("left").tabs).toHaveLength(1))
    await tabMenu("left", 0, "Save tabs…")
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "both" } })
    expect(screen.getByRole("status")).toHaveTextContent("will be replaced")
    await click(screen.getByRole("button", { name: "Save" }))
    const sets = readTabSets(fake.settings[TAB_SETS_KEY])
    expect(sets).toHaveLength(1)
    expect(sets[0]!.panels).toHaveLength(1)

    await tabMenu("left", 0, "Tab sets…")
    const dialog = screen.getByRole("dialog", { name: "Tab sets" })
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "Renamed" },
    })
    await click(within(dialog).getByRole("button", { name: "Rename" }))
    expect(readTabSets(fake.settings[TAB_SETS_KEY])[0]!.name).toBe("Renamed")
    await click(within(dialog).getByRole("button", { name: "Remove" }))
    expect(readTabSets(fake.settings[TAB_SETS_KEY])).toEqual([])
    expect(within(dialog).getByText(/No tab sets yet/)).toBeInTheDocument()
  })

  it("opens a set of both panels in both, whichever panel asked", async () => {
    await start({
      settings: {
        [TAB_SETS_KEY]: {
          v: 1,
          sets: [
            {
              id: 1,
              name: "Pair",
              panels: [
                { tabs: [{ path: WORK.path, name: "work" }], active: 0 },
                { tabs: [{ path: ROOT.path }, { path: PICS.path, title: "P" }], active: 1 },
              ],
            },
          ],
        },
      },
    })
    await waitFor(() => expect(path("right")).toHaveTextContent(HOME.path))
    await tabMenu("right", 0, "Tab sets…")
    expect(screen.getByRole("option", { name: /Pair/ })).toHaveTextContent(
      "Left: 1 tab · Right: 2 tabs",
    )
    await click(screen.getByRole("button", { name: "Open" }))
    await waitFor(() => expect(path("left")).toHaveTextContent(WORK.path))
    await waitFor(() => expect(path("right")).toHaveTextContent(PICS.path))
    expect(tabsOf("right").tabs.map((t) => t.title)).toEqual(["", "P"])
    expect(useListingStore.getState().right.dirId).toBe(10_000_000)
  })

  it("drops stored sets of an unknown shape and never reads more than fifty", () => {
    expect(readTabSets(null)).toEqual([])
    expect(readTabSets({ v: 2, sets: [] })).toEqual([])
    const ok = { id: 1, name: " A ", panels: [{ tabs: [{ path: HOME.path }], active: 9 }] }
    const read = readTabSets({
      v: 1,
      sets: [
        ok,
        { ...ok, id: 1, name: "same id" },
        { ...ok, id: 2, name: "" },
        { ...ok, id: 3, panels: [] },
        { ...ok, id: 4, panels: [{ tabs: [{ path: "" }] }] },
        { ...ok, id: -5 },
        "junk",
      ],
    })
    expect(read).toHaveLength(1)
    expect(read[0]).toMatchObject({ id: 1, name: "A", panels: [{ active: 0 }] })
    const many = Array.from({ length: MAX_TAB_SETS + 5 }, (_, i) => ({ ...ok, id: i + 1 }))
    expect(readTabSets({ v: 1, sets: many })).toHaveLength(MAX_TAB_SETS)
  })

  it("says why nothing was saved without a name", async () => {
    await start()
    await waitFor(() => expect(path("left")).toHaveTextContent(HOME.path))
    await tabMenu("left", 0, "Save tabs…")
    await click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a name for the tab set.")
    expect(useTabSetsStore.getState().sets).toEqual([])
  })
})
