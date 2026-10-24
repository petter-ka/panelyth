import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

afterEach(() => cleanup())

const proto = Element.prototype as unknown as Record<string, unknown>
proto.scrollIntoView ??= () => undefined
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver

// jsdom has no layout; CodeMirror measures text ranges.
const empty = (): DOMRect => ({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  toJSON: () => ({}),
})
const rangeProto = Range.prototype as unknown as Record<string, unknown>
rangeProto.getClientRects ??= () => ({
  length: 0,
  item: () => null,
  [Symbol.iterator]: [][Symbol.iterator],
})
rangeProto.getBoundingClientRect ??= empty
