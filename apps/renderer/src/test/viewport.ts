import { vi } from "vitest"

/**
 * jsdom has no layout: every element measures 0×0. The tile view reads
 * getBoundingClientRect and TanStack Virtual reads offsetWidth/offsetHeight,
 * so tests give elements a viewport size through both.
 */
export function mockViewport(
  width: number,
  height: number,
): { resize(w: number, h: number): void } {
  let size = { width, height }
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        width: size.width,
        height: size.height,
        top: 0,
        left: 0,
        right: size.width,
        bottom: size.height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  )
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => size.width)
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => size.height)
  return {
    resize(w: number, h: number) {
      size = { width: w, height: h }
    },
  }
}
