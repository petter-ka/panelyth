import type { StrokePoint } from "@panelyth/contracts"
import { describe, expect, it } from "vitest"
import {
  cloneOp,
  constrain,
  DEFAULT_PAINT,
  drawStroke,
  eyeRect,
  healOp,
  redEyeOp,
  simplifyPath,
  sourceFor,
  stepBrush,
  STROKE_TOLERANCE,
  strokePoint,
} from "./paint"

describe("stroke points", () => {
  it("travel with four decimals, and with pressure only from a pen", () => {
    expect(strokePoint(0.123456, 0.987654)).toEqual([0.1235, 0.9877])
    // A mouse reports 0.5 while pressed: that is no pressure.
    expect(strokePoint(0.5, 0.5, 0.5)).toEqual([0.5, 0.5])
    expect(strokePoint(0.5, 0.5, 0)).toEqual([0.5, 0.5])
    expect(strokePoint(0.5, 0.5, 0.731)).toEqual([0.5, 0.5, 0.73])
    expect(strokePoint(0.5, 0.5, 4)).toEqual([0.5, 0.5, 1])
  })
})

describe("simplifyPath", () => {
  it("keeps the ends of a straight line and nothing between", () => {
    const line = Array.from({ length: 300 }, (_, i): StrokePoint => [
      i / 299,
      0.2 + (i / 299) * 0.3,
    ])
    expect(simplifyPath(line, STROKE_TOLERANCE)).toEqual([line[0], line[299]])
  })

  it("thins a curve within the tolerance", () => {
    const wave = Array.from({ length: 3000 }, (_, i): StrokePoint => [
      i / 2999,
      0.5 + 0.2 * Math.sin((i / 2999) * 25),
      0.7,
    ])
    const tolerance = 0.002
    const thin = simplifyPath(wave, tolerance)
    expect(thin.length).toBeLessThan(250)
    expect(thin.length).toBeGreaterThan(20)
    expect(thin[0]).toBe(wave[0])
    expect(thin.at(-1)).toBe(wave.at(-1))
    // Pressure travels with its point.
    expect(thin.every((p) => p.length === 3)).toBe(true)
    // No dropped point is farther from what is left than the tolerance.
    for (let i = 0; i < wave.length; i += 7) {
      const p = wave[i]!
      let best = Infinity
      for (let k = 1; k < thin.length; k++) {
        const a = thin[k - 1]!
        const b = thin[k]!
        const dx = b[0] - a[0]
        const dy = b[1] - a[1]
        const u = Math.min(
          Math.max(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy), 0),
          1,
        )
        best = Math.min(best, Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy))
      }
      expect(best).toBeLessThanOrEqual(tolerance * 1.0001)
    }
  })

  it("leaves short paths and a zero tolerance alone", () => {
    const two: StrokePoint[] = [
      [0, 0],
      [1, 1],
    ]
    expect(simplifyPath(two, 1)).toEqual(two)
    const three: StrokePoint[] = [
      [0, 0],
      [0.5, 0.5],
      [1, 1],
    ]
    expect(simplifyPath(three, 0)).toHaveLength(3)
    // A path that returns to its start keeps its far point.
    expect(
      simplifyPath(
        [
          [0, 0],
          [0.5, 0.5],
          [0, 0],
        ],
        0.01,
      ),
    ).toHaveLength(3)
  })
})

describe("constrain", () => {
  // A picture 4:3; points are 0..1 of each side.
  const aspect = 4 / 3

  it("turns a line in steps of 45 degrees, keeping its length on screen", () => {
    const flat = constrain("line", [0.2, 0.5], [0.6, 0.52], aspect)
    expect(flat[1]).toBeCloseTo(0.5)
    expect(flat[0]).toBeCloseTo(0.6, 2)
    const diagonal = constrain("arrow", [0.2, 0.2], [0.5, 0.65], aspect)
    // 45° on screen: as far down as across, in pixels.
    expect((diagonal[0] - 0.2) * aspect).toBeCloseTo(diagonal[1] - 0.2)
    const up = constrain("line", [0.5, 0.5], [0.51, 0.1], aspect)
    expect(up[0]).toBeCloseTo(0.5)
    expect(up[1]).toBeCloseTo(0.1, 2)
  })

  it("makes a rectangle a square and an ellipse a circle", () => {
    const corner = constrain("rect", [0.1, 0.1], [0.4, 0.3], aspect)
    expect((corner[0] - 0.1) * aspect).toBeCloseTo(corner[1] - 0.1)
    // The larger side wins; the direction of the drag stays.
    const back = constrain("ellipse", [0.5, 0.5], [0.3, 0.45], aspect)
    expect(back[0]).toBeLessThan(0.5)
    expect(back[1]).toBeLessThan(0.5)
    expect(Math.abs(back[0] - 0.5) * aspect).toBeCloseTo(Math.abs(back[1] - 0.5))
  })
})

