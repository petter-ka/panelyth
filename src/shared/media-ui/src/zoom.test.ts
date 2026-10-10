import { describe, expect, it } from "vitest"
import { clampOffset, clampZoom, displaySize, fitZoom, MAX_ZOOM, zoomAt } from "./zoom"

const view = { w: 1000, h: 800 }

describe("viewer zoom math", () => {
  it("fits the whole image and never upscales", () => {
    expect(fitZoom({ w: 4000, h: 3000 }, view, 1)).toBeCloseTo(0.25)
    expect(fitZoom({ w: 3000, h: 4000 }, view, 1)).toBeCloseTo(0.2)
    expect(fitZoom({ w: 500, h: 400 }, view, 1)).toBe(1) // small image: 100 %, not stretched
    expect(fitZoom({ w: 4000, h: 3000 }, view, 2)).toBeCloseTo(0.5) // HiDPI shows more pixels
  })

  it("100 % is one image pixel per device pixel", () => {
    expect(displaySize({ w: 4000, h: 3000 }, 1, 2)).toEqual({ w: 2000, h: 1500 })
    expect(displaySize({ w: 4000, h: 3000 }, 1, 1)).toEqual({ w: 4000, h: 3000 })
  })

  it("clamps zoom between a small minimum and 800 %", () => {
    expect(clampZoom(100, 0.25)).toBe(MAX_ZOOM)
    expect(clampZoom(0.0001, 0.25)).toBe(0.1)
    expect(clampZoom(0.0001, 0.05)).toBe(0.05) // tiny fit stays reachable
  })

  it("keeps the point under the cursor fixed while zooming", () => {
    const s = { zoom: 0.5, x: 0, y: 0 }
    const point = { x: 200, y: -100 }
    const next = zoomAt(s, 1, point)
    // Image coordinate under the cursor before and after: (point - offset) / zoom.
    expect((point.x - s.x) / s.zoom).toBeCloseTo((point.x - next.x) / next.zoom)
    expect((point.y - s.y) / s.zoom).toBeCloseTo((point.y - next.y) / next.zoom)
  })

  it("centres images smaller than the viewport and stops panning at the edges", () => {
    const image = { w: 4000, h: 3000 }
    expect(clampOffset({ zoom: 0.2, x: 300, y: -50 }, image, view, 1)).toEqual({
      zoom: 0.2,
      x: 0,
      y: 0,
    })
    // At 100 % the image is 4000×3000 CSS px: pan limit is (4000-1000)/2 × (3000-800)/2.
    expect(clampOffset({ zoom: 1, x: 99999, y: -99999 }, image, view, 1)).toEqual({
      zoom: 1,
      x: 1500,
      y: -1100,
    })
  })
})
