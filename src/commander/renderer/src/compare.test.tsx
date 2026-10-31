import type { Crumb, TextDiffRow } from "@panelyth/contracts"
import { useInterfaceSizeStore } from "@panelyth/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { resetCarry, startPanels } from "./features/carry"
import {
  compareLabel,
  hashResult,
  resetCompare,
  startCompareEvents,
  symbolOf,
  useCompareStore,
} from "./features/compare"
import { runPanelAction } from "./features/commands"
import { resetDrives } from "./features/drives"
import { resetFiles } from "./features/files"
import { resetHotlist } from "./features/hotlist"
import { resetKeymap } from "./features/keymap"
import {
  moveCursor,
  pageStoreOf,
  parentRows,
  resetListing,
  useListingStore,
} from "./features/listing"
import { markCount } from "@panelyth/renderer-core"
import { resetMarks, useMarksStore } from "./features/marks"
import { usePanelsStore } from "./features/panels"
import { resetQueue, startQueue } from "./features/queue"
import { PANELS_KEY } from "./features/session"
import { readSettings, resetSettings, SETTINGS_KEY, updateSettings } from "./features/settings"
import { resetTabs } from "./features/tabs"
import {
  diffRow,
  folder,
  installFakeCommander,
  item,
  type FakeArchive,
  type FakeOptions,
} from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// Stage C08: compare, synchronize and checksums
// (docs/commander/stages/C08-compare-and-sync.md).

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const WORK: Crumb = { name: "work", path: "C:\\work" }
const BACKUP: Crumb = { name: "Backup", path: "C:\\Backup" }
const T0 = 1_700_000_000_000

const L = 10_000_000
const R = 20_000_000
const folders = () => [
  folder(10, WORK.path, [ROOT, WORK], 1, 0, [
    item(L + 100, "same.txt", { sizeBytes: 5 }),
    item(L + 101, "newer.txt", { sizeBytes: 9, modifiedMs: T0 + 60_000 }),
    item(L + 102, "only-left.txt", { sizeBytes: 1 }),
    item(L + 103, "data.bin", { sizeBytes: 4096 }),
    item(L + 104, "sums.sha256", { sizeBytes: 80 }),
    // A second older than on the right: the same within the FAT tolerance.
    item(L + 105, "fat.txt", { sizeBytes: 3, modifiedMs: T0 - 1000 }),
  ]),
  folder(20, BACKUP.path, [ROOT, BACKUP], 1, 0, [
    item(R + 100, "same.txt", { sizeBytes: 5 }),
    item(R + 101, "newer.txt", { sizeBytes: 3 }),
    item(R + 102, "only-right.txt", { sizeBytes: 1 }),
    item(R + 103, "data.bin", { sizeBytes: 4096 }),
    item(R + 105, "fat.txt", { sizeBytes: 3 }),
  ]),
]

/** A finished compare of the two folders (a mirror: the right side follows the left). */
const C = 6 * 2 ** 50 // compare rows have ids of their own range
const compared = () => [
  diffRow(C + 1, "newer.txt", "leftNewer", "copyRight", { left: 9, right: 3 }),
  diffRow(C + 2, "only-left.txt", "leftOnly", "copyRight", { left: 1 }),
  diffRow(C + 3, "only-right.txt", "rightOnly", "copyLeft", { right: 1 }),
  diffRow(C + 4, "same.txt", "equal", "none", { left: 5, right: 5 }),
  diffRow(C + 5, "edited.txt", "rightNewer", "copyLeft", { dir: "docs", left: 7, right: 8 }),
  diffRow(C + 6, "size.txt", "different", "none", { dir: "docs", left: 7, right: 9 }),
]

let stops: (() => void)[] = []

async function start(options: Partial<FakeOptions> = {}) {
  const fake = installFakeCommander({
    folders: folders(),
    home: WORK.path,
    volumes: [],
    settings: {
      [PANELS_KEY]: {
        v: 2,
        active: "left",
        left: { tabs: [{ path: WORK.path }] },
        right: { tabs: [{ path: BACKUP.path }] },
      },
    },
    ...options,
  })
  render(<AppShell />)
  await act(async () => {
    stops.push(startQueue())
    stops.push(await startPanels())
    stops.push(startCompareEvents())
  })
  await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(WORK.path))
  await waitFor(() => expect(screen.getByTestId("path-right")).toHaveTextContent(BACKUP.path))
  await waitFor(() => expect(rows("left").length).toBeGreaterThan(2))
  await waitFor(() => expect(rows("right").length).toBeGreaterThan(2))
  return fake
}

const grid = (side: "left" | "right") => screen.getByTestId(`grid-${side}`)
const rows = (side: "left" | "right") => [...grid(side).querySelectorAll<HTMLElement>("[data-row]")]
const key = (init: KeyboardEventInit & { key: string }, side: "left" | "right" = "left") =>
  act(async () => {
    fireEvent.keyDown(grid(side), init)
  })
const noticeText = () => screen.getByTestId("files-notice").textContent

/** Puts a panel's cursor on the entry named `name`. */
async function cursorTo(name: string, side: "left" | "right" = "left") {
  const index = () => {
    const p = useListingStore.getState()[side]
    for (let i = 0; i < (p.query?.total ?? 0); i++) {
      if (pageStoreOf(side).getItem(i)?.name === name) return i + parentRows(p)
    }
    return -1
  }
  await waitFor(() => expect(index()).toBeGreaterThanOrEqual(0))
  await act(async () => moveCursor(side, index()))
}

/** The names a panel's marks cover. */
function marked(side: "left" | "right"): string[] {
  const m = useMarksStore.getState()[side]
  const out: string[] = []
  for (const [a, b] of m.ranges) {
    for (let i = a; i < b; i++) out.push(pageStoreOf(side).getItem(i)?.name ?? `#${i}`)
  }
  return out.sort()
}

const run = (action: Parameters<typeof runPanelAction>[1], side: "left" | "right" = "left") =>
  act(async () => runPanelAction(side, action))

