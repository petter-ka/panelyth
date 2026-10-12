// Stage 14: the effects in the editor shell. Go draws them (golden tests
// there); these tests cover the edit list each control writes, the picked
// pictures (an id and a thumbnail token, never a path), the regions and the
// lens centre on the canvas by keyboard, and undo.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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

const SESSION = "0123456789abcdef01234567"
const ASSET = "0123456789abcdef0123456789abcdef"
const editor = () => screen.getByTestId("editor")
const state = () => useEditorStore.getState()
const ops = () => toEditList(state().items)
const params = <T,>(i = 0) => ops()[i]!.p as T
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
const slider = (name: string) => panel().getByRole("slider", { name })
const undo = () => key(editor(), "z", { ctrlKey: true })

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

describe("the effects group", () => {
  it("lists the eight tools, opens with E and is found by the search", async () => {
    await setup()
    await key(editor(), "e")
    expect(screen.getByTestId("tool-panel").dataset.group).toBe("effects")
    expect(document.activeElement).toBe(group("effects"))
    const headers = [
      ...screen.getByTestId("tool-panel").querySelectorAll<HTMLElement>("button[data-tool]"),
    ]
    expect(headers.map((h) => h.dataset.tool)).toEqual([
      "border",
      "frameMask",
      "watermark",
      "obscure",
      "lens",
      "bump",
      "sketch",
      "oil",
    ])
    expect(searchTools("logo").map((d) => d.id)).toEqual(["watermark"])
    expect(searchTools("censor").map((d) => d.id)).toEqual(["obscure"])
    expect(searchTools("polaroid").map((d) => d.id)).toEqual(["border"])
    // Some effects are looks too; one request still renders every thumbnail.
    expect(LOOKS.map((l) => l.id)).toEqual(
      expect.arrayContaining(["vignette", "polaroid", "pencil", "oil"]),
    )
    expect(LOOKS.length).toBeLessThanOrEqual(16)
  })
})

describe("the editor and what is behind it", () => {
  it("keeps the focus: what is behind the editor cannot take it", async () => {
    await setup()
    // Something focusable of the window behind the editor (a toolbar button).
    const behind = () =>
      [...document.querySelectorAll<HTMLElement>("button:not([disabled])")].find(
        (el) => !screen.queryByTestId("editor")?.contains(el),
      )!
    const button = behind()
    expect(button).toBeTruthy()
    // A menu that opened the editor hands the focus back when it closes.
    act(() => button.focus())
    expect(document.activeElement).toBe(group("adjust"))
    // So a key still reaches the editor.
    await key(document.activeElement as HTMLElement, "e")
    expect(screen.getByTestId("tool-panel").dataset.group).toBe("effects")
    act(() => button.focus())
    expect(document.activeElement).toBe(group("effects"))
    // Once the editor is closed the window takes the focus as before.
    await key(editor(), "Escape")
    expect(screen.queryByTestId("editor")).toBeNull()
    const again = behind()
    act(() => again.focus())
    expect(document.activeElement).toBe(again)
  })
})

describe("keys when the focused control is gone", () => {
  it("still reach the editor from the page itself", async () => {
    await setup()
    // A button that was disabled while focused leaves the focus on the page.
    act(() => (document.activeElement as HTMLElement).blur())
    expect(document.activeElement).toBe(document.body)
    await key(document.body, "e")
    expect(screen.getByTestId("tool-panel").dataset.group).toBe("effects")
    // The editor has the focus again; Esc closes it.
    expect(editor().contains(document.activeElement)).toBe(true)
    act(() => (document.activeElement as HTMLElement).blur())
    await key(document.body, "Escape")
    expect(screen.queryByTestId("editor")).toBeNull()
    // Closed: the page's keys are the page's again.
    await key(document.body, "e")
    expect(screen.queryByTestId("editor")).toBeNull()
  })
})

