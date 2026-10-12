import type { CurvePoint, EditHistogram } from "@panelyth/contracts"
import { describe, expect, it } from "vitest"
import { autoLevels, curveLut, levelsFromPick, movePoint, NEUTRAL, toHex, withPoint } from "./tone"
import { CURVE_PRESETS, defaultOp, describeOp, isNoOp, LOOKS, TOOLS, toolDef } from "./tools"

const histogram = (bins: number[]): EditHistogram => ({
  lum: bins,
  r: bins,
  g: bins,
  b: bins,
  pixels: bins.reduce((a, b) => a + b, 0),
  clipLow: 0,
  clipHigh: 0,
  mean: 128,
})

describe("curveLut", () => {
  it("is the identity for the straight line", () => {
    expect(
      curveLut([
        [0, 0],
        [255, 255],
      ]),
    ).toEqual(Array.from({ length: 256 }, (_, v) => v))
  })

  it("passes through every point and never overshoots between two of them", () => {
    const points: CurvePoint[] = [
      [0, 0],
      [64, 48],
      [128, 128],
      [192, 240],
      [255, 255],
    ]
    const lut = curveLut(points)
    for (const [x, y] of points) expect(lut[x]).toBe(y)
    // Rising points give a rising curve.
    for (let v = 1; v < 256; v++) expect(lut[v]!).toBeGreaterThanOrEqual(lut[v - 1]!)
    // A plateau stays flat: no ringing around it.
    const flat = curveLut([
      [0, 0],
      [100, 200],
      [150, 200],
      [255, 255],
    ])
    for (let v = 100; v <= 150; v++) expect(flat[v]).toBe(200)
  })

  it("is flat before the first point and after the last", () => {
    const lut = curveLut([
      [50, 20],
      [200, 230],
    ])
    expect(lut[0]).toBe(20)
    expect(lut[50]).toBe(20)
    expect(lut[200]).toBe(230)
    expect(lut[255]).toBe(230)
    expect(lut[125]).toBe(125)
  })

  it("inverts and stays within 0..255", () => {
    const lut = curveLut([
      [0, 255],
      [255, 0],
    ])
    expect(lut[0]).toBe(255)
    expect(lut[255]).toBe(0)
    expect(lut[100]).toBe(155)
    for (const preset of CURVE_PRESETS) {
      for (const v of curveLut(preset.points)) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(255)
      }
    }
  })
})

describe("curve points", () => {
  const line: CurvePoint[] = [
    [0, 0],
    [255, 255],
  ]

  it("adds a point in order and replaces one at the same input", () => {
    const three = withPoint(line, 128.4, 160.2)
    expect(three).toEqual([
      [0, 0],
      [128, 160],
      [255, 255],
    ])
    expect(withPoint(three, 128, 90)).toEqual([
      [0, 0],
      [128, 90],
      [255, 255],
    ])
    expect(withPoint(line, -20, 300)).toEqual([
      [0, 255],
      [255, 255],
    ])
  })

  it("keeps a moved point between its neighbours", () => {
    const three = withPoint(line, 128, 160)
    expect(movePoint(three, 1, 400, 10)[1]).toEqual([254, 10])
    expect(movePoint(three, 1, -5, 300)[1]).toEqual([1, 255])
    expect(movePoint(three, 0, 200, 40)[0]).toEqual([127, 40])
    // The input is untouched; the others are copies.
    expect(three[1]).toEqual([128, 160])
  })
})

describe("autoLevels", () => {
  const narrow: number[] = Array.from({ length: 256 }, (_, i) => (i >= 40 && i <= 215 ? 6 : 0))

  it("sets the input range to where the pixels are, per channel", () => {
    const p = autoLevels(histogram(narrow), { clip: 0.1, mode: "rgb", gamma: false })
    expect(p).toEqual({
      r: { ...NEUTRAL, inBlack: 40, inWhite: 215 },
      g: { ...NEUTRAL, inBlack: 40, inWhite: 215 },
      b: { ...NEUTRAL, inBlack: 40, inWhite: 215 },
    })
    expect(autoLevels(histogram(narrow), { clip: 0.1, mode: "lum", gamma: false })).toEqual({
      l: { ...NEUTRAL, inBlack: 40, inWhite: 215 },
    })
  })

  it("cuts off the given share at each end", () => {
    // 1 % of 1,056 pixels is 10: one full bin (6) and part of the next.
    const p = autoLevels(histogram(narrow), { clip: 1, mode: "lum", gamma: false })
    expect(p.l).toMatchObject({ inBlack: 41, inWhite: 214 })
    // A few stray pixels at the ends do not hold the range open.
    const stray = narrow.slice()
    stray[0] = 1
    stray[255] = 1
    expect(autoLevels(histogram(stray), { clip: 0.1, mode: "lum", gamma: false }).l).toMatchObject({
      inBlack: 40,
      inWhite: 215,
    })
    expect(autoLevels(histogram(stray), { clip: 0, mode: "lum", gamma: false }).l).toMatchObject({
      inBlack: 0,
      inWhite: 255,
    })
  })

  it("centres the midtones when asked, within limits", () => {
    // Most pixels are dark: the median sits low, so gamma brightens.
    const dark = Array.from({ length: 256 }, (_, i) => (i < 64 ? 12 : 1))
    const p = autoLevels(histogram(dark), { clip: 0, mode: "lum", gamma: true })
    expect(p.l!.gamma).toBeGreaterThan(1)
    expect(p.l!.gamma).toBeLessThanOrEqual(1.6)
    const even = autoLevels(histogram(narrow), { clip: 0.1, mode: "lum", gamma: true })
    expect(even.l!.gamma).toBeCloseTo(1, 1)
  })

  it("survives an empty histogram", () => {
    const empty = Array.from({ length: 256 }, () => 0)
    const p = autoLevels(histogram(empty), { clip: 0.1, mode: "lum", gamma: true })
    expect(p.l!.inBlack).toBeLessThan(p.l!.inWhite)
  })
})