beforeEach(() => {
  mockViewport(1200, 800)
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
  resetQueue()
  resetCompare()
  usePanelsStore.setState({ active: "left", split: 50, layoutToken: 0 })
  useInterfaceSizeStore.setState({ size: "medium" })
})
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
  delete window.panelyth
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("compare directories (Shift+F2)", () => {
  it("marks what is unique or newer in each panel, by the date rules in Settings", async () => {
    const fake = await start()
    await key({ key: "F2", shiftKey: true })
    await waitFor(() => expect(noticeText()).toContain("3 marked on the left, 1 on the right"))
    // Newer on the left, or only there; the right keeps its own file.
    expect(marked("left")).toEqual(["newer.txt", "only-left.txt", "sums.sha256"])
    expect(marked("right")).toEqual(["only-right.txt"])
    // Both sessions in one call, with the 2 s tolerance of FAT drives: fat.txt is the same.
    expect(fake.api.compare.marks).toHaveBeenCalledWith(
      expect.objectContaining({ toleranceMs: 2000, dst: false, ignoreDates: false }),
    )
    expect(marked("left")).not.toContain("fat.txt")
    // Folders are never marked.
    expect(marked("left")).not.toContain("dir000000")
  })

  it("replaces the marks and says so when nothing differs", async () => {
    await start({
      folders: [
        folder(10, WORK.path, [ROOT, WORK], 0, 2),
        folder(20, BACKUP.path, [ROOT, BACKUP], 0, 2),
      ],
    })
    // The two folders hold the same two files; an old mark is replaced.
    await act(async () => {
      useMarksStore.setState((s) => ({ left: { ...s.left, ranges: [[0, 1]] } }))
    })
    await key({ key: "F2", shiftKey: true })
    await waitFor(() => expect(noticeText()).toBe("The two panels have the same files."))
    expect(markCount(useMarksStore.getState().left)).toBe(0)
  })

  it("uses exact dates when Settings say so", async () => {
    const fake = await start({
      settings: {
        [PANELS_KEY]: {
          v: 2,
          active: "left",
          left: { tabs: [{ path: WORK.path }] },
          right: { tabs: [{ path: BACKUP.path }] },
        },
      },
    })
    await act(async () => updateSettings({ compareToleranceMs: 0 }))
    await key({ key: "F2", shiftKey: true })
    await waitFor(() => expect(noticeText()).toContain("marked on the left"))
    expect(fake.api.compare.marks).toHaveBeenCalledWith(expect.objectContaining({ toleranceMs: 0 }))
    // A second newer on the right now counts.
    expect(marked("right")).toContain("fat.txt")
    expect(fake.settings[SETTINGS_KEY]).toMatchObject({ compareToleranceMs: 0 })
  })
})

