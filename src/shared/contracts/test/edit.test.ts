// The image editor's contract (Stage 12, ADR-0035): the structural check of
// an edit list from a renderer, and the guards for what the sidecar answers.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  ASSET_ID,
  COMMANDER_METHODS,
  DRAW_TOOLS,
  EDIT_OPS,
  ERROR_CODES,
  JOB_KINDS,
  MAIN_METHODS,
  MAX_EDIT_DEPTH,
  MAX_EDIT_LIST_CHARS,
  MAX_EDIT_NUMBERS,
  MAX_EDIT_OPS,
  MAX_EDIT_STRING_CHARS,
  MAX_POLYGON_POINTS,
  MAX_STROKES,
  MAX_STROKE_POINTS,
  MAX_WATERMARK_CHARS,
  VIEWER_METHODS,
  editListProblem,
  eventGuards,
  isEditAssetFile,
  isEditFrameResult,
  isResponseFrame,
  sidecarResultGuards,
} from "../src"

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures")
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), "utf8"))

const flip = { op: "flip", p: { axis: "h" } }

describe("editListProblem", () => {
  it("accepts the lists the editor builds", () => {
    expect(editListProblem([])).toBeNull()
    expect(
      editListProblem([
        { op: "rotate", p: { angle: 7.5, mode: "crop", fill: "#ffffff" } },
        { op: "flip", p: { axis: "v" }, off: true },
        { op: "crop", p: { rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } } },
        { op: "resize", p: { mode: "fit", w: 1920, h: 1080, algo: "lanczos3", noEnlarge: true } },
        { op: "canvas", p: { w: 2000, h: 0, anchor: "c", fill: "edge" } },
        { op: "dpi", p: { x: 300, resample: false } },
      ]),
    ).toBeNull()
    expect(editListProblem(Array.from({ length: MAX_EDIT_OPS }, () => flip))).toBeNull()
  })

  it.each([
    ["not a list", { op: "flip" }],
    ["a string", '[{"op":"flip"}]'],
    ["too many operations", Array.from({ length: MAX_EDIT_OPS + 1 }, () => flip)],
    ["an operation that is not an object", ["flip"]],
    ["an array as an operation", [[flip]]],
    ["an unknown operation", [{ op: "explode", p: {} }]],
    ["an operation name that is not a string", [{ op: 7, p: {} }]],
    ["no parameters", [{ op: "flip" }]],
    ["parameters that are not an object", [{ op: "flip", p: "h" }]],
    ["an extra key", [{ ...flip, path: "C:\\x" }]],
    ["off that is not a boolean", [{ ...flip, off: 1 }]],
    ["NaN", [{ op: "rotate", p: { angle: Number.NaN } }]],
    ["infinity", [{ op: "rotate", p: { angle: Number.POSITIVE_INFINITY } }]],
    ["null", [{ op: "rotate", p: { angle: null } }]],
    ["a long text", [{ op: "canvas", p: { fill: "#".padEnd(MAX_EDIT_STRING_CHARS + 1, "f") } }]],
    ["a long key", [{ op: "flip", p: { ["a".repeat(65)]: 1 } }]],
  ])("refuses %s", (_name, list) => {
    expect(editListProblem(list)).not.toBeNull()
  })

  it("refuses parameters nested too deeply", () => {
    let deep: unknown = 1
    for (let i = 0; i < MAX_EDIT_DEPTH + 1; i++) deep = { v: deep }
    expect(editListProblem([{ op: "crop", p: deep }])).toMatch(/nested/)
    let ok: unknown = 1
    for (let i = 0; i < MAX_EDIT_DEPTH - 2; i++) ok = { v: ok }
    expect(editListProblem([{ op: "crop", p: { v: ok } }])).toBeNull()
  })

  it("refuses more numbers than a stroke list may hold, and oversized lists", () => {
    const many = Array.from({ length: MAX_EDIT_NUMBERS + 1 }, () => 0)
    expect(editListProblem([{ op: "crop", p: { points: many } }])).toMatch(/too many/)
    const text = "x".repeat(MAX_EDIT_STRING_CHARS)
    const big = Array.from({ length: MAX_EDIT_OPS }, () => ({
      op: "canvas",
      p: { a: text, b: text, c: text },
    }))
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_EDIT_LIST_CHARS)
    expect(editListProblem(big)).toMatch(/too large/)
  })

  it("does not accept objects with a prototype", () => {
    class Op {
      op = "flip"
      p = { axis: "h" }
    }
    expect(editListProblem([new Op()])).not.toBeNull()
    expect(editListProblem([{ op: "flip", p: new Date() }])).not.toBeNull()
  })
})

