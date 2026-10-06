import type { Crumb } from "@fastview/contracts"
import { useInterfaceSizeStore } from "@fastview/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { resetCarry, startPanels } from "./features/carry"
import { resetDrives } from "./features/drives"
import { resetFiles, useFilesStore } from "./features/files"
import { resetHotlist } from "./features/hotlist"
import { resetKeymap } from "./features/keymap"
import { resetListing, useListingStore } from "./features/listing"
import { resetMarks, useMarksStore } from "./features/marks"
import { usePanelsStore } from "./features/panels"
import { PANELS_KEY } from "./features/session"
import { resetQueue, startQueue, useQueueStore } from "./features/queue"
import { resetSettings } from "./features/settings"
import { resetTabs } from "./features/tabs"
import { folder, installFakeCommander, item, type FakeOptions } from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// Stage C04: file operations (docs/commander/stages/C04-file-operations.md).

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const SRC: Crumb = { name: "src", path: "C:\\src" }
const DST: Crumb = { name: "Backup", path: "C:\\Backup" }
const OTHER: Crumb = { name: "other", path: "C:\\other" }

// src: dir000000, dir000001, file000000.txt … file000003.txt (ids 10e6 + n)
const folders = () => [
  folder(10, SRC.path, [ROOT, SRC], 2, 4, [item(10_000_100, "photo.jpg", { sizeBytes: 2048 })]),
  folder(20, DST.path, [ROOT, DST], 0, 2),
  folder(30, OTHER.path, [ROOT, OTHER], 0, 1),
]

let stops: (() => void)[] = []

async function start(options: Partial<FakeOptions> = {}) {
  const fake = installFakeCommander({
    folders: folders(),
    home: SRC.path,
    settings: {
      [PANELS_KEY]: {
        v: 2,
        active: "left",
        left: { tabs: [{ path: SRC.path }] },
        right: { tabs: [{ path: DST.path }] },
      },
    },
    ...options,
  })
  render(<AppShell />)
  await act(async () => {
    stops.push(startQueue())
    stops.push(await startPanels())
  })
  await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(SRC.path))
  await waitFor(() => expect(screen.getByTestId("path-right")).toHaveTextContent(DST.path))
  return fake
}

const grid = (side: "left" | "right") => screen.getByTestId(`grid-${side}`)
const key = (side: "left" | "right", init: KeyboardEventInit & { key: string }) =>
  act(async () => {
    fireEvent.keyDown(grid(side), init)
  })
const cursorRow = (side: "left" | "right") =>
  grid(side).querySelector<HTMLElement>("[data-cursor=true]")
/** Rows: 0 "..", 1 dir000000, 2 dir000001, 3 file000000.txt, … */
async function cursorTo(row: number) {
  await waitFor(() =>
    expect(grid("left").querySelector(`[data-row="${row}"][data-id]`)).not.toBeNull(),
  )
  await act(async () => {
    fireEvent.mouseDown(grid("left").querySelector(`[data-row="${row}"]`)!, { button: 0 })
  })
}

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
  resetFiles()
  resetQueue()
  usePanelsStore.setState({ active: "left", split: 50, layoutToken: 0 })
  useInterfaceSizeStore.setState({ size: "medium" })
})
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
  vi.useRealTimers()
})

