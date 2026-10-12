import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppShell } from "../../app/AppShell"
import {
  DEFAULT_EDITOR_SETTINGS,
  EDITOR_SETTINGS_KEY,
  parseEditorSettings,
  startEditorSettingsPersistence,
  useEditorSettings,
} from "../../features/editor/editorSettings"
import {
  editBlocker,
  isDirty,
  openEditor,
  resetEditor,
  startEditor,
  toEditList,
  useEditorStore,
} from "../../features/editor/editorStore"
import { searchTools, toolDef, type ToolId } from "../../features/editor/tools"
import {
  openFolder,
  resetFolderStore,
  startFolderMonitoring,
} from "../../features/folder/folderStore"
import { startLibraryMonitoring, useLibraryStore } from "../../features/library/libraryStore"
import { resetThumbs, startThumbMonitoring } from "../../features/previews/thumbStore"
import { resetShortcutStore } from "../../features/shortcuts/shortcutStore"
import { startSidecarMonitoring, useSidecarStore } from "../../features/system/sidecarStore"
import { resetLayoutStore } from "../../features/tiles/layoutStore"
import { resetViewerImages, startViewerImageMonitoring } from "../../features/viewer/viewerImages"
import { openViewerAt, resetViewer } from "../../features/viewer/viewerStore"
import { installFakeBridge, makeItems } from "../../test/fakeBridge"
import { mockViewport } from "../../test/viewport"

let stop: (() => void)[] = []

/** 2 folders, then images (ids are index + 1); the editor opens on IMG_2 (id 3). */
async function setup(openIt = true) {
  const bridge = installFakeBridge()
  bridge.backend.items = makeItems(12, 2)
  stop = [
    startSidecarMonitoring(),
    startFolderMonitoring(),
    startThumbMonitoring(),
    startViewerImageMonitoring(),
    startEditor(),
  ]
  render(<AppShell />)
  await act(() => openFolder("/photos"))
  if (openIt) await act(() => openEditor({ id: 3, name: "IMG_2.jpg" }))
  return bridge
}

const editor = () => screen.getByTestId("editor")
const state = () => useEditorStore.getState()
const lists = (bridge: Awaited<ReturnType<typeof setup>>) =>
  bridge.backend.edit.renders.map((r) => r.editList)
const lastRender = (bridge: Awaited<ReturnType<typeof setup>>) =>
  bridge.backend.edit.renders.at(-1)!
const key = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  act(async () => void fireEvent.keyDown(el, { key: k, ...init }))
const tool = (id: string) => editor().querySelector<HTMLButtonElement>(`button[data-tool="${id}"]`)!
const group = (id: string) =>
  editor().querySelector<HTMLButtonElement>(`button[data-group="${id}"]`)!
const click = (el: HTMLElement) => act(async () => void fireEvent.click(el))
/** Opens a tool as a user does: its group in the rail, then its header in the panel. */
const pick = async (id: ToolId) => {
  await click(group(toolDef(id).group))
  if (tool(id).getAttribute("aria-expanded") !== "true") await click(tool(id))
}
/** The frame the canvas shows follows the newest render. */
const settled = (bridge: Awaited<ReturnType<typeof setup>>) =>
  waitFor(() =>
    expect(screen.getByTestId("editor-canvas").dataset.frame).toBe(
      `panelyth-media://m/${String(lastRender(bridge).rev).padStart(32, "0")}`,
    ),
  )

beforeEach(() => {
  mockViewport(1400, 900)
  localStorage.clear()
  resetLayoutStore()
  resetFolderStore()
  resetThumbs()
  resetViewer()
  resetViewerImages()
  resetEditor()
  resetShortcutStore()
  useEditorSettings.setState({ settings: DEFAULT_EDITOR_SETTINGS })
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
})
afterEach(() => {
  stop.forEach((s) => s())
  resetEditor()
})