describe("the editor's profile", () => {
  const viewer: readonly string[] = VIEWER_METHODS
  const commander: readonly string[] = COMMANDER_METHODS
  const main: readonly string[] = MAIN_METHODS

  it("is the viewer's alone", () => {
    const edit = viewer.filter((m) => m.startsWith("edit."))
    expect(edit.sort()).toEqual([
      "edit.close",
      "edit.colors",
      "edit.estimate",
      "edit.eyes",
      "edit.fonts",
      "edit.info",
      "edit.open",
      "edit.probe",
      "edit.render",
      "edit.reveal",
      "edit.save",
      "edit.saved",
      "edit.thumbs",
    ])
    expect(commander.filter((m) => m.startsWith("edit."))).toEqual([])
    // Stage 14: pictures picked for a watermark, a mask or a texture.
    expect(viewer.filter((m) => m.startsWith("asset.")).sort()).toEqual([
      "asset.pick",
      "asset.release",
    ])
    expect(commander.filter((m) => m.startsWith("asset."))).toEqual([])
  })

  it("keeps paths with main: frames, saves and reveals are main methods", () => {
    for (const m of [
      "edit.render",
      "edit.save",
      "edit.reveal",
      "edit.thumbs",
      "asset.pick",
      "asset.release",
    ]) {
      expect(main).toContain(m)
    }
    // What they call in the sidecar is not callable from a renderer.
    for (const m of [
      "edit.frame",
      "edit.write",
      "edit.savedPath",
      "edit.source",
      "edit.thumbFrames",
      "edit.assetAdd",
      "edit.assetDrop",
    ]) {
      expect(viewer).not.toContain(m)
      expect(commander).not.toContain(m)
    }
  })

  it("has its job kind, error codes and operations", () => {
    expect(JOB_KINDS).toContain("editSave")
    for (const code of [
      "EDIT_TOO_LARGE",
      "EDIT_UNSUPPORTED",
      "EDIT_SESSION_GONE",
      "EDIT_ASSET_INVALID",
    ]) {
      expect(ERROR_CODES).toContain(code)
    }
    expect([...EDIT_OPS].sort()).toEqual([
      "blur",
      "border",
      "bump",
      "canvas",
      "clone",
      "colors",
      "crop",
      "curves",
      "denoise",
      "dpi",
      "draw",
      "flip",
      "frameMask",
      "grayscale",
      "heal",
      "lens",
      "levels",
      "lighting",
      "negative",
      "obscure",
      "oil",
      "redeye",
      "reduceColors",
      "replaceColor",
      "resize",
      "rotate",
      "sepia",
      "sharpen",
      "sketch",
      "swapChannels",
      "watermark",
    ])
  })
})

