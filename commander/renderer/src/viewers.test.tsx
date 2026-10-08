import type { Crumb } from "@panelyth/contracts"
import { resetViewerImages } from "@panelyth/media-ui"
import { useInterfaceSizeStore } from "@panelyth/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { setRangeFetch } from "./features/bytes"
import { resetCarry, startPanels } from "./features/carry"
import { resetDrives } from "./features/drives"
import { resetFiles, useFilesStore } from "./features/files"
import { resetHotlist } from "./features/hotlist"
import { resetKeymap } from "./features/keymap"
import { resetListing, useListingStore } from "./features/listing"
import { resetMarks } from "./features/marks"
import { resetMediaConfig, startMedia } from "./features/media"
import { resetOpen, startOpen } from "./features/open"
import { usePanelsStore } from "./features/panels"
import { resetQueue } from "./features/queue"
import { PANELS_KEY } from "./features/session"
import { resetSettings, updateSettings } from "./features/settings"
import { resetTabs } from "./features/tabs"
import {
  createSettler,
  QUICK_SETTLE_MS,
  resetViewers,
  startQuickView,
  useViewersStore,
} from "./features/viewers"
import { folder, installFakeCommander, item, type FakeOptions } from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// Stage C05: quick view, lister, open and edit
// (docs/commander/stages/C05-quick-view-and-lister.md).

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const SRC: Crumb = { name: "src", path: "C:\\src" }
const DST: Crumb = { name: "Backup", path: "C:\\Backup" }

const utf8 = (s: string) => new TextEncoder().encode(s)
const utf16le = (s: string) => {
  const out = new Uint8Array(2 + s.length * 2)
  out.set([0xff, 0xfe])
  for (let i = 0; i < s.length; i++) {
    out[2 + i * 2] = s.charCodeAt(i) & 0xff
    out[3 + i * 2] = s.charCodeAt(i) >> 8
  }
  return out
}

/** 8 MiB of numbered log lines: big enough that reading it all would show. */
const BIG = utf8(
  Array.from({ length: 200_000 }, (_, i) => `${String(i).padStart(6, "0")} log line`).join("\n") +
    "\n",
)

const ID = {
  big: 1001,
  clip: 1002,
  data: 1003,
  notes: 1004,
  photo: 1005,
  setup: 1006,
  wide: 1007,
}
/** Rows: 0 "..", 1 dir000000, then the files by name. */
const ROW = { dir: 1, big: 2, clip: 3, data: 4, notes: 5, photo: 6, setup: 7, wide: 8 }

const contents: Record<number, Uint8Array> = {
  [ID.big]: BIG,
  [ID.data]: Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256),
  [ID.notes]: utf8("Grüße aus Köln\r\nsecond line\nthird line\n"),
  [ID.wide]: utf16le("Wide text\r\nline two\r\n"),
  [ID.setup]: Uint8Array.of(0x4d, 0x5a, 0x90, 0),
}

const folders = () => [
  folder(10, SRC.path, [ROOT, SRC], 1, 0, [
    item(ID.big, "big.log", { sizeBytes: BIG.length }),
    item(ID.clip, "clip.mp4", { kind: "video", sizeBytes: 5000 }),
    item(ID.data, "data.bin", { sizeBytes: 300 }),
    item(ID.notes, "notes.txt", { sizeBytes: contents[ID.notes]!.length }),
    item(ID.photo, "photo.jpg", { kind: "image", sizeBytes: 2048 }),
    item(ID.setup, "setup.exe", { sizeBytes: 4, attrs: 16 }),
    item(ID.wide, "wide.txt", { sizeBytes: contents[ID.wide]!.length }),
  ]),
  folder(20, DST.path, [ROOT, DST], 0, 2),
]

let stops: (() => void)[] = []

async function start(options: Partial<FakeOptions> = {}) {
  const fake = installFakeCommander({
    folders: folders(),
    home: SRC.path,
    contents,
    programs: [ID.setup],
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
    stops.push(startOpen(), startQuickView(), startMedia())
    stops.push(await startPanels())
  })
  await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(SRC.path))
  await waitFor(() => expect(screen.getByTestId("path-right")).toHaveTextContent(DST.path))
  return fake
}

const grid = (side: "left" | "right") => screen.getByTestId(`grid-${side}`)
const key = (el: HTMLElement, init: KeyboardEventInit & { key: string }) =>
  act(async () => {
    fireEvent.keyDown(el, init)
  })