describe("opening the editor", () => {
  it("opens from the focused viewer's Edit button and from E", async () => {
    const bridge = await setup(false)
    act(() => void openViewerAt(2))
    await click(screen.getByTestId("viewer-edit"))
    await waitFor(() => expect(editor().dataset.status).toBe("ready"))
    expect(bridge.api.edit.open).toHaveBeenCalledWith(3)
    expect(screen.getByTestId("editor-name")).toHaveTextContent("IMG_2.jpg")
    expect(screen.getByTestId("editor-size")).toHaveTextContent("4,000 × 3,000")
    // The first render is the untouched picture, at the size the canvas shows.
    await settled(bridge)
    expect(lists(bridge)[0]).toEqual([])
    expect(lastRender(bridge)).toMatchObject({ quality: "final", histogram: true })
    expect(lastRender(bridge).view.maxEdge).toBeLessThanOrEqual(2560)
    // Focus is on the tool rail: the group whose tools the panel lists.
    expect(document.activeElement).toBe(group("adjust"))
    expect(screen.getByTestId("tool-panel").dataset.group).toBe("adjust")
    expect(screen.queryByTestId("editor-unsaved")).toBeNull()

    // Esc returns to the viewer, which takes the keys again.
    await key(editor(), "Escape")
    expect(screen.queryByTestId("editor")).toBeNull()
    expect(bridge.backend.edit.closed).toEqual(["0123456789abcdef01234567"])
    expect(document.activeElement).toBe(screen.getByTestId("viewer"))
    await key(screen.getByTestId("viewer"), "e")
    await waitFor(() => expect(editor().dataset.status).toBe("ready"))
    expect(bridge.api.edit.open).toHaveBeenCalledTimes(2)
  })

  it("starts from the turn and flip the viewer showed", async () => {
    const bridge = await setup(false)
    act(() => void openViewerAt(2))
    await key(screen.getByTestId("viewer"), "r")
    await key(screen.getByTestId("viewer"), "h")
    await key(screen.getByTestId("viewer"), "e")
    await waitFor(() => expect(editor().dataset.status).toBe("ready"))
    await settled(bridge)
    expect(lastRender(bridge).editList).toEqual([
      { op: "rotate", p: { angle: 90 } },
      { op: "flip", p: { axis: "h" } },
    ])
    expect(screen.getByTestId("editor-unsaved")).toBeInTheDocument()
    expect(screen.getAllByTestId("stack-item")).toHaveLength(2)
    expect(screen.getByTestId("editor-size")).toHaveTextContent("3,000 × 4,000")
  })

  it("says why a picture cannot be edited", async () => {
    const bridge = installFakeBridge()
    bridge.api.edit.open.mockResolvedValueOnce({
      ok: false,
      e: { code: "EDIT_TOO_LARGE", message: "the picture is too large to edit", retryable: false },
    } as never)
    render(<AppShell />)
    await act(() => openEditor({ id: 3, name: "huge.png" }))
    expect(screen.getByTestId("editor-error")).toHaveTextContent(/too large to edit/)
    expect(bridge.api.edit.render).not.toHaveBeenCalled()
    await click(within(screen.getByTestId("editor-error")).getByRole("button"))
    expect(screen.queryByTestId("editor")).toBeNull()
  })

  it("gives a reason for what has no Edit", () => {
    expect(editBlocker({ kind: "image" })).toBeNull()
    expect(editBlocker({ kind: "video" })).toMatch(/Videos/)
    expect(editBlocker({ kind: "dir" })).toMatch(/Folders/)
    expect(editBlocker(null)).toMatch(/Select a picture/)
  })

  it("opens on the picture the commander handed over", async () => {
    const bridge = await setup(false)
    act(() => bridge.push("edit.request", { entryId: 7 }))
    await waitFor(() => expect(editor().dataset.status).toBe("ready"))
    expect(bridge.api.edit.open).toHaveBeenCalledWith(7)
    // The name comes from the session; the commander sent only the id.
    expect(screen.getByTestId("editor-name")).toHaveTextContent("IMG_2.jpg")
  })
})