describe("copy and move", () => {
  it("F5 shows the destination and the count before anything starts; Enter copies now", async () => {
    const fake = await start()
    await cursorTo(3)
    await key("left", { key: "Insert" }) // file000000.txt
    await key("left", { key: "Insert" }) // file000001.txt
    await key("left", { key: "F5" })
    const dialog = await screen.findByTestId("copy-dialog")
    expect(screen.getByRole("dialog")).toHaveTextContent("Copy 2 items")
    expect(within(dialog).getByLabelText("Destination")).toHaveValue(DST.path)
    expect(within(dialog).getByLabelText("If the name exists")).toHaveValue("ask")
    await waitFor(() => expect(useFilesStore.getState().copy?.bytes).not.toBeNull())
    await act(async () => {
      fireEvent.submit(dialog)
    })
    expect(fake.api.files.start).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "copy", destinationDirId: 20, conflict: "ask", now: true }),
    )
    const sent = fake.api.files.start.mock.calls[0]![0]
    expect(sent).not.toHaveProperty("mask")
    const sel = sent.source.selection
    expect(
      sel.ranges.reduce((n: number, [a, b]: number[]) => n + b! - a!, 0) + sel.include.length,
    ).toBe(2)
    expect(screen.queryByTestId("copy-dialog")).toBeNull()
    // The marks are cleared once the job is queued; the keys are back in the panel.
    expect(useMarksStore.getState().left.ranges).toEqual([])
    await waitFor(() => expect(grid("left")).toHaveFocus())
  })

  it("F6 queues a move with a mask, verify and another policy; an edited destination is resolved in Go", async () => {
    const fake = await start()
    await cursorTo(1) // dir000000
    await key("left", { key: "F6" })
    const dialog = await screen.findByTestId("copy-dialog")
    expect(screen.getByRole("dialog")).toHaveTextContent("Move dir000000")
    fireEvent.change(within(dialog).getByLabelText("Destination"), {
      target: { value: OTHER.path },
    })
    fireEvent.change(within(dialog).getByLabelText("File mask"), { target: { value: "*.jpg" } })
    fireEvent.change(within(dialog).getByLabelText("If the name exists"), {
      target: { value: "replaceOlder" },
    })
    fireEvent.click(within(dialog).getByLabelText(/Verify after copying/))
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Queue" }))
    })
    expect(fake.api.dir.open).toHaveBeenCalledWith({ path: OTHER.path, recursive: false })
    const sent = fake.api.files.start.mock.calls.at(-1)![0]
    expect(sent).toMatchObject({
      kind: "move",
      destinationDirId: 30,
      conflict: "replaceOlder",
      verify: true,
      mask: "*.jpg",
    })
    expect(sent).not.toHaveProperty("now")
  })

  it("shows why a destination can't be used and keeps the dialog", async () => {
    await start()
    await cursorTo(3)
    await key("left", { key: "F5" })
    const dialog = await screen.findByTestId("copy-dialog")
    fireEvent.change(within(dialog).getByLabelText("Destination"), {
      target: { value: "C:\\nowhere" },
    })
    await act(async () => {
      fireEvent.submit(dialog)
    })
    expect(within(dialog).getByRole("alert")).toHaveTextContent("doesn't exist")
  })

  it("Shift+F5 copies the cursor entry here under a new name", async () => {
    const fake = await start()
    await cursorTo(7) // photo.jpg
    await key("left", { key: "F5", shiftKey: true })
    const dialog = await screen.findByTestId("copy-dialog")
    expect(screen.getByRole("dialog")).toHaveTextContent("Copy photo.jpg here")
    const name = within(dialog).getByLabelText("New name") as HTMLInputElement
    expect(name.value).toBe("photo.jpg")
    fireEvent.change(name, { target: { value: "photo copy.jpg" } })
    await act(async () => {
      fireEvent.submit(dialog)
    })
    expect(fake.api.files.start.mock.calls.at(-1)![0]).toMatchObject({
      kind: "copy",
      destinationDirId: 10,
      name: "photo copy.jpg",
    })
  })

  it("drags a row to the other panel: the copy dialog with that folder", async () => {
    await start()
    await cursorTo(3)
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
    const row = grid("left").querySelector('[data-row="4"]')!
    await act(async () => {
      fireEvent.dragStart(row, { dataTransfer })
    })
    const body = grid("right").children[1]!
    await act(async () => {
      fireEvent.dragOver(body, { dataTransfer })
      fireEvent.drop(body, { dataTransfer })
    })
    // (jsdom drop events carry no modifier keys; Shift+drop = move is in the e2e spec.)
    const c = useFilesStore.getState().copy!
    expect(c).toMatchObject({
      kind: "copy",
      destination: DST.path,
      destinationDirId: 20,
      what: "file000001.txt",
    })
  })
})