const panelKey = (init: KeyboardEventInit & { key: string }) => key(grid("left"), init)
/** Shell keys (Ctrl+Q, Tab) go to the window, as AppShell listens there. */
const shellKey = (init: KeyboardEventInit & { key: string }) =>
  act(async () => {
    fireEvent.keyDown(window, init)
  })
async function cursorTo(row: number) {
  // Row 0 is the synthetic "..", which has no entry id.
  const ready = row === 0 ? `[data-row="0"]` : `[data-row="${row}"][data-id]`
  await waitFor(() => expect(grid("left").querySelector(ready)).not.toBeNull())
  await act(async () => {
    fireEvent.mouseDown(grid("left").querySelector(`[data-row="${row}"]`)!, { button: 0 })
  })
}
const lister = () => screen.getByTestId("lister")
const listerKey = (init: KeyboardEventInit & { key: string }) =>
  key(document.activeElement as HTMLElement, init)

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
  resetViewers()
  resetOpen()
  resetMediaConfig()
  resetViewerImages()
  usePanelsStore.setState({ active: "left", split: 50, layoutToken: 0 })
  useInterfaceSizeStore.setState({ size: "medium" })
})
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
  setRangeFetch(null)
  vi.useRealTimers()
})

describe("settle logic", () => {
  it("delivers a value only after it stayed for the delay; repeats never restart the wait", () => {
    vi.useFakeTimers()
    const seen: (number | null)[] = []
    const s = createSettler<number | null>(QUICK_SETTLE_MS, (v) => seen.push(v))
    s.push(1)
    vi.advanceTimersByTime(100)
    s.push(2) // moved on: 1 never shows
    vi.advanceTimersByTime(100)
    s.push(2) // the same entry again does not restart the wait
    vi.advanceTimersByTime(50)
    expect(seen).toEqual([2])
    s.push(2) // already shown
    vi.advanceTimersByTime(500)
    expect(seen).toEqual([2])
    s.push(3)
    s.push(2) // back to the shown entry before 3 settled: nothing to do
    vi.advanceTimersByTime(500)
    expect(seen).toEqual([2])
    s.push(null)
    s.cancel()
    vi.advanceTimersByTime(500)
    expect(seen).toEqual([2])
  })
})