describe("assets and fonts (Stage 14)", () => {
  it("an asset from the sidecar has an id, a name and a thumbnail file", () => {
    const asset = (load("res-edit.assetAdd.json") as { r: Record<string, unknown> }).r
    expect(isEditAssetFile(asset)).toBe(true)
    expect(ASSET_ID.test(asset.assetId as string)).toBe(true)
    for (const bad of [
      { ...asset, assetId: "../../etc/passwd" },
      { ...asset, assetId: (asset.assetId as string).toUpperCase() },
      { ...asset, name: "" },
      { ...asset, thumb: { file: "", width: 1, height: 1 } },
      { ...asset, thumb: null },
      { ...asset, width: -1 },
      null,
    ]) {
      expect(isEditAssetFile(bad), JSON.stringify(bad)).toBe(false)
    }
    const refused = load("res-edit.assetAdd-invalid.json") as { ok: boolean; e: { code: string } }
    expect(refused.ok).toBe(false)
    expect(refused.e.code).toBe("EDIT_ASSET_INVALID")
  })

  it("fonts are names only", () => {
    const fonts = (load("res-edit.fonts.json") as { r: { families: string[] } }).r
    expect(fonts.families.slice(0, 2)).toEqual(["Go", "Go Mono"])
    expect(sidecarResultGuards["edit.fonts"](fonts)).toBe(true)
    // A name is short: a path repeated to 500 characters is not one.
    expect(
      sidecarResultGuards["edit.fonts"]({ families: ["C:/Windows/Fonts/arial.ttf".repeat(20)] }),
    ).toBe(false)
    expect(sidecarResultGuards["edit.fonts"]({ families: [""] })).toBe(false)
    expect(sidecarResultGuards["edit.fonts"]({ families: "Go" })).toBe(false)
  })

  it("an edit list of effects passes the structural check; paths have no place in it", () => {
    const asset = "0123456789abcdef0123456789abcdef"
    expect(
      editListProblem([
        { op: "border", p: { style: "shadow", width: 2, blur: 3, offset: 1, shadow: "#00000080" } },
        { op: "frameMask", p: { shape: "custom", assetId: asset } },
        { op: "watermark", p: { kind: "image", assetId: asset, size: 20, tile: true } },
        { op: "watermark", p: { text: "{name}\n© {year}", size: 5, font: "Go Mono", bold: true } },
        { op: "bump", p: { height: 50 } },
        { op: "sketch", p: {} },
        { op: "oil", p: { radius: 4, levels: 20 } },
        { op: "lens", p: { amount: 30 } },
        { op: "obscure", p: { strength: 50, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
      ]),
    ).toBeNull()
    expect(editListProblem([{ op: "watermark", p: { text: "x".repeat(5000), size: 5 } }])).toMatch(
      /too long/,
    )
    expect(editListProblem([{ op: "emboss", p: {} }])).toMatch(/unknown operation/)
    expect(MAX_WATERMARK_CHARS).toBe(1000)
    expect(MAX_POLYGON_POINTS).toBe(256)
  })
})

describe("draw and retouch (Stage 15)", () => {
  it("strokes are operations of the list; a long stroke fits, an endless one does not", () => {
    const points = (n: number): [number, number][] =>
      Array.from({ length: n }, (_, i) => [Number((i / n).toFixed(4)), 0.5])
    expect(
      editListProblem([
        {
          op: "draw",
          p: {
            strokes: [
              { tool: "brush", color: "#ff0000", size: 4, hardness: 50, points: points(5000) },
              { tool: "eraser", size: 10, points: [[0.5, 0.5]] },
              { tool: "text", size: 6, text: "{name}", points: [[0.1, 0.1]] },
              { tool: "fill", color: "#00ff00", tolerance: 20, points: [[0.9, 0.9]] },
            ],
          },
        },
        { op: "clone", p: { size: 5, source: [0.2, 0.2], points: points(100) } },
        { op: "heal", p: { size: 4, points: [[0.5, 0.5, 0.8]] } },
        { op: "redeye", p: { rect: { x: 0.4, y: 0.4, w: 0.05, h: 0.05 } } },
      ]),
    ).toBeNull()
    // The size of the list is the bound: a megabyte of points is refused before Go sees it.
    expect(
      editListProblem([
        { op: "draw", p: { strokes: [{ tool: "brush", size: 4, points: points(90_000) }] } },
      ]),
    ).toMatch(/too large|too many/)
    expect(MAX_STROKES).toBe(2000)
    expect(MAX_STROKE_POINTS).toBe(20_000)
    expect(DRAW_TOOLS).toHaveLength(8)
  })

  it("found eyes are rects of the picture", () => {
    const eyes = (load("res-edit.eyes.json") as { r: unknown }).r
    expect(sidecarResultGuards["edit.eyes"](eyes)).toBe(true)
    expect(sidecarResultGuards["edit.eyes"]({ eyes: [{ x: 0.3, y: 0.4, w: 0.04, h: 0.05 }] })).toBe(
      true,
    )
    for (const bad of [
      { eyes: [{ x: 0.3, y: 0.4, w: 0, h: 0.05 }] },
      { eyes: [{ x: "0.3", y: 0.4, w: 0.1, h: 0.05 }] },
      { eyes: Array.from({ length: 33 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1 })) },
      { eyes: null },
    ]) {
      expect(sidecarResultGuards["edit.eyes"](bad), JSON.stringify(bad).slice(0, 60)).toBe(false)
    }
    // A stroke renders like any frame.
    expect(isEditFrameResult((load("res-edit.frame-strokes.json") as { r: unknown }).r)).toBe(true)
  })
})

describe("the sidecar's answers", () => {
  it("a frame carries its file, the output size and the histogram", () => {
    const frame = load("res-edit.frame.json")
    if (!isResponseFrame(frame) || !frame.ok) throw new Error("not a success")
    expect(isEditFrameResult(frame.r)).toBe(true)
    expect(frame.r).toMatchObject({ rev: 1, output: { width: 24, height: 32 } })
    const r = frame.r as { histogram: { lum: number[]; pixels: number } }
    expect(r.histogram.lum.reduce((a, b) => a + b, 0)).toBe(r.histogram.pixels)
  })

  it("a superseded revision has no frame", () => {
    const frame = load("res-edit.frame-superseded.json")
    if (!isResponseFrame(frame) || !frame.ok) throw new Error("not a success")
    expect(frame.r).toEqual({ rev: 1, superseded: true })
    expect(isEditFrameResult(frame.r)).toBe(true)
    expect(isEditFrameResult({ rev: 1 })).toBe(false)
    expect(isEditFrameResult({ rev: 1, superseded: true, frame: {} })).toBe(false)
  })

  it("a closed session answers EDIT_SESSION_GONE", () => {
    const frame = load("res-edit.frame-gone.json")
    expect(isResponseFrame(frame) && !frame.ok && frame.e.code).toBe("EDIT_SESSION_GONE")
  })

  it("the save job reports its steps", () => {
    const evt = load("evt-job.progress-editSave.json") as { p: unknown }
    expect(eventGuards["job.progress"](evt.p)).toBe(true)
    expect(evt.p).toMatchObject({ kind: "editSave", state: "completed", done: 5, total: 5 })
  })

  it("carries the histogram a tool is given, a probed color, thumbnails and the color count", () => {
    const frame = load("res-edit.frame-before.json")
    if (!isResponseFrame(frame) || !frame.ok) throw new Error("not a success")
    expect(isEditFrameResult(frame.r)).toBe(true)
    const r = frame.r as { before: { lum: number[]; pixels: number }; histogram?: unknown }
    expect(r.histogram).toBeUndefined()
    expect(r.before.lum.reduce((a, b) => a + b, 0)).toBe(r.before.pixels)
    expect(isEditFrameResult({ ...(frame.r as object), before: { lum: [] } })).toBe(false)

    const probe = (load("res-edit.probe.json") as { r: { rgba: number[]; hex: string } }).r
    expect(sidecarResultGuards["edit.probe"](probe)).toBe(true)
    expect(probe.hex).toBe(
      "#" +
        probe.rgba
          .slice(0, 3)
          .map((v) => v.toString(16).padStart(2, "0"))
          .join(""),
    )
    expect(sidecarResultGuards["edit.probe"]({ rgba: [0, 0, 300, 255], hex: "#000000" })).toBe(
      false,
    )
    expect(sidecarResultGuards["edit.probe"]({ rgba: [0, 0, 0], hex: "#000000" })).toBe(false)

    const thumbs = (load("res-edit.thumbFrames.json") as { r: { thumbs: unknown[] } }).r
    expect(sidecarResultGuards["edit.thumbFrames"](thumbs)).toBe(true)
    // An invalid list has no thumbnail and does not fail the batch.
    expect(thumbs.thumbs).toHaveLength(3)
    expect(thumbs.thumbs[2]).toBeNull()

    const colors = (load("res-edit.colors.json") as { r: Record<string, unknown> }).r
    expect(sidecarResultGuards["edit.colors"](colors)).toBe(true)
    // Reduced to four colors: counted exactly, shares adding up.
    expect(colors.distinct).toBe(4)
    const shares = (colors.palette as { share: number }[]).reduce((a, s) => a + s.share, 0)
    expect(shares).toBeCloseTo(1, 3)
    expect(
      sidecarResultGuards["edit.colors"]({ ...colors, palette: [{ hex: "red", share: 1 }] }),
    ).toBe(false)
  })

  it("accepts the Stage 13 operations as plain data", () => {
    expect(
      editListProblem([
        { op: "lighting", p: { exposure: 0.5, contrast: 20 } },
        {
          op: "colors",
          p: { balance: { shadows: [0, 0, 10], midtones: [0, 0, 0], highlights: [5, 0, 0] } },
        },
        { op: "levels", p: { auto: { clip: 0.5, mode: "rgb" } } },
        {
          op: "curves",
          p: {
            l: [
              [0, 0],
              [64, 48],
              [255, 255],
            ],
            r: [
              [0, 0],
              [255, 240],
            ],
          },
        },
        { op: "reduceColors", p: { count: 16, dither: "fs" } },
        { op: "replaceColor", p: { from: "#ff0000", to: "#00ff00", tolerance: 20 } },
      ]),
    ).toBeNull()
  })

  it("guards refuse malformed results", () => {
    const open = (load("res-edit.open.json") as { r: Record<string, unknown> }).r
    expect(sidecarResultGuards["edit.open"](open)).toBe(true)
    expect(sidecarResultGuards["edit.open"]({ ...open, format: "heic" })).toBe(false)
    expect(sidecarResultGuards["edit.open"]({ ...open, saveFormat: "webp" })).toBe(false)
    expect(sidecarResultGuards["edit.open"]({ ...open, sessionId: "" })).toBe(false)
    expect(sidecarResultGuards["edit.open"]({ ...open, dpi: { x: -1, y: 0 } })).toBe(false)
    expect(sidecarResultGuards["edit.info"]({ groups: [{ name: "secrets", items: [] }] })).toBe(
      false,
    )
    expect(eventGuards["edit.request"]({ entryId: 0 })).toBe(false)
    expect(eventGuards["edit.request"]({ entryId: 12 })).toBe(true)
  })
})