describe("levelsFromPick", () => {
  it("makes the picked color black or white, channel by channel", () => {
    const white = levelsFromPick({}, "white", [200, 100, 50])
    expect(white).toEqual({
      r: { ...NEUTRAL, inWhite: 200 },
      g: { ...NEUTRAL, inWhite: 100 },
      b: { ...NEUTRAL, inWhite: 50 },
    })
    const both = levelsFromPick(white, "black", [10, 120, 0])
    expect(both.r).toMatchObject({ inBlack: 10, inWhite: 200 })
    // Black stays below white.
    expect(both.g).toMatchObject({ inBlack: 99, inWhite: 100 })
    expect(both.b).toMatchObject({ inBlack: 0, inWhite: 50 })
  })

  it("makes a picked color neutral with the gray eyedropper", () => {
    const p = levelsFromPick({ l: NEUTRAL, auto: { clip: 1, mode: "rgb" } }, "gray", [160, 128, 96])
    // Picked values become ordinary numbers: the auto variant is gone.
    expect(p.auto).toBeUndefined()
    expect(p.l).toEqual(NEUTRAL)
    // Red is above the mean and is darkened, blue below and is lightened.
    expect(p.r!.gamma).toBeLessThan(1)
    expect(p.g!.gamma).toBeCloseTo(1, 5)
    expect(p.b!.gamma).toBeGreaterThan(1)
    // Each channel's gamma brings its value to the mean (128): out = in^(1/gamma).
    for (const [name, v] of [
      ["r", 160],
      ["b", 96],
    ] as const) {
      const out = 255 * Math.pow(v / 255, 1 / p[name]!.gamma!)
      expect(Math.abs(out - 128)).toBeLessThan(1.5)
    }
    // A gray pick changes nothing.
    const same = levelsFromPick({}, "gray", [90, 90, 90])
    expect(same.r!.gamma).toBe(1)
  })
})

describe("the tool registry", () => {
  it("formats a color", () => {
    expect(toHex([255, 0, 128, 255])).toBe("#ff0080")
    expect(toHex([-4, 300, 15.6])).toBe("#00ff10")
  })

  it("starts every tool neutral, or adds it on opening", () => {
    const image = { width: 4000, height: 3000, dpi: 300 }
    const neutral = TOOLS.filter((d) => d.id !== "looks" && isNoOp(defaultOp(d.id, image), image))
    expect(neutral.map((d) => d.id).sort()).toEqual(
      [
        "blur",
        "border",
        "bump",
        "canvas",
        "colors",
        "crop",
        "curves",
        "denoise",
        "dpi",
        "draw",
        "lens",
        "levels",
        "lighting",
        "resize",
        "rotate",
        "sharpen",
      ].sort(),
    )
    for (const def of TOOLS) {
      expect(toolDef(def.id)).toBe(def)
      if (def.id !== "looks") expect(typeof describeOp(defaultOp(def.id, image))).toBe("string")
    }
  })

  it("builds every look from ordinary operations that change the picture", () => {
    const image = { width: 4000, height: 3000, dpi: 300 }
    // One batched request renders them all: at most 16 thumbnails a call.
    expect(LOOKS.length).toBe(16)
    expect(new Set(LOOKS.map((l) => l.id)).size).toBe(LOOKS.length)
    for (const look of LOOKS) {
      expect(look.ops.length).toBeGreaterThan(0)
      for (const op of look.ops) expect(isNoOp(op, image)).toBe(false)
    }
  })
})
