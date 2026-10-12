import { ENTRY_ATTRS, type Crumb, type RenamePlan } from "@panelyth/contracts"
import { markCount } from "@panelyth/renderer-core"
import { useInterfaceSizeStore } from "@panelyth/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { describeJob } from "./components/QueuePanel"
import {
  attributesJob,
  resetAttributes,
  toDateInput,
  useAttributesStore,
  type AttributesDialogState,
} from "./features/attributes"
import { resetCarry, startPanels } from "./features/carry"
import { resetCompare } from "./features/compare"
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
import { resetMarks, useMarksStore } from "./features/marks"
import { usePanelsStore } from "./features/panels"
import { resetQueue, startQueue } from "./features/queue"
import {
  DEFAULT_PLAN,
  PREVIEW_PAGE,
  renameResult,
  resetRename,
  startRenameEvents,
  useRenameStore,
} from "./features/rename"
import { PANELS_KEY } from "./features/session"
import { resetSettings } from "./features/settings"
import { resetTabs } from "./features/tabs"
import { fakeRename, folder, installFakeCommander, item, type FakeOptions } from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// Stage C09: multi-rename with its preview and undo, attributes and dates,
// properties (docs/commander/stages/C09-multi-rename-and-attributes.md).

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const WORK: Crumb = { name: "work", path: "C:\\work" }
const BACKUP: Crumb = { name: "Backup", path: "C:\\Backup" }

const L = 10_000_000
const folders = () => [
  folder(10, WORK.path, [ROOT, WORK], 1, 0, [
    item(L + 100, "IMG_1.jpg", { sizeBytes: 5 }),
    item(L + 101, "IMG_2.jpg", { sizeBytes: 9 }),
    item(L + 102, "notes.txt", { sizeBytes: 1, attrs: ENTRY_ATTRS.readOnly | ENTRY_ATTRS.archive }),
    item(L + 103, "taken.txt", { sizeBytes: 2 }),
    item(L + 104, "shortcut", { kind: "link" }),
  ]),
  folder(20, BACKUP.path, [ROOT, BACKUP], 0, 1),
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
    stops.push(startRenameEvents())
  })
  await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(WORK.path))
  await waitFor(() => expect(rows().length).toBeGreaterThan(2))
  return fake
}

const grid = () => screen.getByTestId("grid-left")
const rows = () => [...grid().querySelectorAll<HTMLElement>("[data-row]")]
const key = (init: KeyboardEventInit & { key: string }) =>
  act(async () => {
    fireEvent.keyDown(grid(), init)
  })
const noticeText = () => screen.getByTestId("files-notice").textContent
const run = (action: Parameters<typeof runPanelAction>[1]) =>
  act(async () => runPanelAction("left", action))

async function cursorTo(name: string) {
  const index = () => {
    const p = useListingStore.getState().left
    for (let i = 0; i < (p.query?.total ?? 0); i++) {
      if (pageStoreOf("left").getItem(i)?.name === name) return i + parentRows(p)
    }
    return -1
  }
  await waitFor(() => expect(index()).toBeGreaterThanOrEqual(0))
  await act(async () => moveCursor("left", index()))
}

/** Marks the entries named `names` (rows are in name order, the folder first). */
async function mark(...names: string[]) {
  const store = pageStoreOf("left")
  const ranges: [number, number][] = []
  const total = useListingStore.getState().left.query?.total ?? 0
  for (let i = 0; i < total; i++) {
    if (names.includes(store.getItem(i)?.name ?? "")) ranges.push([i, i + 1])
  }
  expect(ranges).toHaveLength(names.length)
  await act(async () => {
    useMarksStore.setState((s) => ({ left: { ...s.left, ranges } }))
  })
}

const dialog = () => screen.findByTestId("multi-rename-dialog")
/** The preview's mounted rows as "old → new status". */
const preview = () =>
  [...screen.getByTestId("rename-preview").querySelectorAll('[role="row"]')].map((r) =>
    [...r.querySelectorAll('[role="cell"]')]
      .map((c) => c.textContent)
      .filter((text) => text !== "")
      .join(" | "),
  )