describe("border", () => {
  it("grows the picture by a share of its shorter edge, or covers its edge", async () => {
    await setup()
    await pick("border")
    // Looking at the tool is not an edit.
    expect(state().items).toHaveLength(0)
    await change(slider("Width"), "4")
    expect(ops()).toEqual([{ op: "border", p: { style: "solid", width: 4, color: "#ffffff" } }])
    // 4 % of 3,000 px on every side.
    await waitFor(() =>
      expect(screen.getByTestId("editor-size")).toHaveTextContent("4,240 × 3,240"),
    )
    await click(panel().getByRole("checkbox", { name: /Inside the picture/ }))
    await waitFor(() =>
      expect(screen.getByTestId("editor-size")).toHaveTextContent("4,000 × 3,000"),
    )
    await change(slider("Opacity"), "70")
    expect(params()).toMatchObject({ inside: true, opacity: 70 })
    // A style brings what makes it that style.
    await change(panel().getByRole("combobox", { name: "Style" }), "rounded")
    expect(params()).toMatchObject({ style: "rounded", radius: 8 })
    await click(panel().getByRole("checkbox", { name: /Inside the picture/ }))
    await change(panel().getByRole("combobox", { name: "Style" }), "shadow")
    expect(params()).toMatchObject({ style: "shadow", blur: 3, offset: 1.5 })
    await change(panel().getByRole("combobox", { name: "Style" }), "double")
    expect(panel().getByLabelText("Line between")).toBeInTheDocument()
    // Pixels are another scale: the width starts over.
    await click(panel().getByRole("radio", { name: "Pixels of the full picture" }))
    expect(params()).toMatchObject({ unit: "px", width: 0 })
    expect(slider("Width")).toHaveAttribute("max", "400")
    // Every step is one undo.
    const steps = state().past.length
    for (let i = 0; i < steps; i++) await undo()
    expect(state().items).toHaveLength(0)
  })
})

