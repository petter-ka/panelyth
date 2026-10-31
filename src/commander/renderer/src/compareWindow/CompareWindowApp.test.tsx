import type { Crumb, QueryDescriptor, TextDiffRow } from "@panelyth/contracts"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "../bridge"
import { resetCompare, startCompareEvents, useCompareStore } from "../features/compare"
import { resetFiles } from "../features/files"
import { resetQueue, startQueue } from "../features/queue"
import { resetSettings } from "../features/settings"
import { folder, installFakeCommander, item } from "../test/fakeApi"
import { mockViewport } from "../test/viewport"
import {
  CompareWindowApp,
  compareRequestOf,
  releaseCompare,
  startCompareRequest,
  type CompareRequest,
} from "./CompareWindowApp"

// ADR-0048: compare by content, the list of several compared files and
// Synchronize directories in a window of their own.

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const WORK: Crumb = { name: "work", path: "C:\\work" }
const BACKUP: Crumb = { name: "Backup", path: "C:\\Backup" }
const L = 10_000_000
const R = 20_000_000
const ROWS: TextDiffRow[] = [
  { op: "equal", l: 1, r: 1, left: "one" },
  { op: "changed", l: 2, r: 2, left: "two words", right: "two birds", spans: [4, 8, 4, 8] },
]

const folders = () => [
  folder(10, WORK.path, [ROOT, WORK], 1, 0, [
    item(L + 100, "same.txt", { sizeBytes: 5 }),
    item(L + 101, "newer.txt", { sizeBytes: 9 }),
  ]),
  folder(20, BACKUP.path, [ROOT, BACKUP], 1, 0, [
    item(R + 100, "same.txt", { sizeBytes: 5 }),
    item(R + 101, "newer.txt", { sizeBytes: 3 }),
  ]),
]

let stops: (() => void)[] = []
let close: ReturnType<typeof vi.spyOn>

function install() {
  return installFakeCommander({
    folders: folders(),
    home: WORK.path,
    volumes: [],
    textDiff: { rows: ROWS },
  })
}

/** What main does for the window: the request first, then the page. */
async function open(request: CompareRequest) {
  await act(async () => {
    stops.push(startQueue())
    stops.push(startCompareEvents())
    startCompareRequest(request)
  })
  render(<CompareWindowApp />)
}

/** A listing of a folder, as a panel holds it. */
async function session(fake: ReturnType<typeof install>, dirId: number): Promise<number> {
  const d = {
    dirId,
    recursive: false,
    sort: [{ field: "name", direction: "asc" }],
    kinds: [],
    search: "",
    exts: [],
    favorite: false,
    minRating: 0,
    tags: [],
    scope: "all",
    showHidden: true,
  } as unknown as QueryDescriptor
  const res = (await fake.api.query.open(d)) as { r: { queryId: number } }
  return res.r.queryId
}

beforeEach(() => {
  mockViewport(1200, 800)
  resetBridgeCache()
  resetSettings()
  resetFiles()
  resetQueue()
  resetCompare()
  close = vi.spyOn(window, "close").mockImplementation(() => undefined)
})
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
  delete window.panelyth
  vi.restoreAllMocks()
})

describe("the window's request", () => {
  it("reads what main put in the fragment", () => {
    expect(compareRequestOf("#view=files&l=3&ln=a+b.txt&r=4&rn=%C3%A4.txt")).toEqual({
      view: "files",
      left: { id: 3, name: "a b.txt" },
      right: { id: 4, name: "ä.txt" },
    })
    expect(
      compareRequestOf("#view=many&job=9&side=right&count=14&folder=D%3A%5Cb&mq=2&tq=5"),
    ).toEqual({
      view: "many",
      jobId: 9,
      side: "right",
      count: 14,
      folder: "D:\\b",
      queries: { mine: 2, theirs: 5 },
    })
    expect(compareRequestOf("#view=sync&lp=C%3A%5Ca&ld=1&rp=D%3A%5Cb")).toEqual({
      view: "sync",
      left: { path: "C:\\a", dirId: 1 },
      right: { path: "D:\\b", dirId: null },
    })
  })

  it("takes nothing else", () => {
    for (const hash of [
      "",
      "#view=lister",
      "#view=files&l=3&r=0",
      "#view=files&l=x&r=4",
      "#view=many&job=9&side=up&mq=2&tq=5",
      "#view=many&job=9&side=left&mq=2",
    ]) {
      expect(compareRequestOf(hash), hash).toBeNull()
    }
  })
})