describe("the edit list", () => {
  it("adds a quarter turn, undoes and redoes it", async () => {
    const bridge = await setup()
    await pick("rotate")
    expect(screen.getByTestId("tool-panel").dataset.tool).toBe("rotate")
    await click(screen.getByRole("button", { name: "Right" }))
    await settled(bridge)
    expect(lastRender(bridge).editList).toEqual([{ op: "rotate", p: { angle: 90 } }])
    expect(screen.getByTestId("editor-size")).toHaveTextContent("3,000 × 4,000")
    expect(screen.getByTestId("stack-item")).toHaveTextContent("Rotate")
    expect(screen.getByTestId("stack-item")).toHaveTextContent("90°")
    expect(screen.getByTestId("editor-unsaved")).toBeInTheDocument()

    await key(editor(), "z", { ctrlKey: true })
    await settled(bridge)
    expect(lastRender(bridge).editList).toEqual([])
    expect(screen.queryByTestId("stack-item")).toBeNull()
    expect(screen.queryByTestId("editor-unsaved")).toBeNull()
    await key(editor(), "z", { ctrlKey: true, shiftKey: true })
    await settled(bridge)
    expect(lastRender(bridge).editList).toEqual([{ op: "rotate", p: { angle: 90 } }])
    await click(screen.getByRole("button", { name: "Undo" }))
    expect(state().items).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled()
  })

  it("steps a slider with the keyboard and speaks its value", async () => {
    const bridge = await setup()
    await pick("rotate")
    const slider = screen.getByRole("slider", { name: "Angle" })
    expect(slider).toHaveAttribute("aria-valuetext", "0 °")
    // The native range input steps on arrow keys; jsdom reports the change.
    await act(async () => void fireEvent.change(slider, { target: { value: "2.5" } }))
    await settled(bridge)
    expect(lastRender(bridge).editList).toEqual([
      { op: "rotate", p: { angle: 2.5, mode: "crop", fill: "#ffffff" } },
    ])
    expect(screen.getByRole("slider", { name: "Angle" })).toHaveAttribute("aria-valuetext", "2.5 °")
    // Typing a number with its unit, then Enter.
    const field = screen.getByRole("textbox", { name: "Angle" })
    await act(async () => void fireEvent.change(field, { target: { value: "-7,5°" } }))
    await key(field, "Enter")
    expect(state().items[0]!.op).toMatchObject({ p: { angle: -7.5 } })
    // Arrow keys in the field step by the slider's step, Shift by ten.
    await key(field, "ArrowUp", { shiftKey: true })
    expect(state().items[0]!.op).toMatchObject({ p: { angle: -6.5 } })
    // Reset: the dot, and Ctrl+0 on the slider.
    await click(screen.getByRole("button", { name: "Reset Angle" }))
    expect(state().items[0]!.op).toMatchObject({ p: { angle: 0 } })
    await act(async () => void fireEvent.change(slider, { target: { value: "9" } }))
    await key(screen.getByRole("slider", { name: "Angle" }), "0", { ctrlKey: true })
    expect(state().items[0]!.op).toMatchObject({ p: { angle: 0 } })
    // A number typed into a field never triggers a tool or closes the editor.
    await key(field, "1")
    await key(field, "/")
    expect(screen.queryByTestId("tool-search")).toBeNull()
    expect(screen.getByTestId("editor")).toBeInTheDocument()
  })

  it("makes one history step of a drag, with drafts while it moves and a final frame when it rests", async () => {
    const bridge = await setup()
    await pick("rotate")
    const slider = screen.getByRole("slider", { name: "Angle" })
    await settled(bridge)
    const before = bridge.backend.edit.renders.length
    await act(async () => {
      fireEvent.pointerDown(slider)
      for (const v of ["1", "2", "3", "4"]) fireEvent.change(slider, { target: { value: v } })
    })
    expect(state().past).toHaveLength(1)
    expect(state().items).toHaveLength(1)
    await waitFor(() => expect(bridge.backend.edit.renders.length).toBeGreaterThan(before))
    expect(bridge.backend.edit.renders[before]!.quality).toBe("draft")
    await act(async () => void fireEvent.pointerUp(slider))
    await waitFor(() => expect(lastRender(bridge).quality).toBe("final"))
    expect(lastRender(bridge).editList[0]).toMatchObject({ p: { angle: 4 } })
    // Fewer renders than changes: only the newest request waits.
    expect(bridge.backend.edit.renders.length - before).toBeLessThanOrEqual(4)
    // One undo takes the whole drag back.
    await key(editor(), "z", { ctrlKey: true })
    expect(state().items).toHaveLength(0)
  })

  it("switches an edit off, moves it and removes it from the stack", async () => {
    const bridge = await setup()
    await pick("rotate")
    await click(screen.getByRole("button", { name: "Right" }))
    await pick("flip")
    await click(screen.getByRole("button", { name: "Horizontal" }))
    await settled(bridge)
    expect(screen.getAllByTestId("stack-item").map((el) => el.dataset.op)).toEqual([
      "rotate",
      "flip",
    ])
    await click(screen.getByRole("switch", { name: "Apply Rotate" }))
    await settled(bridge)
    expect(lastRender(bridge).editList).toEqual([
      { op: "rotate", p: { angle: 90 }, off: true },
      { op: "flip", p: { axis: "h" } },
    ])
    await click(screen.getByRole("button", { name: "Move Flip earlier" }))
    expect(toEditList(state().items).map((o) => o.op)).toEqual(["flip", "rotate"])
    await click(screen.getByRole("button", { name: "Remove Flip" }))
    expect(toEditList(state().items)).toEqual([{ op: "rotate", p: { angle: 90 }, off: true }])
    await click(screen.getByRole("button", { name: "Reset all" }))
    expect(state().items).toHaveLength(0)
    // Every step is one undo.
    for (let i = 0; i < 4; i++) await key(editor(), "z", { ctrlKey: true })
    expect(toEditList(state().items).map((o) => o.op)).toEqual(["rotate", "flip"])
  })

  it("finds a tool by typing and opens it", async () => {
    await setup()
    await key(editor(), "/")
    const search = within(screen.getByTestId("tool-search")).getByRole("searchbox")
    expect(document.activeElement).toBe(search)
    await act(async () => void fireEvent.change(search, { target: { value: "resi" } }))
    expect(within(screen.getByTestId("tool-search")).getAllByRole("option")).toHaveLength(1)
    await key(search, "Enter")
    // The tool opens in its own group.
    expect(screen.getByTestId("tool-panel").dataset.tool).toBe("resize")
    expect(screen.getByTestId("tool-panel").dataset.group).toBe("geometry")
    expect(searchTools("mirror").map((t) => t.id)).toEqual(["flip"])
    expect(searchTools("print size").map((t) => t.id)).toContain("resize")
    expect(searchTools("nothing-like-this")).toEqual([])
  })

  it("moves through the tool rail with the arrow keys and lists a group's tools", async () => {
    await setup()
    expect(document.activeElement).toBe(group("adjust"))
    // One tab stop: the group that is shown.
    expect(group("adjust").tabIndex).toBe(0)
    expect(group("color").tabIndex).toBe(-1)
    await key(group("adjust"), "ArrowDown")
    expect(document.activeElement).toBe(group("color"))
    await key(group("color"), "End")
    expect(document.activeElement).toBe(group("looks"))
    await key(group("looks"), "ArrowDown")
    expect(document.activeElement).toBe(group("adjust"))
    await key(group("adjust"), "ArrowUp")
    await key(group("looks"), "ArrowUp")
    expect(document.activeElement).toBe(group("geometry"))
    // Moving the focus shows nothing new; choosing a group does.
    expect(screen.getByTestId("tool-panel").dataset.group).toBe("adjust")
    await click(group("geometry"))
    expect(screen.getByTestId("tool-panel").dataset.group).toBe("geometry")
    expect(group("geometry")).toHaveAttribute("aria-pressed", "true")
    const headers = [
      ...screen.getByTestId("tool-panel").querySelectorAll<HTMLElement>("button[data-tool]"),
    ]
    expect(headers.map((h) => h.dataset.tool)).toEqual([
      "rotate",
      "flip",
      "crop",
      "resize",
      "canvas",
      "dpi",
    ])
    // A header opens its tool and closes it again; one tool is open at a time.
    await click(tool("rotate"))
    expect(tool("rotate")).toHaveAttribute("aria-expanded", "true")
    await click(tool("resize"))
    expect(tool("rotate")).toHaveAttribute("aria-expanded", "false")
    await click(tool("resize"))
    expect(screen.getByTestId("tool-panel").dataset.tool).toBe("")
    // A hidden panel comes back when a group is chosen.
    await click(screen.getByRole("button", { name: "Hide the panel" }))
    expect(screen.queryByTestId("tool-panel")).toBeNull()
    await click(group("detail"))
    expect(screen.getByTestId("tool-panel").dataset.group).toBe("detail")
  })

  it("resizes, sets the canvas and the resolution from their panels", async () => {
    const bridge = await setup()
    await pick("resize")
    const panel = () => within(screen.getByTestId("tool-panel"))
    await act(
      async () =>
        void fireEvent.change(panel().getByRole("combobox", { name: "Resize by" }), {
          target: { value: "percent" },
        }),
    )
    await settled(bridge)
    expect(lastRender(bridge).editList).toEqual([
      { op: "resize", p: { mode: "percent", w: 100, h: 0, algo: "lanczos3", noEnlarge: false } },
    ])
    const width = panel().getByRole("textbox", { name: "Width" })
    await act(async () => void fireEvent.change(width, { target: { value: "50 %" } }))
    await key(width, "Enter")
    await settled(bridge)
    expect(screen.getByTestId("editor-size")).toHaveTextContent("2,000 × 1,500")

    await pick("canvas")
    await click(panel().getByRole("radio", { name: "Bottom right" }))
    expect(toEditList(state().items)[1]).toMatchObject({
      op: "canvas",
      p: { w: 2000, h: 1500, anchor: "se" },
    })
    await pick("dpi")
    await click(panel().getByRole("checkbox", { name: /Resample/ }))
    expect(toEditList(state().items)[2]).toEqual({ op: "dpi", p: { x: 300, resample: true } })
    expect(state().items).toHaveLength(3)
  })
})