describe("frame mask", () => {
  it("is chosen by opening it, and a custom mask asks main for its picture", async () => {
    const bridge = await setup()
    await pick("frameMask")
    expect(ops()).toEqual([
      { op: "frameMask", p: { shape: "rounded", radius: 10, feather: 0, inset: 0 } },
    ])
    await change(panel().getByRole("combobox", { name: "Shape" }), "vignette")
    expect(params()).toMatchObject({ shape: "vignette", strength: 50, feather: 30 })
    expect(panel().queryByRole("slider", { name: "Inset" })).toBeNull()
    await change(slider("Strength"), "80")
    // The dialog is main's: the renderer sends its session and gets an id back.
    await change(panel().getByRole("combobox", { name: "Shape" }), "custom")
    await waitFor(() => expect(params()).toMatchObject({ shape: "custom", assetId: ASSET }))
    expect(bridge.api.edit.pickAsset).toHaveBeenCalledWith(SESSION)
    expect(panel().getByTestId("asset-name")).toHaveTextContent("logo.png")
    expect(panel().getByTestId("asset-picker").querySelector("img")).toHaveAttribute(
      "src",
      expect.stringMatching(/^panelyth-media:\/\/m\/[0-9a-f]{32}$/),
    )
    // No path anywhere in the editor's state.
    expect(JSON.stringify(state())).not.toMatch(/[A-Z]:\\|\/photos|\.png"?,"path/)
    // A cancelled dialog changes nothing.
    await change(panel().getByRole("combobox", { name: "Shape" }), "ellipse")
    expect(params()).not.toHaveProperty("assetId")
    bridge.backend.edit.asset = null
    await change(panel().getByRole("combobox", { name: "Shape" }), "custom")
    await waitFor(() => expect(bridge.api.edit.pickAsset).toHaveBeenCalledTimes(2))
    expect(params()).toMatchObject({ shape: "ellipse" })
    expect(state().picking).toBe(false)
  })

  it("says why a file cannot be used and leaves the edit list alone", async () => {
    const bridge = await setup()
    await pick("frameMask")
    bridge.api.edit.pickAsset.mockResolvedValueOnce({
      ok: false,
      e: {
        code: "EDIT_ASSET_INVALID",
        message: "not a PNG, JPEG, WebP or GIF picture",
        retryable: false,
      },
    } as never)
    await change(panel().getByRole("combobox", { name: "Shape" }), "custom")
    await waitFor(() =>
      expect(useNoticeStore.getState().notice).toMatchObject({
        tone: "error",
        text: expect.stringMatching(/can't be used.*PNG, JPEG, WebP or GIF/),
      }),
    )
    expect(params()).toMatchObject({ shape: "rounded" })
    expect(state().assets).toEqual({})
    expect(state().picking).toBe(false)
  })
})

describe("watermark", () => {
  it("writes text with tokens, a font by name, a place and a repeat", async () => {
    const bridge = await setup()
    await pick("watermark")
    expect(ops()).toEqual([
      {
        op: "watermark",
        p: {
          kind: "text",
          text: "© {year} {name}",
          size: 5,
          color: "#ffffff",
          opacity: 60,
          anchor: "se",
          margin: 3,
        },
      },
    ])
    // Fonts are names from Go, asked for once.
    await waitFor(() => expect(bridge.api.edit.fonts).toHaveBeenCalledWith(SESSION))
    const font = await panel().findByRole("combobox", { name: "Font" })
    await waitFor(() => expect(within(font).getAllByRole("option").length).toBe(4))
    await change(font, "Arial")
    expect(params()).toMatchObject({ font: "Arial" })
    // The default is the absence of a name.
    await change(font, "")
    expect(params()).not.toHaveProperty("font")
    const text = panel().getByTestId("watermark-text") as HTMLTextAreaElement
    expect(text).toHaveAttribute("maxlength", "1000")
    await change(text, "Photo: ")
    // A chip puts a token where the caret is.
    text.setSelectionRange(7, 7)
    await click(panel().getByRole("button", { name: "Camera" }))
    expect(params<{ text: string }>().text).toBe("Photo: {exif.model}")
    await click(panel().getByRole("checkbox", { name: "Bold" }))
    await click(panel().getByRole("radio", { name: "Top left" }))
    await change(slider("Size"), "12")
    await change(slider("Rotation"), "-30")
    await change(slider("Outline"), "5")
    expect(panel().getByLabelText("Outline color")).toBeInTheDocument()
    await click(panel().getByRole("checkbox", { name: "Repeat over the picture" }))
    await click(panel().getByRole("checkbox", { name: "Shift every other row" }))
    await change(panel().getByRole("combobox", { name: "Blend" }), "multiply")
    expect(params()).toEqual({
      kind: "text",
      text: "Photo: {exif.model}",
      size: 12,
      color: "#ffffff",
      opacity: 60,
      anchor: "nw",
      margin: 3,
      bold: true,
      rotation: -30,
      outline: 5,
      tile: true,
      spacing: 60,
      stagger: true,
      blend: "multiply",
    })
    expect(screen.getByTestId("stack-item")).toHaveTextContent("Photo: {exif.mod")
    expect(bridge.api.edit.fonts).toHaveBeenCalledTimes(1)
  })

  it("stamps a picked picture instead of text", async () => {
    const bridge = await setup()
    await pick("watermark")
    await click(panel().getByRole("radio", { name: "Picture" }))
    await waitFor(() => expect(params()).toMatchObject({ kind: "image", assetId: ASSET, size: 20 }))
    expect(bridge.api.edit.pickAsset).toHaveBeenCalledWith(SESSION)
    expect(panel().queryByTestId("watermark-text")).toBeNull()
    expect(panel().getByTestId("asset-name")).toHaveTextContent("logo.png")
    expect(screen.getByTestId("stack-item")).toHaveTextContent("image")
    // Back to text: the picture's id leaves the operation.
    await click(panel().getByRole("radio", { name: "Text" }))
    expect(params()).toMatchObject({ kind: "text", size: 10 })
    expect(params()).not.toHaveProperty("assetId")
    await undo()
    expect(params()).toMatchObject({ kind: "image", assetId: ASSET })
  })
})

describe("obscure", () => {
  it("puts a region on the picture that the keyboard moves and sizes", async () => {
    await setup()
    await pick("obscure")
    expect(ops()).toEqual([
      {
        op: "obscure",
        p: {
          method: "blur",
          strength: 60,
          shape: "rect",
          rect: { x: 0.35, y: 0.35, w: 0.3, h: 0.3 },
          feather: 0,
        },
      },
    ])
    // It says once what saving means.
    expect(panel().getByTestId("obscure-note")).toHaveTextContent(/cannot be brought back/)
    const region = screen.getByTestId("obscure-region")
    type Box = { rect: { x: number; y: number; w: number; h: number } }
    // One picture pixel per key, ten with Shift (the picture is 4,000 × 3,000).
    await key(region, "ArrowRight")
    expect(params<Box>().rect.x).toBeCloseTo(0.35 + 1 / 4000, 6)
    await key(region, "ArrowUp", { shiftKey: true })
    expect(params<Box>().rect.y).toBeCloseTo(0.35 - 10 / 3000, 6)
    const corner = within(region).getByRole("button", { name: "Bottom right corner" })
    await key(corner, "ArrowRight", { shiftKey: true })
    expect(params<Box>().rect.w).toBeCloseTo(0.3 + 10 / 4000, 6)
    // The keys never leave the editor or move the picture.
    expect(screen.getByTestId("tool-panel").dataset.tool).toBe("obscure")
    // Numbers, in percent of the picture.
    const left = panel().getByRole("textbox", { name: "Left" })
    await change(left, "10")
    await key(left, "Enter")
    expect(params<Box>().rect.x).toBeCloseTo(0.1)
    await click(panel().getByRole("radio", { name: "Ellipse" }))
    await click(panel().getByRole("radio", { name: "Pixelate" }))
    await change(slider("Strength"), "90")
    await change(slider("Soft edge"), "25")
    await click(panel().getByRole("checkbox", { name: "Obscure everything else" }))
    expect(params()).toMatchObject({
      method: "pixelate",
      strength: 90,
      shape: "ellipse",
      feather: 25,
      invert: true,
    })
    // Another region is another step.
    await click(tool("obscure"))
    await click(tool("obscure"))
    expect(ops().map((o) => o.op)).toEqual(["obscure", "obscure"])
  })

  it("draws a polygon by its points", async () => {
    await setup()
    await pick("obscure")
    await click(panel().getByRole("radio", { name: "Polygon" }))
    type Poly = { points: [number, number][]; rect?: unknown }
    // The box's corners are the first points.
    const rounded = () =>
      params<Poly>().points.map((q) => q.map((v) => Math.round(v * 1000) / 1000))
    expect(rounded()).toEqual([
      [0.35, 0.35],
      [0.65, 0.35],
      [0.65, 0.65],
      [0.35, 0.65],
    ])
    expect(params<Poly>().rect).toBeUndefined()
    const overlay = () => within(screen.getByTestId("region-overlay"))
    expect(overlay().getAllByRole("button")).toHaveLength(4)
    await click(panel().getByRole("button", { name: "Add a point" }))
    expect(params<Poly>().points).toHaveLength(5)
    expect(rounded()[4]).toEqual([0.35, 0.5])
    const first = overlay().getByRole("button", { name: "Point 1 of 5 of the region" })
    await key(first, "ArrowDown", { shiftKey: true })
    expect(params<Poly>().points[0]![1]).toBeCloseTo(0.35 + 10 / 3000, 6)
    await key(overlay().getByRole("button", { name: "Point 5 of 5 of the region" }), "Delete")
    await key(overlay().getByRole("button", { name: "Point 4 of 4 of the region" }), "Delete")
    expect(params<Poly>().points).toHaveLength(3)
    // Three points are the least: Delete does nothing more.
    await key(overlay().getByRole("button", { name: "Point 3 of 3 of the region" }), "Delete")
    expect(params<Poly>().points).toHaveLength(3)
    // Back to a box: the one around the points.
    await click(panel().getByRole("radio", { name: "Rectangle" }))
    const back = params<{ rect: { x: number; w: number }; points?: unknown }>()
    expect(back.points).toBeUndefined()
    expect(back.rect.x).toBeCloseTo(0.35)
    expect(back.rect.w).toBeCloseTo(0.3)
  })
})

describe("lens", () => {
  it("has a centre the keyboard moves, and a ring while it acts in a circle", async () => {
    await setup()
    await pick("lens")
    expect(state().items).toHaveLength(0)
    expect(screen.getByTestId("lens-ring")).toBeInTheDocument()
    const centre = screen.getByTestId("lens-centre")
    await key(centre, "ArrowRight")
    await key(screen.getByTestId("lens-centre"), "ArrowDown", { shiftKey: true })
    type Lens = { cx: number; cy: number; amount: number; mode: string }
    expect(params<Lens>().cx).toBeCloseTo(0.5 + 1 / 4000, 5)
    expect(params<Lens>().cy).toBeCloseTo(0.5 + 10 / 3000, 5)
    await change(slider("Amount"), "40")
    await change(slider("Radius"), "80")
    expect(params()).toMatchObject({ mode: "bulge", amount: 40, radius: 80, soft: 30 })
    const across = panel().getByRole("textbox", { name: "Across" })
    await change(across, "25")
    await key(across, "Enter")
    expect(params<Lens>().cx).toBeCloseTo(0.25)
    // A barrel acts on the whole picture: no ring, no radius.
    await change(panel().getByRole("combobox", { name: "Kind of lens" }), "barrel")
    expect(screen.queryByTestId("lens-ring")).toBeNull()
    expect(panel().queryByRole("slider", { name: "Radius" })).toBeNull()
    expect(screen.getByTestId("lens-centre")).toBeInTheDocument()
    // Another tool: the overlay goes.
    await pick("oil")
    expect(screen.queryByTestId("lens-overlay")).toBeNull()
  })
})

describe("bump map, sketch and oil painting", () => {
  it("writes their operations; a texture is a picked picture", async () => {
    const bridge = await setup()
    await pick("bump")
    expect(state().items).toHaveLength(0)
    await change(slider("Depth"), "45")
    await change(slider("Light from"), "270")
    expect(ops()).toEqual([
      { op: "bump", p: { height: 45, angle: 270, elevation: 45, smooth: 1, color: 0 } },
    ])
    await click(panel().getByRole("radio", { name: "Canvas, paper or any picture" }))
    await waitFor(() =>
      expect(params()).toMatchObject({ source: "texture", assetId: ASSET, tile: true }),
    )
    expect(bridge.api.edit.pickAsset).toHaveBeenCalledTimes(1)
    await click(panel().getByRole("radio", { name: "Bright parts stand out" }))
    expect(params()).toEqual({
      height: 45,
      angle: 270,
      elevation: 45,
      smooth: 1,
      color: 0,
      source: "picture",
    })

    await pick("sketch")
    expect(ops()[1]).toEqual({
      op: "sketch",
      p: { style: "pencil", detail: 60, strength: 40, paper: 0, color: 60 },
    })
    expect(panel().queryByRole("slider", { name: "Color amount" })).toBeNull()
    await click(panel().getByRole("radio", { name: "Colored pencil" }))
    await change(slider("Color amount"), "85")
    await change(slider("Paper tone"), "30")
    expect(params(1)).toMatchObject({ style: "color", color: 85, paper: 30 })

    await pick("oil")
    expect(ops()[2]).toEqual({ op: "oil", p: { radius: 4, levels: 20 } })
    await change(slider("Brush size"), "7.5")
    await change(slider("Shades"), "12")
    expect(params(2)).toEqual({ radius: 7.5, levels: 12 })
    expect(screen.getAllByTestId("stack-item").map((el) => el.dataset.op)).toEqual([
      "bump",
      "sketch",
      "oil",
    ])
  })
})