describe("synchronize directories", () => {
  const dialog = () => screen.getByTestId("sync-dialog")
  const table = () => screen.getByTestId("sync-table")
  const tableRows = () => [...table().querySelectorAll<HTMLElement>("[role=option]")]
  const names = () => tableRows().map((r) => r.firstElementChild?.textContent ?? "")
  const rowOf = (name: string) => tableRows().find((r) => r.textContent?.includes(name))!

  async function compare(fake: Awaited<ReturnType<typeof start>>, mirror = false) {
    await run("compare.sync")
    await waitFor(() => expect(dialog()).toBeInTheDocument())
    if (mirror) {
      await act(async () => {
        fireEvent.click(within(dialog()).getByLabelText(/Left to right only/))
      })
    }
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Compare" }))
    })
    await waitFor(() => expect(fake.api.compare.dirs).toHaveBeenCalled())
    await act(async () => fake.finishCompare(fake.openCompares().at(-1)!, compared()))
    await waitFor(() => expect(tableRows().length).toBeGreaterThan(0))
  }

  it("compares the two panels' folders and lists the differences with a direction each", async () => {
    const fake = await start()
    await run("compare.sync")
    expect(within(dialog()).getByLabelText("Left folder")).toHaveValue(WORK.path)
    expect(within(dialog()).getByLabelText("Right folder")).toHaveValue(BACKUP.path)
    expect(screen.getByTestId("sync-status")).toHaveTextContent("press Compare")
    // Nothing to synchronize before a compare.
    expect(within(dialog()).getByRole("button", { name: "Synchronize…" })).toBeDisabled()

    await act(async () => {
      fireEvent.click(within(dialog()).getByLabelText("Compare contents"))
      fireEvent.click(within(dialog()).getByRole("button", { name: "Compare" }))
    })
    await waitFor(() =>
      expect(fake.api.compare.dirs).toHaveBeenCalledWith({
        leftDirId: 10,
        rightDirId: 20,
        toleranceMs: 2000,
        dst: false,
        ignoreDates: false,
        content: true,
        asymmetric: false,
      }),
    )
    expect(screen.getByTestId("sync-status")).toHaveTextContent("Comparing")
    expect(within(dialog()).getByRole("button", { name: "Stop" })).toBeInTheDocument()

    await act(async () => fake.finishCompare(1, compared()))
    // The equal row is hidden by default; rows show their folder below the roots.
    await waitFor(() =>
      expect(names()).toEqual([
        "newer.txt",
        "only-left.txt",
        "only-right.txt",
        "docs/edited.txt",
        "docs/size.txt",
      ]),
    )
    expect(rowOf("newer.txt")).toHaveAttribute("data-action", "copyRight")
    expect(rowOf("newer.txt")).toHaveTextContent("→")
    expect(rowOf("only-right.txt")).toHaveTextContent("←")
    expect(rowOf("size.txt")).toHaveTextContent("≠")
    expect(screen.getByTestId("sync-status")).toHaveTextContent("Compared 12 entries")
    // The filter buttons count every row by symbol.
    await waitFor(() => expect(screen.getByTestId("sync-show-equal")).toHaveTextContent("1"))
    expect(screen.getByTestId("sync-show-copyRight")).toHaveTextContent("2")
    expect(screen.getByTestId("sync-show-equal")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByTestId("sync-summary")).toHaveTextContent(
      "To the right: 2 · to the left: 2 · to delete: 0",
    )
  })

  it("filters by symbol, and gives rows a direction from the keyboard and the buttons", async () => {
    const fake = await start()
    await compare(fake)
    // Show the equal row too.
    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-show-equal"))
    })
    await waitFor(() => expect(names()).toContain("same.txt"))
    expect(fake.api.compare.show).toHaveBeenLastCalledWith(1, [
      "copyRight",
      "copyLeft",
      "equal",
      "different",
      "delete",
    ])
    // Hide what goes to the left: those rows leave the table (and the plan).
    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-show-copyLeft"))
    })
    await waitFor(() => expect(names()).not.toContain("only-right.txt"))
    await waitFor(() =>
      expect(screen.getByTestId("sync-summary")).toHaveTextContent("to the left: 0"),
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-show-copyLeft"))
    })
    await waitFor(() => expect(names()).toContain("only-right.txt"))

    // The cursor row, by key: newer.txt is left alone (≠).
    await act(async () => {
      fireEvent.click(rowOf("newer.txt"))
    })
    await act(async () => {
      fireEvent.keyDown(table(), { key: "=" })
    })
    await waitFor(() => expect(rowOf("newer.txt")).toHaveAttribute("data-action", "none"))
    expect(fake.api.compare.setAction).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ ranges: [[0, 1]] }),
      "none",
    )
    // Backspace restores the direction the compare chose.
    await act(async () => {
      fireEvent.keyDown(table(), { key: "Backspace" })
    })
    await waitFor(() => expect(rowOf("newer.txt")).toHaveAttribute("data-action", "copyRight"))

    // A one-sided entry can be deleted where it is; the doomed side is struck through.
    await act(async () => {
      fireEvent.click(rowOf("only-right.txt"))
    })
    await act(async () => {
      fireEvent.keyDown(table(), { key: "Delete" })
    })
    await waitFor(() =>
      expect(rowOf("only-right.txt")).toHaveAttribute("data-action", "deleteRight"),
    )
    expect(rowOf("only-right.txt")).toHaveTextContent("×")
    await waitFor(() => expect(screen.getByTestId("sync-show-delete")).toHaveTextContent("1"))

    // Several rows at once: Shift+arrows select, the → button sets them.
    await act(async () => {
      fireEvent.click(rowOf("edited.txt"))
    })
    await act(async () => {
      fireEvent.keyDown(table(), { key: "ArrowDown", shiftKey: true })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-set-copyRight"))
    })
    await waitFor(() => expect(rowOf("size.txt")).toHaveAttribute("data-action", "copyRight"))
    expect(rowOf("edited.txt")).toHaveAttribute("data-action", "copyRight")
    // edited.txt is newer on the right: copying over it is marked.
    expect(within(rowOf("edited.txt")).getByText("Replaces a newer file")).toBeInTheDocument()
    // A copy to the left of a left-only entry has no source: Go keeps its direction.
    await act(async () => {
      fireEvent.click(rowOf("only-left.txt"))
    })
    await act(async () => {
      fireEvent.keyDown(table(), { key: "ArrowLeft" })
    })
    await waitFor(() =>
      expect(fake.api.compare.setAction).toHaveBeenLastCalledWith(1, expect.anything(), "copyLeft"),
    )
    expect(rowOf("only-left.txt")).toHaveAttribute("data-action", "copyRight")
  })

  it("confirms what a sync copies and deletes, then starts the job with that plan", async () => {
    const fake = await start()
    await compare(fake, true)
    expect(fake.lastCompare()?.params.asymmetric).toBe(true)
    // only-right.txt is deleted on the right in this plan.
    await act(async () => {
      fireEvent.click(rowOf("only-right.txt"))
    })
    await act(async () => {
      fireEvent.keyDown(table(), { key: "Delete" })
    })
    await waitFor(() =>
      expect(rowOf("only-right.txt")).toHaveAttribute("data-action", "deleteRight"),
    )

    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Synchronize…" }))
    })
    const confirm = screen.getByTestId("sync-confirm")
    expect(confirm).toHaveTextContent(`Copy 2 files (10 B) to the right: ${BACKUP.path}`)
    expect(confirm).toHaveTextContent(`Copy 1 file (8 B) to the left: ${WORK.path}`)
    expect(confirm).toHaveTextContent(`Delete 1 entry on the right: ${BACKUP.path}`)
    expect(confirm).toHaveTextContent("Only the rows the table shows are synchronized")
    // Nothing started yet.
    expect(fake.api.files.start).not.toHaveBeenCalled()

    // Back: the table again.
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Back" }))
    })
    expect(screen.queryByTestId("sync-confirm")).toBeNull()
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Synchronize…" }))
    })
    await act(async () => {
      fireEvent.click(within(dialog()).getByLabelText(/Delete permanently/))
    })
    const version = useCompareStore.getState().sync!.plan!.version
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("sync-confirm")).getByRole("button", { name: "Synchronize" }),
      )
    })
    await waitFor(() =>
      expect(fake.api.files.start).toHaveBeenCalledWith({
        kind: "sync",
        compareId: 1,
        planVersion: version,
        deletePermanently: true,
      }),
    )
    // The dialog closes, its compare is forgotten in Go, and the queue has the job.
    await waitFor(() => expect(screen.queryByTestId("sync-dialog")).toBeNull())
    await waitFor(() => expect(fake.openCompares()).toEqual([]))
    expect(noticeText()).toContain("Synchronizing")
    await waitFor(() => expect(grid("left")).toHaveFocus())
  })

  it("does not start a sync when the table changed after the confirmation", async () => {
    const fake = await start()
    await compare(fake)
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Synchronize…" }))
    })
    // The plan in Go moves on (another filter) while the confirmation shows.
    await act(async () => {
      await fake.api.compare.show(1, ["copyRight"])
    })
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("sync-confirm")).getByRole("button", { name: "Synchronize" }),
      )
    })
    await waitFor(() =>
      expect(within(dialog()).getByRole("alert")).toHaveTextContent(
        "The table changed since you confirmed",
      ),
    )
    expect(screen.getByTestId("sync-dialog")).toBeInTheDocument()
    // The confirmation now shows the plan as it is.
    await waitFor(() =>
      expect(screen.getByTestId("sync-confirm")).not.toHaveTextContent("to the left"),
    )
  })

  it("says why two folders can't be compared, and resolves a typed folder", async () => {
    const fake = await start()
    await run("compare.sync")
    // The same folder on both sides.
    await act(async () => {
      fireEvent.change(within(dialog()).getByLabelText("Right folder"), {
        target: { value: WORK.path },
      })
    })
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Compare" }))
    })
    await waitFor(() =>
      expect(within(dialog()).getByRole("alert")).toHaveTextContent("two separate folders"),
    )
    // The typed path was opened to get its folder id: no path goes to compare.dirs.
    expect(fake.api.dir.open).toHaveBeenCalledWith(expect.objectContaining({ path: WORK.path }))
    expect(fake.api.compare.dirs).toHaveBeenLastCalledWith(
      expect.objectContaining({ leftDirId: 10, rightDirId: 10 }),
    )
    await act(async () => {
      fireEvent.change(within(dialog()).getByLabelText("Right folder"), {
        target: { value: "C:\\nowhere" },
      })
    })
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Compare" }))
    })
    await waitFor(() =>
      expect(within(dialog()).getByRole("alert")).toHaveTextContent("doesn't exist"),
    )
  })

  it("closing the dialog ends its compare; a cancelled compare offers nothing to synchronize", async () => {
    const fake = await start()
    await run("compare.sync")
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Compare" }))
    })
    await waitFor(() => expect(fake.openCompares()).toEqual([1]))
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Stop" }))
    })
    expect(fake.api.compare.cancel).toHaveBeenCalledWith(1)
    await act(async () => fake.finishCompare(1, [], { state: "cancelled" }))
    await waitFor(() => expect(screen.getByTestId("sync-status")).toHaveTextContent("Stopped"))
    expect(within(dialog()).getByRole("button", { name: "Synchronize…" })).toBeDisabled()
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }))
    })
    await waitFor(() => expect(fake.openCompares()).toEqual([]))
    expect(screen.queryByTestId("sync-dialog")).toBeNull()
  })

  it("reports what the compare left out", async () => {
    const fake = await start()
    await run("compare.sync")
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Compare" }))
    })
    await waitFor(() => expect(fake.openCompares()).toEqual([1]))
    await act(async () => fake.finishCompare(1, compared(), { errors: 2, links: 3 }))
    await waitFor(() =>
      expect(screen.getByTestId("sync-status")).toHaveTextContent(
        "2 folders or entries could not be read and were left out. 3 links were not compared.",
      ),
    )
  })
})