const type = (form: HTMLElement, label: string, value: string) =>
  act(async () => {
    fireEvent.change(within(form).getByLabelText(label), { target: { value } })
  })
const summary = () => screen.getByTestId("rename-summary").textContent
const startButton = (form: HTMLElement) => within(form).getByRole("button", { name: "Start" })

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
  resetRename()
  resetAttributes()
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

describe("multi-rename (Ctrl+M)", () => {
  it("previews the cursor entry, follows the masks and starts one job", async () => {
    const fake = await start()
    await cursorTo("notes.txt")
    await key({ key: "m", ctrlKey: true })
    const form = await dialog()
    expect(screen.getByRole("dialog")).toHaveTextContent("Multi-rename")
    // The masks start as "the name as it is": nothing would change yet.
    expect(within(form).getByLabelText("Name mask")).toHaveValue("[N]")
    expect(within(form).getByLabelText("Extension mask")).toHaveValue("[E]")
    await waitFor(() => expect(preview()).toEqual(["notes.txt | notes.txt | Unchanged"]))
    expect(summary()).toBe("0 of 1 name will change")
    expect(startButton(form)).toBeDisabled()

    await type(form, "Name mask", "2024 [N]")
    await waitFor(() => expect(preview()).toEqual(["notes.txt | 2024 notes.txt"]))
    expect(summary()).toBe("1 of 1 name will change")
    await type(form, "Extension mask", "md")
    await waitFor(() => expect(preview()).toEqual(["notes.txt | 2024 notes.md"]))
    // Go named the batch: one page for the rows in view.
    expect(fake.api.rename.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ queryId: expect.any(Number) }),
      { ...DEFAULT_PLAN, nameMask: "2024 [N]", extMask: "md" },
      0,
      PREVIEW_PAGE,
    )

    await act(async () => {
      fireEvent.submit(form)
    })
    await waitFor(() =>
      expect(fake.api.files.start).toHaveBeenCalledWith({
        kind: "multiRename",
        source: { selection: expect.objectContaining({ queryId: expect.any(Number) }) },
        plan: { ...DEFAULT_PLAN, nameMask: "2024 [N]", extMask: "md" },
      }),
    )
    expect(screen.queryByTestId("multi-rename-dialog")).toBeNull()
    expect(noticeText()).toContain("Renaming notes.txt")
    // The result is announced when the job ends.
    const jobId = (await fake.api.files.list()).r.jobs.at(-1)!.jobId
    await act(async () =>
      fake.emit(
        "job.progress",
        fake.job({ jobId, kind: "multiRename", state: "completed", total: 1, done: 1 }),
      ),
    )
    await waitFor(() => expect(noticeText()).toBe("Renamed 1 item."))
    // The keys are the panel's again.
    await waitFor(() => expect(grid()).toHaveFocus())
  })

  it("names the marks with a counter, search and replace and a case", async () => {
    const fake = await start()
    await mark("IMG_1.jpg", "IMG_2.jpg", "notes.txt")
    await run("files.multiRename")
    const form = await dialog()
    await waitFor(() => expect(preview()).toHaveLength(3))
    // A placeholder button writes into the mask used last, at the caret.
    const nameMask = within(form).getByLabelText<HTMLInputElement>("Name mask")
    await act(async () => {
      nameMask.focus()
      nameMask.setSelectionRange(3, 3)
      fireEvent.click(within(form).getByRole("button", { name: "[C]" }))
    })
    expect(nameMask).toHaveValue("[N][C]")
    await type(form, "Digits", "3")
    await type(form, "Start at", "10")
    await type(form, "Step", "5")
    await type(form, "Search for", "img_")
    await type(form, "Replace with", "pic-")
    await act(async () => {
      fireEvent.change(within(form).getByLabelText("Case"), { target: { value: "upper" } })
    })
    await waitFor(() =>
      expect(preview()).toEqual([
        "IMG_1.jpg | PIC-1010.JPG",
        "IMG_2.jpg | PIC-2015.JPG",
        "notes.txt | NOTES020.TXT",
      ]),
    )
    expect(summary()).toBe("3 of 3 names will change")
    await act(async () => {
      fireEvent.click(within(form).getByLabelText("Regular expression"))
      fireEvent.click(within(form).getByLabelText("Match case"))
    })
    const plan: RenamePlan = {
      nameMask: "[N][C]",
      extMask: "[E]",
      search: "img_",
      replace: "pic-",
      regex: true,
      matchCase: true,
      case: "upper",
      start: 10,
      step: 5,
      digits: 3,
    }
    await waitFor(() => expect(fake.api.rename.preview.mock.calls.at(-1)![1]).toEqual(plan))
    await act(async () => {
      fireEvent.click(startButton(form))
    })
    await waitFor(() =>
      expect(fake.api.files.start).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "multiRename", plan }),
      ),
    )
    // The marks are cleared once the job is queued.
    expect(markCount(useMarksStore.getState().left)).toBe(0)
    expect(noticeText()).toContain("Renaming 3 items")
  })

  it("says which names are not free or invalid, in words", async () => {
    await start()
    await mark("IMG_1.jpg", "IMG_2.jpg", "notes.txt")
    await run("files.multiRename")
    const form = await dialog()
    // Both pictures become "taken.jpg"; the notes become taken.txt, which exists.
    await type(form, "Name mask", "taken")
    await waitFor(() =>
      expect(preview()).toEqual([
        "IMG_1.jpg | taken.jpg | Same name twice",
        "IMG_2.jpg | taken.jpg | Same name twice",
        "notes.txt | taken.txt | Name is taken",
      ]),
    )
    expect(summary()).toBe("0 of 3 names will change · 3 names are not free")
    expect(startButton(form)).toBeDisabled()
    expect(within(form).getByRole("button", { name: "Show the first one" })).toBeInTheDocument()
    await type(form, "Name mask", "a/[N]")
    await waitFor(() => expect(preview()[0]).toBe("IMG_1.jpg | a/IMG_1.jpg | Invalid name"))
    expect(summary()).toBe("0 of 3 names will change · 3 names are invalid")
    // What can be renamed is; the rest is left to the job's list.
    await type(form, "Name mask", "[N]")
    await type(form, "Search for", "notes")
    await type(form, "Replace with", "taken")
    await waitFor(() => expect(summary()).toBe("0 of 3 names will change · 1 name is not free"))
    await type(form, "Search for", "IMG_1")
    await waitFor(() => expect(summary()).toBe("1 of 3 names will change"))
    expect(startButton(form)).toBeEnabled()
  })

  it("shows why a mask or an expression cannot be used and keeps the last names", async () => {
    const fake = await start()
    await cursorTo("notes.txt")
    await run("files.multiRename")
    const form = await dialog()
    await type(form, "Name mask", "new [N]")
    await waitFor(() => expect(preview()).toEqual(["notes.txt | new notes.txt"]))
    await type(form, "Name mask", "new [N")
    await waitFor(() =>
      expect(within(form).getByRole("alert")).toHaveTextContent(
        "The mask can't be used: a [ has no ]",
      ),
    )
    expect(within(form).getByLabelText("Name mask")).toBeInvalid()
    // The rows are the last good ones, and nothing can be started.
    expect(preview()).toEqual(["notes.txt | new notes.txt"])
    expect(startButton(form)).toBeDisabled()
    await act(async () => {
      fireEvent.submit(form)
    })
    expect(fake.api.files.start).not.toHaveBeenCalled()
    await type(form, "Name mask", "new [N]")
    await waitFor(() => expect(within(form).queryByRole("alert")).toBeNull())
    expect(startButton(form)).toBeEnabled()

    await act(async () => {
      fireEvent.click(within(form).getByLabelText("Regular expression"))
    })
    await type(form, "Search for", "(")
    await waitFor(() =>
      expect(within(form).getByRole("alert")).toHaveTextContent(
        "The expression can't be used: missing closing )",
      ),
    )
    expect(within(form).getByLabelText("Search for")).toBeInvalid()
  })

  it("asks Go once more for the newest plan while a preview is on its way", async () => {
    const fake = await start()
    await cursorTo("notes.txt")
    await run("files.multiRename")
    const form = await dialog()
    await waitFor(() => expect(preview()).toHaveLength(1))
    const answer = fake.api.rename.preview.getMockImplementation()!
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    fake.api.rename.preview.mockImplementationOnce(async (...args) => {
      await held
      return answer(...args)
    })
    const before = fake.api.rename.preview.mock.calls.length
    // Four key presses while the first of them is being named.
    for (const mask of ["a", "ab", "abc", "abc[N]"]) await type(form, "Name mask", mask)
    expect(fake.api.rename.preview.mock.calls.length).toBe(before + 1)
    await act(async () => {
      release()
    })
    await waitFor(() => expect(preview()).toEqual(["notes.txt | abcnotes.txt"]))
    // One for "a" (dropped when it came back) and one for the last mask.
    expect(fake.api.rename.preview.mock.calls.length).toBe(before + 2)
    expect(fake.api.rename.preview.mock.calls.at(-1)![1].nameMask).toBe("abc[N]")
  })

  it("mounts only the rows in view of a large batch and asks for their pages", async () => {
    const fake = await start({
      folders: [
        folder(10, WORK.path, [ROOT, WORK], 0, 5000, [item(L + 9000, "zz-last.txt")]),
        folder(20, BACKUP.path, [ROOT, BACKUP], 0, 1),
      ],
    })
    await key({ key: "a", ctrlKey: true })
    await run("files.multiRename")
    const form = await dialog()
    await waitFor(() => expect(summary()).toBe("0 of 5,001 names will change"))
    expect(preview().length).toBeGreaterThan(10)
    expect(preview().length).toBeLessThan(80)
    expect(
      fake.api.rename.preview.mock.calls.every((c) => c[2] === 0 && c[3] === PREVIEW_PAGE),
    ).toBe(true)
    // The last entry would take the name of the one before it: the first problem is far down.
    await type(form, "Search for", "zz-last")
    await type(form, "Replace with", "file004999")
    await waitFor(() => expect(summary()).toContain("1 name is not free"))
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Show the first one" }))
    })
    // jsdom lays nothing out: the scroll the button asked for is made by hand.
    const table = screen.getByTestId("rename-preview")
    Object.defineProperty(table, "scrollTop", { configurable: true, value: 5000 * 22 })
    await act(async () => fireEvent.scroll(table))
    await waitFor(() => expect(preview()).toContain("zz-last.txt | file004999.txt | Name is taken"))
    // Its page was asked for, not the 24 before it.
    const offsets = new Set(fake.api.rename.preview.mock.calls.map((c) => c[2]))
    expect(offsets.has(5000)).toBe(true)
    expect(offsets.size).toBeLessThanOrEqual(3)
    expect(preview().length).toBeLessThan(80)
  })

  it("undoes the last multi-rename from the dialog or as a command", async () => {
    const fake = await start()
    // Nothing to undo yet.
    await run("files.undoRename")
    await waitFor(() => expect(noticeText()).toBe("There is no multi-rename to undo."))
    await cursorTo("notes.txt")
    await run("files.multiRename")
    let form = await dialog()
    expect(within(form).queryByRole("button", { name: "Undo last" })).toBeNull()
    await type(form, "Name mask", "old [N]")
    await waitFor(() => expect(startButton(form)).toBeEnabled())
    await act(async () => {
      fireEvent.submit(form)
    })
    await waitFor(() => expect(screen.queryByTestId("multi-rename-dialog")).toBeNull())
    expect(fake.folder(10)!.entries.map((e) => e.name)).toContain("old notes.txt")
    await act(async () => fake.relist(10))

    // The dialog offers the undo, whatever is under the cursor now.
    await cursorTo("taken.txt")
    await run("files.multiRename")
    form = await dialog()
    const undo = await within(form).findByRole("button", { name: "Undo last" })
    await act(async () => {
      fireEvent.click(undo)
    })
    await waitFor(() =>
      expect(fake.api.files.start).toHaveBeenLastCalledWith({ kind: "undoRename" }),
    )
    expect(screen.queryByTestId("multi-rename-dialog")).toBeNull()
    expect(noticeText()).toBe("Undoing the rename of 1 item…")
    expect(fake.folder(10)!.entries.map((e) => e.name)).toContain("notes.txt")
    const jobId = (await fake.api.files.list()).r.jobs.at(-1)!.jobId
    await act(async () =>
      fake.emit(
        "job.progress",
        fake.job({ jobId, kind: "undoRename", state: "completed", total: 1, done: 1 }),
      ),
    )
    await waitFor(() => expect(noticeText()).toBe("1 name is back."))
    // One level: there is nothing more to undo.
    await run("files.undoRename")
    await waitFor(() => expect(noticeText()).toBe("There is no multi-rename to undo."))
  })

  it("lists what could not be renamed when the job ends", async () => {
    const fake = await start()
    await mark("IMG_1.jpg", "IMG_2.jpg")
    await run("files.multiRename")
    const form = await dialog()
    await type(form, "Name mask", "x[N]")
    await waitFor(() => expect(startButton(form)).toBeEnabled())
    await act(async () => {
      fireEvent.submit(form)
    })
    await waitFor(() => expect(fake.api.files.start).toHaveBeenCalled())
    const jobId = (await fake.api.files.list()).r.jobs.at(-1)!.jobId
    await act(async () =>
      fake.emit(
        "job.progress",
        fake.job({ jobId, kind: "multiRename", state: "completed", total: 2, done: 1, failed: 1 }),
      ),
    )
    await waitFor(() => expect(noticeText()).toBe("Renamed 1 of 2 items; the rest is listed."))
    await waitFor(() => expect(fake.api.files.errors).toHaveBeenCalledWith(jobId, 0, 200))
    expect(await screen.findByText("locked.jpg")).toBeInTheDocument()
  })

  it("closes with Esc and forgets its rows", async () => {
    await start()
    await cursorTo("notes.txt")
    await key({ key: "m", ctrlKey: true })
    const form = await dialog()
    await waitFor(() => expect(preview()).toHaveLength(1))
    await act(async () => {
      fireEvent.keyDown(form, { key: "Escape" })
    })
    await waitFor(() => expect(useRenameStore.getState().dialog).toBeNull())
    await waitFor(() => expect(grid()).toHaveFocus())
  })
})