describe("delete, new folder and rename", () => {
  it("F8 moves to the trash; where there is none, the dialog says so and offers permanent delete", async () => {
    const fake = await start({ trash: false })
    await cursorTo(3)
    await key("left", { key: "F8" })
    const dialog = await screen.findByTestId("delete-dialog")
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toHaveTextContent("This drive has no trash"),
    )
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently…" }))
    })
    expect(screen.getByRole("dialog")).toHaveTextContent("Delete file000000.txt permanently?")
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("delete-dialog")).getByRole("button", {
          name: "Delete permanently",
        }),
      )
    })
    expect(fake.api.files.start).toHaveBeenCalledWith(expect.objectContaining({ kind: "delete" }))
  })

  it("Shift+Delete asks first; the cursor lands on the next entry once the item is gone", async () => {
    const fake = await start()
    await cursorTo(3)
    await key("left", { key: "Delete", shiftKey: true })
    expect(await screen.findByTestId("delete-dialog")).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toHaveTextContent("permanently")
    expect(fake.api.files.start).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.submit(screen.getByTestId("delete-dialog"))
    })
    expect(fake.api.files.start).toHaveBeenCalledWith(expect.objectContaining({ kind: "delete" }))
    // Go removes the file; the session is invalidated.
    const src = fake.folder(10)!
    src.entries = src.entries.filter((e) => e.name !== "file000000.txt")
    await act(async () => fake.relist(10))
    await waitFor(() => expect(cursorRow("left")).toHaveTextContent("file000001"))
  })

  it("F8 with Enter moves to the trash", async () => {
    const fake = await start()
    await cursorTo(3)
    await key("left", { key: "F8" })
    const dialog = await screen.findByTestId("delete-dialog")
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Move to trash" })).toBeEnabled(),
    )
    await act(async () => {
      fireEvent.submit(dialog)
    })
    expect(fake.api.files.start).toHaveBeenCalledWith(expect.objectContaining({ kind: "trash" }))
  })

  it("F7 creates a folder chain and puts the cursor on it", async () => {
    const fake = await start()
    await key("left", { key: "F7" })
    const input = await screen.findByLabelText("Folder name")
    fireEvent.change(input, { target: { value: "bad:name" } })
    await act(async () => {
      fireEvent.submit(input.closest("form")!)
    })
    expect(screen.getByRole("alert")).toHaveTextContent("characters that aren't allowed")
    fireEvent.change(input, { target: { value: "aaa/b/c" } })
    await act(async () => {
      fireEvent.submit(input.closest("form")!)
    })
    expect(fake.api.fs.mkdir).toHaveBeenLastCalledWith(10, "aaa/b/c")
    await act(async () => fake.relist(10))
    await waitFor(() => expect(cursorRow("left")).toHaveTextContent("aaa"))
  })

  it("F2 renames in place with the extension left out of the selection; errors show by the row", async () => {
    const fake = await start()
    await cursorTo(7) // photo.jpg
    await key("left", { key: "F2" })
    const field = (await screen.findByTestId("rename-field")) as HTMLInputElement
    expect(field.value).toBe("photo.jpg")
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5])
    fireEvent.change(field, { target: { value: "file000001.txt" } })
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" })
    })
    expect(screen.getByRole("alert")).toHaveTextContent("already exists")
    fireEvent.change(field, { target: { value: "beach.jpg" } })
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" })
    })
    expect(fake.api.files.rename).toHaveBeenLastCalledWith(10_000_100, "beach.jpg")
    expect(screen.queryByTestId("rename-field")).toBeNull()
    await act(async () => fake.relist(10))
    await waitFor(() => expect(cursorRow("left")).toHaveTextContent("beach"))
    expect(grid("left")).toHaveFocus()
    // Esc cancels without a call.
    await key("left", { key: "F6", shiftKey: true })
    const again = await screen.findByTestId("rename-field")
    await act(async () => {
      fireEvent.keyDown(again, { key: "Escape" })
    })
    expect(fake.api.files.rename).toHaveBeenCalledTimes(2)
  })
})

describe("clipboard", () => {
  it("Ctrl+C / Ctrl+X / Ctrl+V use the internal clipboard; names and paths copy as text", async () => {
    const fake = await start()
    await cursorTo(3)
    await key("left", { key: "c", ctrlKey: true })
    expect(fake.api.clip.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ ranges: [[2, 3]] }),
      "copy",
    )
    await waitFor(() =>
      expect(screen.getByTestId("files-notice")).toHaveTextContent("1 item copied"),
    )
    await key("left", { key: "x", ctrlKey: true })
    expect(fake.api.clip.set).toHaveBeenLastCalledWith(expect.anything(), "cut")
    await key("right", { key: "v", ctrlKey: true })
    expect(fake.api.clip.paste).toHaveBeenLastCalledWith(20, "ask")
    await key("left", { key: "c", ctrlKey: true, shiftKey: true })
    expect(fake.api.clipboard.copyPaths).toHaveBeenLastCalledWith(expect.anything(), false)
    await key("left", { key: "c", ctrlKey: true, altKey: true })
    expect(fake.api.clipboard.copyPaths).toHaveBeenLastCalledWith(expect.anything(), true)
  })
})