describe("operations from the brush", () => {
  const points: StrokePoint[] = [
    [0.1, 0.1],
    [0.2, 0.3],
  ]

  it("writes only what a stroke's tool uses, and only what is not the default", () => {
    expect(drawStroke(DEFAULT_PAINT, points)).toEqual({
      tool: "brush",
      color: "#ff3b30",
      size: 2,
      hardness: 80,
      points,
    })
    expect(
      drawStroke({ ...DEFAULT_PAINT, drawTool: "eraser", hardness: 100, opacity: 50 }, points),
    ).toEqual({
      tool: "eraser",
      size: 2,
      opacity: 50,
      points,
    })
    expect(drawStroke({ ...DEFAULT_PAINT, drawTool: "rect", filled: true }, points)).toEqual({
      tool: "rect",
      color: "#ff3b30",
      size: 2,
      filled: true,
      points,
    })
    expect(
      drawStroke({ ...DEFAULT_PAINT, drawTool: "text", text: "Hi", font: "Arial", bold: true }, [
        [0.5, 0.5],
      ]),
    ).toEqual({
      tool: "text",
      color: "#ff3b30",
      size: 2,
      text: "Hi",
      font: "Arial",
      bold: true,
      points: [[0.5, 0.5]],
    })
    expect(drawStroke({ ...DEFAULT_PAINT, drawTool: "fill", tolerance: 35 }, [[0.5, 0.5]])).toEqual(
      {
        tool: "fill",
        color: "#ff3b30",
        tolerance: 35,
        points: [[0.5, 0.5]],
      },
    )
  })

  it("clones and heals from a source", () => {
    expect(cloneOp({ ...DEFAULT_PAINT, hardness: 50 }, points, [0.123456, 0.5])).toEqual({
      op: "clone",
      p: { size: 2, source: [0.1235, 0.5], points },
    })
    expect(cloneOp({ ...DEFAULT_PAINT, opacity: 40 }, points, [0, 0]).p).toMatchObject({
      hardness: 80,
      opacity: 40,
    })
    // A spot heal has no source, whatever was chosen for the brush.
    expect(healOp(DEFAULT_PAINT, points, [0.3, 0.3])).toEqual({
      op: "heal",
      p: { size: 2, points },
    })
    expect(healOp({ ...DEFAULT_PAINT, healMode: "brush" }, points, [0.3, 0.3])).toEqual({
      op: "heal",
      p: { mode: "brush", size: 2, source: [0.3, 0.3], points },
    })
  })

  it("keeps the source at its distance from the brush", () => {
    expect(sourceFor({ source: null, offset: null }, [0.5, 0.5])).toBeNull()
    // The first stroke copies from the chosen point…
    const first = sourceFor({ source: [0.2, 0.3], offset: null }, [0.5, 0.5])!
    expect(first.source).toEqual([0.2, 0.3])
    expect(first.offset[0]).toBeCloseTo(-0.3)
    expect(first.offset[1]).toBeCloseTo(-0.2)
    // …later ones from as far beside the brush.
    const later = sourceFor({ source: [0.2, 0.3], offset: first.offset }, [0.7, 0.6])!
    expect(later.source[0]).toBeCloseTo(0.4)
    expect(later.source[1]).toBeCloseTo(0.4)
  })

  it("boxes an eye from a drag or around a click", () => {
    expect(eyeRect([0.4, 0.3], [0.5, 0.42], 1.5)).toEqual({ x: 0.4, y: 0.3, w: 0.1, h: 0.12 })
    expect(eyeRect([0.5, 0.42], [0.4, 0.3], 1.5)).toEqual({ x: 0.4, y: 0.3, w: 0.1, h: 0.12 })
    // A click: 6 % of the shorter edge, square on screen, around the point.
    const click = eyeRect([0.5, 0.5], [0.5, 0.5], 1.5)
    expect(click.h).toBeCloseTo(0.06)
    expect(click.w * 1.5).toBeCloseTo(0.06)
    expect(click.x + click.w / 2).toBeCloseTo(0.5)
    // At the edge the box stays in the picture.
    const corner = eyeRect([0.99, 0.01], [0.99, 0.01], 1)
    expect(corner.y).toBe(0)
    expect(corner.x + corner.w).toBeLessThanOrEqual(1)
    expect(redEyeOp(DEFAULT_PAINT, click)).toEqual({ op: "redeye", p: { rect: click } })
    expect(redEyeOp({ ...DEFAULT_PAINT, redStrength: 70, redPupil: -20 }, click).p).toMatchObject({
      strength: 70,
      pupil: -20,
    })
  })

  it("steps the brush size in steps that grow with it", () => {
    expect(stepBrush(0.5, 1)).toBe(0.6)
    expect(stepBrush(1, 1)).toBe(1.5)
    expect(stepBrush(1, -1)).toBe(0.9)
    expect(stepBrush(5, 1)).toBe(6)
    expect(stepBrush(5, -1)).toBe(4.5)
    expect(stepBrush(20, 1)).toBe(25)
    expect(stepBrush(20, -1)).toBe(19)
    expect(stepBrush(50, 1)).toBe(50)
    expect(stepBrush(0.05, -1)).toBe(0.05)
    // Up and down again is where it was.
    expect(stepBrush(stepBrush(2, 1), -1)).toBe(2)
  })
})