describe("compare by content", () => {
  const ROWS: TextDiffRow[] = [
    { op: "equal", l: 1, r: 1, left: "one" },
    { op: "changed", l: 2, r: 2, left: "two", right: "2" },
    { op: "equal", l: 3, r: 3, left: "three" },
    { op: "added", l: 0, r: 4, left: "", right: "four" },
  ]

  it("shows two marked files side by side, line by line", async () => {
    const fake = await start({ textDiff: { rows: ROWS } })
    await cursorTo("same.txt")
    await key({ key: "Insert" })
    await cursorTo("newer.txt")
    await key({ key: "Insert" })
    await run("compare.content")
    const dialog = await screen.findByTestId("diff-dialog")
    await waitFor(() => expect(fake.api.diff.open).toHaveBeenCalledWith(L + 101, L + 100))
    await waitFor(() =>
      expect(screen.getByTestId("diff-status")).toHaveTextContent("2 differences"),
    )
    const side = (s: "left" | "right") => () => [
      ...screen.getByTestId("diff-rows").querySelectorAll(`[data-op][data-side=${s}]`),
    ]
    const lines = side("left")
    const right = side("right")
    await waitFor(() => expect(lines()).toHaveLength(4))
    expect(lines().map((l) => l.getAttribute("data-op"))).toEqual([
      "equal",
      "changed",
      "equal",
      "added",
    ])
    expect(right().map((l) => l.getAttribute("data-op"))).toEqual(
      lines().map((l) => l.getAttribute("data-op")),
    )
    // An equal row shows its text on both sides; an added row only on the right.
    expect(lines()[0]).toHaveTextContent("1one")
    expect(right()[0]).toHaveTextContent("1one")
    expect(lines()[1]).toHaveTextContent("2two")
    expect(right()[1]).toHaveTextContent("22")
    expect(lines()[3]).toHaveTextContent(/^$/)
    expect(right()[3]).toHaveTextContent("4four")
    expect(dialog).toHaveTextContent("UTF-8")
    // One page of rows for the whole view, not a call per line.
    expect(fake.api.diff.page).toHaveBeenCalledTimes(1)
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    })
    await waitFor(() => expect(fake.openDiffs()).toEqual([]))
    expect(screen.queryByTestId("diff-dialog")).toBeNull()
  })

  it("compares the cursor file with the file of the same name in the other panel", async () => {
    const fake = await start({ textDiff: { rows: [ROWS[0]!] } })
    await cursorTo("newer.txt")
    await run("compare.content")
    await waitFor(() => expect(fake.api.diff.open).toHaveBeenCalledWith(L + 101, R + 101))
    await waitFor(() =>
      expect(screen.getByTestId("diff-status")).toHaveTextContent("The files are identical."),
    )
    // From the right panel, the left panel's file is still the left side.
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("diff-dialog")).getByRole("button", { name: "Close" }),
      )
    })
    await cursorTo("same.txt", "right")
    await run("compare.content", "right")
    await waitFor(() => expect(fake.api.diff.open).toHaveBeenLastCalledWith(L + 100, R + 100))
  })

  it("says what is missing instead of comparing", async () => {
    const fake = await start()
    // No file of that name on the other side, and its cursor is on "..".
    await cursorTo("only-left.txt")
    await act(async () => moveCursor("right", 0))
    await run("compare.content")
    await waitFor(() => expect(noticeText()).toContain("no file to compare with"))
    await cursorTo("dir000000")
    await run("compare.content")
    await waitFor(() => expect(noticeText()).toContain("Put the cursor on a file"))
    expect(fake.api.diff.open).not.toHaveBeenCalled()
    expect(screen.queryByTestId("diff-dialog")).toBeNull()
  })

  it("answers identical or not for files that are not text, from a job", async () => {
    const fake = await start({ textDiff: { reason: "binary" } })
    await cursorTo("data.bin")
    await run("compare.content")
    await screen.findByTestId("diff-dialog")
    await waitFor(() =>
      expect(fake.api.files.start).toHaveBeenCalledWith({
        kind: "compareFiles",
        leftId: L + 103,
        rightId: R + 103,
      }),
    )
    expect(screen.getByTestId("diff-dialog")).toHaveTextContent("not text files")
    const jobId = (await fake.api.files.list()).r.jobs.at(-1)!.jobId
    await act(async () =>
      fake.emit(
        "job.progress",
        fake.job({ jobId, kind: "compareFiles", state: "running", bytesTotal: 100, bytesDone: 40 }),
      ),
    )
    await waitFor(() => expect(screen.getByTestId("diff-answer")).toHaveTextContent("40 %"))
    await act(async () =>
      fake.emit(
        "job.progress",
        fake.job({ jobId, kind: "compareFiles", state: "completed", total: 1, done: 1 }),
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("diff-answer")).toHaveTextContent("The files are identical."),
    )
  })

  it("says the files differ, with Go's detail", async () => {
    const fake = await start({ textDiff: { reason: "tooLarge" } })
    fake.api.files.errors.mockResolvedValue({
      ok: true,
      r: {
        errors: [
          {
            name: "data.bin",
            code: "DIFFERENT",
            message: "The files have the same size but differ; the first difference is at byte 12.",
          },
        ],
        total: 1,
      },
    } as never)
    await cursorTo("data.bin")
    await run("compare.content")
    await screen.findByTestId("diff-dialog")
    await waitFor(() => expect(fake.api.files.start).toHaveBeenCalled())
    expect(screen.getByTestId("diff-dialog")).toHaveTextContent("too large for a text comparison")
    const jobId = (await fake.api.files.list()).r.jobs.at(-1)!.jobId
    await act(async () =>
      fake.emit(
        "job.progress",
        fake.job({ jobId, kind: "compareFiles", state: "completed", total: 1, failed: 1 }),
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("diff-answer")).toHaveTextContent("The files are different."),
    )
    await waitFor(() =>
      expect(screen.getByTestId("diff-dialog")).toHaveTextContent("first difference is at byte 12"),
    )
  })

  it("is not offered inside an archive", async () => {
    const archive: FakeArchive = {
      entryId: L + 104,
      archiveId: 3,
      root: [item(2 ** 50 + 1, "a.txt")],
    }
    await start({ archives: [archive] })
    await act(async () => {
      useListingStore.setState((s) => ({
        left: {
          ...s.left,
          archive: {
            archiveId: 3,
            entryId: L + 104,
            name: "x.zip",
            format: "zip",
            dirs: [],
            rejected: 0,
          },
        },
      }))
    })
    await run("compare.content")
    expect(noticeText()).toContain("out of the archive")
    await run("compare.sync")
    expect(noticeText()).toContain("Archives can't be synchronized")
    expect(screen.queryByTestId("sync-dialog")).toBeNull()
  })
})

