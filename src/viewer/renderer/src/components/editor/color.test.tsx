// Stage 13: the color tools in the editor shell. The pixels are Go's work
// (golden tests there); these tests cover what the renderer owns: the edit
// list each control writes, undo and redo, the widgets' keyboard routes, the
// eyedropper and its loupe, the looks and Count colors.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppShell } from "../../app/AppShell"
import { DEFAULT_EDITOR_SETTINGS, useEditorSettings } from "../../features/editor/editorSettings"
import {
  openEditor,
  resetEditor,
  startEditor,
  toEditList,
  useEditorStore,
} from "../../features/editor/editorStore"
import { LOOKS, searchTools, toolDef, type ToolId } from "../../features/editor/tools"
import {
  openFolder,
  resetFolderStore,
  startFolderMonitoring,
} from "../../features/folder/folderStore"
import { resetThumbs, startThumbMonitoring } from "../../features/previews/thumbStore"
import { resetShortcutStore } from "../../features/shortcuts/shortcutStore"
import { startSidecarMonitoring, useSidecarStore } from "../../features/system/sidecarStore"
import { resetLayoutStore } from "../../features/tiles/layoutStore"
import { resetViewerImages, startViewerImageMonitoring } from "../../features/viewer/viewerImages"
import { resetViewer } from "../../features/viewer/viewerStore"
import { installFakeBridge, makeItems } from "../../test/fakeBridge"
import { mockViewport } from "../../test/viewport"

let stop: (() => void)[] = []

async function setup() {
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
  await act(() => openEditor({ id: 3, name: "IMG_2.jpg" }))
  return bridge
}

type Bridge = Awaited<ReturnType<typeof setup>>

const editor = () => screen.getByTestId("editor")
const state = () => useEditorStore.getState()
const ops = () => toEditList(state().items)
const panel = () => within(screen.getByTestId("tool-panel"))
const lastRender = (bridge: Bridge) => bridge.backend.edit.renders.at(-1)!
const key = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  act(async () => void fireEvent.keyDown(el, { key: k, ...init }))
const click = (el: HTMLElement) => act(async () => void fireEvent.click(el))
const change = (el: HTMLElement, value: string) =>
  act(async () => void fireEvent.change(el, { target: { value } }))
const tool = (id: string) => editor().querySelector<HTMLButtonElement>(`button[data-tool="${id}"]`)!
const group = (id: string) =>
  editor().querySelector<HTMLButtonElement>(`button[data-group="${id}"]`)!
const pick = async (id: ToolId) => {
  await click(group(toolDef(id).group))
  if (tool(id).getAttribute("aria-expanded") !== "true") await click(tool(id))
}
const slider = (name: string) => panel().getByRole("slider", { name })
const undo = () => key(editor(), "z", { ctrlKey: true })
const redo = () => key(editor(), "z", { ctrlKey: true, shiftKey: true })
const settled = (bridge: Bridge) =>
  waitFor(() =>
    expect(screen.getByTestId("editor-canvas").dataset.frame).toBe(
      `panelyth-media://m/${String(lastRender(bridge).rev).padStart(32, "0")}`,
    ),
  )
/** jsdom lays nothing out: give an element a box so pointer positions mean something. */
const box = (el: HTMLElement, width: number, height: number) => {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 }) as DOMRect
}

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