describe("cropping", () => {
  it("draws a box, locks a ratio, takes numbers and keys, and applies with Enter", async () => {
    const bridge = await setup()
    await pick("crop")
    const box = screen.getByTestId("crop-box")
    expect(state().crop!.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    // 1:1 inside 4000×3000.
    const panel = within(screen.getByTestId("tool-panel"))
    await click(panel.getByRole("button", { name: "1:1" }))
    expect(panel.getByRole("textbox", { name: "Width" })).toHaveValue("3000")
    expect(panel.getByRole("textbox", { name: "Height" })).toHaveValue("3000")
    expect(panel.getByRole("textbox", { name: "Left" })).toHaveValue("500")
    // The arrow keys move the box by a pixel, ten with Shift.
    box.focus()
    await key(box, "ArrowLeft", { shiftKey: true })
    expect(panel.getByRole("textbox", { name: "Left" })).toHaveValue("490")
    // A focused handle resizes; the ratio stays locked.
    const corner = screen.getByRole("button", { name: "Top left corner" })
    await key(corner, "ArrowRight", { shiftKey: true })
    expect(panel.getByRole("textbox", { name: "Width" })).toHaveValue("2990")
    expect(panel.getByRole("textbox", { name: "Height" })).toHaveValue("2990")
    // Nothing is in the list until the crop is applied.
    expect(state().items).toHaveLength(0)
    await key(box, "Enter")
    await settled(bridge)
    expect(screen.queryByTestId("crop-overlay")).toBeNull()
    expect(lastRender(bridge).editList).toHaveLength(1)
    expect(lastRender(bridge).editList[0]!.op).toBe("crop")
    expect(screen.getByTestId("editor-size")).toHaveTextContent("2,990 × 2,990")
  })

  it("cancels with Esc without closing the editor, and re-edits a crop under later edits", async () => {
    const bridge = await setup()
    await pick("crop")
    await key(screen.getByTestId("crop-box"), "Escape")
    expect(screen.queryByTestId("crop-overlay")).toBeNull()
    expect(screen.getByTestId("editor")).toBeInTheDocument()
    expect(state().items).toHaveLength(0)

    await pick("crop")
    const width = within(screen.getByTestId("tool-panel")).getByRole("textbox", { name: "Width" })
    await act(async () => void fireEvent.change(width, { target: { value: "2000" } }))
    await key(width, "Enter")
    await click(screen.getByRole("button", { name: "Apply" }))
    await pick("flip")
    await click(screen.getByRole("button", { name: "Vertical" }))
    await settled(bridge)
    // Changing the crop shows the picture before it; the flip is hidden meanwhile.
    await click(editor().querySelector<HTMLElement>('[data-tooltip-content="Change Crop"]')!)
    await settled(bridge)
    expect(lastRender(bridge).editList).toEqual([])
    expect(state().crop!.rect.w).toBeCloseTo(0.5)
    await click(screen.getByRole("button", { name: "Select everything" }))
    await click(screen.getByRole("button", { name: "Apply" }))
    await settled(bridge)
    expect(lastRender(bridge).editList.map((o) => o.op)).toEqual(["crop", "flip"])
    expect(state().items[0]!.op).toMatchObject({ p: { rect: { w: 1, h: 1 } } })
  })

  it("levels the picture along a drawn line", async () => {
    await setup()
    await pick("rotate")
    await click(screen.getByRole("button", { name: "Straighten" }))
    const overlay = screen.getByTestId("straighten-overlay")
    // Each event is its own task, as in the browser.
    await act(
      async () => void fireEvent.pointerDown(overlay, { button: 0, clientX: 100, clientY: 100 }),
    )
    await act(async () => void fireEvent.pointerMove(overlay, { clientX: 300, clientY: 135 }))
    await act(async () => void fireEvent.pointerUp(overlay, { clientX: 300, clientY: 135 }))
    expect(screen.queryByTestId("straighten-overlay")).toBeNull()
    const op = state().items[0]!.op
    // atan(35 / 200) ≈ 9.9°, turned the other way.
    expect(op).toMatchObject({ op: "rotate", p: { angle: -9.9, mode: "crop" } })
  })
})

describe("before and after", () => {
  it("shows the original while the key is held", async () => {
    const bridge = await setup()
    await pick("flip")
    await click(screen.getByRole("button", { name: "Horizontal" }))
    await settled(bridge)
    await key(editor(), "\\")
    await settled(bridge)
    expect(lastRender(bridge).editList).toEqual([])
    expect(screen.getByTestId("editor-canvas").dataset.compare).toBe("true")
    await act(async () => void fireEvent.keyUp(editor(), { key: "\\" }))
    await settled(bridge)
    expect(lastRender(bridge).editList).toEqual([{ op: "flip", p: { axis: "h" } }])
    // Peeking is not an edit.
    expect(state().past).toHaveLength(1)
  })
})

describe("panels", () => {
  it("shows the histogram's clipping, the EXIF tags and the estimated size", async () => {
    const bridge = await setup()
    await settled(bridge)
    expect(screen.getByTestId("clip-low")).toHaveTextContent("0.9%")
    expect(screen.getByTestId("clip-high")).toHaveTextContent("2.8%")
    const exif = await screen.findByTestId("exif")
    expect(exif).toHaveTextContent("Maker")
    expect(exif).toHaveTextContent("Panelyth")
    expect(exif).toHaveTextContent("Shutter speed")
    // A value from a fixed list is translated, not shown as its code.
    expect(exif).toHaveTextContent("Aperture priority")
    expect(exif).not.toHaveTextContent("aperturePriority")
    await click(within(exif).getByRole("button", { name: /Copy Maker/ }))
    expect(bridge.api.clipboard.copyText).toHaveBeenCalledWith("Panelyth")
    // "Remove this data when saving" is the save option.
    await click(within(exif).getByRole("checkbox"))
    expect(state().saveOptions.metadata).toBe("strip")

    await click(screen.getByRole("tab", { name: "File" }))
    const file = screen.getByTestId("editor-file")
    expect(file).toHaveTextContent("4,000 × 3,000 pixels")
    await waitFor(() => expect(file).toHaveTextContent("about 2.3 MB"), { timeout: 3000 })
    expect(bridge.api.edit.estimate).toHaveBeenLastCalledWith(
      expect.objectContaining({ format: "jpeg", quality: 92, metadata: "strip" }),
    )
  })

  it("keeps no pixels in state: a frame is a token URL", async () => {
    const bridge = await setup()
    await pick("flip")
    await click(screen.getByRole("button", { name: "Horizontal" }))
    await settled(bridge)
    const s = state()
    expect(s.frame!.url).toMatch(/^panelyth-media:\/\/m\/[0-9a-f]{32}$/)
    const json = JSON.stringify(s)
    expect(json).not.toMatch(/data:|base64|blob:/)
    // The whole state is small: the list, the history and 4 × 256 bins.
    expect(json.length).toBeLessThan(20_000)
  })
})

describe("saving", () => {
  const addFlip = async () => {
    await pick("flip")
    await click(screen.getByRole("button", { name: "Horizontal" }))
  }

  it("saves a copy as a job and shows where it went", async () => {
    const bridge = await setup()
    await addFlip()
    await click(screen.getByTestId("save-main"))
    expect(bridge.backend.edit.saves).toEqual([
      {
        sessionId: "0123456789abcdef01234567",
        editList: [{ op: "flip", p: { axis: "h" } }],
        target: "copy",
        format: "jpeg",
        quality: 92,
        metadata: "keep",
        dpi: 0,
      },
    ])
    expect(screen.getByTestId("save-controls").dataset.save).toBe("saving")
    expect(screen.getByTestId("save-main")).toBeDisabled()
    const jobId = state().save.jobId!
    act(() => bridge.job(jobId, "running", { done: 2 }))
    expect(screen.getByTestId("save-controls").dataset.save).toBe("saving")
    act(() => bridge.job(jobId, "completed", { done: 5 }))
    expect(screen.getByTestId("save-done")).toHaveTextContent("Saved as IMG_2 (edited).jpg")
    expect(screen.queryByTestId("editor-unsaved")).toBeNull()
    // The history stays; another change is unsaved again.
    expect(state().past).toHaveLength(1)
    await click(screen.getByRole("button", { name: "Show in folder" }))
    expect(bridge.api.edit.reveal).toHaveBeenCalledWith(jobId)
    // Clean now: Esc closes without a prompt, and the saved file gets selected.
    await key(editor(), "Escape")
    expect(screen.queryByTestId("editor")).toBeNull()
    await waitFor(() => expect(bridge.api.edit.saved).toHaveBeenCalledWith(jobId))
  })

  it("shows a failed save and keeps the changes unsaved", async () => {
    const bridge = await setup()
    await addFlip()
    await click(screen.getByTestId("save-main"))
    act(() =>
      bridge.job(state().save.jobId!, "failed", {
        error: "There isn't enough space on the destination drive.",
      }),
    )
    expect(screen.getByTestId("save-error")).toHaveTextContent(/enough space/)
    expect(screen.getByTestId("editor-unsaved")).toBeInTheDocument()
    await click(screen.getByRole("button", { name: "Dismiss the message" }))
    expect(screen.getByTestId("save-controls").dataset.save).toBe("idle")
    // A save that cannot start (a closed session) is said too.
    bridge.api.edit.save.mockResolvedValueOnce({
      ok: false,
      e: { code: "EDIT_SESSION_GONE", message: "gone", retryable: false },
    } as never)
    await click(screen.getByTestId("save-main"))
    expect(screen.getByTestId("save-error")).toHaveTextContent(/session has ended/)
  })

  it("cancels a running save", async () => {
    const bridge = await setup()
    await addFlip()
    await click(screen.getByTestId("save-main"))
    const jobId = state().save.jobId!
    await click(within(screen.getByTestId("save-controls")).getByRole("button", { name: "Cancel" }))
    expect(bridge.api.jobs.cancel).toHaveBeenCalledWith(jobId)
    act(() => bridge.job(jobId, "cancelled"))
    expect(screen.getByTestId("save-controls").dataset.save).toBe("idle")
    expect(isDirty(state())).toBe(true)
  })

  it("asks before replacing the original, then continues on the saved picture", async () => {
    const user = userEvent.setup()
    const bridge = await setup()
    await addFlip()
    await user.click(screen.getByTestId("save-more"))
    await user.click(await screen.findByRole("menuitem", { name: /Replace original/ }))
    const confirm = await screen.findByTestId("confirm-replace")
    expect(bridge.backend.edit.saves).toHaveLength(0)
    // Cancel has the focus (once the menu that opened the dialog has let go
    // of it): Enter does not replace.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Cancel" })),
    )
    await user.click(within(confirm).getByRole("button", { name: "Replace original" }))
    expect(bridge.backend.edit.saves[0]).toMatchObject({ target: "replace", format: "jpeg" })
    act(() => bridge.job(state().save.jobId!, "completed"))
    // The original is the edited picture now: a new session, an empty list.
    await waitFor(() => expect(bridge.api.edit.open).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(state().status).toBe("ready"))
    expect(state().items).toHaveLength(0)
    expect(isDirty(state())).toBe(false)
    expect(screen.getByTestId("save-done")).toHaveTextContent("Saved as IMG_2.jpg")
  })

  it("does not offer Replace where it cannot be done", async () => {
    const user = userEvent.setup()
    const bridge = installFakeBridge()
    bridge.backend.edit.session = { ...bridge.backend.edit.session, canReplace: false }
    useEditorSettings.setState({
      settings: { ...DEFAULT_EDITOR_SETTINGS, saveTarget: "replace" },
    })
    render(<AppShell />)
    await act(() => openEditor({ id: 3, name: "IMG_2.jpg" }))
    // The default falls back to a copy.
    expect(screen.getByTestId("save-main")).toHaveTextContent("Save a copy")
    await user.click(screen.getByTestId("save-more"))
    const item = await screen.findByRole("menuitem", { name: /no trash/ })
    expect(item).toHaveAttribute("aria-disabled", "true")
  })

  it("does nothing when the save-as dialog is cancelled", async () => {
    const user = userEvent.setup()
    const bridge = await setup()
    await addFlip()
    bridge.backend.edit.cancelDialog = true
    await user.click(screen.getByTestId("save-more"))
    await user.click(await screen.findByRole("menuitem", { name: "Save as…" }))
    await waitFor(() => expect(bridge.backend.edit.saves).toHaveLength(1))
    expect(bridge.backend.edit.saves[0]).toMatchObject({ target: "as" })
    // No path ever leaves the renderer.
    expect(Object.keys(bridge.backend.edit.saves[0]!)).not.toContain("path")
    await waitFor(() => expect(screen.getByTestId("save-controls").dataset.save).toBe("idle"))
    expect(isDirty(state())).toBe(true)
  })

  it("sets the format, quality and metadata in the save options", async () => {
    const user = userEvent.setup()
    const bridge = await setup()
    await user.click(screen.getByTestId("save-more"))
    await user.click(await screen.findByRole("menuitem", { name: /Save options/ }))
    const options = await screen.findByTestId("save-options")
    expect(options).toHaveTextContent(/Each JPEG save loses a little quality/)
    await waitFor(() =>
      expect(screen.getByTestId("save-estimate")).toHaveTextContent("about 2.3 MB"),
    )
    await user.selectOptions(within(options).getByRole("combobox", { name: "Format" }), "png")
    // Quality is a JPEG matter.
    expect(within(options).queryByRole("slider", { name: "Quality" })).toBeNull()
    await user.selectOptions(
      within(options).getByRole("combobox", { name: "Camera data (EXIF)" }),
      "stripGps",
    )
    await user.click(within(options).getByRole("button", { name: "Done" }))
    await click(screen.getByTestId("save-main"))
    expect(bridge.backend.edit.saves[0]).toMatchObject({
      format: "png",
      quality: 0,
      metadata: "stripGps",
    })
  })
})

