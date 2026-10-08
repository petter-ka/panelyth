import type { Crumb } from "@panelyth/contracts"
import { useInterfaceSizeStore } from "@panelyth/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { resetArchives, startArchives, testResult, withFormat } from "./features/archives"
import { resetCarry, startPanels } from "./features/carry"
import { resetFiles } from "./features/files"
import {
  archivePath,
  moveCursor,
  pageStoreOf,
  parentRows,
  resetListing,
  useListingStore,
} from "./features/listing"
import { startOpen } from "./features/open"
import { usePanelsStore } from "./features/panels"
import { folder, installFakeCommander, item, type FakeArchive } from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// Stage C07: archives (docs/commander/stages/C07-archives.md).

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const HOME: Crumb = { name: "home", path: "C:\\home" }

const A = 2 ** 50 // archive entry ids come from their own range
const SET: FakeArchive = {
  entryId: 10_000_200,
  archiveId: 7,
  root: [
    item(A + 1, "docs", { kind: "dir", dirSizeBytes: 12 }),
    item(A + 2, "a.txt", { sizeBytes: 5 }),
  ],
  dirs: { [A + 1]: [item(A + 3, "readme.txt", { sizeBytes: 12 })] },
}

const home = () =>
  folder(10, HOME.path, [ROOT, HOME], 1, 1, [
    item(10_000_200, "set.zip", { sizeBytes: 100 }),
    item(10_000_201, "broken.zip"),
    item(10_000_202, "photos.rar"),
  ])

let stops: (() => void)[] = []

async function start(over: { archiveWarnings?: ("space" | "ratio")[]; sevenZip?: boolean } = {}) {
  const fake = installFakeCommander({
    folders: [home()],
    home: HOME.path,
    volumes: [],
    archives: [
      SET,
      {
        entryId: 10_000_201,
        archiveId: 8,
        root: [],
        error: {
          code: "CORRUPT_MEDIA",
          reason: "corrupt",
          message: "The archive is damaged and can't be read.",
        },
      },
      {
        entryId: 10_000_202,
        archiveId: 9,
        root: [],
        error: {
          code: "UNSUPPORTED_MEDIA",
          reason: "noTool",
          message: "This archive needs 7-Zip.",
        },
      },
    ],
    ...over,
  })
  render(<AppShell />)
  await act(async () => {
    stops = [await startPanels(), startOpen(), startArchives()]
  })
  await waitFor(() => expect(rows("left").length).toBeGreaterThan(3))
  await waitFor(() => expect(rows("right").length).toBeGreaterThan(3))
  return fake
}

const grid = (side: "left" | "right") => screen.getByTestId(`grid-${side}`)
const rows = (side: "left" | "right") => [...grid(side).querySelectorAll<HTMLElement>("[data-row]")]
const key = (init: KeyboardEventInit & { key: string }) =>
  act(async () => {
    fireEvent.keyDown(grid("left"), init)
  })
const noticeText = () => screen.getByTestId("files-notice").textContent

/** Puts the left panel's cursor on the entry named `name` (the Full view splits off extensions). */
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

async function enterSet() {
  await cursorTo("set.zip")
  await key({ key: "Enter" })
  await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent("set.zip"))
}