describe("quick view (Ctrl+Q)", () => {
  it("shows the cursor entry in the other panel once the cursor settles, by kind", async () => {
    const fake = await start()
    await cursorTo(ROW.notes)
    await shellKey({ key: "q", ctrlKey: true })
    const quick = await screen.findByTestId("quick-view")
    // In place of the right panel, which stays mounted but inert.
    expect(quick.closest("[data-slot]")).toHaveAttribute("data-slot", "right")
    expect(screen.getByTestId("panel-right").parentElement).toHaveAttribute("inert")
    expect(quick).toHaveAttribute("data-entry", String(ID.notes))
    // UTF-8 text, CRLF and LF lines, from the first window.
    const text = await within(quick).findByTestId("text-view")
    await waitFor(() => expect(text).toHaveTextContent("Grüße aus Köln"))
    expect(text.querySelectorAll("[data-offset]")).toHaveLength(3)

    // UTF-16 with a BOM.
    await panelKey({ key: "ArrowDown" })
    await panelKey({ key: "ArrowDown" })
    await panelKey({ key: "ArrowDown" }) // wide.txt
    await waitFor(() => expect(quick).toHaveAttribute("data-entry", String(ID.wide)))
    await waitFor(() =>
      expect(within(quick).getByTestId("text-view")).toHaveTextContent("Wide text"),
    )
    // Only the settled entries were opened: photo.jpg and setup.exe were passed over.
    const opened = fake.api.file.open.mock.calls.map(([id]) => id)
    expect(opened).toEqual([ID.notes, ID.wide])
    expect(fake.api.media.open).not.toHaveBeenCalled()

    // Binary: hex plus properties.
    await cursorTo(ROW.data)
    await waitFor(() => expect(quick).toHaveAttribute("data-entry", String(ID.data)))
    const hex = await within(quick).findByTestId("hex-view")
    await waitFor(() => expect(hex).toHaveTextContent("00000000"))
    expect(hex).toHaveTextContent("00 25 4a 6f")
    expect(within(quick).getByTestId("quick-properties")).toHaveTextContent("300 bytes")

    // An image through the shared ImageViewer and the preview cache.
    await cursorTo(ROW.photo)
    await waitFor(() => expect(within(quick).getByTestId("image-viewer")).toBeInTheDocument())
    await waitFor(() => expect(fake.api.media.open).toHaveBeenCalledWith(ID.photo))
    expect(fake.api.preview.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ lane: "cmd-quick", profile: "viewer-fit" }),
    )
    // A video through the shared VideoPlayer.
    await cursorTo(ROW.clip)
    await waitFor(() => expect(within(quick).getByTestId("video-player")).toBeInTheDocument())
    // A folder: its properties.
    await cursorTo(ROW.dir)
    await waitFor(() => expect(quick).toHaveAttribute("data-kind", "dir"))
    expect(within(quick).getByTestId("quick-properties")).toHaveTextContent("dir000000")
    // ".." shows nothing.
    await cursorTo(0)
    await waitFor(() => expect(quick).toHaveTextContent("No file under the cursor"))

    // Ctrl+Q again: the right panel is back, with its listing untouched.
    await shellKey({ key: "q", ctrlKey: true })
    expect(screen.queryByTestId("quick-view")).toBeNull()
    expect(screen.getByTestId("panel-right").parentElement).not.toHaveAttribute("inert")
    expect(screen.getByTestId("path-right")).toHaveTextContent(DST.path)
  })

  it("never loads while the cursor keeps moving", async () => {
    const fake = await start()
    await cursorTo(ROW.big)
    await shellKey({ key: "q", ctrlKey: true })
    await waitFor(() => expect(fake.api.file.open).toHaveBeenCalledTimes(1))
    for (let i = 0; i < 5; i++) {
      await panelKey({ key: "ArrowDown" })
      await new Promise((r) => setTimeout(r, QUICK_SETTLE_MS / 3))
    }
    // clip, data, notes, photo were passed over within the settle time; setup.exe settles.
    await waitFor(() =>
      expect(screen.getByTestId("quick-view")).toHaveAttribute("data-entry", String(ID.setup)),
    )
    expect(fake.api.file.open.mock.calls.map(([id]) => id)).toEqual([ID.big, ID.setup])
    expect(fake.api.media.open).not.toHaveBeenCalled()
  })

  it("Tab moves into the quick view and back; the active panel stays", async () => {
    await start()
    await cursorTo(ROW.notes)
    await shellKey({ key: "q", ctrlKey: true })
    const text = await within(screen.getByTestId("quick-view")).findByTestId("text-view")
    await shellKey({ key: "Tab" })
    expect(text).toHaveFocus()
    expect(usePanelsStore.getState().active).toBe("left")
    await shellKey({ key: "Tab" })
    await waitFor(() => expect(grid("left")).toHaveFocus())
  })
})