describe("tools with a neutral state", () => {
  // The tool, a slider of it, a value and the parameter the value lands in.
  const cases: [ToolId, string, string, object][] = [
    ["lighting", "Exposure", "1.5", { exposure: 1.5 }],
    ["lighting", "Shadows", "40", { shadows: 40 }],
    ["colors", "Vibrance", "35", { vibrance: 35 }],
    ["colors", "Hue", "-90", { hue: -90 }],
    ["levels", "Midtones", "1.4", { l: { gamma: 1.4 } }],
    ["sharpen", "Amount", "150", { amount: 150, radius: 1 }],
    ["blur", "Radius", "8", { type: "gaussian", radius: 8 }],
    ["denoise", "Luminance noise", "60", { luminance: 60, quality: "fast" }],
    ["replaceColor", "Tolerance", "45", { tolerance: 45, from: "#ff0000" }],
  ]

  it.each(cases)("%s: %s writes one operation; undo and redo", async (id, name, value, p) => {
    const bridge = await setup()
    await pick(id)
    // Only looking at a tool is not an edit.
    expect(state().items).toHaveLength(0)
    await change(slider(name), value)
    expect(ops()).toHaveLength(1)
    expect(ops()[0]).toMatchObject({ op: id, p })
    await settled(bridge)
    expect(lastRender(bridge).editList).toEqual(ops())
    expect(screen.getByTestId("stack-item").dataset.op).toBe(id)
    await undo()
    expect(state().items).toHaveLength(0)
    await redo()
    expect(ops()[0]).toMatchObject({ op: id, p })
    // The panel edits the operation that came back, not a second one.
    expect(slider(name)).toHaveValue(value)
    // The reset dot takes the slider back.
    await click(panel().getByRole("button", { name: `Reset ${name}` }))
    expect(ops()).toHaveLength(1)
    expect(ops()[0]).not.toMatchObject({ p })
  })

  it("keeps one operation while several controls of a tool change", async () => {
    await setup()
    await pick("lighting")
    await change(slider("Contrast"), "30")
    await change(slider("Highlights"), "-20")
    await change(slider("Gamma"), "1.2")
    expect(ops()).toEqual([{ op: "lighting", p: { contrast: 30, highlights: -20, gamma: 1.2 } }])
    expect(state().past).toHaveLength(3)
    // The eye in the tool's header is the one in the edit stack.
    const eye = within(tool("lighting").closest("h2")!).getByRole("switch", {
      name: "Apply Lighting",
    })
    await click(eye)
    expect(ops()[0]).toMatchObject({ off: true })
    // A switched-off operation keeps its values and stays off while they change.
    await change(slider("Contrast"), "10")
    expect(ops()[0]).toMatchObject({ off: true, p: { contrast: 10 } })
    await click(panel().getByRole("button", { name: "Reset this tool" }))
    expect(ops()[0]).toEqual({ op: "lighting", p: {}, off: true })
  })

  it("sets the color balance of shadows, midtones and highlights", async () => {
    await setup()
    await pick("colors")
    await click(panel().getByRole("button", { name: "Color balance" }))
    const shadows = within(panel().getByRole("group", { name: "Shadows" }))
    await change(shadows.getByRole("slider", { name: "Red" }), "25")
    const highlights = within(panel().getByRole("group", { name: "Highlights" }))
    await change(highlights.getByRole("slider", { name: "Blue" }), "-40")
    expect(ops()).toEqual([
      {
        op: "colors",
        p: { balance: { shadows: [25, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, -40] } },
      },
    ])
  })

  it("switches between the kinds of blur and of noise reduction", async () => {
    await setup()
    await pick("blur")
    expect(panel().queryByRole("slider", { name: "Angle" })).toBeNull()
    await click(panel().getByRole("radio", { name: "Motion" }))
    await change(slider("Length"), "20")
    await change(slider("Angle"), "45")
    expect(ops()[0]).toEqual({ op: "blur", p: { type: "motion", radius: 20, angle: 45 } })
    await pick("denoise")
    await change(slider("Color noise"), "30")
    await click(panel().getByRole("radio", { name: "Slower; keeps texture better" }))
    expect(ops()[1]).toEqual({
      op: "denoise",
      p: { luminance: 0, color: 30, detail: 50, quality: "high" },
    })
  })
})