describe("compare several files (Stage C10.5)", () => {
  const ROWS: TextDiffRow[] = [
    { op: "equal", l: 1, r: 1, left: "one" },
    { op: "changed", l: 2, r: 2, left: "two words", right: "two birds", spans: [4, 8, 4, 8] },
  ]
  const DIFFERENT = "The files differ in size: 9 and 3 bytes."
  const MISSING = "The other folder has no file of this name."

  const mark = async (names: string[], side: "left" | "right" = "left") => {
    for (const name of names) {
      await cursorTo(name, side)
      await key({ key: "Insert" }, side)
    }
  }
  /** The compareFiles job the dialog started, finished with these items. */
  async function finish(
    fake: Awaited<ReturnType<typeof start>>,
    items: [string, "DIFFERENT" | "NOT_FOUND" | "IO_ERROR"][],
    done: number,
    skipped = 0,
  ) {
    fake.api.files.errors.mockResolvedValue({
      ok: true,
      r: {
        errors: items.map(([name, code]) => ({
          name,
          code,
          message: code === "DIFFERENT" ? DIFFERENT : code === "NOT_FOUND" ? MISSING : "I/O error",
        })),
        total: items.length,
      },
    } as never)
    const jobId = (await fake.api.files.list()).r.jobs.at(-1)!.jobId
    await act(async () =>
      fake.emit(
        "job.progress",
        fake.job({
          jobId,
          kind: "compareFiles",
          state: "completed",
          total: done + items.length + skipped,
          done,
          failed: items.length,
          skipped,
        }),
      ),
    )
    return jobId
  }
  const manyRowsOf = () => [
    ...screen.getByTestId("compare-many-rows").querySelectorAll<HTMLElement>("[role=option]"),
  ]

  it("compares one marked file of each panel with each other", async () => {
    const fake = await start({ textDiff: { rows: ROWS } })
    await mark(["newer.txt"])
    await mark(["only-right.txt"], "right")
    expect(compareLabel("left")).toBe("Compare 2 files")
    // From either panel, the left panel's file is the left side.
    await run("compare.content", "right")
    await waitFor(() => expect(fake.api.diff.open).toHaveBeenCalledWith(L + 101, R + 102))
    expect(fake.api.files.start).not.toHaveBeenCalled()
    // What differs inside the changed line is marked on both sides.
    await waitFor(() =>
      expect(
        [...screen.getByTestId("diff-rows").querySelectorAll("mark")].map((m) => m.textContent),
      ).toEqual(["word", "bird"]),
    )
  })

  it("shows the two files in two panes and marks every changed word in its own pane", async () => {
    await start({
      textDiff: {
        rows: [
          { op: "equal", l: 1, r: 1, left: "same line" },
          {
            op: "changed",
            l: 2,
            r: 2,
            left: "the quick brown fox",
            right: "the slow brown cat",
            spans: [4, 9, 4, 8, 16, 19, 15, 18],
          },
        ],
      },
    })
    await mark(["newer.txt"])
    await mark(["only-right.txt"], "right")
    await run("compare.content", "right")
    const rows = await screen.findByTestId("diff-rows")
    await waitFor(() => expect(rows.querySelectorAll("[data-op]")).toHaveLength(4))
    const pane = (side: string) =>
      rows.querySelector<HTMLElement>(`[role=region][data-side=${side}]`)!
    const marks = (side: string) =>
      [...pane(side).querySelectorAll("mark")].map((m) => m.textContent)
    expect(marks("left")).toEqual(["quick", "fox"])
    expect(marks("right")).toEqual(["slow", "cat"])
    // Each pane holds one file's lines: what is not marked stays plain text.
    expect(pane("left")).toHaveTextContent("the quick brown fox")
    expect(pane("left")).not.toHaveTextContent("slow")
    expect(pane("right")).toHaveTextContent("the slow brown cat")
    expect(pane("right")).not.toHaveTextContent("quick")
  })

  it("compares more than two marked files with the other panel as one job, and lists what is not identical", async () => {
    const fake = await start({ textDiff: { rows: ROWS } })
    await mark(["same.txt", "newer.txt", "only-left.txt"])
    expect(compareLabel("left")).toBe("Compare 3 files with the other panel")
    await run("compare.content")
    const dialog = await screen.findByTestId("compare-many")
    await waitFor(() => expect(fake.api.files.start).toHaveBeenCalledTimes(1))
    const params = fake.api.files.start.mock.calls[0]![0] as {
      kind: string
      destinationDirId: number
      source: { selection: { ranges: [number, number][]; include: number[] } }
    }
    expect(params.kind).toBe("compareFiles")
    expect(params.destinationDirId).toBe(20)
    const { ranges, include } = params.source.selection
    expect(ranges.reduce((n, [a, b]) => n + b - a, 0) + include.length).toBe(3)
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "3 marked files, each with the file of its name in C:\\Backup",
    )
    // No file was opened for a diff, and nothing is read by the renderer.
    expect(fake.api.diff.open).not.toHaveBeenCalled()

    const jobId = (await fake.api.files.list()).r.jobs.at(-1)!.jobId
    await act(async () =>
      fake.emit(
        "job.progress",
        fake.job({ jobId, kind: "compareFiles", state: "running", total: 3, done: 1 }),
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("compare-many-status")).toHaveTextContent("Comparing… 1 of 3"),
    )
    await finish(
      fake,
      [
        ["newer.txt", "DIFFERENT"],
        ["only-left.txt", "NOT_FOUND"],
      ],
      1,
    )
    await waitFor(() =>
      expect(screen.getByTestId("compare-many-status")).toHaveTextContent(
        "Identical: 1 · Not identical: 2",
      ),
    )
    await waitFor(() => expect(manyRowsOf()).toHaveLength(2))
    // One request for the job's items, not one per row.
    expect(fake.api.files.errors).toHaveBeenCalledTimes(1)
    expect(manyRowsOf()[0]).toHaveTextContent("newer.txt")
    expect(manyRowsOf()[0]).toHaveTextContent("Different")
    expect(manyRowsOf()[0]).toHaveTextContent(DIFFERENT)
    expect(manyRowsOf()[1]).toHaveTextContent("Missing")
    expect(within(dialog).getByRole("button", { name: "Different 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    expect(within(dialog).getByRole("button", { name: "Not read 0" })).toBeDisabled()

    // A filter button hides its rows.
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Different 1" }))
    })
    expect(manyRowsOf().map((r) => r.dataset.result)).toEqual(["missing"])
    // Enter on a missing file opens nothing.
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("compare-many-rows"), { key: "Enter" })
    })
    expect(fake.api.diff.open).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Different 1" }))
    })
    expect(manyRowsOf()).toHaveLength(2)

    // Enter on the differing file: the pair side by side; the list steps aside and comes back.
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("compare-many-rows"), { key: "Enter" })
    })
    await waitFor(() => expect(fake.api.diff.open).toHaveBeenCalledWith(L + 101, R + 101))
    await screen.findByTestId("diff-dialog")
    expect(screen.queryByTestId("compare-many")).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to the list" }))
    })
    await waitFor(() => expect(screen.queryByTestId("diff-dialog")).toBeNull())
    expect(manyRowsOf()).toHaveLength(2)
    expect(manyRowsOf()[0]).toHaveAttribute("aria-selected", "true")

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("compare-many")).getByRole("button", { name: "Close" }),
      )
    })
    expect(useCompareStore.getState().many).toBeNull()
    expect(fake.api.jobs.cancel).not.toHaveBeenCalled()
  })

  it("steps from one differing file to the next from the diff, and lets the first go", async () => {
    const fake = await start({ textDiff: { rows: ROWS } })
    await mark(["newer.txt", "only-left.txt", "fat.txt", "same.txt"])
    await run("compare.content")
    await screen.findByTestId("compare-many")
    await waitFor(() => expect(fake.api.files.start).toHaveBeenCalled())
    await finish(
      fake,
      [
        ["fat.txt", "DIFFERENT"],
        ["only-left.txt", "NOT_FOUND"],
        ["newer.txt", "DIFFERENT"],
      ],
      1,
    )
    await waitFor(() => expect(manyRowsOf()).toHaveLength(3))
    // ↓ moves the cursor; ↑ back to the first row.
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("compare-many-rows"), { key: "ArrowDown" })
    })
    expect(manyRowsOf()[1]).toHaveAttribute("aria-selected", "true")
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("compare-many-rows"), { key: "Home" })
    })
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("compare-many-rows"), { key: "Enter" })
    })
    await waitFor(() => expect(fake.api.diff.open).toHaveBeenLastCalledWith(L + 105, R + 105))
    await waitFor(() => expect(fake.openDiffs()).toHaveLength(1))
    const first = fake.openDiffs()[0]
    expect(screen.getByRole("button", { name: "Previous file" })).toBeDisabled()

    // Shift+N: the next file that differs (the missing one is passed over).
    await waitFor(() => expect(screen.getByTestId("diff-rows")).toBeInTheDocument())
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("diff-rows"), { key: "N", shiftKey: true })
    })
    await waitFor(() => expect(fake.api.diff.open).toHaveBeenLastCalledWith(L + 101, R + 101))
    await waitFor(() => expect(fake.openDiffs()).toHaveLength(1))
    expect(fake.openDiffs()[0]).not.toBe(first)
    await waitFor(() => expect(screen.getByRole("button", { name: "Next file" })).toBeDisabled())
    expect(useCompareStore.getState().many?.cursor).toBe(2)
  })

  it("says so when every file is identical, and counts what it left out", async () => {
    const fake = await start()
    await mark(["same.txt", "fat.txt", "data.bin"])
    await run("compare.content")
    await screen.findByTestId("compare-many")
    await waitFor(() => expect(fake.api.files.start).toHaveBeenCalled())
    await finish(fake, [], 2, 1)
    await waitFor(() =>
      expect(screen.getByTestId("compare-many-status")).toHaveTextContent(
        "All 2 files are identical. · 1 folder or link left out",
      ),
    )
    expect(screen.queryByTestId("compare-many-rows")).toBeNull()
    expect(fake.api.files.errors).not.toHaveBeenCalled()
  })

  it("stops the job when the dialog closes while it runs", async () => {
    const fake = await start()
    await mark(["same.txt", "fat.txt", "data.bin"])
    await run("compare.content")
    const dialog = await screen.findByTestId("compare-many")
    await waitFor(() => expect(fake.api.files.start).toHaveBeenCalled())
    const jobId = (await fake.api.files.list()).r.jobs.at(-1)!.jobId
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }))
    })
    expect(fake.api.jobs.cancel).toHaveBeenCalledWith(jobId)
    expect(screen.queryByTestId("compare-many")).toBeNull()
  })

  it("needs a folder in the other panel", async () => {
    const fake = await start()
    await mark(["same.txt", "fat.txt", "data.bin"])
    await act(async () => {
      useListingStore.setState((s) => ({
        right: { ...s.right, find: { findId: 1, label: "*.txt" } },
      }))
    })
    await run("compare.content")
    expect(noticeText()).toContain("Open a folder in the other panel")
    expect(fake.api.files.start).not.toHaveBeenCalled()
    expect(screen.queryByTestId("compare-many")).toBeNull()
  })

  it("still compares one marked file with the file of its name in the other panel", async () => {
    const fake = await start({ textDiff: { rows: ROWS } })
    await mark(["newer.txt"])
    expect(compareLabel("left")).toBe("Compare by content")
    await run("compare.content")
    await waitFor(() => expect(fake.api.diff.open).toHaveBeenCalledWith(L + 101, R + 101))
  })
})