describe("change attributes", () => {
  it("sets and clears Windows attributes and dates of the cursor entry", async () => {
    const fake = await start()
    await cursorTo("notes.txt")
    await run("files.attributes")
    const form = await screen.findByTestId("attributes-dialog")
    expect(screen.getByRole("dialog")).toHaveTextContent("Change attributes of notes.txt")
    // The entry as it is now; every box starts as "leave it".
    await waitFor(() =>
      expect(screen.getByTestId("attributes-current")).toHaveTextContent("Now: Read-only, Archive"),
    )
    const box = (name: string) => within(form).getByRole("checkbox", { name })
    for (const name of ["Read-only", "Hidden", "System", "Archive"])
      expect(box(name)).toHaveAttribute("aria-checked", "mixed")
    // One click sets, a second clears, a third leaves it again.
    await act(async () => {
      fireEvent.click(box("Hidden"))
      fireEvent.click(box("Archive"))
    })
    await act(async () => {
      fireEvent.click(box("Archive"))
      fireEvent.click(box("System"))
    })
    await act(async () => {
      fireEvent.click(box("System"))
    })
    await act(async () => {
      fireEvent.click(box("System"))
    })
    expect(box("Hidden")).toHaveAttribute("aria-checked", "true")
    expect(box("Archive")).toHaveAttribute("aria-checked", "false")
    expect(box("System")).toHaveAttribute("aria-checked", "mixed")
    const when = new Date(2021, 3, 5, 6, 7, 8)
    await act(async () => {
      fireEvent.change(within(form).getByLabelText("Modified"), {
        target: { value: toDateInput(when.getTime()) },
      })
      fireEvent.click(within(form).getByLabelText("Also everything inside the folders"))
    })
    await act(async () => {
      fireEvent.submit(form)
    })
    await waitFor(() =>
      expect(fake.api.files.start).toHaveBeenCalledWith({
        kind: "setAttributes",
        source: { selection: expect.objectContaining({ queryId: expect.any(Number) }) },
        setAttrs: ENTRY_ATTRS.hidden,
        clearAttrs: ENTRY_ATTRS.archive,
        modifiedMs: when.getTime(),
        recursive: true,
      }),
    )
    expect(screen.queryByTestId("attributes-dialog")).toBeNull()
    const jobId = (await fake.api.files.list()).r.jobs.at(-1)!.jobId
    await act(async () =>
      fake.emit(
        "job.progress",
        fake.job({ jobId, kind: "setAttributes", state: "completed", total: 1, done: 1 }),
      ),
    )
    await waitFor(() => expect(noticeText()).toBe("Changed 1 item."))
  })

  it("offers permission bits where the system has them", async () => {
    const fake = await start({ permissions: 0o644 })
    await cursorTo("notes.txt")
    await run("files.attributes")
    const form = await screen.findByTestId("attributes-dialog")
    await waitFor(() =>
      expect(screen.getByTestId("attributes-current")).toHaveTextContent("Now: rw-r--r-- (644)"),
    )
    expect(within(form).getAllByRole("checkbox", { name: /: (Read|Write|Execute)$/ })).toHaveLength(
      9,
    )
    const box = (name: string) => within(form).getByRole("checkbox", { name })
    await act(async () => {
      fireEvent.click(box("Owner: Execute"))
      fireEvent.click(box("Others: Read"))
    })
    await act(async () => {
      fireEvent.click(box("Others: Read"))
    })
    await act(async () => {
      fireEvent.submit(form)
    })
    await waitFor(() =>
      expect(fake.api.files.start).toHaveBeenCalledWith({
        kind: "setAttributes",
        source: { selection: expect.anything() },
        setMode: 0o100,
        clearMode: 0o004,
      }),
    )
  })

  it("needs something to change, and takes the marks", async () => {
    const fake = await start()
    await mark("IMG_1.jpg", "IMG_2.jpg")
    await run("files.attributes")
    const form = await screen.findByTestId("attributes-dialog")
    expect(screen.getByRole("dialog")).toHaveTextContent("Change attributes of 2 items")
    // Marks have no single current state.
    expect(screen.queryByTestId("attributes-current")).toBeNull()
    await act(async () => {
      fireEvent.submit(form)
    })
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "Choose an attribute or a date to change.",
    )
    expect(fake.api.files.start).not.toHaveBeenCalled()
    // "Now" fills in the current time.
    await act(async () => {
      fireEvent.click(within(form).getAllByRole("button", { name: "Now" })[1]!)
    })
    expect(within(form).getByLabelText<HTMLInputElement>("Accessed").value).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/,
    )
    await act(async () => {
      fireEvent.submit(form)
    })
    await waitFor(() =>
      expect(fake.api.files.start).toHaveBeenCalledWith({
        kind: "setAttributes",
        source: { selection: expect.anything() },
        accessedMs: expect.any(Number),
      }),
    )
    expect(markCount(useMarksStore.getState().left)).toBe(0)
  })

  it("builds the job a dialog asks for", () => {
    const d: AttributesDialogState = {
      side: "left",
      source: { queryId: 1, version: 1, ranges: [[0, 1]], include: [], exclude: [] },
      what: "x",
      windows: true,
      current: null,
      bits: { [ENTRY_ATTRS.readOnly]: "set", [ENTRY_ATTRS.system]: "keep" },
      modified: "",
      accessed: "",
      recursive: false,
      busy: false,
      error: null,
    }
    expect(attributesJob(d)).toEqual({
      kind: "setAttributes",
      source: { selection: d.source },
      setAttrs: ENTRY_ATTRS.readOnly,
    })
    expect(attributesJob({ ...d, bits: {} })).toBe("Choose an attribute or a date to change.")
    expect(attributesJob({ ...d, modified: "1975-01-01T00:00:00" })).toBe(
      "Enter a date between 1980 and 9999.",
    )
    expect(attributesJob({ ...d, accessed: "nonsense" })).toBe(
      "Enter a date between 1980 and 9999.",
    )
  })
})