describe("closing with unsaved changes", () => {
  it("asks, with Cancel focused; Don't save closes, Cancel stays", async () => {
    const bridge = await setup()
    await pick("flip")
    await click(screen.getByRole("button", { name: "Horizontal" }))
    await key(editor(), "Escape")
    const prompt = await screen.findByTestId("unsaved-prompt")
    expect(document.activeElement).toBe(within(prompt).getByRole("button", { name: "Cancel" }))
    await click(within(prompt).getByRole("button", { name: "Cancel" }))
    expect(screen.getByTestId("editor")).toBeInTheDocument()
    expect(state().items).toHaveLength(1)
    await click(screen.getByTestId("editor-close"))
    await click(
      within(await screen.findByTestId("unsaved-prompt")).getByRole("button", {
        name: "Don't save",
      }),
    )
    expect(screen.queryByTestId("editor")).toBeNull()
    expect(bridge.backend.edit.saves).toHaveLength(0)
    expect(bridge.backend.edit.closed).toHaveLength(1)
  })

  it("saves and closes once the job is done", async () => {
    const bridge = await setup()
    await pick("flip")
    await click(screen.getByRole("button", { name: "Horizontal" }))
    await key(editor(), "Escape")
    const prompt = await screen.findByTestId("unsaved-prompt")
    await click(within(prompt).getByRole("button", { name: "Save a copy" }))
    expect(bridge.backend.edit.saves).toHaveLength(1)
    // Still open while the job runs.
    expect(screen.getByTestId("editor")).toBeInTheDocument()
    act(() => bridge.job(state().save.jobId!, "completed"))
    await waitFor(() => expect(screen.queryByTestId("editor")).toBeNull())
  })

  it("does not ask when the reminder is switched off", async () => {
    const { useSettingsStore } = await import("../../features/settings/settingsStore")
    await setup()
    act(() => useSettingsStore.getState().setPreference("remindSaveChanges", false))
    await pick("flip")
    await click(screen.getByRole("button", { name: "Horizontal" }))
    await key(editor(), "Escape")
    expect(screen.queryByTestId("editor")).toBeNull()
    act(() => useSettingsStore.getState().setPreference("remindSaveChanges", true))
  })
})