describe("in a window of its own (ADR-0048)", () => {
  it("opens two files, several files and two folders in compare windows instead of dialogs", async () => {
    const fake = await start({ textDiff: { rows: [] } })
    fake.api.compare.openWindow.mockResolvedValue({ ok: true, r: { ok: true } } as never)
    const queries = () => ({
      mineQueryId: useListingStore.getState().left.query!.queryId,
      theirsQueryId: useListingStore.getState().right.query!.queryId,
    })

    // The cursor file and its namesake in the other panel.
    await cursorTo("newer.txt")
    await run("compare.content")
    await waitFor(() =>
      expect(fake.api.compare.openWindow).toHaveBeenLastCalledWith({
        view: "files",
        left: { id: L + 101, name: "newer.txt" },
        right: { id: R + 101, name: "newer.txt" },
      }),
    )
    expect(fake.api.diff.open).not.toHaveBeenCalled()
    expect(screen.queryByTestId("diff-dialog")).toBeNull()

    // Several marked files: the job starts here, the window follows it.
    for (const name of ["same.txt", "newer.txt", "only-left.txt"]) {
      await cursorTo(name)
      await key({ key: "Insert" })
    }
    await run("compare.content")
    await waitFor(() => expect(fake.api.files.start).toHaveBeenCalledTimes(1))
    const jobId = (await fake.api.files.list()).r.jobs.at(-1)!.jobId
    await waitFor(() =>
      expect(fake.api.compare.openWindow).toHaveBeenLastCalledWith({
        view: "many",
        jobId,
        side: "left",
        count: 3,
        folder: BACKUP.path,
        ...queries(),
      }),
    )
    expect(screen.queryByTestId("compare-many")).toBeNull()
    expect(useCompareStore.getState().many).toBeNull()
    expect(fake.api.jobs.cancel).not.toHaveBeenCalled()

    // Synchronize directories: the two panels' folders.
    await run("compare.sync")
    await waitFor(() =>
      expect(fake.api.compare.openWindow).toHaveBeenLastCalledWith({
        view: "sync",
        left: { path: WORK.path, dirId: 10 },
        right: { path: BACKUP.path, dirId: 20 },
      }),
    )
    expect(screen.queryByTestId("sync-dialog")).toBeNull()
    expect(fake.api.compare.dirs).not.toHaveBeenCalled()
  })

  it("shows the dialog when the window cannot open", async () => {
    const fake = await start({ textDiff: { rows: [] } })
    fake.api.compare.openWindow.mockResolvedValue({
      ok: false,
      e: { code: "INTERNAL", message: "no window" },
    } as never)
    await run("compare.sync")
    await screen.findByTestId("sync-dialog")
    expect(fake.api.compare.openWindow).toHaveBeenCalledTimes(1)
  })
})