describe("lister (F3)", () => {
  it("opens text with the detected encoding; 1–4 switch modes; Esc keeps the cursor", async () => {
    await start()
    await cursorTo(ROW.wide)
    await panelKey({ key: "F3" })
    expect(lister()).toHaveAttribute("data-entry", String(ID.wide))
    await waitFor(() => expect(lister()).toHaveAttribute("data-mode", "text"))
    expect(within(lister()).getByLabelText("Encoding")).toHaveValue("utf-16le")
    await waitFor(() =>
      expect(within(lister()).getByTestId("text-view")).toHaveTextContent("line two"),
    )
    // Image and video do not apply to a text file.
    expect(within(lister()).getByRole("button", { name: "Image" })).toBeDisabled()
    await listerKey({ key: "3" })
    expect(lister()).toHaveAttribute("data-mode", "text")
    await listerKey({ key: "2" })
    expect(lister()).toHaveAttribute("data-mode", "hex")
    await waitFor(() =>
      expect(within(lister()).getByTestId("hex-view")).toHaveTextContent("ff fe 57 00"),
    )
    await listerKey({ key: "1" })
    expect(lister()).toHaveAttribute("data-mode", "text")
    // A different encoding re-reads the same bytes.
    fireEvent.change(within(lister()).getByLabelText("Encoding"), {
      target: { value: "windows-1252" },
    })
    await waitFor(() => expect(within(lister()).getByTestId("text-view")).toHaveTextContent("ÿþW"))
    // Esc: back to the panel, cursor where it was.
    await act(async () => {
      fireEvent.keyDown(lister(), { key: "Escape" })
    })
    expect(screen.queryByTestId("lister")).toBeNull()
    expect(useListingStore.getState().left.cursor).toBe(ROW.wide)
    await waitFor(() => expect(grid("left")).toHaveFocus())
  })

  it("starts binary files in hex, images and videos in their modes; N / P step through files only", async () => {
    await start()
    await cursorTo(ROW.big)
    await panelKey({ key: "F3" })
    await waitFor(() => expect(lister()).toHaveAttribute("data-mode", "text"))
    await listerKey({ key: "p" }) // the folder before big.log is skipped: nothing before it
    expect(lister()).toHaveAttribute("data-entry", String(ID.big))
    await listerKey({ key: "n" })
    await waitFor(() => expect(lister()).toHaveAttribute("data-entry", String(ID.clip)))
    expect(lister()).toHaveAttribute("data-mode", "video")
    expect(within(lister()).getByTestId("video-player")).toBeInTheDocument()
    await listerKey({ key: "n" })
    await waitFor(() => expect(lister()).toHaveAttribute("data-entry", String(ID.data)))
    await waitFor(() => expect(lister()).toHaveAttribute("data-mode", "hex"))
    await listerKey({ key: "n" })
    await listerKey({ key: "n" })
    await waitFor(() => expect(lister()).toHaveAttribute("data-entry", String(ID.photo)))
    expect(lister()).toHaveAttribute("data-mode", "image")
    expect(within(lister()).getByTestId("image-viewer")).toBeInTheDocument()
    await act(async () => {
      fireEvent.keyDown(lister(), { key: "Escape" })
    })
    // The panel's cursor did not follow N / P.
    expect(useListingStore.getState().left.cursor).toBe(ROW.big)
  })

  it("does nothing on a folder or ..", async () => {
    await start()
    await cursorTo(ROW.dir)
    await panelKey({ key: "F3" })
    expect(screen.queryByTestId("lister")).toBeNull()
    await cursorTo(0)
    await panelKey({ key: "F3" })
    expect(screen.queryByTestId("lister")).toBeNull()
  })

  it("reads a big file in bounded windows: End, then the scroll bar, never the whole file", async () => {
    const fake = await start()
    await cursorTo(ROW.big)
    await panelKey({ key: "F3" })
    const view = await within(lister()).findByTestId("text-view")
    await waitFor(() => expect(view).toHaveTextContent("000000 log line"))
    await listerKey({ key: "End" })
    await waitFor(() => expect(view).toHaveTextContent("199999 log line"))
    expect(within(lister()).getByTestId("lister-position")).toHaveTextContent("100%")
    await listerKey({ key: "Home" })
    await waitFor(() => expect(view).toHaveTextContent("000000 log line"))
    await listerKey({ key: "PageDown" })
    await waitFor(() => expect(view).not.toHaveTextContent("000000 log line"))
    const read = fake.reads.reduce((n, r) => n + r.end - r.start + 1, 0)
    expect(read).toBeLessThan(BIG.length / 8)
    // Keys move by lines.
    const top = Number(view.dataset.top)
    await listerKey({ key: "ArrowDown" })
    await waitFor(() => expect(Number(view.dataset.top)).toBe(top + "000000 log line\n".length))
    await listerKey({ key: "ArrowUp" })
    await waitFor(() => expect(Number(view.dataset.top)).toBe(top))
  })

  it("finds text forward and backward, case-insensitively by default", async () => {
    await start()
    await cursorTo(ROW.big)
    await panelKey({ key: "F3" })
    const view = await within(lister()).findByTestId("text-view")
    await listerKey({ key: "f", ctrlKey: true })
    const input = within(lister()).getByLabelText("Find")
    fireEvent.change(input, { target: { value: "150000 LOG" } })
    await act(async () => {
      fireEvent.submit(input.closest("form")!)
    })
    await waitFor(() =>
      expect(within(view).getByTestId("find-mark")).toHaveTextContent("150000 log"),
    )
    // F3 finds the next one: there is none.
    await key(input, { key: "F3" })
    await waitFor(() =>
      expect(within(lister()).getByTestId("find-status")).toHaveTextContent("Not found"),
    )
    // Esc closes the find bar first, then the lister.
    await key(input, { key: "Escape" })
    expect(within(lister()).queryByLabelText("Find")).toBeNull()
    await act(async () => {
      fireEvent.keyDown(lister(), { key: "Escape" })
    })
    expect(screen.queryByTestId("lister")).toBeNull()
  })
})