describe("editor settings", () => {
  it("reads saved settings and falls back for anything unknown", () => {
    expect(parseEditorSettings(undefined)).toEqual(DEFAULT_EDITOR_SETTINGS)
    expect(
      parseEditorSettings({ saveTarget: "replace", jpegQuality: 80, metadata: "stripGps" }),
    ).toEqual({
      ...DEFAULT_EDITOR_SETTINGS,
      saveTarget: "replace",
      jpegQuality: 80,
      metadata: "stripGps",
    })
    expect(
      parseEditorSettings({
        saveTarget: "burn",
        jpegQuality: 500,
        metadata: 7,
        surround: "pink",
        panel: false,
      }),
    ).toEqual({ ...DEFAULT_EDITOR_SETTINGS, panel: false })
  })

  it("applies and stores the defaults of a save", async () => {
    const bridge = installFakeBridge()
    bridge.backend.settings[EDITOR_SETTINGS_KEY] = { saveTarget: "as", jpegQuality: 70 }
    stop = [
      startSidecarMonitoring(),
      startLibraryMonitoring(),
      startEditorSettingsPersistence(),
      startEditor(),
    ]
    render(<AppShell />)
    await waitFor(() => expect(useLibraryStore.getState().loaded).toBe(true))
    expect(useEditorSettings.getState().settings).toMatchObject({
      saveTarget: "as",
      jpegQuality: 70,
    })
    await act(() => openEditor({ id: 3, name: "IMG_2.jpg" }))
    expect(screen.getByTestId("save-main")).toHaveTextContent("Save as…")
    expect(state().saveOptions.quality).toBe(70)
    act(() => useEditorSettings.getState().set("surround", "black"))
    expect(bridge.api.library.setSetting).toHaveBeenLastCalledWith(
      EDITOR_SETTINGS_KEY,
      expect.objectContaining({ surround: "black", saveTarget: "as" }),
    )
    expect(screen.getByTestId("editor-canvas").style.background).toMatch(/rgb\(0, 0, 0\)|#000000/)
  })
})