describe("tools that are chosen by opening them", () => {
  it("adds grayscale at once and mixes the channels", async () => {
    await setup()
    await pick("grayscale")
    expect(ops()).toEqual([{ op: "grayscale", p: { method: "luminance" } }])
    await change(panel().getByRole("combobox", { name: "Method" }), "mixer")
    await change(slider("Red"), "60")
    expect(ops()).toEqual([{ op: "grayscale", p: { method: "mixer", mix: [60, 72, 7] } }])
    // Opening it was the first step: three undos empty the list.
    for (let i = 0; i < 3; i++) await undo()
    expect(state().items).toHaveLength(0)
    expect(state().past).toHaveLength(0)
  })

  it("adds sepia, a negative and a channel swap with their options", async () => {
    await setup()
    await pick("sepia")
    await change(slider("Strength"), "50")
    await pick("negative")
    await click(panel().getByRole("checkbox", { name: "Blue" }))
    await click(panel().getByRole("checkbox", { name: "Green" }))
    // One channel stays: an empty negative would be nothing.
    expect(panel().getByRole("checkbox", { name: "Red" })).toBeDisabled()
    await pick("swapChannels")
    await change(panel().getByRole("combobox"), "grb")
    expect(ops()).toEqual([
      { op: "sepia", p: { strength: 50, tone: 0 } },
      { op: "negative", p: { channels: "r" } },
      { op: "swapChannels", p: { order: "grb" } },
    ])
    expect(screen.getAllByTestId("stack-item").map((el) => el.dataset.op)).toEqual([
      "sepia",
      "negative",
      "swapChannels",
    ])
    // A chip of the stack opens its tool on that operation, in its group.
    await click(editor().querySelector<HTMLElement>('[data-tooltip-content="Change Sepia"]')!)
    expect(screen.getByTestId("tool-panel").dataset.tool).toBe("sepia")
    await change(slider("Strength"), "20")
    expect(ops()).toHaveLength(3)
    expect(ops()[0]).toEqual({ op: "sepia", p: { strength: 20, tone: 0 } })
  })

  it("reduces the colors, suggests PNG and shows the palette of the preview", async () => {
    const bridge = await setup()
    expect(state().saveOptions.format).toBe("jpeg")
    await pick("reduceColors")
    expect(ops()).toEqual([
      { op: "reduceColors", p: { count: 16, quantizer: "median", dither: "fs" } },
    ])
    // A JPEG would bring the colors back.
    expect(state().saveOptions.format).toBe("png")
    expect(panel().getByText(/Saved as PNG/)).toBeInTheDocument()
    await change(slider("Number of colors"), "8")
    await change(panel().getByRole("combobox", { name: "Dithering" }), "ordered4")
    await click(panel().getByRole("checkbox", { name: /Keep transparency/ }))
    expect(ops()[0]).toEqual({
      op: "reduceColors",
      p: { count: 8, quantizer: "median", dither: "ordered4", keepTransparency: true },
    })
    await click(panel().getByRole("button", { name: "Show the palette" }))
    expect(bridge.backend.edit.counts).toEqual([
      {
        sessionId: "0123456789abcdef01234567",
        editList: ops(),
        scope: "preview",
        maxColors: 32,
      },
    ])
    const swatches = within(await panel().findByTestId("swatches")).getAllByRole("button")
    expect(swatches).toHaveLength(2)
    await click(swatches[0]!)
    expect(bridge.api.clipboard.copyText).toHaveBeenCalledWith("#336699")
    // The exact count of the edited picture is another answer, kept beside this one.
    await click(screen.getByRole("tab", { name: "Colors" }))
    await click(screen.getByRole("button", { name: "Count colors" }))
    expect(bridge.backend.edit.counts.at(-1)).toMatchObject({ scope: "edited" })
    expect(panel().getByTestId("swatches")).toBeInTheDocument()
    expect(Object.keys(state().colors).sort()).toEqual(["edited", "preview"])
    // The palette belongs to the list it was made for.
    await change(slider("Number of colors"), "4")
    expect(panel().queryByTestId("swatches")).toBeNull()
    expect(panel().getByRole("button", { name: "Show the palette" })).toBeInTheDocument()
  })
})