describe("the queue", () => {
  it("shows progress with speed and ETA, pauses, resumes and cancels", async () => {
    const fake = await start()
    const j = fake.job({
      kind: "copy",
      state: "running",
      total: 1204,
      done: 300,
      destination: "Backup",
      bytesTotal: 6 * 1024 ** 3,
      bytesDone: 2 * 1024 ** 3,
      bytesPerSec: 412 * 1024 ** 2,
      etaMs: 12_000,
    })
    await act(async () => fake.emit("job.progress", j))
    const row = screen.getByTestId(`job-${j.jobId}`)
    expect(row).toHaveTextContent("Copying 1,204 items to Backup")
    expect(row).toHaveTextContent("2.0 GB of 6.0 GB · 412.0 MB/s · 12 s left")
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Pause" }))
    })
    expect(fake.api.files.pause).toHaveBeenCalledWith(j.jobId)
    await act(async () =>
      fake.emit("job.progress", { ...j, state: "paused", bytesPerSec: 0, etaMs: 0 }),
    )
    expect(screen.getByTestId(`job-${j.jobId}`)).toHaveTextContent("paused")
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId(`job-${j.jobId}`)).getByRole("button", { name: "Resume" }),
      )
    })
    expect(fake.api.files.resume).toHaveBeenCalledWith(j.jobId)
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId(`job-${j.jobId}`)).getByRole("button", { name: "Cancel" }),
      )
    })
    expect(fake.api.jobs.cancel).toHaveBeenCalledWith(j.jobId)
    // Ctrl+J lists every job; a queued one can start now.
    const q = fake.job({ kind: "move", state: "queued", total: 3, destination: "other" })
    await act(async () => fake.emit("job.progress", q))
    await act(async () => {
      fireEvent.keyDown(window, { key: "j", ctrlKey: true })
    })
    expect(useQueueStore.getState().expanded).toBe(true)
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId(`job-${q.jobId}`)).getByRole("button", { name: "Start now" }),
      )
    })
    expect(fake.api.files.startNow).toHaveBeenCalledWith(q.jobId)
  })

  it("a job that asks gets its dialog; Esc leaves the question in the queue", async () => {
    const fake = await start()
    const conflict = {
      name: "photo.jpg",
      source: { id: 1, size: 2048, modifiedMs: 1_800_000_000_000, isDir: false },
      target: { id: 2, size: 100, modifiedMs: 1_700_000_000_000, isDir: false },
    }
    const j = fake.job({ kind: "copy", state: "asking", total: 4, destination: "Backup", conflict })
    await act(async () => fake.emit("job.progress", j))
    const dialog = await screen.findByTestId("conflict-dialog")
    expect(screen.getByRole("dialog")).toHaveTextContent("“photo.jpg” already exists")
    expect(dialog).toHaveTextContent("2,048 bytes")
    expect(within(dialog).getAllByText("newer")).toHaveLength(1)
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    })
    expect(screen.queryByTestId("conflict-dialog")).toBeNull()
    const row = screen.getByTestId(`job-${j.jobId}`)
    expect(row).toHaveTextContent("needs your decision")
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Needs your decision" }))
    })
    // "Apply to all", then Rename existing.
    fireEvent.click(
      within(screen.getByTestId("conflict-dialog")).getByLabelText(
        "Apply to all conflicts in this job",
      ),
    )
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("conflict-dialog")).getByRole("button", {
          name: "Rename existing",
        }),
      )
    })
    expect(fake.api.files.resolve).toHaveBeenLastCalledWith(j.jobId, "renameExisting", true)
    // Another question: "Overwrite all older" always applies to all.
    await act(async () =>
      fake.emit("job.progress", { ...j, conflict: { ...conflict, name: "b.jpg" } }),
    )
    await act(async () => {
      fireEvent.click(
        within(await screen.findByTestId("conflict-dialog")).getByRole("button", {
          name: "Overwrite all older",
        }),
      )
    })
    expect(fake.api.files.resolve).toHaveBeenLastCalledWith(j.jobId, "replaceOlder", true)
    await act(async () =>
      fake.emit("job.progress", { ...j, conflict: { ...conflict, name: "c.jpg" } }),
    )
    await act(async () => {
      fireEvent.click(
        within(await screen.findByTestId("conflict-dialog")).getByRole("button", {
          name: "Cancel job",
        }),
      )
    })
    expect(fake.api.jobs.cancel).toHaveBeenCalledWith(j.jobId)
  })

  it("a finished job with failures keeps a Details button", async () => {
    const fake = await start()
    const j = fake.job({
      kind: "copy",
      state: "completed",
      total: 5,
      done: 4,
      failed: 1,
      finishedMs: 2,
      destination: "Backup",
    })
    await act(async () => fake.emit("job.progress", j))
    const row = screen.getByTestId(`job-${j.jobId}`)
    expect(row).toHaveTextContent("Copied 5 items to Backup")
    expect(row).toHaveTextContent("1 failed")
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Details" }))
    })
    expect(await screen.findByTestId("job-details")).toHaveTextContent("locked.jpg")
    // Folder-size jobs belong to the status line, not the queue.
    await act(async () =>
      fake.emit("job.progress", fake.job({ kind: "dirSize", state: "running" })),
    )
    expect(useQueueStore.getState().jobs.some((x) => x.kind === "dirSize")).toBe(false)
  })

  it("the function-key bar runs F5 to F8", async () => {
    await start()
    await cursorTo(3)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /F7 New folder/ }))
    })
    expect(await screen.findByLabelText("Folder name")).toBeInTheDocument()
    expect(useListingStore.getState().left.dirId).toBe(10)
  })
})
