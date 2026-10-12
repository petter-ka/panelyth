import { describe, expect, it } from "vitest"
import {
  clampRect,
  CROP_RATIOS,
  dragHandle,
  fitRatio,
  fromPixels,
  FULL,
  moveRect,
  nudge,
  ratioValue,
  straightenAngle,
  toPixels,
} from "./crop"

const image = { w: 4000, h: 3000 }
const close = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(1e-9)

describe("crop box", () => {
  it("rounds to pixels like the Go pipeline", () => {
    expect(toPixels(FULL, image)).toEqual({ x: 0, y: 0, w: 4000, h: 3000 })
    expect(toPixels({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, image)).toEqual({
      x: 400,
      y: 600,
      w: 2000,
      h: 1800,
    })
    // Never empty, never outside.
    expect(toPixels({ x: 0.99999, y: 0.99999, w: 0.000001, h: 0.000001 }, image)).toEqual({
      x: 3999,
      y: 2999,
      w: 1,
      h: 1,
    })
    const back = fromPixels({ x: 400, y: 600, w: 2000, h: 1800 }, image)
    expect(toPixels(back, image)).toEqual({ x: 400, y: 600, w: 2000, h: 1800 })
  })

  it("stays inside the picture", () => {
    expect(clampRect({ x: -1, y: 2, w: 5, h: 0 }, image)).toEqual({
      x: 0,
      y: 1 - 1 / 3000,
      w: 1,
      h: 1 / 3000,
    })
    const moved = moveRect({ x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, 0.9, -0.9, image)
    close(moved.x, 0.6)
    close(moved.y, 0)
  })

  it("fits a ratio inside the box it replaces", () => {
    const square = fitRatio(FULL, 1, image)
    const px = toPixels(square, image)
    expect(px).toEqual({ x: 500, y: 0, w: 3000, h: 3000 })
    const wide = toPixels(fitRatio(FULL, 16 / 9, image), image)
    expect(wide.w).toBe(4000)
    expect(wide.h).toBe(2250)
    expect(wide.y).toBe(375)
    const original = CROP_RATIOS.find((r) => r.id === "original")!
    expect(ratioValue(original, image)).toBeCloseTo(4 / 3)
    expect(ratioValue(CROP_RATIOS[0]!, image)).toBeNull()
  })

  it("drags corners and edges freely", () => {
    const r = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }
    const se = dragHandle(r, "se", 0.1, 0.2, null, image)
    close(se.w, 0.5)
    close(se.h, 0.6)
    const nw = dragHandle(r, "nw", -0.5, -0.5, null, image)
    expect(nw).toEqual({ x: 0, y: 0, w: 0.6000000000000001, h: 0.6000000000000001 })
    // An edge cannot cross its opposite: one pixel stays.
    const w = dragHandle(r, "w", 5, 0, null, image)
    close(w.w, 1 / 4000)
    close(w.x + w.w, 0.6)
  })

  it("keeps a locked ratio from corners and edges, inside the picture", () => {
    const r = fitRatio({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1, image)
    for (const handle of ["se", "nw", "ne", "sw", "n", "s", "e", "w"] as const) {
      for (const [dx, dy] of [
        [0.1, 0.05],
        [-0.2, 0.3],
        [5, 5],
        [-5, -5],
      ] as const) {
        const next = dragHandle(r, handle, dx, dy, 1, image)
        const px = { w: next.w * image.w, h: next.h * image.h }
        expect(Math.abs(px.w - px.h), `${handle} ${dx},${dy}`).toBeLessThan(1e-6)
        expect(next.x).toBeGreaterThanOrEqual(-1e-9)
        expect(next.y).toBeGreaterThanOrEqual(-1e-9)
        expect(next.x + next.w).toBeLessThanOrEqual(1 + 1e-9)
        expect(next.y + next.h).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
    // The opposite corner stays where it was.
    const grown = dragHandle(r, "se", 0.05, 0.05, 1, image)
    close(grown.x, r.x)
    close(grown.y, r.y)
  })

  it("moves by one pixel with the arrow keys, ten with Shift", () => {
    const r = fromPixels({ x: 100, y: 100, w: 1000, h: 500 }, image)
    expect(toPixels(nudge(r, "move", "ArrowRight", false, null, image)!, image).x).toBe(101)
    expect(toPixels(nudge(r, "move", "ArrowUp", true, null, image)!, image).y).toBe(90)
    expect(toPixels(nudge(r, "e", "ArrowLeft", true, null, image)!, image).w).toBe(990)
    expect(toPixels(nudge(r, "s", "ArrowDown", false, null, image)!, image).h).toBe(501)
    expect(nudge(r, "move", "Enter", false, null, image)).toBeNull()
  })
})

describe("straighten", () => {
  it("levels a line drawn along the horizon or a wall", () => {
    expect(straightenAngle(100, 0)).toBeCloseTo(0)
    // The horizon drops to the right by 5°: turn 5° counter-clockwise.
    expect(
      straightenAngle(Math.cos((5 * Math.PI) / 180), Math.sin((5 * Math.PI) / 180)),
    ).toBeCloseTo(-5)
    // Drawn right to left: the same correction.
    expect(
      straightenAngle(-Math.cos((5 * Math.PI) / 180), -Math.sin((5 * Math.PI) / 180)),
    ).toBeCloseTo(-5)
    // A wall leaning 3° from upright.
    expect(
      straightenAngle(Math.sin((3 * Math.PI) / 180), -Math.cos((3 * Math.PI) / 180)),
    ).toBeCloseTo(-3)
    expect(straightenAngle(0, 0)).toBe(0)
    for (let a = -180; a <= 180; a += 7) {
      const c = straightenAngle(Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180))
      expect(Math.abs(c)).toBeLessThanOrEqual(45 + 1e-9)
    }
  })
})