describe("levels", () => {
  it("draws the histogram of the picture the tool is given", async () => {
    const bridge = await setup()
    await pick("flip")
    await click(panel().getByRole("button", { name: "Horizontal" }))
    await pick("levels")
    await settled(bridge)
    // Nothing of levels is in the list yet: it would come after the flip.
    expect(lastRender(bridge)).toMatchObject({ histogram: true, histogramAt: 1 })
    await waitFor(() => expect(panel().getByTestId("before-histogram").dataset.ready).toBe("true"))
    await change(slider("Black point"), "12")
    await settled(bridge)
    // Now levels is the second operation; what it is given is still the first.
    expect(lastRender(bridge).histogramAt).toBe(1)
    expect(ops()[1]).toMatchObject({ op: "levels", p: { l: { inBlack: 12, inWhite: 255 } } })
    // Another tool does not ask for it.
    await pick("lighting")
    await change(slider("Contrast"), "5")
    await settled(bridge)
    expect(lastRender(bridge).histogramAt).toBeUndefined()
  })

  it("keeps black below white, edits one channel and sets the output range", async () => {
    await setup()
    await pick("levels")
    await change(slider("White point"), "100")
    await change(slider("Black point"), "180")
    expect(ops()[0]).toMatchObject({ p: { l: { inBlack: 99, inWhite: 100 } } })
    await click(panel().getByRole("radio", { name: "Blue" }))
    await change(slider("Output white"), "200")
    expect(ops()[0]).toMatchObject({
      p: {
        l: { inBlack: 99, inWhite: 100 },
        b: { inBlack: 0, inWhite: 255, outBlack: 0, outWhite: 200 },
      },
    })
  })

  it("fits the levels to the picture with Auto, as ordinary values", async () => {
    const bridge = await setup()
    await pick("levels")
    await settled(bridge)
    await waitFor(() => expect(panel().getByRole("button", { name: "Auto" })).toBeEnabled())
    await click(panel().getByRole("button", { name: "Auto" }))
    // The fake's picture has everything between 40 and 215.
    const fitted = { inBlack: 40, inWhite: 215, gamma: 1, outBlack: 0, outWhite: 255 }
    expect(ops()).toEqual([{ op: "levels", p: { r: fitted, g: fitted, b: fitted } }])
    await click(panel().getByRole("radio", { name: "Keeps the colors as they are" }))
    await click(panel().getByRole("button", { name: "Auto" }))
    expect(ops()).toEqual([{ op: "levels", p: { l: fitted } }])
    // The values can be tuned like any others.
    await change(slider("Black point"), "50")
    expect(ops()[0]).toMatchObject({ p: { l: { inBlack: 50, inWhite: 215 } } })
  })

  it("adds a fitted Levels step from Auto enhance", async () => {
    const bridge = await setup()
    await pick("lighting")
    await settled(bridge)
    await click(panel().getByRole("button", { name: "Auto enhance" }))
    expect(ops()).toHaveLength(1)
    expect(ops()[0]).toMatchObject({
      op: "levels",
      p: { r: { inBlack: 20, inWhite: 235 }, g: { inBlack: 20 }, b: { inWhite: 235 } },
    })
    await undo()
    expect(state().items).toHaveLength(0)
  })
})

describe("the eyedropper", () => {
  it("shows the color under the pointer in a loupe and takes it on a click", async () => {
    const bridge = await setup()
    await pick("levels")
    const dropper = editor().querySelector<HTMLButtonElement>('[data-dropper="white"]')!
    dropper.focus()
    await click(dropper)
    expect(state().picker).toBe("levels-white")
    expect(dropper).toHaveAttribute("aria-pressed", "true")
    const overlay = screen.getByTestId("picker-overlay")
    box(overlay, 400, 300)
    // The keyboard reaches the picture at once.
    expect(document.activeElement).toBe(overlay)
    await act(async () => void fireEvent.pointerMove(overlay, { clientX: 100, clientY: 150 }))
    await waitFor(() => expect(screen.getByTestId("loupe-hex")).toHaveTextContent("#c86432"))
    expect(screen.getByTestId("loupe-rgb")).toHaveTextContent("R 200 G 100 B 50")
    expect(screen.getByTestId("loupe")).not.toHaveAttribute("hidden")
    // Go reads the color: a 5 × 5 average of what the tool is given.
    await waitFor(() =>
      expect(bridge.backend.edit.probes.at(-1)).toMatchObject({ x: 0.25, y: 0.5, radius: 2 }),
    )
    expect(bridge.backend.edit.probes.at(-1)!.editList).toEqual([])

    await act(async () => void fireEvent.click(overlay, { clientX: 200, clientY: 75 }))
    await waitFor(() => expect(state().picker).toBeNull())
    expect(bridge.backend.edit.probes.at(-1)).toMatchObject({ x: 0.5, y: 0.25 })
    expect(ops()).toEqual([
      {
        op: "levels",
        p: {
          r: { inBlack: 0, inWhite: 200, gamma: 1, outBlack: 0, outWhite: 255 },
          g: { inBlack: 0, inWhite: 100, gamma: 1, outBlack: 0, outWhite: 255 },
          b: { inBlack: 0, inWhite: 50, gamma: 1, outBlack: 0, outWhite: 255 },
        },
      },
    ])
    expect(screen.queryByTestId("picker-overlay")).toBeNull()
    // The focus is back where the eyedropper was started.
    expect(document.activeElement).toBe(dropper)
    // The picked color never becomes state: only the numbers of the operation.
    expect(JSON.stringify(state())).not.toMatch(/data:|base64|blob:/)
  })

  it("works with the keyboard and is cancelled by Esc without closing the editor", async () => {
    const bridge = await setup()
    await pick("levels")
    const gray = editor().querySelector<HTMLButtonElement>('[data-dropper="gray"]')!
    await click(gray)
    const overlay = screen.getByTestId("picker-overlay")
    box(overlay, 400, 300)
    await key(overlay, "ArrowRight", { shiftKey: true })
    await key(overlay, "ArrowDown")
    await waitFor(() => {
      const at = bridge.backend.edit.probes.at(-1)!
      expect(at.x).toBeCloseTo(0.55)
      expect(at.y).toBeCloseTo(0.505)
    })
    await key(overlay, "Escape")
    expect(state().picker).toBeNull()
    expect(screen.getByTestId("editor")).toBeInTheDocument()
    expect(state().items).toHaveLength(0)

    // Enter takes the color at the point; a second press of the button cancels.
    await click(gray)
    await click(gray)
    expect(state().picker).toBeNull()
    await click(gray)
    await key(screen.getByTestId("picker-overlay"), "Enter")
    await waitFor(() => expect(state().items).toHaveLength(1))
    // 200, 100, 50 around their mean: red is darkened, blue lightened.
    const p = ops()[0]!.p as { r: { gamma: number }; b: { gamma: number } }
    expect(p.r.gamma).toBeLessThan(1)
    expect(p.b.gamma).toBeGreaterThan(1)
  })

  it("picks the color to replace, from the picture before the tool", async () => {
    const bridge = await setup()
    await pick("flip")
    await click(panel().getByRole("button", { name: "Vertical" }))
    await pick("replaceColor")
    await change(slider("Softness"), "10")
    await click(editor().querySelector<HTMLButtonElement>('[data-dropper="replace"]')!)
    expect(state().picker).toBe("replace-from")
    const overlay = screen.getByTestId("picker-overlay")
    box(overlay, 400, 300)
    await act(async () => void fireEvent.click(overlay, { clientX: 40, clientY: 30 }))
    await waitFor(() => expect(state().picker).toBeNull())
    // The flip is in what is probed, the tool's own operation is not.
    expect(bridge.backend.edit.probes.at(-1)!.editList).toEqual([{ op: "flip", p: { axis: "v" } }])
    expect(ops()[1]).toEqual({
      op: "replaceColor",
      p: { from: "#c86432", to: "#0000ff", tolerance: 20, softness: 10, keepLuminance: true },
    })
    // Closing the tool disarms an eyedropper that was left on.
    await click(editor().querySelector<HTMLButtonElement>('[data-dropper="replace"]')!)
    await pick("sepia")
    expect(state().picker).toBeNull()
    expect(screen.queryByTestId("picker-overlay")).toBeNull()
  })
})

describe("curves", () => {
  const points = () => (ops()[0]!.p as { l?: number[][]; r?: number[][] }).l
  const handle = (i: number) =>
    screen.getByTestId("curves").querySelector<HTMLButtonElement>(`[data-point="${i}"]`)!

  it("adds a point with a click and drags it as one history step", async () => {
    const bridge = await setup()
    await pick("curves")
    await settled(bridge)
    expect(lastRender(bridge).histogramAt).toBe(0)
    const widget = screen.getByTestId("curves")
    box(widget, 255, 255)
    expect(widget.dataset.points).toBe("2")
    // 128 in; 160 out is 95 px from the top of a 255 px widget.
    await act(
      async () => void fireEvent.pointerDown(widget, { button: 0, clientX: 128, clientY: 95 }),
    )
    expect(points()).toEqual([
      [0, 0],
      [128, 160],
      [255, 255],
    ])
    await act(async () => void fireEvent.pointerMove(widget, { clientX: 100, clientY: 55 }))
    await act(async () => void fireEvent.pointerMove(widget, { clientX: 90, clientY: 45 }))
    await act(async () => void fireEvent.pointerUp(widget, { clientX: 90, clientY: 45 }))
    expect(points()).toEqual([
      [0, 0],
      [90, 210],
      [255, 255],
    ])
    expect(state().past).toHaveLength(1)
    await settled(bridge)
    expect(lastRender(bridge)).toMatchObject({ quality: "final", editList: ops() })
    await undo()
    expect(state().items).toHaveLength(0)
    expect(screen.getByTestId("curves").dataset.points).toBe("2")
  })

  it("is edited with the keyboard alone", async () => {
    await setup()
    await pick("curves")
    // A preset gives points to work with; no pointer is needed.
    await change(panel().getByRole("combobox", { name: "Preset" }), "contrast")
    expect(points()).toEqual([
      [0, 0],
      [64, 48],
      [192, 208],
      [255, 255],
    ])
    expect(screen.getByTestId("curves").dataset.points).toBe("4")
    // Tab walks the points: each is a button with its values as its name.
    const second = handle(1)
    expect(second).toHaveAccessibleName("Point 2 of 4: input 64, output 48")
    act(() => second.focus())
    await key(second, "ArrowUp")
    await key(handle(1), "ArrowRight", { shiftKey: true })
    expect(points()![1]).toEqual([74, 49])
    // A point cannot pass its neighbour.
    for (let i = 0; i < 30; i++) await key(handle(1), "ArrowRight", { shiftKey: true })
    expect(points()![1]).toEqual([191, 49])
    // The numbers of the focused point.
    const input = panel().getByRole("textbox", { name: "Input" })
    const output = panel().getByRole("textbox", { name: "Output" })
    expect(input).toHaveValue("191")
    await change(output, "30")
    await key(output, "Enter")
    await change(input, "100")
    await key(input, "Enter")
    expect(points()![1]).toEqual([100, 30])
    // Delete removes the point; the two ends stay.
    await key(handle(1), "Delete")
    expect(points()).toEqual([
      [0, 0],
      [192, 208],
      [255, 255],
    ])
    await key(handle(1), "Delete")
    await key(handle(1), "Delete")
    expect(points()).toHaveLength(2)
    expect(panel().getByRole("button", { name: "Remove the point" })).toBeDisabled()
    // The arrow keys never leave the widget (they would move the picture or close a tool).
    expect(screen.getByTestId("tool-panel").dataset.tool).toBe("curves")
  })

  it("has a curve per channel and resets", async () => {
    await setup()
    await pick("curves")
    await change(panel().getByRole("combobox", { name: "Preset" }), "lighten")
    await click(panel().getByRole("radio", { name: "Red" }))
    expect(screen.getByTestId("curves").dataset.points).toBe("2")
    await change(panel().getByRole("combobox", { name: "Preset" }), "invert")
    expect(ops()).toEqual([
      {
        op: "curves",
        p: {
          l: [
            [0, 0],
            [128, 160],
            [255, 255],
          ],
          r: [
            [0, 255],
            [255, 0],
          ],
        },
      },
    ])
    await click(panel().getByRole("button", { name: "Reset this tool" }))
    expect(ops()).toEqual([{ op: "curves", p: {} }])
    await undo()
    expect((ops()[0]!.p as { r: number[][] }).r).toHaveLength(2)
  })
})