beforeEach(() => {
  mockViewport(800, 600)
  resetListing()
  resetCarry()
  resetFiles()
  resetArchives()
  resetBridgeCache()
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

describe("archives as folders", () => {
  it("Enter opens an archive; its folders open; Backspace returns with the cursor on what was left", async () => {
    const fake = await start()
    await enterSet()
    expect(fake.api.archive.open).toHaveBeenCalledWith(SET.entryId)
    expect(fake.lastDescriptor()).toMatchObject({
      dirId: 10,
      archiveId: 7,
      archiveDirId: 0,
      scope: "all",
    })
    expect(screen.getByTestId("path-left")).toHaveTextContent("C:\\home\\set.zip")
    await waitFor(() => expect(rows("left")).toHaveLength(3)) // "..", docs, a.txt
    expect(rows("left")[1]).toHaveTextContent("docs")

    await cursorTo("docs")
    await key({ key: "Enter" })
    await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent("set.zip\\docs"))
    expect(fake.lastDescriptor()).toMatchObject({ archiveId: 7, archiveDirId: A + 1 })
    await waitFor(() => expect(rows("left")[1]).toHaveTextContent("readme"))

    await key({ key: "Backspace" })
    await waitFor(() => expect(useListingStore.getState().left.archive?.dirs).toEqual([]))
    expect(useListingStore.getState().left.cursor).toBe(1) // on docs

    await key({ key: "Backspace" })
    await waitFor(() => expect(useListingStore.getState().left.archive).toBeNull())
    expect(screen.getByTestId("path-left")).toHaveTextContent(/^C:\\home$/)
    await waitFor(() => {
      const p = useListingStore.getState().left
      expect(pageStoreOf("left").getItem(p.cursor - parentRows(p))?.name).toBe("set.zip")
    })
  })

  it("is read-only: changing commands say so and start nothing", async () => {
    const fake = await start()
    await enterSet()
    await cursorTo("a.txt")
    for (const k of [{ key: "F8" }, { key: "F7" }, { key: "F6" }, { key: "F2" }, { key: "F4" }]) {
      await key(k)
      expect(noticeText()).toMatch(/read-only|can't be edited/)
    }
    expect(fake.api.files.start).not.toHaveBeenCalled()
    expect(screen.queryByTestId("delete-dialog")).toBeNull()
  })

  it("F5 copies entries out with an extract job; warnings come first", async () => {
    const fake = await start({ archiveWarnings: ["ratio"] })
    await enterSet()
    await cursorTo("docs")
    await key({ key: "F5" })
    const d = screen.getByTestId("copy-dialog")
    expect(screen.getByRole("dialog")).toHaveTextContent("Copy docs")
    expect(screen.getByRole("dialog")).toHaveTextContent("out of the archive")
    expect(within(d).queryByLabelText("File mask")).toBeNull()
    await waitFor(() =>
      expect(within(d).getByTestId("archive-warnings")).toHaveTextContent("zip bomb"),
    )
    await act(async () => {
      fireEvent.submit(d)
    })
    expect(fake.api.files.start).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "extract",
        destinationDirId: 10,
        conflict: "ask",
        links: true,
      }),
    )
  })

  it("nothing is copied or pasted into an archive panel", async () => {
    const fake = await start()
    await enterSet()
    // The right panel copies towards the archive on the left.
    act(() => {
      usePanelsStore.setState({ active: "right" })
      moveCursor("right", 2)
    })
    await act(async () => {
      fireEvent.keyDown(grid("right"), { key: "F5" })
    })
    expect(screen.queryByTestId("copy-dialog")).toBeNull()
    expect(noticeText()).toMatch(/can't be copied into an archive/)
    expect(fake.api.files.start).not.toHaveBeenCalled()
  })

  it("a damaged archive says why; without 7-Zip it opens with its app", async () => {
    const fake = await start()
    await cursorTo("broken.zip")
    await key({ key: "Enter" })
    await waitFor(() => expect(noticeText()).toMatch(/broken.zip can't be opened: .*damaged/))
    expect(useListingStore.getState().left.archive).toBeNull()

    await cursorTo("photos.rar")
    await key({ key: "Enter" })
    await waitFor(() => expect(fake.shell).toContainEqual({ action: "open", entryId: 10_000_202 }))
    expect(noticeText()).toMatch(/7-Zip isn't installed/)
  })
})

describe("pack, unpack and test", () => {
  it("Alt+F5 packs into the other panel's folder in the chosen format", async () => {
    const fake = await start()
    await cursorTo("file000000.txt")
    await key({ key: "F5", altKey: true })
    const d = screen.getByTestId("pack-dialog")
    expect(within(d).getByLabelText("Archive name")).toHaveValue("file000000.zip")
    await waitFor(() => expect(fake.api.archive.tools).toHaveBeenCalled())
    expect(within(d).getByLabelText("7Z (7-Zip)")).toBeDisabled()
    fireEvent.click(within(d).getByLabelText("TAR.GZ"))
    expect(within(d).getByLabelText("Archive name")).toHaveValue("file000000.tar.gz")
    fireEvent.change(within(d).getByLabelText("Compression"), { target: { value: "9" } })
    fireEvent.click(within(d).getByLabelText(/Delete the originals/))
    await act(async () => {
      fireEvent.submit(d)
    })
    expect(fake.api.files.start).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "pack",
        destinationDirId: 10,
        name: "file000000.tar.gz",
        format: "tgz",
        level: 9,
        deleteOriginals: true,
      }),
    )
    expect(screen.queryByTestId("pack-dialog")).toBeNull()
  })

  it("Alt+F9 unpacks with the size checked first; Alt+Shift+F9 tests and announces", async () => {
    const fake = await start()
    await cursorTo("set.zip")
    await key({ key: "F9", altKey: true })
    const d = screen.getByTestId("unpack-dialog")
    await waitFor(() => expect(within(d).getByTestId("unpack-size")).toHaveTextContent("1 file"))
    fireEvent.click(within(d).getByLabelText(/each archive into its own folder/))
    await act(async () => {
      fireEvent.submit(d)
    })
    expect(fake.api.files.start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "extract",
        destinationDirId: 10,
        subfolders: true,
        links: true,
      }),
    )

    await key({ key: "F9", altKey: true, shiftKey: true })
    expect(fake.api.files.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "testArchive" }),
    )
    const job = (await fake.api.files.start.mock.results.at(-1)!.value) as { r: { jobId: number } }
    await act(async () => {
      fake.emit(
        "job.progress",
        fake.job({
          jobId: job.r.jobId,
          kind: "testArchive",
          state: "completed",
          total: 1,
          done: 1,
        }),
      )
    })
    expect(noticeText()).toBe("1 archive tested: no errors.")
  })

  it("names and messages", () => {
    expect(withFormat("photos.zip", "tgz")).toBe("photos.tar.gz")
    expect(withFormat("photos.tar.gz", "7z")).toBe("photos.7z")
    expect(withFormat("photos", "zip")).toBe("photos.zip")
    const base = { jobId: 1, kind: "testArchive" as const, total: 3, done: 2, failed: 1 }
    expect(testResult({ ...base, state: "completed" } as never)).toMatch(
      /1 archive of 3 archives damaged/,
    )
    expect(
      archivePath("C:\\home", {
        archiveId: 1,
        entryId: 2,
        name: "a.zip",
        format: "zip",
        dirs: [{ id: 3, name: "d" }],
        rejected: 0,
      }),
    ).toBe("C:\\home\\a.zip\\d")
    expect(
      archivePath("/", {
        archiveId: 1,
        entryId: 2,
        name: "a.zip",
        format: "zip",
        dirs: [],
        rejected: 0,
      }),
    ).toBe("/a.zip")
  })
})