describe("properties (Alt+Enter)", () => {
  it("shows the cursor entry with its attributes and leads to the other dialogs", async () => {
    const fake = await start()
    await cursorTo("notes.txt")
    await key({ key: "Enter", altKey: true })
    const list = await screen.findByTestId("properties")
    await waitFor(() => expect(list).toHaveAttribute("aria-busy", "false"))
    expect(screen.getByRole("dialog")).toHaveTextContent("notes.txt")
    expect(within(list).getByTestId("props-path")).toHaveTextContent("C:\\fake\\notes.txt")
    expect(within(list).getByTestId("props-attrs")).toHaveTextContent("Read-only, Archive")
    expect(within(list).queryByTestId("props-link")).toBeNull()
    expect(fake.api.props.get).toHaveBeenCalledWith(L + 102)
    // Enter must not have opened the file.
    expect(fake.shell).toHaveLength(0)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Change attributes…" }))
    })
    expect(await screen.findByTestId("attributes-dialog")).toBeInTheDocument()
    expect(useAttributesStore.getState().properties).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    })

    await run("files.properties")
    await screen.findByTestId("properties")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Checksums…" }))
    })
    expect(await screen.findByTestId("checksum-dialog")).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toHaveTextContent("Create checksums for notes.txt")
  })

  it("says where a link points and what the marks add up to", async () => {
    await start({ permissions: 0o755 })
    await cursorTo("shortcut")
    await run("files.properties")
    let list = await screen.findByTestId("properties")
    await waitFor(() =>
      expect(within(list).getByTestId("props-link")).toHaveTextContent("C:\\target\\shortcut"),
    )
    expect(within(list).getByTestId("props-attrs")).toHaveTextContent("rwxr-xr-x (755)")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }))
    })
    await waitFor(() => expect(screen.queryByTestId("properties")).toBeNull())

    await mark("IMG_1.jpg", "IMG_2.jpg", "notes.txt")
    await run("files.properties")
    list = await screen.findByTestId("properties")
    await waitFor(() => expect(list).toHaveAttribute("aria-busy", "false"))
    expect(screen.getByRole("dialog")).toHaveTextContent("3 items marked")
    expect(list).toHaveTextContent("Total size")
  })
})

