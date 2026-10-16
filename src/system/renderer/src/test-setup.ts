import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

afterEach(() => cleanup())

// Radix menus and react-resizable-panels use pointer capture, scrollIntoView
// and ResizeObserver, which jsdom lacks.
const proto = Element.prototype as unknown as Record<string, unknown>
proto.hasPointerCapture ??= () => false
proto.setPointerCapture ??= () => undefined
proto.releasePointerCapture ??= () => undefined
proto.scrollIntoView ??= () => undefined
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver
