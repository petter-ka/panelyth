// Stage 15: draw and retouch in the editor shell. Go paints the strokes
// (golden tests there); these tests cover what the renderer owns: pointer
// gestures become operations with normalized points, one history step each;
// the brush, the clone source and the keyboard paths; Auto red-eye.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { EditOp, Stroke } from "@panelyth/contracts"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppShell } from "../../app/AppShell"
import { useNoticeStore } from "../../features/clipboard/clipboard"
import { DEFAULT_EDITOR_SETTINGS, useEditorSettings } from "../../features/editor/editorSettings"
import {
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

const editor = () => screen.getByTestId("editor")
const state = () => useEditorStore.getState()
const ops = () => toEditList(state().items)
const strokes = (i = 0) => (ops()[i] as Extract<EditOp, { op: "draw" }>).p.strokes
const panel = () => within(screen.getByTestId("tool-panel"))
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
const undo = () => key(editor(), "z", { ctrlKey: true })
const notice = () => useNoticeStore.getState().notice

/** The paint overlay, 400 × 300 on screen (the picture is 4,000 × 3,000). */
function surface(): HTMLElement {
  const el = screen.getByTestId("paint-overlay")
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0 }) as DOMRect
  return el
}
const down = (x: number, y: number, init: object = {}) =>
  act(
    async () =>
      void fireEvent.pointerDown(surface(), { button: 0, clientX: x, clientY: y, ...init }),
  )
const move = (x: number, y: number, init: object = {}) =>
  act(async () => void fireEvent.pointerMove(surface(), { clientX: x, clientY: y, ...init }))
const up = () => act(async () => void fireEvent.pointerUp(surface()))
/** A drag from one point through others. */
async function drag(points: [number, number][], init: object = {}): Promise<void> {
  await down(points[0]![0], points[0]![1], init)
  for (const p of points.slice(1)) await move(p[0], p[1], init)
  await up()
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
  useNoticeStore.setState({ notice: null })
  useEditorSettings.setState({ settings: DEFAULT_EDITOR_SETTINGS })
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
})
afterEach(() => {
  stop.forEach((s) => s())
  resetEditor()
})

describe("the draw and retouch group", () => {
  it("opens with R and lists its four tools", async () => {
    await setup()
    await key(editor(), "r")
    expect(screen.getByTestId("tool-panel").dataset.group).toBe("retouch")
    const headers = [
      ...screen.getByTestId("tool-panel").querySelectorAll<HTMLElement>("button[data-tool]"),
    ]
    expect(headers.map((h) => h.dataset.tool)).toEqual(["draw", "clone", "heal", "redeye"])
    // No overlay until a tool is open; the picture pans and zooms as always.
    expect(screen.queryByTestId("paint-overlay")).toBeNull()
    await click(tool("draw"))
    expect(screen.getByTestId("paint-overlay").dataset.tool).toBe("draw")
    await click(tool("heal"))
    expect(screen.getByTestId("paint-overlay").dataset.tool).toBe("heal")
    expect(searchTools("blemish").map((d) => d.id)).toEqual(["heal"])
    expect(searchTools("arrow").map((d) => d.id)).toEqual(["draw"])
  })
})

describe("draw", () => {
  it("makes a stroke of a drag: one edit, points of the picture, thinned", async () => {
    const bridge = await setup()
    await pick("draw")
    expect(state().items).toHaveLength(0)
    await drag([
      [100, 150],
      [150, 150],
      [200, 150],
      [300, 150],
    ])
    // A straight drag is its two ends, 0..1 of the picture.
    expect(ops()).toEqual([
      {
        op: "draw",
        p: {
          strokes: [
            {
              tool: "brush",
              color: "#ff3b30",
              size: 2,
              hardness: 80,
              points: [
                [0.25, 0.5],
                [0.75, 0.5],
              ],
            },
          ],
        },
      },
    ])
    expect(state().past).toHaveLength(1)
    // The frame at rest is a full one of the committed list.
    await waitFor(() =>
      expect(bridge.backend.edit.renders.at(-1)).toMatchObject({
        quality: "final",
        editList: ops(),
      }),
    )
    // The next stroke joins the same drawing; each is one undo.
    await drag([
      [100, 50],
      [100, 250],
    ])
    expect(ops()).toHaveLength(1)
    expect(strokes()).toHaveLength(2)
    expect(strokes()[1]!.points).toEqual([
      [0.25, 0.1667],
      [0.25, 0.8333],
    ])
    expect(state().past).toHaveLength(2)
    expect(panel().getByTestId("draw-count")).toHaveTextContent("Strokes in this drawing: 2")
    expect(screen.getByTestId("stack-item")).toHaveTextContent("Draw")
    await undo()
    expect(strokes()).toHaveLength(1)
    await undo()
    expect(state().items).toHaveLength(0)
    expect(panel().getByTestId("draw-count")).toHaveTextContent("Nothing drawn yet.")
  })

  it("draws with the brush as it is set, and erases", async () => {
    await setup()
    await pick("draw")
    await change(panel().getByRole("slider", { name: "Size" }), "5")
    await change(panel().getByRole("slider", { name: "Hardness" }), "100")
    await change(panel().getByRole("slider", { name: "Opacity" }), "40")
    await change(panel().getByLabelText("Color"), "#00aa55")
    await drag([
      [40, 30],
      [80, 60],
    ])
    expect(strokes()[0]).toEqual({
      tool: "brush",
      color: "#00aa55",
      size: 5,
      opacity: 40,
      points: [
        [0.1, 0.1],
        [0.2, 0.2],
      ],
    })
    // A click is a dot.
    await drag([[200, 150]])
    expect(strokes()[1]!.points).toEqual([[0.5, 0.5]])
    await click(panel().getByRole("radio", { name: "Eraser" }))
    expect(panel().queryByLabelText("Color")).toBeNull()
    await drag([
      [40, 30],
      [80, 60],
    ])
    expect(strokes()[2]).toMatchObject({ tool: "eraser", size: 5, opacity: 40 })
    expect(strokes()[2]).not.toHaveProperty("color")
    // The last stroke can be taken back from the panel; the last of all removes the drawing.
    for (let i = 0; i < 3; i++)
      await click(panel().getByRole("button", { name: "Remove the last stroke" }))
    expect(state().items).toHaveLength(0)
    expect(panel().getByRole("button", { name: "Remove the last stroke" })).toBeDisabled()
  })

  it("takes the pressure of a pen", async () => {
    // jsdom has pointer events with pressure; where it has not, there is nothing to test.
    if (
      typeof PointerEvent === "undefined" ||
      new PointerEvent("pointerdown", { pressure: 0.8 }).pressure !== 0.8
    )
      return
    await setup()
    await pick("draw")
    await down(100, 150, { pointerType: "pen", pressure: 0.2 })
    await move(200, 100, { pointerType: "pen", pressure: 0.9 })
    await move(300, 150, { pointerType: "pen", pressure: 0.4 })
    await up()
    expect(strokes()[0]!.points).toEqual([
      [0.25, 0.5, 0.2],
      [0.5, 0.3333, 0.9],
      [0.75, 0.5, 0.4],
    ])
    // A mouse has none.
    await drag([
      [100, 150],
      [300, 150],
    ])
    expect(strokes()[1]!.points.every((p) => p.length === 2)).toBe(true)
  })

  it("draws shapes by dragging, straight or square with Shift, or by numbers", async () => {
    await setup()
    await pick("draw")
    await click(panel().getByRole("radio", { name: "Rectangle" }))
    // A click with a shape tool draws nothing.
    await drag([[200, 150]])
    expect(state().items).toHaveLength(0)
    expect(state().past).toHaveLength(0)
    await drag([
      [100, 75],
      [200, 225],
    ])
    expect(strokes()[0]).toEqual({
      tool: "rect",
      color: "#ff3b30",
      size: 2,
      points: [
        [0.25, 0.25],
        [0.5, 0.75],
      ],
    })
    // Shift: a square on screen. The picture is 4:3, so 0.25 of its width is 0.3333 of its height.
    await click(panel().getByRole("checkbox", { name: "Filled" }))
    await down(100, 75)
    await move(200, 100, { shiftKey: true })
    await up()
    expect(strokes()[1]).toMatchObject({
      tool: "rect",
      filled: true,
      points: [
        [0.25, 0.25],
        [0.5, 0.5833],
      ],
    })
    // A line with Shift turns in steps of 45°.
    await click(panel().getByRole("radio", { name: "Line" }))
    await down(100, 150)
    await move(300, 160, { shiftKey: true })
    await up()
    const line = strokes()[2]!
    expect(line.tool).toBe("line")
    expect(line.points[1]![1]).toBeCloseTo(0.5, 3)
    // By numbers: no pointer needed.
    await click(panel().getByRole("radio", { name: "Arrow" }))
    for (const [name, value] of [
      ["From across", "10"],
      ["From down", "20"],
      ["To across", "60"],
      ["To down", "20"],
    ] as const) {
      const field = panel().getByRole("textbox", { name })
      await change(field, value)
      await key(field, "Enter")
    }
    await click(panel().getByRole("button", { name: "Add the shape" }))
    expect(strokes()[3]).toMatchObject({
      tool: "arrow",
      points: [
        [0.1, 0.2],
        [0.6, 0.2],
      ],
    })
    expect(state().past).toHaveLength(4)
  })

  it("places text and fills, by a click or by numbers", async () => {
    const bridge = await setup()
    await pick("draw")
    await click(panel().getByRole("radio", { name: "Text" }))
    // Without text a click says what is missing and draws nothing.
    await drag([[200, 150]])
    expect(state().items).toHaveLength(0)
    expect(notice()?.text).toMatch(/Type the text/)
    expect(panel().getByRole("button", { name: "Add the text" })).toBeDisabled()
    await waitFor(() => expect(bridge.api.edit.fonts).toHaveBeenCalled())
    await change(panel().getByTestId("draw-text"), "Hello {name}")
    await change(await panel().findByRole("combobox", { name: "Font" }), "Arial")
    await click(panel().getByRole("checkbox", { name: "Bold" }))
    await drag([[100, 60]])
    expect(strokes()[0]).toEqual({
      tool: "text",
      color: "#ff3b30",
      size: 2,
      text: "Hello {name}",
      font: "Arial",
      bold: true,
      points: [[0.25, 0.2]],
    })
    await click(panel().getByRole("button", { name: "Add the text" }))
    expect(strokes()[1]!.points).toEqual([[0.25, 0.25]])
    await click(panel().getByRole("radio", { name: "Fill" }))
    await change(panel().getByRole("slider", { name: "Tolerance" }), "35")
    await drag([[300, 225]])
    expect(strokes()[2]).toEqual({
      tool: "fill",
      color: "#ff3b30",
      tolerance: 35,
      points: [[0.75, 0.75]],
    })
    await click(panel().getByRole("button", { name: "Fill there" }))
    expect(strokes()).toHaveLength(4)
  })

  it("works with the keyboard: a cross, Enter, and the size keys", async () => {
    await setup()
    await pick("draw")
    const area = surface()
    await key(area, "ArrowRight", { shiftKey: true })
    await key(area, "ArrowDown")
    expect(screen.getByTestId("paint-cross")).not.toHaveAttribute("hidden")
    await key(area, "Enter")
    expect(strokes()[0]!.points).toEqual([[0.55, 0.505]])
    await key(area, "]")
    expect(state().paint.size).toBe(2.5)
    await key(area, "[")
    await key(area, "[")
    expect(state().paint.size).toBe(1.5)
    await key(area, "{")
    expect(state().paint.hardness).toBe(70)
    await key(area, "}")
    await key(area, "}")
    await key(area, "}")
    expect(state().paint.hardness).toBe(100)
    // The keys are the tool's: nothing else in the editor reacted.
    expect(screen.getByTestId("tool-panel").dataset.tool).toBe("draw")
    expect(screen.getByTestId("editor")).toBeInTheDocument()
    // The brush ring has the brush's size on screen: 1.5 % of 300 px.
    await move(200, 150)
    const ring = screen.getByTestId("paint-ring")
    expect(ring).not.toHaveAttribute("hidden")
    expect(ring.style.left).toBe("50%")
  })

  it("asks Go for at most one frame per animation frame while a stroke is drawn", async () => {
    const bridge = await setup()
    await pick("draw")
    await waitFor(() => expect(bridge.backend.edit.renders.length).toBeGreaterThan(0))
    const before = bridge.backend.edit.renders.length
    await act(async () => {
      const el = surface()
      fireEvent.pointerDown(el, { button: 0, clientX: 50, clientY: 50 })
      // Sixty pointer events in one task, as a fast hand and a 1,000 Hz mouse make them.
      for (let i = 1; i <= 60; i++)
        fireEvent.pointerMove(el, { clientX: 50 + i * 5, clientY: 50 + (i % 7) })
    })
    // Not one render per event: none yet, or the one of the first frame.
    expect(bridge.backend.edit.renders.length - before).toBeLessThanOrEqual(1)
    expect(state().past.length).toBeLessThanOrEqual(1)
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))))
    const during = bridge.backend.edit.renders.length - before
    expect(during).toBeGreaterThanOrEqual(1)
    expect(during).toBeLessThanOrEqual(4)
    expect(bridge.backend.edit.renders.at(-1)!.quality).toBe("draft")
    await up()
    // One stroke, one history step, however many events it had.
    expect(strokes()).toHaveLength(1)
    expect(state().past).toHaveLength(1)
    expect(strokes()[0]!.points.length).toBeGreaterThan(10)
    expect(strokes()[0]!.points.length).toBeLessThanOrEqual(61)
  })

  it("refuses another stroke when the list is as large as it may be", async () => {
    await setup()
    await pick("draw")
    const many: Stroke = {
      tool: "brush",
      size: 1,
      points: Array.from(
        { length: 70_000 },
        (_, i) => [0.1234, (i % 1000) / 1000] as [number, number],
      ),
    }
    act(() =>
      useEditorStore.setState({ items: [{ id: 999, op: { op: "draw", p: { strokes: [many] } } }] }),
    )
    await drag([
      [100, 150],
      [300, 150],
    ])
    expect(ops()).toHaveLength(1)
    expect(strokes()).toHaveLength(1)
    expect(notice()).toMatchObject({
      tone: "error",
      text: expect.stringMatching(/as many strokes as fit/),
    })
  })
})

describe("clone", () => {
  it("needs a source, then copies from it and keeps its distance", async () => {
    await setup()
    await pick("clone")
    // No source: the stroke says so and does nothing.
    await drag([
      [200, 150],
      [240, 150],
    ])
    expect(state().items).toHaveLength(0)
    expect(notice()?.text).toMatch(/Alt and click/)
    expect(panel().getByTestId("paint-source-state")).toHaveTextContent("No source yet.")
    // Alt and a click choose it; a marker shows where.
    await down(40, 30, { altKey: true })
    await up()
    expect(state().paint.source).toEqual([0.1, 0.1])
    expect(state().items).toHaveLength(0)
    expect(screen.getByTestId("paint-source")).toBeInTheDocument()
    expect(panel().getByTestId("paint-source-state")).toHaveTextContent("The source is set")
    await drag([
      [200, 150],
      [240, 150],
    ])
    expect(ops()).toEqual([
      {
        op: "clone",
        p: {
          size: 2,
          hardness: 80,
          source: [0.1, 0.1],
          points: [
            [0.5, 0.5],
            [0.6, 0.5],
          ],
        },
      },
    ])
    // Each stroke is its own edit; the source moved with the brush.
    await drag([
      [300, 240],
      [320, 240],
    ])
    expect(ops()).toHaveLength(2)
    const second = (ops()[1] as Extract<EditOp, { op: "clone" }>).p
    expect(second.source[0]).toBeCloseTo(0.75 - 0.4, 3)
    expect(second.source[1]).toBeCloseTo(0.8 - 0.4, 3)
    expect(state().activeId).toBeNull()
    expect(state().past).toHaveLength(2)
    await undo()
    expect(ops()).toHaveLength(1)
    // By numbers: the source, and a stamp.
    const across = within(
      panel().getByRole("heading", { name: "Copy from" }).parentElement!,
    ).getByRole("textbox", { name: "Across" })
    await change(across, "20")
    await key(across, "Enter")
    expect(state().paint.source![0]).toBeCloseTo(0.2)
    expect(state().paint.offset).toBeNull()
    await click(panel().getByRole("button", { name: "Stamp there" }))
    const stamp = (ops()[1] as Extract<EditOp, { op: "clone" }>).p
    expect(stamp.points).toEqual([[0.5, 0.5]])
    expect(stamp.source[0]).toBeCloseTo(0.2)
  })
})

describe("heal", () => {
  it("heals a spot by itself, or from a source", async () => {
    await setup()
    await pick("heal")
    await drag([[200, 150]])
    expect(ops()).toEqual([{ op: "heal", p: { size: 2, points: [[0.5, 0.5]] } }])
    // Painted over a scratch: one stroke, one edit.
    await drag([
      [100, 100],
      [150, 110],
      [200, 100],
    ])
    expect(ops()).toHaveLength(2)
    expect((ops()[1] as Extract<EditOp, { op: "heal" }>).p.points).toHaveLength(3)
    // From a source: like the clone tool.
    await click(panel().getByRole("radio", { name: "Copies texture from where you choose" }))
    await drag([[300, 200]])
    expect(ops()).toHaveLength(2)
    expect(notice()?.text).toMatch(/Alt and click/)
    await down(40, 30, { ctrlKey: true })
    await up()
    await drag([[300, 200]])
    expect(ops()[2]).toEqual({
      op: "heal",
      p: { mode: "brush", size: 2, source: [0.1, 0.1], points: [[0.75, 0.6667]] },
    })
    await click(panel().getByRole("radio", { name: "Finds clean texture nearby by itself" }))
    await click(panel().getByRole("button", { name: "Heal there" }))
    expect(ops()[3]).toEqual({ op: "heal", p: { size: 2, points: [[0.5, 0.5]] } })
    expect(state().past).toHaveLength(4)
  })
})

describe("red-eye", () => {
  it("fixes an eye at a click or in a dragged box", async () => {
    await setup()
    await pick("redeye")
    await drag([[200, 150]])
    // A click: a box of 6 % of the shorter edge around it.
    const first = (ops()[0] as Extract<EditOp, { op: "redeye" }>).p.rect!
    expect(first.h).toBeCloseTo(0.06, 3)
    expect(first.w).toBeCloseTo(0.045, 3)
    expect(first.x + first.w / 2).toBeCloseTo(0.5, 3)
    await change(panel().getByRole("slider", { name: "Strength" }), "70")
    await change(panel().getByRole("slider", { name: "Pupil size" }), "15")
    await drag([
      [100, 60],
      [140, 90],
    ])
    expect(ops()[1]).toEqual({
      op: "redeye",
      p: { rect: { x: 0.25, y: 0.2, w: 0.1, h: 0.1 }, strength: 70, pupil: 15 },
    })
    expect(state().activeId).toBeNull()
    // By numbers.
    await click(panel().getByRole("button", { name: "Fix the eye there" }))
    expect(ops()).toHaveLength(3)
    expect(state().past).toHaveLength(3)
  })

  it("finds the eyes itself and makes an ordinary edit of each", async () => {
    const bridge = await setup()
    await pick("redeye")
    await click(panel().getByRole("button", { name: "Fix red eyes automatically" }))
    await waitFor(() => expect(ops()).toHaveLength(2))
    expect(bridge.api.edit.eyes).toHaveBeenCalledWith({
      sessionId: "0123456789abcdef01234567",
      editList: [],
    })
    expect(ops()).toEqual([
      { op: "redeye", p: { rect: { x: 0.3, y: 0.4, w: 0.04, h: 0.05 } } },
      { op: "redeye", p: { rect: { x: 0.6, y: 0.41, w: 0.04, h: 0.05 } } },
    ])
    expect(notice()?.text).toBe("Red eyes fixed: 2")
    // One undo for what was found together; each can be removed by itself.
    expect(state().past).toHaveLength(1)
    await click(screen.getAllByRole("button", { name: "Remove Red-eye" })[0]!)
    expect(ops()).toHaveLength(1)
    // Nothing found: said, and nothing changes.
    bridge.backend.edit.eyes = []
    await click(panel().getByRole("button", { name: "Fix red eyes automatically" }))
    await waitFor(() => expect(notice()?.text).toBe("No red eyes found."))
    expect(ops()).toHaveLength(1)
    // The search looks at the picture as it is edited.
    expect(bridge.api.edit.eyes).toHaveBeenLastCalledWith(
      expect.objectContaining({ editList: ops() }),
    )
  })
})