describe("looks", () => {
  it("shows every look on the picture from one batched request and applies one", async () => {
    const bridge = await setup()
    await click(group("looks"))
    expect(screen.getByTestId("tool-panel").dataset.tool).toBe("looks")
    await waitFor(() => expect(bridge.backend.edit.thumbs).toHaveLength(1))
    const asked = bridge.backend.edit.thumbs[0]!
    expect(asked.editLists).toHaveLength(LOOKS.length)
    expect(asked.editLists.length).toBeLessThanOrEqual(16)
    expect(asked.edge).toBeLessThanOrEqual(256)
    expect(asked.editLists[0]).toEqual(LOOKS[0]!.ops)
    const tile = (id: string) => editor().querySelector<HTMLButtonElement>(`[data-look="${id}"]`)!
    await waitFor(() =>
      expect(tile("bw").querySelector("img")).toHaveAttribute(
        "src",
        `panelyth-media://m/${"9000".padStart(32, "0")}`,
      ),
    )
    expect(tile("vivid")).toHaveTextContent("Vivid")

    await click(tile("vivid"))
    // A look is ordinary operations: they can be changed in the stack afterwards.
    expect(ops()).toEqual([
      { op: "colors", p: { vibrance: 55, saturation: 10 } },
      { op: "lighting", p: { contrast: 15 } },
    ])
    expect(state().past).toHaveLength(1)
    // The thumbnails now show each look on top of what was applied.
    await waitFor(() => expect(bridge.backend.edit.thumbs).toHaveLength(2))
    expect(bridge.backend.edit.thumbs[1]!.editLists[0]).toEqual([...ops(), ...LOOKS[0]!.ops])
    await undo()
    expect(state().items).toHaveLength(0)
    // The state holds token URLs, never pixels.
    expect(JSON.stringify(state().looks)).not.toMatch(/data:|base64|blob:/)
  })

  it("shows a group with its key, wherever the focus is", async () => {
    await setup()
    await key(editor(), "g")
    expect(screen.getByTestId("tool-panel").dataset.group).toBe("geometry")
    expect(document.activeElement).toBe(group("geometry"))
    await pick("rotate")
    // A slider is not a text field: the keys still work there.
    await key(slider("Angle"), "c")
    expect(screen.getByTestId("tool-panel").dataset.group).toBe("color")
    // A text field takes its letters.
    await pick("resize")
    await key(panel().getByRole("textbox", { name: "Width" }), "l")
    expect(screen.getByTestId("tool-panel").dataset.group).toBe("geometry")
    await key(editor(), "l")
    expect(screen.getByTestId("tool-panel").dataset.tool).toBe("looks")
  })

  it("finds the new tools by name", () => {
    expect(searchTools("curves").map((d) => d.id)).toEqual(["curves"])
    expect(searchTools("black and white").map((d) => d.id)).toContain("grayscale")
    expect(searchTools("posterize").map((d) => d.id)).toEqual(["reduceColors"])
    expect(searchTools("presets").map((d) => d.id)).toEqual(["looks"])
  })
})

describe("count colors", () => {
  it("counts when asked, shows the palette and knows when the answer is old", async () => {
    const bridge = await setup()
    await click(screen.getByRole("tab", { name: "Colors" }))
    const tab = () => within(screen.getByTestId("editor-colors"))
    // It reads the whole picture: never by itself.
    expect(bridge.api.edit.colors).not.toHaveBeenCalled()
    expect(tab().queryByTestId("colors-result")).toBeNull()
    await click(tab().getByRole("button", { name: "Count colors" }))
    expect(bridge.backend.edit.counts).toEqual([
      { sessionId: "0123456789abcdef01234567", editList: [], scope: "edited", maxColors: 32 },
    ])
    expect(await tab().findByTestId("colors-distinct")).toHaveTextContent("4,096")
    expect(tab().getByTestId("colors-result")).toHaveTextContent("4,000 × 3,000 pixels")
    expect(within(tab().getByTestId("swatches")).getAllByRole("button")).toHaveLength(2)
    await click(tab().getByRole("button", { name: "Copy the list" }))
    expect(bridge.api.clipboard.copyText).toHaveBeenLastCalledWith(
      expect.stringMatching(/^#336699\t50\s?%\n#ffcc00\t25\s?%$/),
    )

    // An edit makes the count of the edited picture old.
    await pick("negative")
    expect(tab().queryByTestId("colors-result")).toBeNull()
    expect(tab().getByText(/has changed since the last count/)).toBeInTheDocument()
    // The original is counted without the edits.
    await click(tab().getByRole("radio", { name: "Original" }))
    await click(tab().getByRole("button", { name: "Count colors" }))
    expect(bridge.backend.edit.counts.at(-1)).toMatchObject({ scope: "original" })
    expect(await tab().findByTestId("colors-distinct")).toHaveTextContent("4,096")
  })

  it("says so when the colors cannot be counted", async () => {
    const bridge = await setup()
    bridge.api.edit.colors.mockResolvedValueOnce({
      ok: false,
      e: { code: "INTERNAL", message: "boom", retryable: false },
    } as never)
    await click(screen.getByRole("tab", { name: "Colors" }))
    await click(screen.getByRole("button", { name: "Count colors" }))
    await waitFor(() => expect(state().colorsBusy).toBeNull())
    expect(state().colors).toEqual({})
    expect(screen.getByRole("button", { name: "Count colors" })).toBeEnabled()
  })
})