describe("helpers", () => {
  it("describes the new jobs in the queue and their results", () => {
    const job = (over: Record<string, unknown>) =>
      ({
        state: "running",
        total: 3,
        done: 0,
        failed: 0,
        destination: "",
        error: "",
        ...over,
      }) as never
    expect(describeJob(job({ kind: "multiRename" }))).toBe("Renaming 3 items")
    expect(describeJob(job({ kind: "undoRename", state: "completed" }))).toBe(
      "Undid the rename of 3 items",
    )
    expect(describeJob(job({ kind: "setAttributes" }))).toBe("Changing attributes of 3 items")
    expect(renameResult("undoRename", job({ state: "completed", done: 2, failed: 1 }))).toBe(
      "2 of 3 names are back; the rest is listed.",
    )
    expect(renameResult("setAttributes", job({ state: "completed", done: 2, failed: 1 }))).toBe(
      "Changed 2 of 3 items; the rest is listed.",
    )
    expect(renameResult("multiRename", job({ state: "cancelled", done: 1 }))).toBe(
      "Stopped after 1 of 3.",
    )
    expect(renameResult("multiRename", job({ state: "failed", error: "Disk gone." }))).toBe(
      "Disk gone.",
    )
  })

  it("names like the fake Go engine the tests rely on", () => {
    expect(fakeRename({ ...DEFAULT_PLAN, nameMask: "[N]-[C]", digits: 2 }, "a.txt", false, 4)).toBe(
      "a-05.txt",
    )
    expect(fakeRename({ ...DEFAULT_PLAN, extMask: "" }, "a.b.txt", false, 0)).toBe("a.b")
    expect(fakeRename(DEFAULT_PLAN, "Folder.v2", true, 0)).toBe("Folder.v2")
    expect(() => fakeRename({ ...DEFAULT_PLAN, nameMask: "[N" }, "a", false, 0)).toThrow()
  })
})