describe("a compare window", () => {
  it("shows two files side by side, filling the window, and closes with Esc", async () => {
    const fake = install()
    await open({
      view: "files",
      left: { id: L + 101, name: "newer.txt" },
      right: { id: R + 101, name: "newer.txt" },
    })
    const view = await screen.findByTestId("diff-dialog")
    expect(screen.getByTestId("compare-window")).toContainElement(view)
    // Not a dialog over panels: the window is the view.
    expect(screen.queryByRole("dialog")).toBeNull()
    await waitFor(() => expect(fake.api.diff.open).toHaveBeenCalledWith(L + 101, R + 101))
    await waitFor(() =>
      expect(screen.getByTestId("diff-rows").querySelectorAll("mark")).toHaveLength(2),
    )
    expect(document.title).toBe("newer.txt ↔ newer.txt – Compare by content")
    expect(fake.openDiffs()).toHaveLength(1)
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" })
    })
    expect(useCompareStore.getState().diff).toBeNull()
    await waitFor(() => expect(close).toHaveBeenCalled())
    await waitFor(() => expect(fake.openDiffs()).toEqual([]))
  })

  it("compares a pair again when Go let its comparison go for newer ones", async () => {
    const fake = install()
    // Go keeps a few comparisons; another window took this one's place.
    fake.api.diff.page.mockResolvedValueOnce({
      ok: false,
      e: { code: "NOT_FOUND", message: "the comparison is no longer open; compare again" },
    } as never)
    await open({
      view: "files",
      left: { id: L + 101, name: "newer.txt" },
      right: { id: R + 101, name: "newer.txt" },
    })
    await waitFor(() => expect(fake.api.diff.open).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByTestId("diff-rows").querySelectorAll("[data-op]")).toHaveLength(4),
    )
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("lists several compared files; a pair opens in the window and goes back to the list", async () => {
    const fake = install()
    const mine = await session(fake, 10)
    const theirs = await session(fake, 20)
    const started = (await fake.api.files.start({
      kind: "compareFiles",
      leftId: L + 100,
      rightId: R + 100,
    })) as { r: { jobId: number } }
    const jobId = started.r.jobId
    await open({
      view: "many",
      jobId,
      side: "left",
      count: 2,
      folder: BACKUP.path,
      queries: { mine, theirs },
    })
    expect(screen.getByTestId("compare-window")).toHaveTextContent(
      "2 marked files, each with the file of its name in C:\\Backup",
    )
    fake.api.files.errors.mockResolvedValue({
      ok: true,
      r: {
        errors: [{ name: "newer.txt", code: "DIFFERENT", message: "The sizes differ." }],
        total: 1,
      },
    } as never)
    await act(async () =>
      fake.emit(
        "job.progress",
        fake.job({ jobId, kind: "compareFiles", state: "completed", total: 2, done: 1, failed: 1 }),
      ),
    )
    const list = await screen.findByTestId("compare-many-rows")
    await waitFor(() => expect(list.querySelectorAll("[role=option]")).toHaveLength(1))
    // The pair is found by name in the listings that were compared.
    await act(async () => {
      fireEvent.keyDown(list, { key: "Enter" })
    })
    await waitFor(() => expect(fake.api.diff.open).toHaveBeenCalledWith(L + 101, R + 101))
    const view = await screen.findByTestId("diff-dialog")
    expect(screen.queryByTestId("compare-many")).toBeNull()
    await act(async () => {
      fireEvent.click(within(view).getByRole("button", { name: "Back to the list" }))
    })
    await screen.findByTestId("compare-many-rows")
    expect(close).not.toHaveBeenCalled()
    // Esc on the list ends the window; a finished job is not cancelled.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" })
    })
    await waitFor(() => expect(close).toHaveBeenCalled())
    expect(fake.api.jobs.cancel).not.toHaveBeenCalled()
  })

  it("follows a job that ended before the window did", async () => {
    const fake = install()
    const started = (await fake.api.files.start({
      kind: "compareFiles",
      leftId: L + 100,
      rightId: R + 100,
    })) as { r: { jobId: number } }
    const jobId = started.r.jobId
    fake.api.files.list.mockResolvedValue({
      ok: true,
      r: {
        jobs: [fake.job({ jobId, kind: "compareFiles", state: "completed", total: 2, done: 2 })],
      },
    } as never)
    await open({
      view: "many",
      jobId,
      side: "left",
      count: 2,
      folder: BACKUP.path,
      queries: { mine: 1, theirs: 2 },
    })
    await waitFor(() =>
      expect(screen.getByTestId("compare-many-status")).toHaveTextContent(
        "All 2 files are identical.",
      ),
    )
  })

  it("synchronizes two folders, and lets go of what it holds when the window closes", async () => {
    const fake = install()
    await open({
      view: "sync",
      left: { path: WORK.path, dirId: 10 },
      right: { path: BACKUP.path, dirId: 20 },
    })
    const view = await screen.findByTestId("sync-dialog")
    expect(document.title).toBe("Synchronize directories")
    expect(within(view).getByLabelText("Left folder")).toHaveValue(WORK.path)
    expect(within(view).getByLabelText("Right folder")).toHaveValue(BACKUP.path)
    await act(async () => {
      fireEvent.click(within(view).getByRole("button", { name: "Compare" }))
    })
    await waitFor(() =>
      expect(fake.api.compare.dirs).toHaveBeenCalledWith(
        expect.objectContaining({ leftDirId: 10, rightDirId: 20 }),
      ),
    )
    await waitFor(() => expect(useCompareStore.getState().sync?.run).not.toBeNull())
    const compareId = useCompareStore.getState().sync!.run!.compareId
    // The window closed by its frame: the page goes, and its compare with it.
    act(() => releaseCompare())
    expect(fake.api.compare.close).toHaveBeenCalledWith(compareId)
  })
})