describe("checksums", () => {
  it("creates one checksum file beside the cursor file, or one list for the marks", async () => {
    const fake = await start()
    await cursorTo("data.bin")
    await run("hash.create")
    let dialog = await screen.findByTestId("checksum-dialog")
    expect(screen.getByRole("dialog")).toHaveTextContent("Create checksums for data.bin")
    // A single file: one checksum file beside it is the default.
    expect(within(dialog).getByLabelText(/One beside each file/)).toBeChecked()
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("Algorithm"), { target: { value: "md5" } })
    })
    expect(within(dialog).getByLabelText(/One beside each file/)).toHaveAccessibleName(
      "One beside each file (name.txt.md5)",
    )
    await act(async () => {
      fireEvent.submit(dialog)
    })
    await waitFor(() =>
      expect(fake.api.files.start).toHaveBeenCalledWith({
        kind: "hashCreate",
        source: { selection: expect.objectContaining({ queryId: expect.any(Number) }) },
        algorithm: "md5",
        perFile: true,
      }),
    )
    expect(screen.queryByTestId("checksum-dialog")).toBeNull()
    expect(noticeText()).toContain("Creating checksums for data.bin")

    // Marks: one list in the panel's folder, named by the user, with the algorithm's extension.
    await key({ key: "a", ctrlKey: true })
    await run("hash.create")
    dialog = await screen.findByTestId("checksum-dialog")
    expect(within(dialog).getByLabelText("One list for all of them")).toBeChecked()
    expect(within(dialog).getByLabelText("List name")).toHaveValue("work")
    expect(dialog).toHaveTextContent(`In ${WORK.path}`)
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("List name"), { target: { value: "all" } })
      fireEvent.change(within(dialog).getByLabelText("Algorithm"), { target: { value: "crc32" } })
    })
    await act(async () => {
      fireEvent.submit(dialog)
    })
    await waitFor(() =>
      expect(fake.api.files.start).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: "hashCreate",
          algorithm: "crc32",
          perFile: false,
          destinationDirId: 10,
          name: "all.sfv",
        }),
      ),
    )
    // The marks are cleared once the job is queued.
    expect(markCount(useMarksStore.getState().left)).toBe(0)
    // The result is announced when the job ends.
    const jobId = (await fake.api.files.list()).r.jobs.at(-1)!.jobId
    await act(async () =>
      fake.emit(
        "job.progress",
        fake.job({ jobId, kind: "hashCreate", state: "completed", total: 6, done: 6 }),
      ),
    )
    await waitFor(() => expect(noticeText()).toBe("Checksums created for 6 files."))
  })

  it("needs a name for a list", async () => {
    const fake = await start()
    await key({ key: "a", ctrlKey: true })
    await run("hash.create")
    const dialog = await screen.findByTestId("checksum-dialog")
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("List name"), { target: { value: "  " } })
    })
    await act(async () => {
      fireEvent.submit(dialog)
    })
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a name"))
    expect(fake.api.files.start).not.toHaveBeenCalled()
  })

  it("verifies a checksum file and lists what did not verify", async () => {
    const fake = await start()
    // Not a checksum file: nothing starts.
    await cursorTo("data.bin")
    await run("hash.verify")
    expect(noticeText()).toContain(".sha256, .sha1, .md5 or .sfv")
    expect(fake.api.files.start).not.toHaveBeenCalled()

    await cursorTo("sums.sha256")
    await run("hash.verify")
    await waitFor(() =>
      expect(fake.api.files.start).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "hashVerify" }),
      ),
    )
    expect(noticeText()).toContain("Verifying sums.sha256")
    const jobId = (await fake.api.files.list()).r.jobs.at(-1)!.jobId
    await act(async () =>
      fake.emit(
        "job.progress",
        fake.job({ jobId, kind: "hashVerify", state: "completed", total: 5, done: 4, failed: 1 }),
      ),
    )
    await waitFor(() => expect(noticeText()).toContain("1 of 5 files did not verify"))
    // The result list: the job's failed items.
    const details = await screen.findByTestId("job-details")
    expect(details).toHaveTextContent("locked.jpg")
    expect(fake.api.files.errors).toHaveBeenCalledWith(jobId, 0, 200)
  })

  it("announces a clean verification without a list", async () => {
    const fake = await start()
    await cursorTo("sums.sha256")
    await run("hash.verify")
    await waitFor(() => expect(fake.api.files.start).toHaveBeenCalled())
    const jobId = (await fake.api.files.list()).r.jobs.at(-1)!.jobId
    await act(async () =>
      fake.emit(
        "job.progress",
        fake.job({ jobId, kind: "hashVerify", state: "completed", total: 5, done: 5 }),
      ),
    )
    await waitFor(() => expect(noticeText()).toBe("5 files verified: all match."))
    expect(screen.queryByTestId("job-details")).toBeNull()
  })
})