describe("open and edit", () => {
  it("Enter opens a file with its default app; folders still open in the panel", async () => {
    const fake = await start()
    await cursorTo(ROW.notes)
    await panelKey({ key: "Enter" })
    expect(fake.shell).toEqual([{ action: "open", entryId: ID.notes }])
    expect(fake.api.shell.open).toHaveBeenCalledWith(ID.notes, undefined)
    await cursorTo(ROW.dir)
    await panelKey({ key: "Enter" })
    await waitFor(() => expect(fake.api.dir.openEntry).toHaveBeenCalled())
    expect(fake.shell).toHaveLength(1)
  })

  it("asks before a program runs; Cancel has the focus", async () => {
    const fake = await start()
    await cursorTo(ROW.setup)
    await panelKey({ key: "Enter" })
    const dialog = await screen.findByTestId("program-dialog")
    expect(screen.getByRole("dialog")).toHaveTextContent("setup.exe is a program")
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus()
    expect(fake.shell).toEqual([])
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    })
    expect(fake.shell).toEqual([])
    await panelKey({ key: "Enter" })
    await act(async () => {
      fireEvent.click(
        within(await screen.findByTestId("program-dialog")).getByRole("button", { name: "Run" }),
      )
    })
    expect(fake.api.shell.open).toHaveBeenLastCalledWith(ID.setup, true)
    expect(fake.shell).toEqual([{ action: "open", entryId: ID.setup }])
  })

  it("follows the setting: never refuses with a message, always runs without asking", async () => {
    const fake = await start()
    await cursorTo(ROW.setup)
    act(() => updateSettings({ runPrograms: "never" }))
    await panelKey({ key: "Enter" })
    expect(screen.queryByTestId("program-dialog")).toBeNull()
    expect(useFilesStore.getState().notice).toMatch(/is a program/)
    expect(fake.shell).toEqual([])
    act(() => updateSettings({ runPrograms: "always" }))
    await panelKey({ key: "Enter" })
    expect(screen.queryByTestId("program-dialog")).toBeNull()
    expect(fake.api.shell.open).toHaveBeenLastCalledWith(ID.setup, true)
    expect(fake.shell).toEqual([{ action: "open", entryId: ID.setup }])
  })

  it("F4 edits the cursor file; Shift+F4 creates a text file, edits it and puts the cursor on it", async () => {
    const fake = await start()
    await cursorTo(ROW.notes)
    await panelKey({ key: "F4" })
    expect(fake.shell).toEqual([{ action: "edit", entryId: ID.notes }])
    await cursorTo(ROW.dir)
    await panelKey({ key: "F4" }) // folders are not edited
    expect(fake.shell).toHaveLength(1)

    await panelKey({ key: "F4", shiftKey: true })
    const input = await screen.findByLabelText("File name")
    expect(input).toHaveValue("new.txt")
    fireEvent.change(input, { target: { value: "bad:name" } })
    await act(async () => {
      fireEvent.submit(input.closest("form")!)
    })
    expect(await screen.findByRole("alert")).toHaveTextContent("aren't allowed")
    fireEvent.change(input, { target: { value: "todo.txt" } })
    await act(async () => {
      fireEvent.submit(input.closest("form")!)
    })
    expect(fake.api.fs.mkfile).toHaveBeenLastCalledWith(10, "todo.txt")
    const created = fake.folder(10)!.entries.find((e) => e.name === "todo.txt")!
    expect(fake.shell.at(-1)).toEqual({ action: "edit", entryId: created.id })
    // The listing brings the new file in; the cursor lands on it.
    fake.relist(10)
    await waitFor(() =>
      expect(grid("left").querySelector("[data-cursor=true]")).toHaveAttribute(
        "data-id",
        String(created.id),
      ),
    )
  })

  it("reports a file that can't be opened", async () => {
    const fake = await start()
    fake.api.shell.open.mockResolvedValueOnce({
      ok: false,
      e: { code: "INTERNAL", message: "No application is associated", retryable: false },
    })
    await cursorTo(ROW.data)
    await panelKey({ key: "Enter" })
    expect(useFilesStore.getState().notice).toMatch(/data.bin can't be opened: No application/)
  })
})

describe("quick view state", () => {
  it("follows the active panel when it changes another way", async () => {
    await start()
    await shellKey({ key: "q", ctrlKey: true })
    expect(useViewersStore.getState().quick).toBe("left")
    act(() => usePanelsStore.setState({ active: "right" }))
    expect(useViewersStore.getState().quick).toBe("right")
    expect(screen.getByTestId("quick-view").closest("[data-slot]")).toHaveAttribute(
      "data-slot",
      "left",
    )
  })
})