describe("compare helpers", () => {
  it("names a row's symbol by its action, then by its state", () => {
    const d = (action: string, state: string) =>
      symbolOf({ dir: "", action, state, left: null, right: null } as never)
    expect(d("copyRight", "leftNewer")).toBe("copyRight")
    expect(d("copyLeft", "rightOnly")).toBe("copyLeft")
    expect(d("deleteRight", "rightOnly")).toBe("delete")
    expect(d("deleteLeft", "leftOnly")).toBe("delete")
    expect(d("none", "equal")).toBe("equal")
    expect(d("none", "different")).toBe("different")
    expect(d("none", "mismatch")).toBe("different")
  })

  it("words the results of checksum jobs", () => {
    const job = (over: object) =>
      ({ state: "completed", done: 0, failed: 0, total: 0, error: "", ...over }) as never
    expect(hashResult("hashCreate", job({ done: 1 }))).toBe("Checksums created for 1 file.")
    expect(hashResult("hashCreate", job({ done: 3, failed: 2 }))).toContain("2 failed")
    expect(hashResult("hashVerify", job({ done: 2, total: 2 }))).toBe(
      "2 files verified: all match.",
    )
    expect(hashResult("hashVerify", job({ state: "cancelled" }))).toContain("cancelled")
    expect(hashResult("hashCreate", job({ state: "failed", error: "No folder." }))).toBe(
      "No folder.",
    )
  })

  it("reads the compare options from stored settings", () => {
    expect(readSettings({ v: 2 })).toMatchObject({
      compareToleranceMs: 2000,
      compareDst: false,
      compareIgnoreDates: false,
    })
    expect(
      readSettings({ v: 2, compareToleranceMs: 0, compareDst: true, compareIgnoreDates: true }),
    ).toMatchObject({ compareToleranceMs: 0, compareDst: true, compareIgnoreDates: true })
    // Anything else falls back to the FAT tolerance.
    expect(readSettings({ v: 2, compareToleranceMs: 99 }).compareToleranceMs).toBe(2000)
  })
})
